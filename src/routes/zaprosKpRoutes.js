const { parseBody, send, generateId } = require('../utils');
const { buildSyntheticQuery } = require('./helpers/syntheticTables');
// ✅ Кир→Лат: GLOB-паттерны с буквами-двойниками (см. helpers/homoglyphs.js)
const { cyrGlobPattern } = require('./helpers/queryBuilder');
// ✅ НОВОЕ: excel-сервис для генерации сводной таблицы КП в .xlsx
const excelService = require('../excelService');
// ✅ T48: файловая система/пути — хранение оснований (PDF) по запросам КП
const fs = require('fs');
const path = require('path');
// ✅ T51: портал ЭДО АВТОВАЗа (создание СЗ «Согласование заказа по запросу ТКП»)
const edo = require('./helpers/edoPortal');
// ============================================================================
// ПАТЧ от 2026-08-31 — восстановление plan_god_kolvo и графиков при автооткате
//   D1 — маркер «Нет КП» больше не удваивает количество (POST_BEST_KP, доназначение)
//   D2 — кэш 2 сек больше не пропускает обязательный откат (POST_BEST_KP, DELETE_WITH_KP)
//   D3 — количество всего поддерева возвращается КОРНЮ (единый алгоритм в _autoRollbackZapros)
//   D4 — ошибки откатов больше не глотаются: транзакция в PUT_KOM_PREDL, 409 клиенту
//   D5 — zapros.statys добавлен в выборку _autoRollbackZapros
//   +  архив графиков grafik_archive: графики корней восстанавливаются после отката
//
//   REV 2 (2026-08-31) — «не срабатывает восстановление графика из архива»:
//     G1 — снимок берётся FIFO (самый СТАРЫЙ необработанный). Раньше брали самый
//         свежий пакет (RB_...), заархивированный самим откатом, — «восстанавливались»
//         устаревшие строки, а исходный снимок (SPLIT_...) навсегда оставался в архиве.
//     G2 — пакет помечается restored=1 только если строки РЕАЛЬНО вставились;
//         вставка фильтруется по фактическим колонкам таблицы grafik.
//     G3 — самовосстановление графиков запроса (_restoreMissingGrafikForZapros):
//         позиция с ПУСТЫМ графиком и необработанным снимком в архиве получает
//         график обратно. Покрывает ранние выходы отката и хвостовые случаи.
//     G4 — DELETE_WITH_KP гарантированно вызывает самовосстановление после отката.
//     G5 — честная диагностика: корень без графика и без снимка пишется в лог прямо.
//     G6 — DELETE_POSITION больше не уничтожает график родителя (архив + возврат).
//     G7 — строковые литералы в SQL переведены на одинарные кавычки (''): двойные
//         кавычки сломаются на SQLite со выключенным DQS (node:sqlite и новые сборки).
//   REV 3 (2026-08-31) — архив не накапливает мусор:
//     G8 — восстановленные строки УДАЛЯЮТСЯ из grafik_archive (не помечаются
//         restored=1); строки, вставить которые не удалось, остаются и логируются
//     G9 — архивируются только снимки КОРНЕЙ: графики удаляемых детей не
//         сохраняются — позиция удаляется навсегда, записи были мёртвым грузом
//     G10 — чистка архива: снимки удалённых позиций и restored=1 от старых
//         версий патча вычищаются при каждом самовосстановлении
// Полный разбор — в отчёте «Разбор диалога с ИИ — запросы КП и автооткат», раздел 5.
// ============================================================================
// В начало модуля (после require)
const _rollbackCache = new Map();
// ========================================================================
// Вспомогательные функции для приоритетов КП
// ========================================================================
function getTypePriority(typeName) {
  const name = (typeName || '').toUpperCase().trim();
  if (name.includes('ПОЛНЫЙ ЦИКЛ')) return 1;
  if (name.includes('ПОЛНАЯ МЕХ') && name.includes('БЕЗ ТО')) return 2;
  if (name.includes('ЧАСТИЧНАЯ МЕХ') && name.includes('С ТО')) return 3;
  if (name.includes('ЧАСТИЧНАЯ МЕХ') && name.includes('БЕЗ ТО')) return 4;
  return 99;
}

// Вспомогательная функция для чтения сырого тела запроса (чистый Node.js)
function getRawBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            // Защита от слишком больших файлов (например, > 10 МБ)
            if (body.length > 1e7) {
                reject(new Error('Файл слишком большой (лимит 10 МБ)'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

// ✅ T48: чтение СЫРОГО БИНАРНОГО тела запроса (Buffer, не строка —
// PDF-файл нельзя накапливать через toString(), байты испортятся).
// Лимит 25 МБ — как в orderRoutes.POST_UPLOAD_FILE.
function getRawBufferBody(req, limitBytes = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limitBytes) {
                reject(new Error('Файл больше 25 МБ'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('error', reject);
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

// ✅ T48: структура хранения оснований — public/запросы/<год>/<номер запроса>/
// Каталог модуля src/routes: корень проекта на два уровня выше.
function osnovaniePaths() {
    const pubDir = path.join(__dirname, '..', '..', 'public');
    return { pubDir, rootDir: path.join(pubDir, 'запросы') };
}

// ✅ T48: безопасное имя файла/папки (символы, запрещённые Windows)
function osnovanieSafeName(name, fallback) {
    const s = String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    return (s || fallback).slice(0, 120);
}

function getGroupNum(typeName) {
  const name = (typeName || '').toUpperCase().trim();
  if (name.includes('ПОЛНЫЙ ЦИКЛ') || 
      (name.includes('ПОЛНАЯ МЕХ') && name.includes('БЕЗ ТО'))) return 1;
  if (name.includes('ЧАСТИЧНАЯ МЕХ')) return 2;
  return 9;
}
// ========================================================================
// Вспомогательная функция для экранирования специальных символов в RegExp
// ========================================================================
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const safeNum = (v) => {
  const n = parseFloat(String(v || '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
};
// ========================================================================
// 📝 ФУНКЦИИ РАБОТЫ С БЛОКАМИ ИСТОРИИ В ПРИМЕЧАНИИ
// Формат: "Разделено Запрос №X от YYYY-MM-DD [блок1] Запрос №Y от YYYY-MM-DD [блок2]"
// Блоки:
//   - [нет КП для N шт.]
//   - [получено КП от Фирма для N шт.]
//   - [автовыбор КП фирмы Z]
// ========================================================================

/**
 * Извлекает все блоки [...] из примечания вместе с их префиксами "Запрос №..."
 * Возвращает массив объектов: { prefix: "Запрос №1 от 2026-07-30", block: "нет КП для 150 шт." }
 */
function extractZaprosBlocks(primechanie) {
    if (!primechanie) return [];
    const regex = /(Запрос №\d+ от \d{4}-\d{2}-\d{2})\s*\[([^\]]+)\]/g;
    const results = [];
    let match;
    while ((match = regex.exec(primechanie)) !== null) {
        results.push({
            prefix: match[1],
            block: match[2]
        });
    }
    return results;
}

/**
 * Собирает примечание из массива блоков
 */
function buildNoteFromBlocks(blocks) {
    if (!blocks || blocks.length === 0) return 'Разделено';
    const blocksStr = blocks.map(b => `${b.prefix} [${b.block}]`).join(' ');
    return `Разделено ${blocksStr}`.trim();
}

/**
 * Добавляет блок "нет КП" в конец примечания
 */
function addNoKPBlock(primechanie, kolvo, zaprosInfo) {
    const blocks = extractZaprosBlocks(primechanie);
    blocks.push({
        prefix: zaprosInfo,
        block: `нет КП для ${kolvo} шт.`
    });
    return buildNoteFromBlocks(blocks);
}

/**
 * Заменяет ПОСЛЕДНИЙ блок "нет КП" на "получено КП"
 * Если последнего блока "нет КП" нет — добавляет новый блок "получено КП"
 */
function replaceLastNoKPWithKP(primechanie, firmaName, kolvo, zaprosInfo) {
    const blocks = extractZaprosBlocks(primechanie);
    
    let replaced = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].block.startsWith('нет КП для')) {
            blocks[i] = {
                prefix: zaprosInfo,
                block: `получено КП от ${firmaName} для ${kolvo} шт.`
            };
            replaced = true;
            break;
        }
    }
    
    if (!replaced) {
        blocks.push({
            prefix: zaprosInfo,
            block: `получено КП от ${firmaName} для ${kolvo} шт.`
        });
    }
    
    return buildNoteFromBlocks(blocks);
}

/**
 * Добавляет блок "автовыбор КП" для распространения лучших КП
 */
function addAutoSelectBlock(primechanie, zaprosInfo, firmaName) {
    const blocks = extractZaprosBlocks(primechanie);
    blocks.push({
        prefix: zaprosInfo,
        block: `автовыбор КП фирмы ${firmaName}`
    });
    return buildNoteFromBlocks(blocks);
}

// ================================================================
// ✅ T51: СОГЛАСОВАНИЕ ЗАКАЗА ПО ЗАПРОСУ ТКП — СЗ в ЭДО.
// На согласование структурным подразделением АВТОВАЗа направляется
// сводная таблица КП с лучшими предложениями (страница «Внесение
// коммерческих предложений»), поэтому согласование привязано к
// ЗАПРОСУ КП (поля n_sogl_avtovaz/statys_sogl_avtovaz/id_doc_edo
// перенесены из zakaz_po_dogovoru в zapros_kp).
// Механизм создания письма — ПО АНАЛОГИИ со «СЗ в СБ об отгрузке»
// (T42/T43): предпросмотр текста из БД (без обращения к порталу) ->
// правка в модальном окне WYSIWYG -> Create_doc_on_template.aspx ->
// KartEdit (подписант из настроек) -> ViewShablon/SaveShablon
// (текст письма) -> n_sogl_avtovaz (номер) и id_doc_edo (d_kod)
// в zapros_kp. Идентификатор шаблона и параметры подписывающего
// берутся из настроек config/edo.json (shablon.sz_soglasovanie,
// podpisant.sz_soglasovanie; дефолт подписанта — «Савченко В.М.»,
// как у СЗ в СБ).
// ================================================================

// Лучшие КП запроса (kp.reshenie = 'лучшее предложение', не исключённые)
// + детали (план/оснастка) + фирма и договор каждого КП.
function szSoglasCollectRows(db, zaprosId) {
  return db.all(`
    SELECT kp.id AS kp_id,
           kp.cena_postavshika, kp.trudoemkost_postavshika,
           kp.moshchnost_kolvo, kp.srok_vipolneniya, kp.tip_izgotovleniya,
           kp.id_firma,
           f.naimenovanie AS firma_name,
           p.id AS plan_id, p.plan_god_kolvo,
           o.nomer_chertezha, o.naimenovanie AS osn_naimenovanie,
           d.nom_dogovor
    FROM kp
    JOIN plan p ON p.id = kp.id_plana
    LEFT JOIN osnastka o ON o.id = p.id_osnastka
    LEFT JOIN firmy f ON f.id_firmy = kp.id_firma
    LEFT JOIN dogovor d ON d.id_dogovor = kp.id_dogovor
    WHERE kp.id_zaprosa_kp = ?
      AND kp.reshenie = 'лучшее предложение'
      AND (kp.isklyuchen IS NULL OR kp.isklyuchen = '')
    ORDER BY o.nomer_chertezha
  `, [zaprosId]);
}

// ✅ T52: значения подстановок для темы СЗ согласования (tema.sz_soglasovanie):
//   {номер} — номер запроса КП (n_zaprosa);
//   {дата}  — дата запроса (data_form, ДД.ММ.ГГГГ; если в БД уже
//             хранится как ДД.ММ.ГГГГ — остаётся как есть);
//   {фирмы} — наименования фирм лучших КП через запятую (без повторов).
function szSoglasTemaValues(zapros, rows) {
  const toRuDate = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v || '').trim();
  };
  const firms = Array.from(
    new Set((rows || []).map((r) => r.firma_name).filter(Boolean))).join(', ');
  return {
    'номер': zapros.n_zaprosa == null ? '' : String(zapros.n_zaprosa),
    'дата': toRuDate(zapros.data_form),
    'фирмы': firms
  };
}

// HTML-текст письма согласования (разметка как в письмах портала:
// приветствие — ПО ЦЕНТРУ, у абзацев первая строка — отступ 10
// пробелов (&nbsp; × 10) — единый стиль с СЗ в СБ об отгрузке).
const SZ_SOGLAS_INDENT = '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;';
function szSoglasBuildLetter(rows, zapros) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toRuDate = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v || '').trim();
  };
  // число для расчёта стоимости партии (цена × план-количество)
  const num = (v) => {
    const s = String(v == null ? '' : v).trim().replace(',', '.');
    return /^[0-9]+(\.[0-9]+)?$/.test(s) ? parseFloat(s) : null;
  };
  const fmt = (n) => n === null
    ? ''
    : n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const parts = [];
  parts.push('<div align="center" style="text-align: center;">Уважаемый Александр Викторович!</div>');
  parts.push('<div><br /></div>');
  parts.push(`<div>${SZ_SOGLAS_INDENT}Прошу Вас согласовать заказ, сформированный на основании запроса ТКП № ${esc(zapros.n_zaprosa)}` +
    ` от ${esc(toRuDate(zapros.data_form))}, по результатам рассмотрения коммерческих предложений контрагентов.` +
    ` Сводная таблица КП с лучшими предложениями прилагается.</div>`);
  parts.push('<div><br /></div>');
  for (const r of rows) {
    const cena = num(r.cena_postavshika);
    const kolvo = num(r.plan_god_kolvo);
    let stoim = '';
    if (cena !== null && kolvo !== null) stoim = `, стоимость партии ${fmt(cena * kolvo)} руб. без НДС`;
    else if (cena !== null) stoim = `, цена за деталь ${fmt(cena)} руб. без НДС`;
    const srok = String(r.srok_vipolneniya || '').trim();
    parts.push(`<div>${SZ_SOGLAS_INDENT}- деталь ${esc(r.nomer_chertezha || '')} (${esc(r.osn_naimenovanie || '')}),` +
      ` план ${esc(r.plan_god_kolvo || '')} шт.: фирма ${esc(r.firma_name || '')}${stoim}` +
      (srok ? `, срок выполнения ${esc(srok)} нед.` : '') + '.</div>');
  }
  parts.push('<div><br /></div>');
  parts.push(`<div>${SZ_SOGLAS_INDENT}Приложение: сводная таблица коммерческих предложений по запросу ТКП № ${esc(zapros.n_zaprosa)}.</div>`);
  return parts.join('\r\n');
}

// ✅ T51-b: СБОР ФАЙЛОВ ДЛЯ ВЛОЖЕНИЯ В СЗ СОГЛАСОВАНИЯ.
// К письму, кроме сводной таблицы, прикрепляются ВСЕ файлы «Основание
// от фирмы» (PDF) по выбранному запросу (таблица ТКПоснование, файлы в
// public/запросы/<год>/<номер запроса>/) и сам запрос в форме Excel —
// он к этому моменту УЖЕ создан и лежит по стандартному пути со
// стандартным именем («Заявка № <№ запроса>.xlsx» в public/Заявки/<год>/,
// создаётся при отправке запроса фирмам) — ПЕРЕСОЗДАВАТЬ его не нужно.
// Отсутствие файла — НЕ ошибка создания СЗ: вложение делается «лучучшими
// усилиями», а список проблем уходит в ответ клиенту (warnings).
async function szSoglasCollectAttachments(db, zapros) {
  const { pubDir } = osnovaniePaths();
  const files = [];    // { path, label } — что грузим на портал (по порядку)
  const missing = [];  // { label, error } — чего не хватило (для предупреждений)

  // Годы-кандидаты: год плана запроса (так вычисляется год при генерации
  // «Заявка № …»), год из даты запроса, текущий год — файл ищется в
  // public/Заявки/<год>/ по очереди.
  const years = [];
  const pushYear = (v) => {
    const m = String(v == null ? '' : v).match(/(19|20)\d{2}/);
    if (m && years.indexOf(m[0]) < 0) years.push(m[0]);
  };
  try {
    const pl = await db.get(
      'SELECT god FROM plan WHERE id IN (SELECT id_plana FROM kp WHERE id_zaprosa_kp = ?) LIMIT 1',
      [zapros.id]);
    if (pl) pushYear(pl.god);
  } catch (e) { /* некритично — есть другие кандидаты */ }
  pushYear(zapros.data_form);
  pushYear(new Date().getFullYear());

  const findInYears = (name) => {
    for (const y of years) {
      const p = path.join(pubDir, 'Заявки', y, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  };

  // 1) Сводная таблица КП (кнопка «Экспорт в Excel» на странице
  //    «Внесение коммерческих предложений»):
  //    public/Заявки/<год>/Выбор поставщика заявка№<№>.xlsx
  //    (имя генерирует excelService.exportSummaryTableKP — номер
  //    очищается от символов, запрещённых Windows, как и там).
  const svodSafe = String(zapros.n_zaprosa == null || zapros.n_zaprosa === ''
    ? 'without_number' : zapros.n_zaprosa).replace(/[\\/:*?"<>|]/g, '_').trim();
  const svodName = 'Выбор поставщика заявка№' + svodSafe + '.xlsx';
  const svodPath = findInYears(svodName);
  if (svodPath) files.push({ path: svodPath, label: svodName });
  else missing.push({ label: svodName, error: 'файл сводной таблицы не найден в public/Заявки/<год> — сначала выполните «Экспорт в Excel» сводной таблицы КП' });

  // 2) Сам запрос в форме Excel — «Заявка № <№>.xlsx» (стандартное имя
  //    excelService.exportZaprosKP). Файл УЖЕ создан к этому моменту и
  //    сохранён по стандартному пути — пересоздавать не нужно, только найти.
  const zayavkaName = 'Заявка № ' + String(zapros.n_zaprosa == null ? '' : zapros.n_zaprosa) + '.xlsx';
  const zayavkaPath = findInYears(zayavkaName);
  if (zayavkaPath) files.push({ path: zayavkaPath, label: zayavkaName });
  else missing.push({ label: zayavkaName, error: 'файл запроса не найден в public/Заявки/<год> (Заявка № …xlsx не пересоздаётся — отправьте запрос фирмам или положите файл вручную)' });

  // 3) Все файлы «Основание от фирмы» (PDF) по запросу — таблица
  //    ТКПоснование (ssylka = /запросы/<год>/<№ запроса>/<файл>).
  try {
    const osn = await db.all(
      'SELECT ssylka, imya_fayla FROM "ТКПоснование" WHERE id_zaprosa_kp = ? ORDER BY id',
      [zapros.id]);
    for (const o of (osn || [])) {
      const rel = String(o.ssylka || '').replace(/^[/\\]+/, '');
      if (!rel) continue;
      const abs = path.join(pubDir, rel);
      if (!abs.startsWith(pubDir)) continue; // защита от traversal
      const label = o.imya_fayla || path.basename(rel);
      if (fs.existsSync(abs)) files.push({ path: abs, label });
      else missing.push({ label, error: 'файл основания отсутствует на диске' });
    }
  } catch (e) { /* нет таблицы/строк — вложений-оснований просто нет */ }

  return { files, missing };
}


// ================================================================
// ✅ T85: КОПИРОВАНИЕ МАРШРУТА родителя на дочернюю позицию плана.
// Разделение по мощности (createChildPlan) и маркеры «нет КП» раньше
// создавали дочернюю позицию БЕЗ шагов маршрута (shagi_marshruta):
// computePositionFlow (planPerevozokRoutes.js / transportOperRoutes.js)
// не находил ни одного шага (currentStep = null), позиция не попадала
// в «доступные позиции для добавления» страницы «План перевозок» —
// её нельзя было добавить в план перевозок и создать по ней грузовые
// позиции. Копируем шаги и операции родителя (новые id_shag/id_oper,
// связь через map — как в POST_COPY marshrutRoutes.js).
// Идемпотентно: у цели уже есть шаги — копирование не выполняется.
// ================================================================
async function copyPlanRoute(db, sourcePlanId, targetPlanId) {
    const existing = await db.get(
        'SELECT COUNT(*) as n FROM shagi_marshruta WHERE id_det = ?',
        [targetPlanId]
    );
    if (existing && existing.n > 0) return 0;
    const sourceSteps = await db.all(
        'SELECT * FROM shagi_marshruta WHERE id_det = ? ORDER BY nom_shag',
        [sourcePlanId]
    );
    if (sourceSteps.length === 0) return 0;
    const stepIdMap = new Map();
    for (const step of sourceSteps) {
        const newStepId = generateId('SHG');
        await db.run(
            'INSERT INTO shagi_marshruta (id_shag, id_det, nom_shag, exec_shag, comm_shag, id_tipa_perevozki) VALUES (?,?,?,?,?,?)',
            [newStepId, targetPlanId, step.nom_shag, step.exec_shag, step.comm_shag, step.id_tipa_perevozki]
        );
        stepIdMap.set(step.id_shag, newStepId);
    }
    let copiedOps = 0;
    const sourceOps = await db.all(`
        SELECT o.id_shag, o.naim_oper
        FROM operatsii_marshruta o
        JOIN shagi_marshruta s ON o.id_shag = s.id_shag
        WHERE s.id_det = ?
        ORDER BY s.nom_shag, o.rowid
    `, [sourcePlanId]);
    for (const op of sourceOps) {
        const newStepId = stepIdMap.get(op.id_shag);
        if (!newStepId) continue;
        await db.run(
            'INSERT INTO operatsii_marshruta (id_oper, id_shag, naim_oper) VALUES (?,?,?)',
            [generateId('OPR'), newStepId, op.naim_oper]
        );
        copiedOps++;
    }
    console.log(`[copyPlanRoute] ✅ T85: маршрут ${sourcePlanId} скопирован на дочернюю позицию ${targetPlanId} (шагов: ${sourceSteps.length}, операций: ${copiedOps})`);
    return sourceSteps.length;
}

// ========================================================================
// ✅ T89: ПРОВЕРКА ПУБЛИЧНОЙ ССЫЛКИ НА ДОКУМЕНТАЦИЮ (поле «Ссылка», zUrl)
// Сервер проходит по публичной ссылке Яндекс.Диска, получает перечень файлов
// (включая вложенные папки) и ПРОБНО скачивает КАЖДЫЙ (Range-GET 2 байта).
// Сами файлы НЕ сохраняются — только факт возможности загрузить. Прочие
// https-ссылки проверяются как одиночный файл/архив (прямая проба).
// ========================================================================
const http = require('http');
const https = require('https');

const CHECK_URL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CHECK_URL_FILE_TIMEOUT_MS = 15000;    // ожидание ответа файлового сервера (T92: вернули 15 с — недокачки добивает перезапрос)
const CHECK_URL_FIRST_BYTE_MS = 12000;      // ожидание первого байта после заголовков (T92: вернули 12 с — страхует перезапрос)
const CHECK_URL_MAX_FILES = 200;            // максимум файлов в перечне
const CHECK_URL_TOTAL_BUDGET_MS = 120000;   // общий бюджет проверки (мс)
const CHECK_URL_CONCURRENCY = 6;            // параллельных проб скачивания
// ✅ T92: автоперезапрос файла при транзиентном сбое (итого до 2 попыток);
// по опыту T91 «сервер не ответил»/обрывы нестабильны — на следующем запросе
// тот же файл скачивается, поэтому пробуем ещё раз свежей ссылкой скачивания
const CHECK_URL_RETRIES = 1;
// транзиентные ошибки (подзависание/обрыв Яндекса) — повод для перезапроса;
// реальные ошибки файла (HTTP 4xx/5xx, HTML вместо файла, битые редиректы)
// НЕ перезапрашиваются
const CHECK_URL_TRANSIENT_RE = /сервер не ответил|Таймаут соединения|не начал передачу файла|соединение оборвано|ошибка сети|закрыл соединение, не передав файл|ошибка при передаче файла/;
// ✅ T91: таймауты проверки увеличены (файловый 15 -> 30 с, первый байт 12 -> 20 с):
// при повторных прогонах одной ссылки «Таймаут 15 с» появлялся на разных файлах —
// сервер Яндекса периодически подзависает; общий бюджет (120 с) НЕ менялся.
// публичные ссылки Яндекс.Диска (перечень файлов доступен через API)
const CHECK_URL_YANDEX_HOST_RE = /(^|\.)(yandex\.ru|yadi\.sk)$/i;

// GET с таймаутом БЕЗ следования редиректам (редиректы — в probe вручную);
// resolve(response-стрим) или reject(Ошибка с понятным текстом)
function checkUrlFetch(urlStr, headers, timeoutMs, opts) {
    return new Promise((resolve, reject) => {
        let urlObj;
        try { urlObj = new URL(urlStr); } catch (e) {
            return reject(new Error('Некорректный URL: ' + urlStr));
        }
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
            return reject(new Error('Поддерживаются только http/https ссылки'));
        }
        const mod = urlObj.protocol === 'http:' ? http : https;
        // ✅ T97-fix1: опциональные method/body (docviewer API принимает
        // только POST; все прежние вызовы продолжают слать GET)
        const method = (opts && opts.method) || 'GET';
        const req = mod.request(urlObj, { method, headers });
        if (opts && opts.body) req.write(opts.body);
        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(arg);
        };
        const timer = setTimeout(() => {
            req.destroy();
            finish(reject, new Error('Таймаут ' + Math.round(timeoutMs / 1000) + ' с — сервер не ответил'));
        }, timeoutMs);
        req.on('error', (e) => {
            const msg = (e && e.message === 'timeout') ? 'Таймаут соединения' : ((e && e.message) || 'ошибка сети');
            finish(reject, new Error(msg));
        });
        req.on('response', (res) => finish(resolve, res));
        req.end();
    });
}

// дочитать до maxBytes тела (для текстов ошибок); никогда не бросает
function checkUrlReadSmall(res, maxBytes) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
            size += c.length;
            chunks.push(c);
            if (size >= maxBytes) { try { res.destroy(); } catch (e) { /* ignore */ } }
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(Buffer.concat(chunks)));
        res.on('close', () => resolve(Buffer.concat(chunks)));
    });
}

// ПРОБА скачивания: Range-GET первых 2 байт, до 5 редиректов, ожидание
// первого байта тела. ok=true — файл реально НАЧАЛ передаваться; иначе
// error с причиной (таймаут/обрыв/HTTP-код/HTML вместо файла).
async function checkUrlProbeDownload(href) {
    let url = href;
    for (let hop = 0; hop < 6; hop++) {
        let res;
        try {
            res = await checkUrlFetch(url, {
                'User-Agent': CHECK_URL_UA,
                'Accept': '*/*',
                'Range': 'bytes=0-1',
            }, CHECK_URL_FILE_TIMEOUT_MS);
        } catch (e) {
            return { ok: false, error: e.message };
        }
        const st = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(st) && res.headers.location) {
            res.resume();
            try { url = new URL(res.headers.location, url).toString(); } catch (e) {
                return { ok: false, httpCode: st, error: 'некорректное перенаправление' };
            }
            continue;
        }
        const contentType = String(res.headers['content-type'] || '');
        const contentRange = String(res.headers['content-range'] || '');
        const contentLength = res.headers['content-length'];
        const mTotal = contentRange.match(/\/(\d+)\s*$/);
        const total = mTotal ? parseInt(mTotal[1], 10)
            : (contentLength != null && !isNaN(parseInt(contentLength, 10)) ? parseInt(contentLength, 10) : null);
        if (st !== 200 && st !== 206) {
            let bodyTxt = '';
            try { bodyTxt = (await checkUrlReadSmall(res, 2048)).toString('utf-8'); } catch (e) { /* ignore */ }
            const short = bodyTxt.replace(/\s+/g, ' ').trim().slice(0, 140);
            return { ok: false, httpCode: st, error: 'HTTP ' + st + (short ? ' — ' + short : '') };
        }
        if (st === 200 && /text\/html/i.test(contentType)) {
            res.resume();
            return { ok: false, httpCode: st, error: 'вместо файла вернулась HTML-страница' };
        }
        // ждём первый байт (или честный конец — пустой файл)
        const verdict = await new Promise((resolve) => {
            let got = 0;
            let finished = false;
            const finish = (ok2, err) => {
                if (finished) return;
                finished = true;
                clearTimeout(t);
                try { res.destroy(); } catch (e) { /* ignore */ }
                resolve({ ok: ok2, err });
            };
            const t = setTimeout(() => finish(false, 'Таймаут — сервер не начал передачу файла'), CHECK_URL_FIRST_BYTE_MS);
            res.on('data', () => finish(true, null));
            res.on('end', () => { if (!finished) finish(got > 0 || total === 0, got > 0 || total === 0 ? null : 'сервер закрыл соединение, не передав файл'); });
            res.on('aborted', () => finish(got > 0, got > 0 ? null : 'соединение оборвано до начала передачи файла'));
            res.on('error', (e) => finish(got > 0, got > 0 ? null : ('ошибка при передаче файла: ' + ((e && e.message) || e))));
        });
        return verdict.ok
            ? { ok: true, httpCode: st, total }
            : { ok: false, httpCode: st, total, error: verdict.err };
    }
    return { ok: false, error: 'слишком много перенаправлений' };
}

// перечень файлов публичного ресурса Яндекс.Диска (пагинация + вложенные
// папки до глубины 2, лимит CHECK_URL_MAX_FILES). Одиночный файл — kind=file.
async function checkUrlListYandex(publicUrl) {
    const apiBase = 'https://cloud-api.yandex.net/v1/disk/public/resources';
    const files = [];
    let rootName = '';
    let kind = 'dir';
    let publicKey = '';   // ✅ T97: public_key корневого ресурса (для docviewer)
    const queue = [{ pth: '', depth: 0 }];
    while (queue.length > 0) {
        const node = queue.shift();
        let offset = 0;
        for (;;) {
            const params = new URLSearchParams({ public_key: publicUrl, limit: '200', offset: String(offset) });
            if (node.pth) params.set('path', node.pth);
            let j;
            try {
                const res = await checkUrlFetch(apiBase + '?' + params.toString(), {
                    'User-Agent': CHECK_URL_UA, 'Accept': 'application/json',
                }, CHECK_URL_FILE_TIMEOUT_MS);
                const body = await checkUrlReadSmall(res, 4 * 1024 * 1024);
                if (res.statusCode !== 200) {
                    let msg = '';
                    try { msg = JSON.parse(body.toString('utf-8')).message || ''; } catch (e) { /* ignore */ }
                    return { error: 'Яндекс.Диск API: HTTP ' + res.statusCode + (msg ? ' — ' + msg : '') };
                }
                j = JSON.parse(body.toString('utf-8'));
            } catch (e) {
                return { error: 'Яндекс.Диск API: ' + e.message };
            }
            if (!node.pth) {
                rootName = j.name || '';
                kind = j.type === 'file' ? 'file' : 'dir';
                // ✅ T97: public_key нужен, чтобы открыть zip-архив как папку
                publicKey = j.public_key || publicKey;
            }
            if (j.type === 'file') {
                // ссылка ведёт на одиночный файл (или архив)
                if (files.length < CHECK_URL_MAX_FILES) {
                    files.push({ name: j.name || 'файл', path: j.path || '', size: (j.size != null ? j.size : null) });
                }
                break;
            }
            const emb = j._embedded;
            const items = (emb && Array.isArray(emb.items)) ? emb.items : [];
            for (const it of items) {
                if (it.type === 'file') {
                    if (files.length < CHECK_URL_MAX_FILES) {
                        files.push({ name: it.name, path: it.path, size: (it.size != null ? it.size : null) });
                    }
                } else if (it.type === 'dir' && node.depth < 2 && files.length < CHECK_URL_MAX_FILES) {
                    queue.push({ pth: it.path, depth: node.depth + 1 });
                }
            }
            const received = items.length;
            if (files.length >= CHECK_URL_MAX_FILES) break;
            if (!emb || received === 0 || offset + received >= emb.total) break;
            offset += received;
        }
        if (kind !== 'dir') break;
        if (files.length >= CHECK_URL_MAX_FILES) break;
    }
    return { name: rootName, kind, files, publicKey };   // ✅ T97: + publicKey
}

// ссылка на скачивание одного файла публичного ресурса (path — внутри ресурса)
async function checkUrlGetDownloadHref(publicUrl, pathInResource) {
    const api = 'https://cloud-api.yandex.net/v1/disk/public/resources/download';
    const params = new URLSearchParams({ public_key: publicUrl });
    if (pathInResource) params.set('path', pathInResource);
    const res = await checkUrlFetch(api + '?' + params.toString(), {
        'User-Agent': CHECK_URL_UA, 'Accept': 'application/json',
    }, CHECK_URL_FILE_TIMEOUT_MS);
    const body = await checkUrlReadSmall(res, 65536);
    if (res.statusCode !== 200) {
        let msg = '';
        try {
            const je = JSON.parse(body.toString('utf-8'));
            msg = je.description || je.message || '';
        } catch (e) { /* ignore */ }
        throw new Error('не удалось получить ссылку скачивания (HTTP ' + res.statusCode + (msg ? ' — ' + msg : '') + ')');
    }
    const j = JSON.parse(body.toString('utf-8'));
    if (!j.href) throw new Error('Яндекс.Диск не вернул ссылку скачивания');
    return j.href;
}

// ========================================================================
// ✅ T97: ZIP-АРХИВ, КОТОРЫЙ НЕ СКАЧИВАЕТСЯ ЦЕЛИКОМ, НО ОТКРЫВАЕТСЯ
// КАК ПАПКА. Яндекс.Диск отдаёт битые/недогруженные архивы ошибкой
// «HTTP 500 — file IO failure: no more reliable hosts» (и в веб-интерфейсе
// скачать их нельзя), НО архив открывается для просмотра, и каждый файл
// внутри скачивается по отдельности. Проверка пользуется этим: открываем
// архив через docviewer.360.yandex.ru (там анонимная сессия выдаётся
// прямо в HTML страницы) и пробно скачиваем каждый файл внутри.
// ========================================================================
const CHECK_URL_ZIP_RE = /\.zip$/i;
const CHECK_URL_DOCVIEWER = 'https://docviewer.360.yandex.ru';

// сессия docviewer: GET страницы архива -> token + dsid (серверные)
async function checkUrlDocviewerOpen(yaPublicPath, zipName) {
    const yaUrl = 'ya-disk-public://' + yaPublicPath;
    const pageUrl = CHECK_URL_DOCVIEWER + '/?url=' + encodeURIComponent(yaUrl) +
        '&name=' + encodeURIComponent(zipName || 'archive.zip') + '&embed=slider';
    const res = await checkUrlFetch(pageUrl, {
        'User-Agent': CHECK_URL_UA,
        'Accept': 'text/html',
    }, CHECK_URL_FILE_TIMEOUT_MS);
    const body = await checkUrlReadSmall(res, 1024 * 1024);
    if (res.statusCode !== 200) {
        throw new Error('docviewer: HTTP ' + res.statusCode);
    }
    const html = body.toString('utf-8');
    const token = (html.match(/"token":"([^"]+)"/) || [])[1];
    const dsid = (html.match(/"dsid":"([^"]+)"/) || [])[1];
    if (!token || !dsid) throw new Error('docviewer не выдал сессию');
    return { token, dsid, pageUrl };
}

// вызов API docviewer (POST JSON; token/dsid — из сессии)
async function checkUrlDocviewerApi(session, method, params) {
    const url = CHECK_URL_DOCVIEWER + '/api/' + method +
        '?*=' + encodeURIComponent(session.token) +
        '&dsid=' + encodeURIComponent(session.dsid);
    const res = await checkUrlFetch(url, {
        'User-Agent': CHECK_URL_UA,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Retpath-Y': 'https://disk.360.yandex.ru/',
        'Referer': session.pageUrl,
        'Origin': 'https://docviewer.360.yandex.ru',
    }, CHECK_URL_FILE_TIMEOUT_MS, {
        // ✅ T97-fix1: POST с JSON-телом (иначе docviewer отвечает 405)
        method: 'POST',
        body: JSON.stringify(params || {}),
    });
    const body = await checkUrlReadSmall(res, 1024 * 1024);
    let j;
    try { j = JSON.parse(body.toString('utf-8')); } catch (e) {
        throw new Error('docviewer ' + method + ': некорректный ответ (HTTP ' + res.statusCode + ')');
    }
    if (res.statusCode !== 200 || j.error) {
        throw new Error('docviewer ' + method + ' (HTTP ' + res.statusCode + ((j && j.code) ? ' — ' + j.code : '') + ')');
    }
    return j.data || {};
}

// рекурсивный сбор файлов из listing docviewer (folder/file-структура);
// path — путь внутри архива от корня (он же нужен download-url как
// "//"+path)
function checkUrlCollectArchiveFiles(node, out) {
    if (!node || out.length >= CHECK_URL_MAX_FILES) return;
    if (Array.isArray(node.file)) {
        for (const f of node.file) {
            if (out.length >= CHECK_URL_MAX_FILES) return;
            if (f && f.name && f.path) {
                out.push({ name: f.name, path: f.path, size: (f.size != null ? f.size : null) });
            }
        }
    }
    if (Array.isArray(node.folder)) {
        for (const sub of node.folder) checkUrlCollectArchiveFiles(sub, out);
    }
    if (Array.isArray(node)) {
        for (const sub of node) checkUrlCollectArchiveFiles(sub, out);
    }
}

// открыть архив как папку и ПРОБНО скачать каждый файл внутри
// (yaPublicPath — "public_key:/путь.zip" внутри публичного ресурса);
// ретраи/бюджет — как в основной проверке (T92)
async function checkUrlCheckArchiveFiles(yaPublicPath, budgetEnd) {
    const out = { attempted: true, opened: false, error: null, total: 0, checked: 0, okCount: 0, failCount: 0, skipped: 0, ok: false, files: [] };
    try {
        const zipName = (yaPublicPath.split(':').pop() || '').split('/').pop() || 'archive.zip';
        const session = await checkUrlDocviewerOpen(yaPublicPath, zipName);
        const st = await checkUrlDocviewerApi(session, 'status', {});
        const lst = await checkUrlDocviewerApi(session, 'archive-listing', { fileId: st.fileId || '' });
        const inner = [];
        checkUrlCollectArchiveFiles(lst && lst.listing, inner);
        out.opened = true;
        out.total = inner.length;
        for (const f of inner) {
            if (out.files.length >= CHECK_URL_MAX_FILES) break;
            const rec = { name: f.name, path: f.path, size: f.size, checked: true, ok: false, httpCode: null, error: null, ms: null };
            if (Date.now() > budgetEnd) {
                rec.checked = false;
                rec.error = 'не проверено — превышен лимит времени';
                out.files.push(rec);
                continue;
            }
            const ts = Date.now();
            for (let attempt = 0; ; attempt++) {
                try {
                    const dl = await checkUrlDocviewerApi(session, 'download-url', { archivePath: '//' + f.path });
                    let href = dl.url || '';
                    // ./source?... — относительно маршрута /view/0/ docviewer
                    if (href.startsWith('.')) href = CHECK_URL_DOCVIEWER + '/view/0/' + href.replace(/^\.\/+/, '');
                    const probe = await checkUrlProbeDownload(href);
                    rec.ok = !!probe.ok;
                    rec.httpCode = probe.httpCode || null;
                    if (probe.total != null && rec.size == null) rec.size = probe.total;
                    if (!probe.ok) rec.error = probe.error || 'файл не загрузился';
                    rec.retried = attempt > 0;
                } catch (e) {
                    rec.ok = false;
                    rec.error = e.message;
                    rec.retried = attempt > 0;
                }
                const transient = !rec.ok && CHECK_URL_TRANSIENT_RE.test(String(rec.error || ''));
                if (rec.ok || !transient || attempt >= CHECK_URL_RETRIES || Date.now() > budgetEnd) break;
                console.log(`[check-url] T97: «${f.name}» (из архива) — ${rec.error}; перезапрос ${attempt + 1}/${CHECK_URL_RETRIES}`);
            }
            rec.ms = Date.now() - ts;
            out.files.push(rec);
        }
    } catch (e) {
        out.error = e.message;
    }
    out.checked = out.files.filter(r => r.checked).length;
    out.okCount = out.files.filter(r => r.checked && r.ok).length;
    out.failCount = out.files.filter(r => r.checked && !r.ok).length;
    out.skipped = out.files.filter(r => !r.checked).length;
    out.ok = out.opened && out.total > 0 && out.failCount === 0 && out.skipped === 0;
    return out;
}


module.exports = (db, wsManager) => ({
    // ========================================================================
    // ✅ T89: POST /api/zapros-kp/check-url  { url }
    // Проверка доступности файлов по публичной ссылке (поле «Ссылка», шаг 2).
    // Яндекс.Диск: перечень файлов (+вложенные папки) и ПРОБНОЕ скачивание
    // каждого (Range-GET 2 байта). Файлы не сохраняются. Прочие https-ссылки:
    // прямая проба одного файла/архива. Успешная проверка — 200 + { ok:true,
    // files:[{name,size,checked,ok,httpCode,error}] }; бизнес-ошибки —
    // 200 + { ok:false, error } (консоль браузера остаётся чистой).
    // ========================================================================
    async POST_CHECK_URL(req, res) {
        try {
            const body = await parseBody(req);
            const url = String((body && body.url) || '').trim();
            if (!url) return send(res, 200, { ok: false, error: 'Ссылка не заполнена' });
            let urlObj;
            try { urlObj = new URL(url); } catch (e) {
                return send(res, 200, { ok: false, error: 'Некорректная ссылка' });
            }
            if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
                return send(res, 200, { ok: false, error: 'Ссылка должна начинаться с http(s)://' });
            }

            const t0 = Date.now();
            let publicPart = null;
            let publicKey = null;   // ✅ T97: public_key ресурса (для zip-fallback)
            let files = [];
            let kind = 'file';
            let name = '';

            if (CHECK_URL_YANDEX_HOST_RE.test(urlObj.hostname)) {
                const listed = await checkUrlListYandex(url);
                if (listed.error) return send(res, 200, { ok: false, error: listed.error });
                publicPart = url;
                files = listed.files || [];
                kind = listed.kind;
                name = listed.name || '';
                publicKey = listed.publicKey || null;   // ✅ T97
            } else {
                // Не Яндекс.Диск — трактуем ссылку как одиночный файл/архив
                kind = 'file';
                name = '';
                try { name = decodeURIComponent(urlObj.pathname.split('/').pop() || ''); } catch (e) { /* ignore */ }
                if (!name) name = urlObj.hostname;
                files = [{ name, path: '', size: null }];
            }

            if (files.length === 0) {
                return send(res, 200, { ok: true, url, name, kind, total: 0, checked: 0, okCount: 0, failCount: 0, skipped: 0, files: [] });
            }

            const truncated = files.length >= CHECK_URL_MAX_FILES;
            const results = new Array(files.length);
            let nextIdx = 0;
            const budgetEnd = t0 + CHECK_URL_TOTAL_BUDGET_MS;

            const worker = async () => {
                for (;;) {
                    const i = nextIdx++;
                    if (i >= files.length) return;
                    const f = files[i];
                    const rec = { name: f.name, path: f.path, size: f.size, checked: true, ok: false, httpCode: null, error: null, ms: null };
                    if (Date.now() > budgetEnd) {
                        rec.checked = false;
                        rec.error = 'не проверено — превышен лимит времени';
                        results[i] = rec;
                        continue;
                    }
                    // ✅ T92: транзиентный сбой (таймаут/обрыв) -> перезапрос файла
                    // (свежая ссылка скачивания), максимум CHECK_URL_RETRIES раз;
                    // бюджет 120 с соблюдается — перед перезапросом перепроверяется
                    const ts = Date.now();
                    for (let attempt = 0; ; attempt++) {
                        try {
                            let href = url;
                            if (publicPart) href = await checkUrlGetDownloadHref(publicPart, f.path);
                            const probe = await checkUrlProbeDownload(href);
                            rec.ok = !!probe.ok;
                            rec.httpCode = probe.httpCode || null;
                            if (probe.total != null && rec.size == null) rec.size = probe.total;
                            if (!probe.ok) rec.error = probe.error || 'файл не загрузился';
                            rec.retried = attempt > 0;
                        } catch (e) {
                            rec.ok = false;
                            rec.error = e.message;
                            rec.retried = attempt > 0;
                        }
                        const transient = !rec.ok && CHECK_URL_TRANSIENT_RE.test(String(rec.error || ''));
                        if (rec.ok || !transient || attempt >= CHECK_URL_RETRIES || Date.now() > budgetEnd) break;
                        console.log(`[check-url] T92: «${f.name}» — ${rec.error}; перезапрос ${attempt + 1}/${CHECK_URL_RETRIES}`);
                    }
                    // ✅ T97: zip-архив целиком не скачивается — пробуем открыть
                    // его как папку (docviewer Яндекса) и проверить каждый файл
                    // внутри по отдельности; результат — в rec.zipFallback
                    if (!rec.ok && publicPart && publicKey && f.path &&
                        CHECK_URL_ZIP_RE.test(String(f.name || '')) && Date.now() <= budgetEnd) {
                        const zipPathNoPrefix = String(f.path).replace(/^disk:/, '');
                        if (zipPathNoPrefix) {
                            rec.zipFallback = await checkUrlCheckArchiveFiles(
                                publicKey + ':' + zipPathNoPrefix, budgetEnd);
                        }
                    }
                    rec.ms = Date.now() - ts;
                    results[i] = rec;
                }
            };

            const nWorkers = Math.max(1, Math.min(CHECK_URL_CONCURRENCY, files.length));
            await Promise.all(Array.from({ length: nWorkers }, worker));

            const okCount = results.filter(r => r.checked && r.ok).length;
            const failCount = results.filter(r => r.checked && !r.ok).length;
            const skipped = results.filter(r => !r.checked).length;
            send(res, 200, {
                ok: true,
                url,
                name,
                kind,
                total: results.length,
                checked: results.length - skipped,
                okCount,
                failCount,
                skipped,
                truncated,
                elapsedMs: Date.now() - t0,
                files: results,
            });
        } catch (e) {
            console.error('[zaprosKpRoutes.POST_CHECK_URL] Error:', e.message);
            send(res, 200, { ok: false, error: e.message });
        }
    },

  // ========================================================================
  // GET — список запросов КП с фильтрацией
  // ========================================================================
  // ========================================================================
    // GET — список запросов КП с фильтрацией
    // ========================================================================
    async GET(req, res, url) {
    try {
        const filters = {};
        const allowedFields = [
        'god', 'firma', 'nomer_chertezha', 'naimenovanie', 'avto_mob_det',
        'zakalka', 'ppd', 'tisnenie', 'pokrytie', 'nitrocementaciya'
        ];
        
        allowedFields.forEach(field => {
        const value = url.searchParams.get(field);
        if (value !== null && value !== '') {
            filters[field] = value;
        }
        });

        const noKp = url.searchParams.get('no_kp') === '1';

        let sql = `
        SELECT DISTINCT z.*
        FROM zapros_kp z
        LEFT JOIN kp ON z.id = kp.id_zaprosa_kp
        LEFT JOIN plan p ON kp.id_plana = p.id
        LEFT JOIN osnastka o ON p.id_osnastka = o.id
        LEFT JOIN firmy f ON kp.id_firma = f.id_firmy
        `;
        
        const params = [];
        const conditions = [];
        
        if (filters.god) { conditions.push('p.god = ?'); params.push(filters.god); }
        if (filters.firma) { conditions.push('kp.id_firma = ?'); params.push(filters.firma); }
        if (filters.nomer_chertezha) { conditions.push('o.nomer_chertezha GLOB ?'); params.push(cyrGlobPattern(filters.nomer_chertezha)); }
        if (filters.naimenovanie) { conditions.push('o.naimenovanie GLOB ?'); params.push(cyrGlobPattern(filters.naimenovanie)); }
        if (filters.avto_mob_det) { conditions.push('o.avto_mob_det GLOB ?'); params.push(cyrGlobPattern(filters.avto_mob_det)); }
        if (filters.zakalka === '1') conditions.push('o.zakalka = 1');
        if (filters.ppd === '1') conditions.push('o.ppd = 1');
        if (filters.tisnenie === '1') conditions.push('o.tisnenie = 1');
        if (filters.pokrytie === '1') conditions.push('o.pokrytie = 1');
        if (filters.nitrocementaciya === '1') conditions.push('o.nitrocementaciya = 1');

        // ✅ Фильтр "нет КП" – исключаем запросы, где уже выбраны лучшие КП
        if (noKp) {
        conditions.push(`(z.statys IS NULL OR z.statys != 'выбраны лучшие КП')`);
        }

        if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY z.data_form DESC, z.n_zaprosa DESC';
        
        const rows = await db.all(sql, params);
        send(res, 200, rows);
    } catch (e) {
        console.error('[zaprosKpRoutes.GET] Error:', e.message);
        send(res, 500, { error: e.message });
    }
    },

    // ========================================================================
    // GET_ALL_KOM_PREDL — все КП
    // ========================================================================
    async GET_ALL_KOM_PREDL(req, res) {
        try {
        const rows = await db.all('SELECT * FROM kp');
        send(res, 200, rows);
        } catch (e) {
        send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ T48: ОСНОВАНИЕ ОТ ФИРМЫ (таблица ТКПоснование)
    //   GET_OSNOVANIE — текущее основание для пары «запрос КП + фирма».
    //   Query: zaprosId (обяз.), firmaId (необяз. — тогда все фирмы запроса).
    //   Ответ: { osnovanie: {...}|null, all: [...] }
    // ========================================================================
    async GET_OSNOVANIE(req, res, url) {
        try {
        const zaprosId = url.searchParams.get('zaprosId') || '';
        const firmaId = url.searchParams.get('firmaId') || '';
        if (!zaprosId) return send(res, 400, { error: 'Не указан zaprosId' });
        let rows;
        if (firmaId) {
            rows = await db.all('SELECT * FROM "ТКПоснование" WHERE id_zaprosa_kp = ? AND id_firma = ? ORDER BY data_zagruzki DESC', [zaprosId, firmaId]);
        } else {
            rows = await db.all('SELECT * FROM "ТКПоснование" WHERE id_zaprosa_kp = ? ORDER BY data_zagruzki DESC', [zaprosId]);
        }
        send(res, 200, { osnovanie: (rows && rows[0]) || null, all: rows || [] });
        } catch (e) {
        console.error('[zaprosKpRoutes.GET_OSNOVANIE] Error:', e.message);
        send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ T48: POST_OSNOVANIE_UPLOAD — прикрепление PDF-основания фирмы.
    //   Сырая загрузка файла (как orders/upload-file): тело — байты файла,
    //   имя в query (?name=). Файл кладётся на сервер в структуру:
    //     public/запросы/<год запроса>/<номер запроса>/<мс>_<имя>.pdf
    //   Запись в ТКПоснование (ключ id_zaprosa_kp + id_firma): повторная
    //   загрузка ЗАМЕНЯЕТ документ (прежний файл удаляется с диска).
    // ========================================================================
    async POST_OSNOVANIE_UPLOAD(req, res, url) {
        try {
        const zaprosId = url.searchParams.get('zaprosId') || '';
        const firmaId = url.searchParams.get('firmaId') || '';
        const origName = url.searchParams.get('name') || 'документ.pdf';
        if (!zaprosId || !firmaId) return send(res, 400, { error: 'Не указаны zaprosId/firmaId' });

        const safe = osnovanieSafeName(origName, 'документ.pdf');
        if (!/\.pdf$/i.test(safe)) {
            return send(res, 400, { error: 'Прикреплять можно только PDF-файл' });
        }

        const zaprosRows = await db.all('SELECT id, n_zaprosa, data_form FROM zapros_kp WHERE id = ?', [zaprosId]);
        const zapros = zaprosRows && zaprosRows[0];
        if (!zapros) return send(res, 404, { error: 'Запрос КП не найден' });
        const firmaRows = await db.all('SELECT id_firmy, naimenovanie FROM firmy WHERE id_firmy = ?', [firmaId]);
        const firma = firmaRows && firmaRows[0];
        if (!firma) return send(res, 404, { error: 'Фирма не найдена' });

        // Год запроса — из data_form ('2026-10-01' или '01.10.2026')
        const m = String(zapros.data_form || '').match(/(19|20)\d{2}/);
        const god = m ? m[0] : String(new Date().getFullYear());
        const nzap = osnovanieSafeName(zapros.n_zaprosa, 'без-номера');

        const { pubDir } = osnovaniePaths();
        const dir = path.join(pubDir, 'запросы', god, nzap);
        fs.mkdirSync(dir, { recursive: true });

        const buf = await getRawBufferBody(req);
        if (!buf || !buf.length) return send(res, 400, { error: 'Пустое тело запроса' });

        // Прежний документ этой пары «запрос + фирма»: удалить файл с диска
        const prevRows = await db.all('SELECT id, ssylka FROM "ТКПоснование" WHERE id_zaprosa_kp = ? AND id_firma = ?', [zaprosId, firmaId]);
        const prev = prevRows && prevRows[0];
        if (prev && prev.ssylka) {
            try {
            const oldAbs = path.join(pubDir, String(prev.ssylka).replace(/^[/\\]+/, ''));
            if (oldAbs.startsWith(pubDir) && fs.existsSync(oldAbs)) fs.unlinkSync(oldAbs);
            } catch (e) {
            console.error('[zaprosKpRoutes.POST_OSNOVANIE_UPLOAD] Не удалось удалить старый файл:', e.message);
            }
        }

        const fname = Date.now() + '_' + safe;
        fs.writeFileSync(path.join(dir, fname), buf);
        const rel = '/запросы/' + god + '/' + nzap + '/' + fname;

        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const stamp = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

        if (prev) {
            await db.run('UPDATE "ТКПоснование" SET ssylka = ?, imya_fayla = ?, data_zagruzki = ? WHERE id = ?', [rel, safe, stamp, prev.id]);
        } else {
            await db.run('INSERT INTO "ТКПоснование" (id, id_zaprosa_kp, id_firma, ssylka, imya_fayla, data_zagruzki) VALUES (?, ?, ?, ?, ?, ?)',
            [generateId('TKPOS'), zaprosId, firmaId, rel, safe, stamp]);
        }

        console.log(`[T48] Основание прикреплено: запрос № ${zapros.n_zaprosa} (${god}), фирма «${firma.naimenovanie}» -> ${rel}`);
        send(res, 200, { ok: true, ssylka: rel, imya_fayla: safe, data_zagruzki: stamp });
        } catch (e) {
        console.error('[zaprosKpRoutes.POST_OSNOVANIE_UPLOAD] Error:', e.message);
        send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ T51: POST_SZ_SOGLAS_PREVIEW — предпросмотр текста письма
    // «Согласование заказа по запросу ТКП № …» БЕЗ обращения к порталу ЭДО
    // (по аналогии с POST_SZ_SB_PREVIEW «СЗ в СБ об отгрузке», T43).
    // Текст собирается из БД: лучшие КП выбранного запроса (kp.reshenie =
    // 'лучшее предложение') — детали, фирмы, цены, сроки; письмо правится
    // в модальном окне WYSIWYG и отправляется в POST_CREATE_SZ_SOGLAS.
    // ========================================================================
    async POST_SZ_SOGLAS_PREVIEW(req, res) {
        try {
        const d = await parseBody(req);
        const zaprosId = String(d.id_zaprosa || '').trim();
        if (!zaprosId) return send(res, 400, { error: 'Запрос КП не выбран' });

        const zaprosRows = await db.all('SELECT * FROM zapros_kp WHERE id = ?', [zaprosId]);
        const zapros = zaprosRows && zaprosRows[0];
        if (!zapros) return send(res, 404, { error: 'Запрос КП не найден' });
        // аналог «Письмо уже было создано» (T42) — у согласования свой идентификатор
        if (String(zapros.id_doc_edo || '').trim() !== '') {
            return send(res, 400, { error: 'СЗ согласования по этому запросу уже создана' });
        }

        const rows = await szSoglasCollectRows(db, zaprosId);
        if (!rows.length) {
            return send(res, 400, { error: 'Лучшие КП не выбраны: сначала нажмите «🏆 КП» (выбрать лучшие КП) для этого запроса' });
        }
        const letter = szSoglasBuildLetter(rows, zapros);
        // ✅ T52: тема письма — из настроек (config/edo.json → tema.sz_soglasovanie),
        // подстановки {номер}/{дата}/{фирмы} — чтобы пользователь видел
        // в модалке РЕАЛЬНУЮ тему, с которой будет создано письмо
        const cfgTema = edo.loadEdoConfig().tema || {};
        const temaSoglas = edo.applyTema(
            cfgTema.sz_soglasovanie || 'Согласование заказа по запросу ТКП № {номер}',
            szSoglasTemaValues(zapros, rows));
        send(res, 200, {
            ok: true,
            letter: letter,
            tema: temaSoglas,
            n_zaprosa: zapros.n_zaprosa,
            firms: Array.from(new Set(rows.map((r) => r.firma_name).filter(Boolean))),
            positions: rows.map((r) => ({
            nomer_chertezha: r.nomer_chertezha,
            osn_naimenovanie: r.osn_naimenovanie,
            firma_name: r.firma_name,
            plan_god_kolvo: r.plan_god_kolvo
            }))
        });
        } catch (e) {
        console.error('[POST_SZ_SOGLAS_PREVIEW] Error:', e.message);
        send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ T51: POST_CREATE_SZ_SOGLAS — «Создать СЗ в ЭДО» (шаг 1 страницы
    // «Внесение коммерческих предложений»). Аналог POST_CREATE_SZ_SB
    // (T42/T43), но по шаблону согласования и для ЗАПРОСА КП:
    //   - тема (krat_sod): ✅ T52 — из настроек (config/edo.json →
    //     tema.sz_soglasovanie) с подстановками {номер}/{дата}/{фирмы};
    //   - шаблон ЭДО: config/edo.json → shablon.sz_soglasovanie
    //     (дефолт 65133697 — меняется в файле настроек);
    //   - подписант: config/edo.json → podpisant.sz_soglasovanie
    //     (дефолт — «Савченко В.М.» 16385, как у СЗ в СБ об отгрузке);
    //   - текст письма: из модального окна WYSIWYG (поле letter; пустой ->
    //     автосборка szSoglasBuildLetter из лучших КП запроса);
    //   - ✅ T51-b вложения (filesave.aspx, best effort): сводная таблица КП,
    //     сам запрос в форме Excel («Заявка № …» — уже создан, не
    //     пересоздаётся) и все файлы «Основание от фирмы» (PDF) по запросу;
    //   - результат: n_sogl_avtovaz (номер СЗ, D_NOM карточки) и
    //     id_doc_edo (d_kod письма) в zapros_kp.
    // ========================================================================
    async POST_CREATE_SZ_SOGLAS(req, res) {
        try {
        const d = await parseBody(req);
        const zaprosId = String(d.id_zaprosa || '').trim();
        if (!zaprosId) return send(res, 400, { error: 'Запрос КП не выбран' });

        const zaprosRows = await db.all('SELECT * FROM zapros_kp WHERE id = ?', [zaprosId]);
        const zapros = zaprosRows && zaprosRows[0];
        if (!zapros) return send(res, 404, { error: 'Запрос КП не найден' });
        if (String(zapros.id_doc_edo || '').trim() !== '') {
            return send(res, 400, { error: 'СЗ согласования по этому запросу уже создана' });
        }

        // --- Учётные данные портала (VBA: лист «настройки», E4/E5) ---
        const cfg = edo.loadEdoConfig();
        if (!cfg.username || !cfg.password) {
            return send(res, 500, { error: 'Не заданы учётные данные портала ЭДО (config/edo.json: username, password)' });
        }
        const edoOpts = { cfg, rejectUnauthorized: cfg.reject_unauthorized };

        const toRuDate = (v) => {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
            return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v || '').trim();
        };
        const toIsoDate = (v) => {
            const s = String(v || '').trim();
            const ru = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
            if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
            const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
            return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : '';
        };

        // --- Лучшие КП запроса + текст письма (модалка WYSIWYG / автосборка) ---
        const rows = await szSoglasCollectRows(db, zaprosId);
        if (!rows.length) {
            return send(res, 400, { error: 'Лучшие КП не выбраны: сначала нажмите «🏆 КП» (выбрать лучшие КП) для этого запроса' });
        }
        const letter = String(d.letter || '').trim() !== ''
            ? String(d.letter)
            : szSoglasBuildLetter(rows, zapros);

        // --- Тема письма: ✅ T52 — из настроек (config/edo.json →
        //     tema.sz_soglasovanie) с подстановками {номер}/{дата}/{фирмы};
        //     дефолт — прежняя захардкоженная строка ---
        const kratSod = edo.applyTema(
            (cfg.tema && cfg.tema.sz_soglasovanie) || 'Согласование заказа по запросу ТКП № {номер}',
            szSoglasTemaValues(zapros, rows));

        // --- ШАГ 1: POST Create_doc_on_template.aspx (шаблон из настроек) ---
        const SZ_SOGLAS_TEMPLATE_ID = String(
            cfg.shablon && cfg.shablon.sz_soglasovanie ? cfg.shablon.sz_soglasovanie : '65133697');
        const postData = 'krat_sod=' + edo.urlEncodeWin1251(kratSod) +
            '&rd=1&data_doc=&DELO=1F010-00&privacy=D&d_kod=' + SZ_SOGLAS_TEMPLATE_ID +
            '&d_type=V01&ch_txt=1&ch_otl=1&ch_rez=0&ch_ree=1&ch_mrsh=1';
        const response = await edo.sendPostRequest(cfg.username, cfg.password,
            cfg.url + '/kisp/Create_doc_on_template.aspx', postData, edoOpts);
        // VBA: kod = Split(Split(response, "d_kod=")(1), "'")(0)
        let kod;
        try { kod = edo.parseDkodFromResponse(response); }
        catch (e) {
            return send(res, 502, { error: 'Создание СЗ согласования в ЭДО не удалось: ' + e.message });
        }

        // --- ШАГ 2: KartEdit — карточка документа, подписант из настроек
        //     (podpisant.sz_soglasovanie; дефолт «Савченко В.М.» — как у
        //     СЗ в СБ об отгрузке; значения ПОДМЕНЯЮТ то, что отдала
        //     страница карточки — там мог остаться исполнитель) ---
        const podpSoglas = (cfg.podpisant && cfg.podpisant.sz_soglasovanie) || {};
        const card = edo.createCardParams();
        try {
            await edo.kartEdit(cfg.username, cfg.password, kod, card,
            Object.assign({}, edoOpts, {
                keepSignatory: true,
                defaults: {
                PRIVACY: 'D',
                PODP: podpSoglas.PODP !== undefined ? podpSoglas.PODP : 'Савченко В.М.',
                PODP_KOD: podpSoglas.PODP_KOD !== undefined ? podpSoglas.PODP_KOD : '16385',
                O_OTV_ISP: podpSoglas.O_OTV_ISP !== undefined ? podpSoglas.O_OTV_ISP : 'Заместитель директора по производству'
                }
            }));
        } catch (e) {
            return send(res, 502, { error: 'Ошибка сохранения карточки ЭДО: ' + e.message });
        }

        // номер/дата письма карточки (VBA: card("D_NOM") / card("DATE_DOC"))
        const szNomer = String(card.D_NOM == null ? '' : card.D_NOM).trim();
        const szDataRaw = String(card.DATE_DOC == null ? '' : card.DATE_DOC).trim();
        const szDataIso = toIsoDate(szDataRaw) || szDataRaw;

        // --- ШАГ 3: ТЕКСТ письма на портал (механизм T39-B: все поля страницы) ---
        let html = '';
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            html = await edo.sendGetRequest(cfg.username, cfg.password,
            cfg.url + '/kisp/ViewShablon.aspx?mode=edit&d_kod=' + encodeURIComponent(kod), edoOpts);
            if (String(html).startsWith('{"oper": ')) {
            return send(res, 502, { error: 'ViewShablon: ' + html });
            }
            // пустая страница или не HTML — повторить (первый GET портала всегда пуст)
            if (!String(html).trim() || String(html).indexOf('<') < 0) continue;
            if (edo.collectShablonFormFields(html).length) break;
        }
        // диагностика — последний HTML страницы перед сохранением текста
        try {
            const logsDir = path.join(__dirname, '..', '..', 'logs');
            fs.mkdirSync(logsDir, { recursive: true });
            fs.writeFileSync(path.join(logsDir, 'edo_viewshablon_soglas_last.html'), String(html), 'utf8');
        } catch (e) { /* диагностика не должна ломать алгоритм */ }
        const pageFields = edo.collectShablonFormFields(html);
        if (!pageFields.length) {
            return send(res, 502, { error: 'ViewShablon: портал вернул пустую страницу после ' + maxAttempts + ' запросов (баг портала ВАЗ). Повторите позже' });
        }
        // ✅ T53: имя-отчество адресата — из строки «Уважаемый …!» ТЕЛА
        // ПИСЬМА, которое портал собрал из ШАБЛОНА для ЭТОГО документа
        // (LETTER среди полей страницы). СЗ адресуются разным людям —
        // заменяем одно и то же имя из автосборки/модалки на персональное.
        // Строки приветствия в шаблоне нет — текст остаётся как был.
        const tplLetterPair = pageFields.find((p) => String(p[0]).toUpperCase() === 'LETTER');
        const uvazhaemyi = edo.extractGreetingName(tplLetterPair ? tplLetterPair[1] : '');
        const letterFinal = uvazhaemyi ? edo.applyGreetingName(letter, uvazhaemyi) : letter;
        let letterSaved = false, letterErr = '';
        try {
            letterSaved = await edo.saveTemplateToPortal(
            kod, letterFinal, cfg.username, cfg.password,
            Object.assign({}, edoOpts, { fields: pageFields })
            );
        } catch (e) {
            letterErr = e.message;
        }
        if (!letterSaved) letterErr = letterErr || 'Портал вернул статус, отличный от 200';

        // --- ФИНАЛ: n_sogl_avtovaz (номер) и id_doc_edo (d_kod) в zapros_kp ---
        try {
            await db.run(
            'UPDATE zapros_kp SET n_sogl_avtovaz = ?, id_doc_edo = ? WHERE id = ?',
            [szNomer, kod, zaprosId]
            );
        } catch (dbErr) {
            return send(res, 500, { error: 'Ошибка при сохранении идентификатора СЗ согласования. ' + dbErr.message });
        }

        // --- ШАГ 4 (✅ T51-b): ВЛОЖЕНИЯ на портал (filesave.aspx?doc_id=) ---
        // К СЗ прикрепляются: сводная таблица КП, сам запрос в форме Excel
        // (уже создан ранее — НЕ пересоздаётся) и все файлы «Основание от
        // фирмы» (PDF) по запросу. Неудача вложения НЕ прерывает создание
        // (как в VBA: MsgBox «Ошибка при загрузке файла» — и цепочка идёт
        // дальше), проблемы собираются в ответ клиенту.
        const attachResults = [];
        try {
            const attach = await szSoglasCollectAttachments(db, zapros);
            for (const f of attach.files) {
            try {
                // ✅ T51-b: opts.fileName — на портал файл уходит под исходным
                // именем (imya_fayla «Основание…pdf»), а не с дисковым
                // префиксом-меткой времени из ТКПоснование
                const okUp = await edo.uploadFileToPortal(f.path, kod, cfg.username, cfg.password,
                Object.assign({}, edoOpts, { fileName: f.label }));
                attachResults.push({ file: f.label, ok: !!okUp,
                error: okUp ? undefined : 'портал вернул статус, отличный от 200' });
            } catch (e) {
                attachResults.push({ file: f.label, ok: false, error: e.message });
            }
            }
            for (const m of attach.missing) {
            attachResults.push({ file: m.label, ok: false, missing: true, error: m.error });
            }
        } catch (e) {
            attachResults.push({ file: '', ok: false, error: 'Ошибка сборки вложений: ' + e.message });
        }
        const attachOk = attachResults.filter((a) => a.ok).length;
        const attachFail = attachResults.length - attachOk;

        // WS: список запросов (новые поля согласования) обновится у всех клиентов
        wsManager.notifyDataChange('zapros_kp', 'update', zaprosId);

        send(res, 200, {
            ok: true,
            id_doc_edo: kod,             // d_kod письма в ЭДО (переход в ИДО)
            n_sogl_avtovaz: szNomer,     // D_NOM карточки — № согласования
            data: szDataIso,
            data_ru: toRuDate(szDataIso) || szDataRaw,
            podp: card.PODP || '',
            podp_kod: card.PODP_KOD || '',
            krat_sod: kratSod,
            letter: letterFinal,        // ✅ T53: текст с персональным приветствием
            uvazhaemyi: uvazhaemyi || '', // ✅ T53: имя-отчество, взятое из шаблона
            letter_saved: letterSaved,
            letter_error: letterErr,
            // ✅ T51-b: итог вложений (сводная + запрос Excel + основания PDF)
            attachments: {
            total: attachResults.length,
            ok: attachOk,
            failed: attachFail,
            details: attachResults
            }
        });
        } catch (e) {
        console.error('[POST_CREATE_SZ_SOGLAS] Error:', e.message);
        send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ T51: PUT_SGLAS — запись полей согласования запроса (перенесённый
    // шаг 3 «Согл. структур. подр. АВТОВАЗ», теперь шаг 2 страницы
    // «Внесение коммерческих предложений»): № письма ЭДО (id_doc_edo —
    // ручной ввод, когда письмо создавали вне системы), № согласования
    // (n_sogl_avtovaz) и решение УЗБ (statys_sogl_avtovaz).
    // ========================================================================
    async PUT_SGLAS(req, res, url) {
        try {
        const zaprosId = url.pathname.split('/')[3];
        const d = await parseBody(req);
        if (!zaprosId) return send(res, 400, { error: 'Не указан id запроса' });

        const ALLOWED = ['n_sogl_avtovaz', 'statys_sogl_avtovaz', 'id_doc_edo'];
        const sets = [];
        const params = [];
        for (const f of ALLOWED) {
            if (f in d) { sets.push(f + ' = ?'); params.push(d[f] === undefined ? '' : d[f]); }
        }
        if (!sets.length) return send(res, 400, { error: 'Нет полей согласования для обновления' });
        params.push(zaprosId);
        await db.run('UPDATE zapros_kp SET ' + sets.join(', ') + ' WHERE id = ?', params);

        wsManager.notifyDataChange('zapros_kp', 'update', zaprosId);
        const row = await db.get('SELECT id, n_zaprosa, n_sogl_avtovaz, statys_sogl_avtovaz, id_doc_edo FROM zapros_kp WHERE id = ?', [zaprosId]);
        send(res, 200, { ok: true, row });
        } catch (e) {
        console.error('[zaprosKpRoutes.PUT_SGLAS] Error:', e.message);
        send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ T51-c: POST_DELETE_SZ_SOGLAS — «Удалить СЗ» (красный крестик шага 1
    // «СЗ в ЭДО» страницы «Внесение коммерческих предложений»). Алгоритм —
    // ТОТ ЖЕ, что POST_DELETE_SZ (T47, красные крестики вкладки «Документы»):
    //   1) простой GET-запрос в систему ВАЗ
    //      https://docs.vaz.ru/document_delete.aspx?d_kod=<id>
    //      (Basic-аутентификация, как во всех запросах к порталу);
    //   2) при успехе — очистка полей СЗ в zapros_kp:
    //      n_sogl_avtovaz / id_doc_edo (решение УЗБ statys_sogl_avtovaz
    //      не трогается — это отдельное решение согласования);
    //   3) интерфейс обновляется через WS.
    // ВАЖНО: при ошибке портала БД НЕ очищается (документ остаётся и в
    // системе ВАЗ, и в базе — можно повторить попытку после восстановления
    // связи). ID берётся из БД, а не из тела запроса — защита от
    // рассинхрона интерфейса (d_kod из интерфейса только сверяется).
    // ========================================================================
    async POST_DELETE_SZ_SOGLAS(req, res) {
        try {
        const d = await parseBody(req);
        const zaprosId = String(d.id_zaprosa || '').trim();
        if (!zaprosId) return send(res, 400, { error: 'Запрос КП не выбран' });
        const zaprosRows = await db.all('SELECT id, n_sogl_avtovaz, id_doc_edo FROM zapros_kp WHERE id = ?', [zaprosId]);
        const zapros = zaprosRows && zaprosRows[0];
        if (!zapros) return send(res, 404, { error: 'Запрос КП не найден' });
        const kod = String(zapros.id_doc_edo || '').trim();
        if (kod === '') {
            return send(res, 400, { error: 'СЗ в ЭДО не создана' });
        }
        // ID из интерфейса, если передан, должен совпадать с базой
        if (d.d_kod && String(d.d_kod).trim() !== kod) {
            return send(res, 409, { error: 'ID СЗ в интерфейсе не совпадает с базой — обновите страницу (F5) и повторите' });
        }
        const cfg = edo.loadEdoConfig();
        if (!cfg.username || !cfg.password) {
            return send(res, 500, { error: 'Не заданы учётные данные портала ЭДО (config/edo.json: username, password)' });
        }
        // База docs.vaz.ru — из docs_url (https://docs.vaz.ru/main.aspx?d_kod=)
        const docsBase = String(cfg.docs_url || 'https://docs.vaz.ru/main.aspx?d_kod=').split('main.aspx')[0];
        const delUrl = docsBase + 'document_delete.aspx?d_kod=' + encodeURIComponent(kod);
        let body;
        try {
            body = await edo.sendGetRequest(cfg.username, cfg.password, delUrl,
            { rejectUnauthorized: cfg.reject_unauthorized });
        } catch (e) {
            return send(res, 502, { error: 'Ошибка соединения с системой ВАЗ: ' + e.message });
        }
        // sendGetRequest при статусе != 200 возвращает {"oper":"ERR","message":"HTTP Status N"}
        const head = String(body).slice(0, 200);
        if (/"oper":\s*"ERR"/.test(head)) {
            const st = (/HTTP Status (\d+)/.exec(head) || [])[1] || '?';
            return send(res, 502, { error: 'Система ВАЗ отказала в удалении (HTTP ' + st + '). СЗ не удалена, база не очищена' });
        }
        // диагностика — ответ портала на удаление
        try {
            const logsDir = path.join(__dirname, '..', '..', 'logs');
            fs.mkdirSync(logsDir, { recursive: true });
            fs.writeFileSync(path.join(logsDir, 'edo_document_delete_soglas_last.html'), String(body), 'utf8');
        } catch (e) { /* диагностика не должна ломать алгоритм */ }
        // Очистка полей СЗ в БД (как до создания письма); statys_sogl_avtovaz не трогается
        await db.run("UPDATE zapros_kp SET n_sogl_avtovaz = '', id_doc_edo = '' WHERE id = ?", [zaprosId]);
        // WS: список запросов (поля согласования) обновится у всех клиентов
        wsManager.notifyDataChange('zapros_kp', 'update', zaprosId);
        send(res, 200, { ok: true, d_kod: kod });
        } catch (e) {
        console.error('[POST_DELETE_SZ_SOGLAS] Error:', e.message);
        send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // GET_KOM_PREDL — КП по запросу (через buildSyntheticQuery)
    // ========================================================================
    async GET_KOM_PREDL(req, res, url) {
    try {
        const zaprosId = url.searchParams.get('zaprosId');
        const noKp = url.searchParams.get('no_kp') === '1' ? '1' : undefined;

        const { sql, params } = buildSyntheticQuery('offers.kp', {
        zaprosId,
        no_kp: noKp
        });

        const rows = await db.all(sql, params);

        // ✅ НОВОЕ: обогащаем строки флагами in_order и plan_is_child
        //   для UI-условия показа чекбокса ручного назначения лучшего КП.
        //   in_order       — позиция уже включена в заказ (poz_zakaz_dogovora)
        //   plan_is_child  — КП привязано к дочерней (разделённой) позиции
        if (Array.isArray(rows) && rows.length > 0) {
            const planIds = [...new Set(rows.map(r => r.id_plana).filter(Boolean))];
            if (planIds.length > 0) {
                const ph = planIds.map(() => '?').join(',');
                const inOrderRows = await db.all(
                    `SELECT DISTINCT id_plana FROM poz_zakaz_dogovora WHERE id_plana IN (${ph}) AND COALESCE(status_poz_zd, '') NOT IN ('отказ фирмы', 'отказ УЭБ') -- ✅ T31`,
                    planIds
                );
                const inOrderSet = new Set(inOrderRows.map(r => r.id_plana));
                const planRows = await db.all(
                    `SELECT id, is_child_plan FROM plan WHERE id IN (${ph})`,
                    planIds
                );
                const planIsChildMap = new Map(planRows.map(r => [r.id, r.is_child_plan]));
                rows.forEach(r => {
                    r.in_order = inOrderSet.has(r.id_plana) ? 1 : 0;
                    r.plan_is_child = planIsChildMap.get(r.id_plana) === 1 ? 1 : 0;
                });
            } else {
                rows.forEach(r => { r.in_order = 0; r.plan_is_child = 0; });
            }
        }

        send(res, 200, rows);
    } catch (e) {
        console.error('[zaprosKpRoutes.GET_KOM_PREDL] Error:', e.message);
        send(res, 500, { error: e.message });
    }
    },
 

    // ========================================================================
    // ✅ T78: POST_KOMPLEKT — требование запроса «все позиции изготавливаются
    //   комплектом» (не допускается разбивать партию). Хранится в колонке
    //   zapros_kp.komplekt (миграция Database.js). Страница «Внесение КП»
    //   устанавливает чекбокс «не допускается разбивать партию» из этого
    //   поля и сохраняет переключение сюда. Матрица выбора поставщика и
    //   диаграмма учитывают требование: без разбиения партии итоги по
    //   фирмам считаются по всем позициям, «Лучшее предложение» —
    //   предложение фирмы-победителя на всю партию.
    //   URL: POST /api/zapros-kp/komplekt   Body: { zaprosId, komplekt: 0|1 }
    // ========================================================================
    async POST_KOMPLEKT(req, res) {
        try {
        const d = await parseBody(req);
        const zaprosId = d.zaprosId;
        if (!zaprosId) return send(res, 400, { error: 'Не указан zaprosId' });
        const val = d.komplekt ? 1 : 0;
        await db.run('UPDATE zapros_kp SET komplekt = ? WHERE id = ?', [val, zaprosId]);
        wsManager.notifyDataChange('zapros_kp', 'update', zaprosId);
        send(res, 200, { ok: true, komplekt: val });
        } catch (e) {
        console.error('[POST_KOMPLEKT] Error:', e.message);
        send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // PUT_EMAIL_DATA — обновление email данных КП
    // ========================================================================
    async PUT_EMAIL_DATA(req, res, url) {
        try {
        const id = url.pathname.split('/')[3];
        const d = await parseBody(req);

        await db.run(`
            UPDATE kp SET email_otpravki=?, date_otpravki=?
            WHERE id=?
        `, [d.email_otpravki || '', d.date_otpravki || '', id]);

        wsManager.notifyDataChange('kp', 'update', id);
        send(res, 200, { ok: true });
        } catch (e) {
        send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ НОВОЕ: _findDogovorForFirma — автоподбор договора фирмы по диапазону
    //   лет (массовая привязка договора перенесена со страницы «Внесение КП»
    //   на этап создания запроса). Ищет договоры фирмы, год даты которых
    //   попадает в диапазон [godFrom..godTo]; из найденных берётся самый
    //   поздний по дате. Возвращает { id_dogovor, nom_dogovor, data_dogovor }
    //   или null, если договор не найден.
    // ========================================================================
    async _findDogovorForFirma(firmaId, godFrom, godTo) {
        if (!firmaId) return null;
        const conds = ['id_firmy = ?'];
        const params = [firmaId];
        if (godFrom) {
            conds.push('CAST(substr(data_dogovor, 1, 4) AS INTEGER) >= ?');
            params.push(godFrom);
        }
        if (godTo) {
            conds.push('CAST(substr(data_dogovor, 1, 4) AS INTEGER) <= ?');
            params.push(godTo);
        }
        const row = await db.get(`
            SELECT id_dogovor, nom_dogovor, data_dogovor
            FROM dogovor
            WHERE ${conds.join(' AND ')}
            ORDER BY data_dogovor DESC
            LIMIT 1
        `, params);
        return row || null;
    },

    // ========================================================================
    // ✅ НОВОЕ: разбор диапазона лет из тела запроса. Приоритет: godFrom/godTo
    //   (фильтр года со страницы «Запросы КП») → god → год даты формирования
    //   запроса (data_form). godTo по умолчанию равен godFrom.
    // ========================================================================
    _parseGodRange(d) {
        const godFrom = parseInt(d.godFrom, 10) || parseInt(d.god, 10) ||
            parseInt(String(d.data_form || '').slice(0, 4), 10) || null;
        const godTo = parseInt(d.godTo, 10) || godFrom;
        return [godFrom, godTo];
    },

    // ========================================================================
    // ✅ НОВОЕ: GET_DOGOVORY_MAP — резолв договора для КАЖДОЙ фирмы по тем же
    //   правилам, что и автопривязка при создании запроса (_parseGodRange:
    //   приоритет godFrom/godTo → god → год data_form; фильтр по году
    //   data_dogovor; из найденных — самый поздний). Используется страницей
    //   «Запросы КП», чтобы в списках «Выбранные фирмы» / «Доступные фирмы»
    //   пользователь сразу видел, какой договор попадёт в КП при создании
    //   записей.
    //   Параметры URL: godFrom, godTo (фильтр года страницы), dataForm
    //   (дата запроса — фолбэк года).
    //   Ответ:
    //     dogovory — { [id_firmy]: { id_dogovor, nom_dogovor, data_dogovor } }
    //     allById  — { [id_dogovor]: { nom_dogovor, data_dogovor } } (справочник
    //                для показа фактических договоров уже созданных КП)
    // ========================================================================
    async GET_DOGOVORY_MAP(req, res, url) {
        try {
            const [godFrom, godTo] = this._parseGodRange({
                godFrom: url.searchParams.get('godFrom') || '',
                godTo: url.searchParams.get('godTo') || '',
                god: url.searchParams.get('god') || '',
                data_form: url.searchParams.get('dataForm') || ''
            });

            const rows = await db.all(`
                SELECT id_firmy, id_dogovor, nom_dogovor, data_dogovor
                FROM dogovor
                ORDER BY data_dogovor DESC
            `);

            // Аналог CAST(substr(data_dogovor,1,4) AS INTEGER) >= / <= из
            // _findDogovorForFirma: нечисловой год не проходит фильтр.
            const yearOk = (data) => {
                const y = parseInt(String(data || '').slice(0, 4), 10);
                if (godFrom && (isNaN(y) || y < godFrom)) return false;
                if (godTo && (isNaN(y) || y > godTo)) return false;
                return true;
            };

            // Строки отсортированы по data_dogovor DESC — первый встреченный
            // договор фирмы в диапазоне и есть самый поздний (как LIMIT 1
            // в _findDogovorForFirma).
            const dogovory = {};
            const allById = {};
            for (const r of rows) {
                if (r.id_dogovor && !allById[r.id_dogovor]) {
                    allById[r.id_dogovor] = { nom_dogovor: r.nom_dogovor, data_dogovor: r.data_dogovor };
                }
                if (!r.id_firmy || dogovory[r.id_firmy]) continue;
                if (yearOk(r.data_dogovor)) {
                    dogovory[r.id_firmy] = {
                        id_dogovor: r.id_dogovor,
                        nom_dogovor: r.nom_dogovor,
                        data_dogovor: r.data_dogovor
                    };
                }
            }

            send(res, 200, { godFrom, godTo, dogovory, allById });
        } catch (e) {
            console.error('[zaprosKpRoutes.GET_DOGOVORY_MAP] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST_WITH_KP — создание запроса с КП
    // ========================================================================
    async POST_WITH_KP(req, res) {
        const d = await parseBody(req);
        
        if (!d.n_zaprosa || !d.data_form) {
        return send(res, 400, { error: 'Заполните № запроса и дату' });
        }
        if (!d.combinations || d.combinations.length === 0) {
        return send(res, 400, { error: 'Не указаны детали и фирмы' });
        }

        // ✅ T54: в рамках одного запроса не может быть позиций с одним
        //   № чертежа — проверяем весь состав создаваемого запроса
        //   (в плане дубликаты допустимы, в запросе — нет).
        const allPlanIds = [...new Set(d.combinations.map(c => c.id_plana).filter(Boolean))];
        if (allPlanIds.length > 1) {
            const ph = allPlanIds.map(() => '?').join(',');
            const dupRows = await db.all(`
                SELECT o.nomer_chertezha
                FROM plan p
                JOIN osnastka o ON p.id_osnastka = o.id
                WHERE p.id IN (${ph})
                GROUP BY UPPER(TRIM(o.nomer_chertezha))
                HAVING COUNT(DISTINCT p.id) > 1
            `, allPlanIds);
            if (dupRows.length > 0) {
                return send(res, 400, {
                    error: `🚫 В запросе не может быть позиций с одинаковым № чертежа: ${dupRows.map(r => String(r.nomer_chertezha).trim()).join(', ')}.`,
                    code: 'DUPLICATE_CHERTEZH'
                });
            }
        }

        const zaprosId = generateId('ZKP');

        // ✅ АВТОПРИВЯЗКА ДОГОВОРОВ (перенесено со страницы «Внесение КП»):
        //   для каждой фирмы запроса подбираем её договор, год которого
        //   попадает в диапазон фильтра года (godFrom..godTo), и записываем
        //   его во ВСЕ КП этой фирмы. Из найденных договоров берётся самый
        //   поздний. Если у фирмы договора по фильтру нет — id_dogovor
        //   остаётся пустым, договор можно задать персонально на странице
        //   «Внесение КП».
        const [godFrom, godTo] = this._parseGodRange(d);
        const firmaIds = [...new Set(d.combinations.map(c => c.id_firma).filter(Boolean))];
        const dogovorByFirma = new Map();
        for (const fid of firmaIds) {
            const dog = await this._findDogovorForFirma(fid, godFrom, godTo);
            if (dog) dogovorByFirma.set(fid, dog);
        }

        try {
        await db.run('BEGIN TRANSACTION');

        // ✅ ИСПРАВЛЕНО: явное указание колонок и использование id_tehnologa вместо email_tehnologa
        await db.run(`
            INSERT INTO zapros_kp (
            id, n_zaprosa, data_form, data_peredach_tehnologu, 
            id_tehnologa, kommentariy, ssylka_na_chertezh, srok_predostavleniya_kp, 
            data_otv_tehnolog, statys, date_url_update
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `, [
            zaprosId, 
            d.n_zaprosa, 
            d.data_form, 
            d.data_peredach_tehnologu || '',
            d.id_tehnologa || null, // ✅ ТЕПЕРЬ ПРАВИЛЬНО: id_tehnologa (или null)
            d.kommentariy || '',
            d.ssylka_na_chertezh || '', 
            d.srok_predostavleniya_kp || '',
            d.data_otv_tehnolog || '', 
            d.statys || 'создание', 
            d.date_url_update || ''
        ]);

        for (const combo of d.combinations) {
            const kpId = generateId('KP');
            const dog = dogovorByFirma.get(combo.id_firma);
            await db.run(`
            INSERT INTO kp (id, id_plana, id_zaprosa_kp, id_firma, id_dogovor)
            VALUES (?, ?, ?, ?, ?)
            `, [kpId, combo.id_plana, zaprosId, combo.id_firma, dog ? dog.id_dogovor : '']);
        }

        await db.run('COMMIT');
        wsManager.notifyDataChange('zapros_kp', 'add', zaprosId);
        send(res, 201, {
            id: zaprosId,
            godFrom,
            godTo,
            // ✅ Информация об автопривязке для тоста на клиенте
            dogovorInfo: firmaIds
                .filter(fid => dogovorByFirma.has(fid))
                .map(fid => ({ id_firma: fid, ...dogovorByFirma.get(fid) })),
            firmyBezDogovora: firmaIds.filter(fid => !dogovorByFirma.has(fid))
        });
        } catch (e) {
        await db.run('ROLLBACK').catch(() => {});
        
        if (e.message.includes('UNIQUE')) {
            send(res, 400, { error: 'Запрос с таким номером и датой уже существует' });
        } else {
            console.error('[POST_WITH_KP] Error:', e.message);
            send(res, 500, { error: e.message });
        }
        }
    },
    async PUT_WITH_KP(req, res, url) {
        const zaprosId = url.pathname.split('/')[3];
        const d = await parseBody(req);
        if (!d.n_zaprosa || !d.data_form) {
            return send(res, 400, { error: 'Заполните № запроса и дату' });
        }
        if (!d.combinations || d.combinations.length === 0) {
            return send(res, 400, {
                error: 'Нельзя сохранить запрос: добавьте хотя бы одну деталь и одну фирму'
            });
        }
        try {
            const currentZapros = await db.get(
                'SELECT statys FROM zapros_kp WHERE id = ?',
                [zaprosId]
            );
            const currentStatus = currentZapros?.statys || '';

            // ✅ ШАГ 1: Получаем текущий состав КП
            const existingKP = await db.all(
                'SELECT id, id_plana, id_firma FROM kp WHERE id_zaprosa_kp = ?',
                [zaprosId]
            );
            const existingKeys = new Set(
                existingKP.map(k => `${k.id_plana}|${k.id_firma}`)
            );

            // ✅ ШАГ 2: Определяем, изменился ли СОСТАВ
            const newCombinations = d.combinations.filter(c => {
                const key = `${c.id_plana}|${c.id_firma}`;
                return !existingKeys.has(key);
            });
            const removedKeys = [...existingKeys].filter(k => {
                return !d.combinations.some(c => `${c.id_plana}|${c.id_firma}` === k);
            });
            const compositionChanged = newCombinations.length > 0 || removedKeys.length > 0;

            // ✅ T54-А: БИЗНЕС-ПРАВИЛО — в рамках одного запроса не может быть
            //   позиций с одним № чертежа. Проверяем ДОБАВЛЯЕМЫЕ позиции плана:
            //   их № чертежа не должен повторяться ни среди уже входящих в
            //   запрос, ни между собой (в плане дубликаты допустимы — в
            //   запросе нет). Уже сохранённые дубли (созданные до введения
            //   правила) прочие правки не блокируют — их убирает кнопка
            //   «🧹 Очистить от дублей» на странице «Запросы КП».
            const newPlanIds = [...new Set(newCombinations.map(c => c.id_plana).filter(Boolean))];
            if (newPlanIds.length > 0) {
                const existingPlanIds = [...new Set(existingKP.map(k => k.id_plana).filter(Boolean))];
                const allPlanIds = [...new Set([...existingPlanIds, ...newPlanIds])];
                const ph = allPlanIds.map(() => '?').join(',');
                const chRows = await db.all(`
                    SELECT p.id, o.nomer_chertezha
                    FROM plan p
                    JOIN osnastka o ON p.id_osnastka = o.id
                    WHERE p.id IN (${ph})
                `, allPlanIds);
                const newPlanSet = new Set(newPlanIds);
                const byKey = new Map();
                for (const r of chRows) {
                    const key = String(r.nomer_chertezha || '').trim().toUpperCase();
                    if (!key) continue;
                    if (!byKey.has(key)) byKey.set(key, { nomer: String(r.nomer_chertezha).trim(), ids: new Set() });
                    byKey.get(key).ids.add(r.id);
                }
                const dupNomers = [];
                for (const g of byKey.values()) {
                    if (g.ids.size < 2) continue;
                    if ([...g.ids].some(id => newPlanSet.has(id))) dupNomers.push(g.nomer);
                }
                if (dupNomers.length > 0) {
                    return send(res, 400, {
                        error: `🚫 В запросе не может быть позиций с одинаковым № чертежа: ${dupNomers.join(', ')}. Добавление дубликата заблокировано. Если дубли уже сохранены в запросе — нажмите «🧹» (очистить от дублей) на странице «Запросы КП»`,
                        code: 'DUPLICATE_CHERTEZH'
                    });
                }
            }

            // ✅ T54-Б: БИЗНЕС-ПРАВИЛО — позицию запроса, по которой назначено
            //   лучшее КП (kp.reshenie = 'лучшее предложение'), удалить нельзя.
            //   Удаление позиций возможно только ДО назначения лучшего
            //   предложения. Снимите назначение лучшего КП на странице
            //   «Внесение КП», если позицию действительно нужно убрать.
            if (removedKeys.length > 0) {
                const kpIdByKey = new Map(existingKP.map(k => [`${k.id_plana}|${k.id_firma}`, k.id]));
                const removedKpIds = removedKeys.map(k => kpIdByKey.get(k)).filter(Boolean);
                if (removedKpIds.length > 0) {
                    const ph2 = removedKpIds.map(() => '?').join(',');
                    const bestRows = await db.all(`
                        SELECT o.nomer_chertezha
                        FROM kp
                        JOIN plan p ON kp.id_plana = p.id
                        JOIN osnastka o ON p.id_osnastka = o.id
                        WHERE kp.id IN (${ph2}) AND kp.reshenie = 'лучшее предложение'
                    `, removedKpIds);
                    if (bestRows.length > 0) {
                        const nomers = [...new Set(bestRows.map(r => String(r.nomer_chertezha || '').trim()))];
                        return send(res, 400, {
                            error: `🚫 Нельзя удалить позицию: по детали (№ чертежа ${nomers.join(', ')}) назначено лучшее КП. Удаление позиций возможно только до назначения лучшего предложения.`,
                            code: 'BEST_KP_ASSIGNED'
                        });
                    }
                }
            }

            // ✅ ШАГ 3: Блокируем добавление ТОЛЬКО после отправки контрагентам
            if (newCombinations.length > 0) {
                const forbiddenStatuses = [
                    'отправлено Всем контрагентам',
                    'отправлено не Всем контрагентам',
                    'выбраны лучшие КП'
                ];
                if (forbiddenStatuses.includes(currentStatus) ) {
                    return send(res, 400, {
                        error: `🚫 Нельзя добавлять новые позиции или фирмы после отправки запроса контрагентам.`,
                        code: 'CANNOT_ADD_AFTER_SEND'
                    });
                }
            }

            // ✅ ШАГ 4: Откат ТОЛЬКО если состав реально изменился
            if (compositionChanged) {
                const depsCheck = await this._checkZaprosDependencies(zaprosId);
                if (!depsCheck.ok) {
                    return send(res, 409, {
                        error: depsCheck.error,
                        code: depsCheck.code,
                        dependentZaprosy: depsCheck.dependentZaprosy
                    });
                }
                await this._autoRollbackZapros(zaprosId);
            }

            // ✅ ШАГ 5: Обновляем zapros_kp (всегда — срок, комментарий и т.д.)
            await db.run(`
                UPDATE zapros_kp SET
                n_zaprosa=?, data_form=?, data_peredach_tehnologu=?,
                id_tehnologa=?, kommentariy=?,
                ssylka_na_chertezh=?, srok_predostavleniya_kp=?,
                data_otv_tehnolog=?, statys=?, date_url_update=?
                WHERE id=?
            `, [
                d.n_zaprosa, d.data_form, d.data_peredach_tehnologu || '',
                d.id_tehnologa || null,
                d.kommentariy || '', d.ssylka_na_chertezh || '',
                d.srok_predostavleniya_kp || '', d.data_otv_tehnolog || '',
                d.statys || '', d.date_url_update || '', zaprosId
            ]);

            // ✅ ШАГ 6: Обновляем состав КП ТОЛЬКО если он изменился
            let dogovorInfo = [];
            let firmyBezDogovora = [];
            if (compositionChanged) {
                const existingMap = new Map();
                existingKP.forEach(kp => {
                    existingMap.set(`${kp.id_plana}|${kp.id_firma}`, kp.id);
                });
                const targetKeys = new Set();
                d.combinations.forEach(c => targetKeys.add(`${c.id_plana}|${c.id_firma}`));

                for (const [key, id] of existingMap) {
                    if (!targetKeys.has(key)) {
                        await db.run('DELETE FROM kp WHERE id = ?', [id]);
                    }
                }

                // ✅ АВТОПРИВЯЗКА ДОГОВОРОВ для ДОБАВЛЕННЫХ КП (перенесено со
                //   страницы «Внесение КП»): новая фирма/позиция получает свой
                //   договор по фильтру года сразу при создании. Уже существующие
                //   КП не трогаем — договор у них мог быть изменён персонально.
                const [godFrom, godTo] = this._parseGodRange(d);
                const newFirmaIds = [...new Set(d.combinations
                    .filter(c => !existingMap.has(`${c.id_plana}|${c.id_firma}`))
                    .map(c => c.id_firma).filter(Boolean))];
                const dogovorByFirma = new Map();
                for (const fid of newFirmaIds) {
                    const dog = await this._findDogovorForFirma(fid, godFrom, godTo);
                    if (dog) dogovorByFirma.set(fid, dog);
                }

                for (const combo of d.combinations) {
                    const key = `${combo.id_plana}|${combo.id_firma}`;
                    if (!existingMap.has(key)) {
                        const kpId = generateId('KP');
                        const dog = dogovorByFirma.get(combo.id_firma);
                        await db.run(`
                            INSERT INTO kp (id, id_plana, id_zaprosa_kp, id_firma, id_dogovor)
                            VALUES (?, ?, ?, ?, ?)
                        `, [kpId, combo.id_plana, zaprosId, combo.id_firma, dog ? dog.id_dogovor : '']);
                    }
                }

                dogovorInfo = newFirmaIds
                    .filter(fid => dogovorByFirma.has(fid))
                    .map(fid => ({ id_firma: fid, ...dogovorByFirma.get(fid) }));
                firmyBezDogovora = newFirmaIds.filter(fid => !dogovorByFirma.has(fid));
                // Уведомления о составе — только при изменении состава
                wsManager.notifyDataChange('kp', 'update', zaprosId);
                wsManager.notifyDataChange('plan', 'update', zaprosId);
            }

            // ✅ Уведомление о zapros_kp — ВСЕГДА (срок мог измениться)
            wsManager.notifyDataChange('zapros_kp', 'update', zaprosId);

            send(res, 200, {
                ok: true,
                compositionChanged,  // ← сообщаем клиенту, менялся ли состав,
                // ✅ Информация об автопривязке договоров добавленных КП
                //   (пустые массивы, если состав не менялся)
                dogovorInfo,
                firmyBezDogovora
            });
        } catch (e) {
            await db.run('ROLLBACK').catch(() => {});
            console.error('[PUT_WITH_KP] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },
    // ========================================================================
    // GET_STATUS — получить статус запроса (для синтетической таблицы)
    // ========================================================================
    async GET_STATUS(req, res, url) {
        try {
            const zaprosId = url.searchParams.get('zaprosId');
            if (!zaprosId) {
                return send(res, 400, { error: 'Не указан zaprosId' });
            }
            
            const { sql, params } = buildSyntheticQuery('offers.status', { zaprosId });
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[zaprosKpRoutes.GET_STATUS] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // GET_ZAPROSY — список запросов (для синтетической таблицы)
    // ========================================================================
    async GET_ZAPROSY(req, res, url) {
        try {
            const { sql, params } = buildSyntheticQuery('requests.zaprosy', {
                god: url.searchParams.get('god'),
                firma: url.searchParams.get('firma'),
                nomer_chertezha: url.searchParams.get('nomer_chertezha')
            });
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[zaprosKpRoutes.GET_ZAPROSY] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // GET_AVAILABLE_DETALIPLAN — доступные детали (для синтетической таблицы)
    // ========================================================================
    async GET_AVAILABLE_DETALIPLAN(req, res, url) {
        try {
            const { sql, params } = buildSyntheticQuery('requests.available', {
                god: url.searchParams.get('god'),
                // ✅ zaprosId вместо списков: сервер сам исключает позиции,
                // уже привязанные к этому запросу (левый список DualListBlock)
                zaprosId: url.searchParams.get('zaprosId'),
                // Обратная совместимость: старый клиент ещё шлёт excludePlanIds
                excludePlanIds: url.searchParams.get('excludePlanIds'),
                nomer_chertezha: url.searchParams.get('nomer_chertezha'),
                naimenovanie: url.searchParams.get('naimenovanie'),
                // ✅ НОВОЕ: фильтр «Авто/Моб/Дет» распространяется и на
                //    доступные детали (раньше параметр молча игнорировался)
                avto_mob_det: url.searchParams.get('avto_mob_det'),
                // ✅ Кир→Лат: hg=0 — строгий поиск без гомоглифов
                hg: url.searchParams.get('hg'),
                zakalka: url.searchParams.get('zakalka'),
                ppd: url.searchParams.get('ppd'),
                tisnenie: url.searchParams.get('tisnenie'),
                pokrytie: url.searchParams.get('pokrytie'),
                nitrocementaciya: url.searchParams.get('nitrocementaciya')
            });
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[zaprosKpRoutes.GET_AVAILABLE_DETALIPLAN] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },
    // ========================================================================
    // DELETE_WITH_KP — удаление запроса с КП
    // ========================================================================
    async DELETE_WITH_KP(req, res, url) {
        const zaprosId = url.pathname.split('/')[3];

        try {
        // 🔒 НОВОЕ: проверка зависимостей
        const depsCheck = await this._checkZaprosDependencies(zaprosId);
        if (!depsCheck.ok) {
            return send(res, 409, {
                error: depsCheck.error,
                code: depsCheck.code,
                dependentZaprosy: depsCheck.dependentZaprosy
            });
        }

        // 🔥 АВТООТКАТ перед удалением.
        // ✅ ИСПРАВЛЕНО (D2): без кэша — пропуск отката оставлял дочерние позиции
        // «зомби» после удаления запроса, а родитель навсегда оставался урезанным.
        await this._autoRollbackZapros(zaprosId, { useCache: false });

        // ✅ НОВОЕ (G4): ГАРАНТИРОВАННОЕ восстановление графиков из grafik_archive.
        // Основной поток отката восстанавливает графики корней сам, но при раннем
        // выходе («нечего откатывать», минимальный сброс) цикл графиков не
        // выполняется. Этот вызов возвращает каждой позиции запроса её график,
        // если он пуст, а в архиве есть необработанный снимок (в т.ч. снятый
        // прошлыми откатами/удалениями). Ошибки самовосстановления не срывают
        // само удаление.
        const grafikRestored = await this._restoreMissingGrafikForZapros(zaprosId);
        if (grafikRestored > 0) {
            console.log(`[DELETE_WITH_KP] ♻ Графики восстановлены из архива у ${grafikRestored} позиций`);
        }

        await db.run('BEGIN TRANSACTION');
        await db.run('DELETE FROM kp WHERE id_zaprosa_kp = ?', [zaprosId]);
        await db.run('DELETE FROM zapros_kp WHERE id = ?', [zaprosId]);
        await db.run('COMMIT');

        wsManager.notifyDataChange('zapros_kp', 'delete', zaprosId);
        send(res, 200, { ok: true });
        } catch (e) {
        await db.run('ROLLBACK').catch(() => {});
        console.error('[DELETE_WITH_KP] Error:', e.message);
        send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // PUT_KOM_PREDL — обновление одного КП (с проверкой всей цепочки детали)
    // ========================================================================
    async PUT_KOM_PREDL(req, res, url) {
        try {
            const kpId = url.pathname.split('/')[3];
            if (!kpId) return send(res, 400, { error: 'ID КП не указан' });

            // 1. Получаем данные изменяемого КП и целевой позиции плана
            const kpInfo = await db.get('SELECT id_plana, id_zaprosa_kp FROM kp WHERE id = ?', [kpId]);
            if (!kpInfo) return send(res, 404, { error: 'КП не найдено' });

            const targetPlan = await db.get('SELECT id_osnastka, god FROM plan WHERE id = ?', [kpInfo.id_plana]);
            if (!targetPlan) return send(res, 404, { error: 'Позиция плана не найдена' });

            // 2. 🔥 НАХОДИМ ВСЮ ЦЕПОЧКУ этой детали (корень + все потомки)
            // ✅ T19C-FIX: раньше цепочка искалась по zapros_kp_id+id_osnastka+god,
            // но у КОРНЕВЫХ позиций plan.zapros_kp_id ПУСТ — проверка не видела
            // корень и редактирование КП «просачивалось» на деталь, уже
            // включённую в заказ (auto-откат цепочки ломал живой заказ).
            // Строим цепочку по parent_plan_id: подъём к корню + рекурсия вниз.
            let rootPlanIdP = kpInfo.id_plana;
            let curPlanP = await db.get('SELECT id, parent_plan_id FROM plan WHERE id = ?', [kpInfo.id_plana]);
            let guardP = 0;
            while (curPlanP && curPlanP.parent_plan_id && guardP < 100) {
                const parentP = await db.get('SELECT id, parent_plan_id FROM plan WHERE id = ?', [curPlanP.parent_plan_id]);
                if (!parentP) break;
                rootPlanIdP = parentP.id;
                curPlanP = parentP;
                guardP++;
            }
            const chainPlans = await db.all(`
                WITH RECURSIVE chain AS (
                    SELECT id FROM plan WHERE id = ?
                    UNION ALL
                    SELECT p.id FROM plan p INNER JOIN chain c ON p.parent_plan_id = c.id
                )
                SELECT id FROM chain
            `, [rootPlanIdP]);

            const planIds = chainPlans.map(p => p.id);
            const placeholders = planIds.map(() => '?').join(',');

            // 3. ПРОВЕРКА: попала ли ХОТЯ БЫ ОДНА позиция из этой цепочки в заказ к договору?
            const inOrderCheck = await db.get(`
                SELECT COUNT(*) as cnt 
                FROM poz_zakaz_dogovora 
                WHERE id_plana IN (${placeholders})
                  AND COALESCE(status_poz_zd, '') NOT IN ('отказ фирмы', 'отказ УЭБ') -- ✅ T31
            `, planIds);

            if (inOrderCheck.cnt > 0) {
                return send(res, 403, {
                    error: `🚫 Невозможно изменить КП!\n\nЭта деталь (или её разделенные части) уже включена в Заказ к договору.\nДля изменения КП сначала удалите позиции из заказа.`,
                    code: 'CHAIN_IN_ORDER',
                    detail: `В заказе находится позиций из цепочки: ${inOrderCheck.cnt}`
                });
            }

            // 4. Если заказов нет — разрешаем изменение и запускаем полный откат запроса.
            // ✅ ИСПРАВЛЕНО (D4): UPDATE КП + откат цепочки + сброс статуса выполняются
            // в ОДНОЙ транзакции; при ошибке отката всё отменяется и клиент получает
            // понятную ошибку вместо молчаливого «успеха» с несброшенной цепочкой.
            const d = await parseBody(req);
            console.log('[PUT_KOM_PREDL] Обновление КП:', kpId, d);

            await db.run('BEGIN TRANSACTION');
            try {
                await db.run(`
                UPDATE kp SET
                trudoemkost_postavshika=?, cena_postavshika=?, moshchnost_kolvo=?,
                srok_vipolneniya=?, tip_izgotovleniya=?, id_dogovor=?
                WHERE id=?
            `, [
                d.trudoemkost_postavshika || '',
                d.cena_postavshika || '',
                d.moshchnost_kolvo || '',
                d.srok_vipolneniya || '',
                d.tip_izgotovleniya || '',
                d.id_dogovor || '',
                kpId
            ]);

                // 🔥 АВТООТКАТ при изменении КП (схлопнет всех детей этой детали в родителя).
                // Транзакцию открывает ВЫЗЫВАЮЩИЙ (useOwnTransaction = false).
                await this._handleKPChange(kpId, { useOwnTransaction: false });

                const zRow = await db.get('SELECT statys FROM zapros_kp WHERE id = ?', [kpInfo.id_zaprosa_kp]);
                if (zRow && zRow.statys === 'выбраны лучшие КП') {
                    const notSent = await db.get(
                        `SELECT COUNT(*) AS cnt FROM kp
                        WHERE id_zaprosa_kp = ? AND (date_otpravki IS NULL OR date_otpravki = '')`,
                        [kpInfo.id_zaprosa_kp]
                    );
                    const prevStatus = (notSent && notSent.cnt > 0)
                        ? 'отправлено не Всем контрагентам'
                        : 'отправлено Всем контрагентам';
                    await db.run('UPDATE zapros_kp SET statys = ? WHERE id = ?', [prevStatus, kpInfo.id_zaprosa_kp]);
                    wsManager.notifyDataChange('zapros_kp', 'update', kpInfo.id_zaprosa_kp);
                }

                await db.run('COMMIT');
            } catch (txErr) {
                await db.run('ROLLBACK').catch(() => {});
                console.error('[PUT_KOM_PREDL] ❌ Транзакция отменена:', txErr.message);
                send(res, 409, { error: `Изменение КП не применено (откат цепочки не выполнен): ${txErr.message}` });
                return;
            }

            wsManager.notifyDataChange('kp', 'update', kpId);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[PUT_KOM_PREDL] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // POST_BEST_KP — выбор лучших КП с разделением по мощностям
    // ========================================================================
    async POST_BEST_KP(req, res) {
        try {
        const d = await parseBody(req);
        if (!d.zaprosId) return send(res, 400, { error: 'Не указан ID запроса' });

        console.log('[POST_BEST_KP] ===== НАЧАЛО =====');
        console.log('[POST_BEST_KP] zaprosId:', d.zaprosId);

        const zaprosCheck = await db.get(
            'SELECT statys, n_zaprosa, data_form FROM zapros_kp WHERE id = ?', [d.zaprosId]
        );
        if (!zaprosCheck) return send(res, 404, { error: 'Запрос не найден' });
        // ✅ T19-PARTIAL: определяем частичный режим ДО гейта и отката.
        // Частичный режим = в запросе есть КП с действующим назначением
        // «лучшее предложение» (сохранившиеся назначения после отката при
        // отказе фирмы и/или ручных назначений — их перетирать НЕЛЬЗЯ).
        const intactBestKP = await db.get(
            `SELECT id FROM kp
             WHERE id_zaprosa_kp = ? AND reshenie = 'лучшее предложение'
             LIMIT 1`,
            [d.zaprosId]
        );
        const partialMode = !!intactBestKP;

        // ✅ T19-PARTIAL: гейт ослаблен — частичный перерасчёт разрешён и для
        // «отправлено не Всем контрагентам» (после отката при отказе фирмы часть
        // КП запроса может быть не отправлена). Полный режим требует полной отправки.
        if (zaprosCheck.statys !== 'отправлено Всем контрагентам' &&
            !(partialMode && zaprosCheck.statys === 'отправлено не Всем контрагентам')) {
            return send(res, 409, {
            error: `🚫 Назначение лучших КП невалидно!\nЗапрос №${zaprosCheck.n_zaprosa} от ${zaprosCheck.data_form} имеет статус "${zaprosCheck.statys}".\nЛучшие КП выбираются только после отправки запроса ВСЕМ контрагентам.`,
            code: 'BEST_KP_REQUIRES_ALL_SENT'
            });
        }
        // 1. АВТООТКАТ перед новым выбором — ТОЛЬКО в полном режиме.
        // ✅ ИСПРАВЛЕНО (D2): без кэша — пропуск отката оставлял старых детей,
        // дети переразделялись (появлялись внуки) и количество портилось.
        // ✅ T19-PARTIAL: в частичном режиме полный откат НЕ выполняется,
        // иначе сохранившиеся (в т.ч. ручные) назначения были бы стёрты.
        if (!partialMode) {
            await this._autoRollbackZapros(d.zaprosId, { useCache: false });
        }

        // 2. Получаем все КП запроса с данными плана и оснастки
        const allKP = await db.all(`
            SELECT kp.*, 
                p.plan_god_kolvo, p.cena_pto, p.id as plan_id,
                o.trudoemkost_pto, p.god, p.id_osnastka
            FROM kp
            LEFT JOIN plan p ON kp.id_plana = p.id
            LEFT JOIN osnastka o ON p.id_osnastka = o.id
            WHERE kp.id_zaprosa_kp = ?
        `, [d.zaprosId]);

        if (allKP.length === 0) {
            return send(res, 400, { error: 'Нет КП для этого запроса' });
        }

        console.log('[POST_BEST_KP] Найдено КП:', allKP.length);

        // 3. Группируем КП по плану
        const kpByPlan = new Map();
        allKP.forEach(kp => {
            if (!kp.id_plana) return;
            if (!kpByPlan.has(kp.id_plana)) kpByPlan.set(kp.id_plana, []);
            kpByPlan.get(kp.id_plana).push(kp);
        });

        // 4. Сортировка КП по приоритету
        // ✅ T77 — критерий выбора лучшего предложения:
        //   1) ЦЕНА ЗА 1 ДЕТАЛЬ (cena_postavshika хранит стоимость одной детали);
        //      сравнивать «партию 2 шт против партии 4 шт» нельзя — у фирм разная
        //      мощность, стоимости партий несопоставимы;
        //   2) при равной цене за деталь — МЕНЬШАЯ трудоёмкость;
        //   3) далее прежние тай-брейки: тип изготовления → срок → мощность.
        const sortKP = (list) => list.sort((a, b) => {
            const gA = getGroupNum(a.tip_izgotovleniya);
            const gB = getGroupNum(b.tip_izgotovleniya);
            if (gA !== gB) return gA - gB;
            
            // ✅ T77: сравниваем ЦЕНУ ЗА 1 ДЕТАЛЬ (стоимость партии у фирм
            // разного размера — 2 шт против 4 шт — несопоставима)
            const costA = safeNum(a.cena_postavshika);
            const costB = safeNum(b.cena_postavshika);
            
            if (costA !== costB) return costA - costB; // ✅ T77: цена за 1 деталь — меньше лучше

            // ✅ T77: при равной цене за 1 деталь берём МЕНЬШУЮ трудоёмкость
            const trA = safeNum(a.trudoemkost_postavshika);
            const trB = safeNum(b.trudoemkost_postavshika);
            if (trA !== trB) return trA - trB;
            
            const pA = getTypePriority(a.tip_izgotovleniya);
            const pB = getTypePriority(b.tip_izgotovleniya);
            if (pA !== pB) return pA - pB;
            
            const tA = safeNum(a.srok_vipolneniya) || 999999999;
            const tB = safeNum(b.srok_vipolneniya) || 999999999;
            if (tA !== tB) return tA - tB;
            
            return safeNum(b.moshchnost_kolvo) - safeNum(a.moshchnost_kolvo);
        });

            // 5. Функция создания дочерней позиции плана и привязки к ней КП
            // ✅ T77: дочерняя позиция получает КП ТОЙ ФИРМЫ, чья мощность идёт на
            // эту часть количества (sourceKP). Раньше «следующее лучшее КП» искалось
            // заново БЕЗ учёта остаточной мощности: КП одной фирмы могло оказаться
            // на двух позициях плана, а мощность в копии КП не урезалась до
            // выделенного количества. Теперь мощность копии КП = выделенное
            // количество («разбиваем мощность предложения по количеству»).
            const createChildPlan = async (parentPlan, assignedQty, sourceKP, groupLabel, zaprosInfo, zaprosId) => {
                const newId = generateId('PPG');

                // 1. Имя фирмы — для блока истории в примечании
                let firmaName = 'неизвестная фирма';
                if (sourceKP && sourceKP.firma_name) {
                    firmaName = sourceKP.firma_name;
                } else if (sourceKP && sourceKP.id_firma) {
                    const fRow = await db.get('SELECT naimenovanie FROM firmy WHERE id_firmy = ?', [sourceKP.id_firma]);
                    if (fRow && fRow.naimenovanie) firmaName = fRow.naimenovanie;
                }

                let newStatPoz = parentPlan.stat_poz || '';
                let newNote;
                let splitReason = 'по мощности';
                let isNoKp = 0;

                if (sourceKP) {
                    // Формируем примечание с блоком "получено КП"
                    newNote = replaceLastNoKPWithKP(parentPlan.primechanie || '', firmaName, assignedQty, zaprosInfo);
                } else {
                    // Фирмы закончились, КП нет
                    isNoKp = 1;
                    splitReason = 'нет КП';
                    newStatPoz = 'Требуется КП';
                    newNote = addNoKPBlock(parentPlan.primechanie || '', assignedQty, zaprosInfo);
                }

                // 2. Создаем дочернюю позицию с правильными служебными полями
                // (Данные копируются из родителя, меняется только количество, статус, примечание и флаги)
                await db.run(`
                    INSERT INTO plan (
                        id, god, id_osnastka, id_kp, cena_pto, plan_god_kolvo,
                        stoim_zagot, zak_pto, data_zak, kol_fakt_got, data_yes_zagot, cex_zatrat,
                        peredel, stat_poz, plan_izgot, primechanie, n_nazv_osnovn_det_zakaza,
                        parent_plan_id, zapros_kp_id, split_group, split_reason, is_child_plan, is_no_kp_plan
                    )
                    SELECT
                        ?, god, id_osnastka, NULL, cena_pto, ?,
                        stoim_zagot, zak_pto, data_zak, kol_fakt_got, data_yes_zagot, cex_zatrat,
                        peredel, ?, plan_izgot, ?, n_nazv_osnovn_det_zakaza,
                        ?, ?, ?, ?, 1, ?
                    FROM plan WHERE id = ?
                `, [
                    newId,
                    String(assignedQty),
                    newStatPoz,
                    newNote,              // ← примечание с блоками истории
                    parentPlan.id,
                    zaprosId,
                    groupLabel,
                    splitReason,
                    isNoKp,
                    parentPlan.id
                ]);

                // ✅ T85: копируем маршрут родителя (shagi_marshruta + операции)
                // на дочернюю позицию — без шагов computePositionFlow возвращает
                // currentStep = null: позиция не попадает в «доступные позиции
                // для добавления» плана перевозок.
                await copyPlanRoute(db, parentPlan.id, newId);

                // 3. ✅ T77: создаем ровно одну запись КП, привязанную к НОВОЙ дочерней
                // позиции плана (newId) и к фирме, чья мощность распределена на эту часть
                if (sourceKP) {
                    const newKpId = generateId('KP');
                    await db.run(`
                        INSERT INTO kp (
                            id, id_plana, id_zaprosa_kp, id_firma, id_dogovor,
                            trudoemkost_postavshika, cena_postavshika, moshchnost_kolvo,
                            srok_vipolneniya, tip_izgotovleniya, reshenie, primechanie_kp,
                            date_otv, link_dok, email_otpravki, date_otpravki, isklyuchen
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        newKpId,
                        newId, // ← Привязываем к НОВОЙ дочерней позиции плана!
                        zaprosId,
                        sourceKP.id_firma,
                        sourceKP.id_dogovor || '',
                        sourceKP.trudoemkost_postavshika || '',
                        sourceKP.cena_postavshika || '',
                        String(assignedQty), // ← ✅ T77: мощность = выделенная часть количества
                        sourceKP.srok_vipolneniya || '',
                        sourceKP.tip_izgotovleniya || '',
                        'лучшее предложение', // ← Сразу помечаем как лучшее для этой части
                        'лучшее предложение по цене', // ← комментарий автоназначения
                        sourceKP.date_otv || '',
                        sourceKP.link_dok || '',
                        sourceKP.email_otpravki || '',
                        sourceKP.date_otpravki || '',
                        sourceKP.isklyuchen || ''
                    ]);
                    console.log(`[createChildPlan] ✅ Создано новое КП ${newKpId} для дочерней позиции ${newId} (Фирма: ${firmaName}, мощность ${assignedQty} шт.)`);

                    // 4. Обновляем id_kp в дочерней позиции плана,
                    // чтобы она ссылалась на только что созданное КП
                    await db.run(
                        'UPDATE plan SET id_kp = ? WHERE id = ?',
                        [newKpId, newId]
                    );
                }

                return { newId, nextKPId: sourceKP ? sourceKP.id : null, isNoKp };
            };

        // 6. Получаем инфо о запросе для примечаний
        const zapros = await db.get('SELECT n_zaprosa, data_form FROM zapros_kp WHERE id = ?', [d.zaprosId]);
        const zaprosInfo = zapros ? `Запрос №${zapros.n_zaprosa} от ${zapros.data_form}` : '';

        // 7. Обрабатываем каждый план
        let splitCount = 0;
        let assignedCount = 0;
        const bestKPPerDetail = new Map();

        // ✅ T19-PARTIAL: в частичном режиме шаг 7 (полное пересоздание назначений
        // по каждой позиции) пропускается — сохранившиеся назначения (авто и ручные)
        // не перетираются. Возникшие «дыры» (позиции без действующего КП) заполняет
        // шаг 8 (каскад с учётом мощностей).
        for (const [planId, kpList] of partialMode ? [] : kpByPlan) {
            const plan = await db.get('SELECT * FROM plan WHERE id = ?', [planId]);
            if (!plan) continue;

            const validKP = kpList.filter(kp => {
                // ✅ T19-ISKLYUCHEN: исключённые КП (отказ фирмы / ручной флаг)
                // не участвуют в назначении ни в каком режиме
                if (kp.isklyuchen === '1' || String(kp.isklyuchen || '') === '1') return false;
                const trud = safeNum(kp.trudoemkost_postavshika);
                const cena = safeNum(kp.cena_postavshika);
                return trud > 0 && cena > 0;
            });

            if (validKP.length === 0) {
                // ✅ ИСПОЛЬЗУЕМ СЛУЖЕБНЫЕ ПОЛЯ ВМЕСТО ПРИМЕЧАНИЯ
                // Создаём дочернюю позицию с флагом is_no_kp_plan = 1.
                // ✅ ИСПРАВЛЕНО (D1): маркер создаётся с количеством 0. Раньше он
                // КОПИРОВАЛ plan_god_kolvo родителя, не уменьшая самого родителя, —
                // при откате это количество прибавлялось обратно и родитель удваивался.
                // Информация о количестве сохраняется в блоке primechanie
                // («нет КП для N шт.») и в статусе родительской позиции.
                const newId = generateId('PPG');
                await db.run(`
                    INSERT INTO plan (
                        id, god, id_osnastka, id_kp, cena_pto, plan_god_kolvo,
                        stoim_zagot, zak_pto, data_zak, kol_fakt_got, data_yes_zagot, cex_zatrat,
                        peredel, stat_poz, plan_izgot, primechanie, n_nazv_osnovn_det_zakaza,
                        parent_plan_id, zapros_kp_id, split_group, split_reason, is_child_plan, is_no_kp_plan
                    )
                    SELECT
                        ?, god, id_osnastka, '', cena_pto, 0,
                        stoim_zagot, zak_pto, data_zak, kol_fakt_got, data_yes_zagot, cex_zatrat,
                        peredel, 'Нет КП. Собственное производство ПТО', plan_izgot, primechanie, n_nazv_osnovn_det_zakaza,
                        ?, ?, 'Нет КП', 'нет КП', 1, 1
                    FROM plan WHERE id = ?
                `, [
                    newId,
                    planId,             // parent_plan_id
                    d.zaprosId,         // zapros_kp_id
                    planId
                ]);
                // ✅ T85: маршрут родителя — и на маркер «нет КП» (позиция может
                // получить КП позже: ручное назначение / повторный выбор)
                await copyPlanRoute(db, planId, newId);
                splitCount++;
                continue;
            }

            const planQty = safeNum(plan.plan_god_kolvo);
            if (planQty <= 0) continue;

            sortKP(validKP);

            const grp1 = validKP.filter(kp => getGroupNum(kp.tip_izgotovleniya) === 1);
            const grp2 = validKP.filter(kp => getGroupNum(kp.tip_izgotovleniya) === 2);

            let remainingQty = planQty;
            let isFirstAssignment = true;
            const exhaustedFirmas = new Set();

            // Группа 1
            for (const kp of grp1) {
                if (remainingQty <= 0) break;
                const kpQty = safeNum(kp.moshchnost_kolvo);
                if (kpQty <= 0) continue;
                const assignedQty = Math.min(kpQty, remainingQty);
                if (isFirstAssignment) {
                    await db.run(
                        'UPDATE plan SET plan_god_kolvo = ?, id_kp = ? WHERE id = ?',
                        [String(assignedQty), kp.id, planId]
                    );
                    await db.run(
                        "UPDATE kp SET reshenie = 'лучшее предложение', primechanie_kp = 'лучшее предложение по цене' WHERE id = ?",
                        [kp.id]
                    );
                    isFirstAssignment = false;
                    const key = `${plan.id_osnastka}|${plan.god}`;
                    if (!bestKPPerDetail.has(key)) bestKPPerDetail.set(key, kp.id);
                } else {
                    // ✅ T77: дочерняя позиция получает КП фирмы (kp), чья мощность идёт на эту часть
                    const newPlanId = await createChildPlan(
                        plan, assignedQty, kp, 'Частичные операции', zaprosInfo, d.zaprosId
                    );
                    splitCount++;
                }
                exhaustedFirmas.add(kp.id_firma);
                remainingQty -= assignedQty;
                assignedCount++;
            }

            // Группа 2
            if (remainingQty > 0) {
                for (const kp of grp2) {
                    if (remainingQty <= 0) break;
                    const kpQty = safeNum(kp.moshchnost_kolvo);
                    if (kpQty <= 0) continue;
                    const assignedQty = Math.min(kpQty, remainingQty);
                    if (isFirstAssignment) {
                        await db.run(
                            'UPDATE plan SET plan_god_kolvo = ?, id_kp = ? WHERE id = ?',
                            [String(assignedQty), kp.id, planId]
                        );
                        await db.run(
                            "UPDATE kp SET reshenie = 'лучшее предложение', primechanie_kp = 'лучшее предложение по цене' WHERE id = ?",
                            [kp.id]
                        );
                        isFirstAssignment = false;
                        const key = `${plan.id_osnastka}|${plan.god}`;
                        if (!bestKPPerDetail.has(key)) bestKPPerDetail.set(key, kp.id);
                    } else {
                        // ✅ T77: дочерняя позиция получает КП фирмы (kp), чья мощность идёт на эту часть
                        const newPlanId = await createChildPlan(
                            plan, assignedQty, kp, 'Частичные операции', zaprosInfo, d.zaprosId
                        );
                        splitCount++;
                    }
                    exhaustedFirmas.add(kp.id_firma);
                    remainingQty -= assignedQty;
                    assignedCount++;
                }
            }

            // Остаток без КП — создаём позицию с флагом is_no_kp_plan = 1
            if (remainingQty > 0 && !isFirstAssignment) {
                const newId = generateId('PPG');
                
                // ✅ НОВОЕ: формируем примечание с блоком "нет КП"
                const newNote = addNoKPBlock(plan.primechanie || '', remainingQty, zaprosInfo);
                
                await db.run(`
                    INSERT INTO plan (
                        id, god, id_osnastka, id_kp, cena_pto, plan_god_kolvo,
                        stoim_zagot, zak_pto, data_zak, kol_fakt_got, data_yes_zagot, cex_zatrat,
                        peredel, stat_poz, plan_izgot, primechanie, n_nazv_osnovn_det_zakaza,
                        parent_plan_id, zapros_kp_id, split_group, split_reason, is_child_plan, is_no_kp_plan
                    )
                    SELECT 
                        ?, god, id_osnastka, NULL, cena_pto, ?,
                        stoim_zagot, zak_pto, data_zak, kol_fakt_got, data_yes_zagot, cex_zatrat,
                        peredel, 'Требуется КП', plan_izgot, ?, n_nazv_osnovn_det_zakaza,
                        ?, ?, 'Нет КП', 'нет КП', 1, 1
                    FROM plan WHERE id = ?
                `, [
                    newId,
                    String(remainingQty),
                    newNote,              // ← НОВОЕ: примечание с блоком "нет КП"
                    planId,
                    d.zaprosId,
                    planId
                ]);
                // ✅ T85: маршрут родителя — на позицию-остаток
                await copyPlanRoute(db, planId, newId);
                splitCount++;
            }
        }
        // ========================================================================
        // 8. ДОназначение: умное распределение для позиций, оставшихся без КП
        // Проверяет остаточную мощность и игнорирует фирмы с пометкой isklyuchen
        // ========================================================================
        let spreadCount = 0;

        // Находим все родительские позиции в ЭТОМ запросе, у которых нет КП
        // ✅ T19-PARTIAL: в частичном режиме доискать нужно ВСЕ позиции запроса
        // (корни — через КП запроса, т.к. plan.zapros_kp_id у корней пуст;
        // дочерние — через zapros_kp_id), у которых НЕТ действующего назначения:
        // пусто / КП удалено / КП ИСКЛЮЧЕНО (isklyuchen='1').
        const unassignedPlans = partialMode ? await db.all(`
            SELECT DISTINCT p.id, p.id_osnastka, p.god, p.plan_god_kolvo, p.primechanie, p.is_child_plan
            FROM plan p
            WHERE (
                    p.id IN (SELECT id_plana FROM kp WHERE id_zaprosa_kp = ?)
                    OR p.zapros_kp_id = ?
                  )
                  AND (
                    p.id_kp IS NULL OR p.id_kp = ''
                    OR NOT EXISTS (SELECT 1 FROM kp kx WHERE kx.id = p.id_kp)
                    OR EXISTS (SELECT 1 FROM kp kx WHERE kx.id = p.id_kp
                               AND COALESCE(kx.isklyuchen, '') = '1')
                  )
        `, [d.zaprosId, d.zaprosId]) : await db.all(`
            SELECT id, id_osnastka, god, plan_god_kolvo, primechanie, is_child_plan
            FROM plan
            WHERE zapros_kp_id = ? 
                AND (id_kp IS NULL OR id_kp = '') 
                AND is_child_plan = 0
        `, [d.zaprosId]);

        for (const p of unassignedPlans) {
            let qtyToAssign = parseFloat(p.plan_god_kolvo) || 0;
            if (qtyToAssign <= 0) continue;
            // ✅ T77: для КОРНЕВОЙ позиции вычитаем количество, уже закрытое
            // ДРУГИМИ позициями этой же детали (дочерние от прошлых разделений).
            // Иначе корень получает плановое количество ЦЕЛИКОМ поверх детей:
            // суммарно по детали выходит больше плана, а КП оказываются «не на тех»
            // позициях плана.
            if (Number(p.is_child_plan) !== 1) {
                const coveredRes = await db.get(`
                    SELECT COALESCE(SUM(CAST(x.plan_god_kolvo AS REAL)), 0) as total
                    FROM plan x
                    WHERE x.id <> ?
                      AND x.id_osnastka = ?
                      AND x.god = ?
                      AND x.id_kp IS NOT NULL AND x.id_kp <> ''
                      AND (
                            x.zapros_kp_id = ?
                            OR x.id IN (SELECT id_plana FROM kp WHERE id_zaprosa_kp = ?)
                          )
                      AND EXISTS (SELECT 1 FROM kp kx WHERE kx.id = x.id_kp
                                  AND COALESCE(kx.isklyuchen, '') <> '1')
                `, [p.id, p.id_osnastka, p.god, d.zaprosId, d.zaprosId]);
                const covered = coveredRes.total || 0;
                if (covered > 0) {
                    console.log(`[POST_BEST_KP] ✅ T77: позиция ${p.id}: ${covered} шт. уже закрыто другими позициями детали — доля корня ${qtyToAssign} → ${Math.max(0, qtyToAssign - covered)}`);
                    qtyToAssign -= covered;
                }
                if (qtyToAssign <= 0) continue;
            }

            // ✅ T19-PARTIAL: у исключённых КП этой позиции сбрасываем устаревшее
            // назначение «лучшее предложение» (позиция перераспределяется заново,
            // иначе после перерасчёта остаются два «лучших» — старое исключённое и новое)
            await db.run(`
                UPDATE kp SET reshenie = '', primechanie_kp = ''
                WHERE id_plana = ? AND reshenie = 'лучшее предложение'
                  AND COALESCE(isklyuchen, '') = '1'
            `, [p.id]);

            // 1. Получаем ВСЕ КП для этой детали в этом запросе, ИСКЛЮЧАЯ отказавшиеся
            const availableKPs = await db.all(`
                SELECT kp.*, f.naimenovanie as firma_name
                FROM kp
                LEFT JOIN firmy f ON kp.id_firma = f.id_firmy
                WHERE kp.id_zaprosa_kp = ?
                AND EXISTS (
                    SELECT 1 FROM plan p2 
                    WHERE p2.id = kp.id_plana 
                        AND p2.id_osnastka = ? 
                        AND p2.god = ?
                )
                AND COALESCE(kp.isklyuchen, '') = ''  -- 🔥 КЛЮЧЕВОЕ: игнорируем фирмы, которые отказались
            `, [d.zaprosId, p.id_osnastka, p.god]);

            // 2. Сортируем доступные КП по рейтингу
            sortKP(availableKPs);

            let isFirstForThisPlan = true;
            // ✅ T19-PARTIAL: накапливаем фирмы, уже назначенные в этом каскаде,
            // и передаём их в createChildPlan — иначе внутри он заново выбирает
            // самое дешёвое КП (ту же фирму) и назначает её сверх мощности.
            const exhaustedFirmas = new Set();

            // 3. Каскадное распределение по остаточной мощности
            for (const kp of availableKPs) {
                if (qtyToAssign <= 0) break;

                // ✅ T77: мощность фирмы учитывается ПО ДЕТАЛИ В ЦЕЛОМ — сумма
                // уже распределённого по ВСЕМ её КП этой детали (исходное + копии
                // на дочерних позициях) в рамках текущего запроса. Раньше мощность
                // считалась по ЗАПИСИ КП: одна фирма назначалась дважды (через
                // исходное КП и его копию) сверх своей мощности.
                const firmAssignedRes = await db.get(`
                    SELECT COALESCE(SUM(CAST(pp.plan_god_kolvo AS REAL)), 0) as total
                    FROM plan pp
                    JOIN kp k2 ON pp.id_kp = k2.id
                    WHERE k2.id_firma = ?
                      AND k2.id_zaprosa_kp = ?
                      AND pp.id <> ?
                      AND pp.id_osnastka = ?
                      AND pp.god = ?
                `, [kp.id_firma, d.zaprosId, p.id, p.id_osnastka, p.god]);

                const alreadyAssigned = firmAssignedRes.total || 0;
                const kpCapacity = parseFloat(kp.moshchnost_kolvo) || 0;
                const remainingCapacity = kpCapacity - alreadyAssigned;

                if (remainingCapacity <= 0) {
                    continue; // Эта фирма исчерпала лимит в этом запросе, переходим к следующей
                }

                const assignQty = Math.min(qtyToAssign, remainingCapacity);

                if (isFirstForThisPlan) {
                    // Назначаем прямо на эту позицию
                    await db.run(
                        'UPDATE plan SET plan_god_kolvo = ?, id_kp = ? WHERE id = ?',
                        [String(assignQty), kp.id, p.id]
                    );
                        //  Устанавливаем reshenie + primechanie_kp
                        await db.run(
                            'UPDATE kp SET reshenie = ?, primechanie_kp = ? WHERE id = ?',
                            ['лучшее предложение', 'лучшее предложение по цене', kp.id]
                        );
                    isFirstForThisPlan = false;
                } else {
                    // Создаем дочернюю позицию (разделение)
                    // ✅ T77: дочерняя позиция получает КП фирмы (kp), чья остаточная мощность идёт на эту часть
                    await createChildPlan(p, assignQty, kp, 'Частичные операции', zaprosInfo, d.zaprosId);
                }

                exhaustedFirmas.add(kp.id_firma);
                qtyToAssign -= assignQty;
                spreadCount++;
            }

            // 4. 🔥 ЕСЛИ ПОСЛЕ ПЕРЕБОРА ВСЕХ ФИРМ ОСТАТОК > 0 → ТРЕБУЕТСЯ ПТО
            // ✅ ИСПРАВЛЕНО (D1): дочерняя позиция-остаток создаётся ТОЛЬКО если
            // часть количества реально назначена (родитель урезан). Если ни одно
            // КП не имело свободной мощности, родитель не урезался, и создавать
            // ребёнка с полным количеством нельзя — откат удвоил бы количество.
            if (qtyToAssign > 0 && !isFirstForThisPlan) {
                const newId = generateId('PPG');
                
                // Формируем примечание с блоком "нет КП"
                const pCurrent = await db.get('SELECT primechanie FROM plan WHERE id = ?', [p.id]);
                const baseNote = pCurrent?.primechanie || `Разделено из ${p.id}`;
                // Используем нашу функцию для добавления блока, но статус будет специальным
                const newNote = addNoKPBlock(baseNote, qtyToAssign, zaprosInfo);

                await db.run(`
                    INSERT INTO plan (
                        id, god, id_osnastka, id_kp, cena_pto, plan_god_kolvo,
                        stoim_zagot, zak_pto, data_zak, kol_fakt_got, data_yes_zagot, cex_zatrat,
                        peredel, stat_poz, plan_izgot, primechanie, n_nazv_osnovn_det_zakaza,
                        parent_plan_id, zapros_kp_id, split_group, split_reason, is_child_plan, is_no_kp_plan
                    ) VALUES (
                        ?, ?, ?, NULL, ?, ?,
                        ?, ?, ?, ?, ?, ?,
                        ?, 'Требуется собственное производство ПТО', ?, ?, ?,
                        ?, ?, 'Нет КП', 'исчерпаны мощности / отказ фирм', 1, 1
                    )
                `, [
                    newId, p.god, p.id_osnastka, p.cena_pto, String(qtyToAssign),
                    p.stoim_zagot, p.zak_pto, p.data_zak, p.kol_fakt_got, p.data_yes_zagot, p.cex_zatrat,
                    p.peredel, p.plan_izgot, newNote, p.n_nazv_osnovn_det_zakaza,
                    p.id, d.zaprosId
                ]);
                // ✅ T85: маршрут родителя — на каскадную позицию-остаток
                await copyPlanRoute(db, p.id, newId);
                spreadCount++;
            } else if (qtyToAssign > 0 && isFirstForThisPlan) {
                // ✅ ИСПРАВЛЕНО (D1): ничего не назначено — родитель сохранил полное
                // количество, помечаем саму родительскую позицию без создания
                // дочерней позиции-дубликата с тем же количеством.
                await db.run(
                    "UPDATE plan SET stat_poz = 'Требуется собственное производство ПТО' WHERE id = ?",
                    [p.id]
                );
            }
        }
        // ✅ 8.5 Удаляем графики родительских позиций, которые были разделены.
            // При разделении у родителя был график на старое (полное) количество.
            // Теперь количество распределено между детьми — график родителя неактуален.
            // ✅ НОВОЕ: перед удалением строки архивируются — откат вернёт график
            // родителя из grafik_archive.
            const splitParents = await db.all(`
            SELECT DISTINCT parent_plan_id
            FROM plan
            WHERE zapros_kp_id = ? AND is_child_plan = 1 AND parent_plan_id IS NOT NULL
            `, [d.zaprosId]);
            const splitParentIds = splitParents.map(p => p.parent_plan_id);
            if (splitParentIds.length > 0) {
            const grafikBatch = 'SPLIT_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            await this._archiveGrafik(splitParentIds, grafikBatch);
            const ph = splitParentIds.map(() => '?').join(',');
            await db.run(`DELETE FROM grafik WHERE id_plana IN (${ph})`, splitParentIds);
            console.log(`[POST_BEST_KP] 🗑 Удалены графики ${splitParentIds.length} родительских позиций (заархивированы, batch ${grafikBatch})`);
            }
        // 9. Обновляем статус запроса
        await db.run(
            "UPDATE zapros_kp SET statys = 'выбраны лучшие КП' WHERE id = ?",
            [d.zaprosId]
        );

        wsManager.notifyDataChange('zapros_kp', 'update', d.zaprosId);
        wsManager.notifyDataChange('kp', 'update', d.zaprosId);
        wsManager.notifyDataChange('plan', 'update', d.zaprosId);

        console.log('[POST_BEST_KP] ===== УСПЕШНО =====');

        send(res, 200, {
            ok: true,
            assigned: assignedCount,
            split: splitCount,
            spread: spreadCount,
            // ✅ T19-PARTIAL: клиенту сообщаем режим перерасчёта
            mode: partialMode ? 'partial' : 'full',
            message: `${partialMode ? 'Частичный перерасчёт (ручные назначения сохранены)' : 'Выбор лучших КП'}: назначено ${assignedCount}. Разделено: ${splitCount}. Распространено: ${spreadCount}.`
        });
        } catch (e) {
        console.error('[POST_BEST_KP] Error:', e.message);
        console.error('[POST_BEST_KP] Stack:', e.stack);
        send(res, 500, { error: e.message });
        }
    },

    //читать сырой поток запроса, парсить JSON и конвертировать Base64 обратно в Buffer для ExcelJS
    async POST_IMPORT_EXCEL(req, res) {
        try {
            const rawBody = await new Promise((resolve, reject) => {
                let body = '';
                req.on('data', chunk => {
                    body += chunk.toString();
                    if (body.length > 1e7) {
                        reject(new Error('Файл слишком большой (лимит 10 МБ)'));
                        req.destroy();
                    }
                });
                req.on('end', () => resolve(body));
                req.on('error', reject);
            });

            const data = JSON.parse(rawBody);
            const { zaprosId, firmaId, fileBase64 } = data;

            if (!zaprosId || !firmaId) {
                return res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Не выбран запрос или фирма' }));
            }
            if (!fileBase64) {
                return res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Файл не передан' }));
            }

            const base64Data = fileBase64.split(',')[1] || fileBase64;
            const fileBuffer = Buffer.from(base64Data, 'base64');

            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(fileBuffer);
            
            const ws = workbook.getWorksheet('обменная форма');
            if (!ws) {
                return res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Лист "обменная форма" не найден' }));
            }

            console.log(`\n========== НАЧАЛО ИМПОРТА ========== `);
            console.log(`Запрос: ${zaprosId}, Фирма: ${firmaId}`);

            // Получаем все КП для этого запроса и фирмы
            const kpRecords = await db.all(`
                SELECT kp.id, kp.id_plana, kp.id_firma, kp.id_zaprosa_kp
                FROM kp
                WHERE kp.id_zaprosa_kp = ? AND kp.id_firma = ?
            `, [zaprosId, firmaId]);

            console.log(`Найдено записей КП: ${kpRecords.length}`);

            if (kpRecords.length === 0) {
                return res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Нет записей КП для выбранного запроса и фирмы' }));
            }

            // Для каждой записи КП получаем номер чертежа
            const planToChertezh = new Map();
            
            for (const kp of kpRecords) {
                const plan = await db.get(
                    'SELECT id_osnastka FROM plan WHERE id = ?',
                    [kp.id_plana]
                );
                
                if (plan) {
                    const osnastka = await db.get(
                        'SELECT nomer_chertezha FROM osnastka WHERE id = ?',
                        [plan.id_osnastka]
                    );
                    
                    if (osnastka) {
                        planToChertezh.set(kp.id_plana, osnastka.nomer_chertezha);
                    }
                }
            }

            // Парсим Excel
            let updatedCount = 0;
            let notFoundCount = 0;

            for (let row = 4; row <= ws.rowCount; row++) {
                const cellA = ws.getCell(row, 1);
                
                // Пропускаем дубликаты объединенных ячеек
                if (cellA.isMerged && cellA.master && cellA.master.address !== cellA.address) {
                    continue;
                }
                
                if (!cellA.value || typeof cellA.value !== 'string') continue;
                if (cellA.value.includes('Итого') || cellA.value.includes('НДС') || cellA.value.includes('Всего')) break;

                // Извлекаем номер чертежа
                const fullText = cellA.value.trim();
                //первым идет номер чертежа. если есть пробел то это часть номера.
                const partNumber = fullText.split(' ')[0].trim();
                // Получаем значения (с учетом формул)
                // 1. Универсальная функция получения "сырого" значения из ячейки
                const getCellValue = (cell) => {
                    // Корректная проверка на пустую ячейку (не отсеивает 0 или false!)
                    if (!cell || cell.value === null || cell.value === undefined) {
                        return '';
                    }

                    const val = cell.value;

                    // Если значение является объектом (формула, гиперссылка, форматированный текст)
                    if (typeof val === 'object') {
                        // Формула или разделяемая формула (shared formula)
                        if ('result' in val) {
                            return val.result !== undefined && val.result !== null ? val.result : '';
                        }
                        // Богатый текст (Rich Text)
                        if (val.richText && Array.isArray(val.richText)) {
                            return val.richText.map(item => item.text || '').join('');
                        }
                        // Гиперссылка
                        if (val.text !== undefined) {
                            return val.text;
                        }
                        // Дата
                        if (val instanceof Date) {
                            return val;
                        }
                        
                        // Если объект нераспознан, возвращаем пустую строку, чтобы избежать "[object Object]"
                        return '';
                    }

                    // Возвращаем примитивное значение (число, строку, булево) как есть
                    return val;
                };

                // 2. Вспомогательная функция для безопасного извлечения числа
                const getNumericValue = (cell) => {
                    const val = getCellValue(cell);
                    
                    // Если ExcelJS уже распознал число, возвращаем его сразу
                    if (typeof val === 'number') {
                        return val;
                    }
                    
                    // Если это строка, очищаем от всех пробелов (включая неразрывные) и заменяем запятую на точку
                    if (typeof val === 'string') {
                        const cleaned = val.replace(/\s/g, '').replace(',', '.');
                        const parsed = parseFloat(cleaned);
                        return isNaN(parsed) ? 0 : parsed;
                    }
                    
                    // Для пустых значений, null и т.д.
                    return 0;
                };

                // 3. Вспомогательная функция для безопасного извлечения текста
                const getTextValue = (cell) => {
                    const val = getCellValue(cell);
                    return val === null || val === undefined ? '' : String(val).trim();
                };

              // Текстовые значения
const tipIzgot = getTextValue(ws.getCell(row, 4));
const srok = getTextValue(ws.getCell(row, 5));

// Числовые значения (теперь работают стабильно независимо от формата ячейки)
const moshchnost = getNumericValue(ws.getCell(row, 6));
const trudoemkost = getNumericValue(ws.getCell(row, 10));
const stoimostDetali = getNumericValue(ws.getCell(row, 11));
                
                // ✅ Расчет цены нормо-часа
                const cenaNCh = trudoemkost > 0 ? (stoimostDetali / trudoemkost) : 0;

                console.log(`\n[Строка ${row}] Чертеж: "${partNumber}"`);
                console.log(`  Трудоемкость: ${trudoemkost}, Стоимость детали: ${stoimostDetali}, Цена н/ч: ${cenaNCh.toFixed(2)}`);

                // Ищем КП по номеру чертежа
                let matchedKP = null;
                for (const [planId, chertezh] of planToChertezh.entries()) {
                    if (chertezh.trim() === partNumber) {
                        matchedKP = kpRecords.find(kp => kp.id_plana === planId);
                        break;
                    }
                }

                if (!matchedKP) {
                    console.log(`  ⚠️ Не найдено КП для чертежа "${partNumber}"`);
                    notFoundCount++;
                    continue;
                }

                console.log(`  ✅ Найдено КП: ${matchedKP.id}`);

                // ✅ Обновляем запись КП:
                  await db.run(`
                    UPDATE kp SET 
                        trudoemkost_postavshika = ?,
                        cena_postavshika = ?,      -- Это полная стоимость детали без НДС
                        moshchnost_kolvo = ?,
                        srok_vipolneniya = ?,
                        tip_izgotovleniya = ?
                    WHERE id = ?
                `, [
                    String(trudoemkost),
                    String(stoimostDetali.toFixed(2)), // Фактическая стоимость детали
                    String(moshchnost),
                    srok,
                    tipIzgot,
                    matchedKP.id
                ]);

                updatedCount++;
                console.log(`  💾 Обновлено КП ${matchedKP.id}`);
            }

            console.log(`\n========== ИТОГИ: Обновлено: ${updatedCount}, Не найдено: ${notFoundCount} ==========\n`);

            wsManager.notifyDataChange('kp', 'bulk_update', zaprosId);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                ok: true, 
                message: `Импорт завершен. Обновлено: ${updatedCount}. Не найдено: ${notFoundCount}.` 
            }));

        } catch (e) {
            console.error('[POST_IMPORT_EXCEL] Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Ошибка при обработке файла: ' + e.message }));
        }
    },

    // ========================================================================
    // ✅ НОВОЕ: POST_MANUAL_BEST_KP — ручное назначение лучшего КП для одной позиции
    //   URL: POST /api/kom-predl/manual-best
    //   Тело: { kpId, primechanieKp, onlyComment?: true }
    //
    //   Режимы:
    //     1) Полное назначение (по умолчанию):
    //        - Проверки: статус "выбраны лучшие КП", КП на корневом плане,
    //          цепочка позиции не в заказе
    //        - Транзакция: _autoRollbackPlanChain → UPDATE plan SET id_kp →
    //          UPDATE kp SET reshenie + primechanie_kp
    //     2) onlyComment=true: обновить ТОЛЬКО комментарий ручного ЛКП
    //        - Без отката цепочки, без изменения reshenie/plan.id_kp
    //        - Проверки: КП существует, reshenie='лучшее предложение',
    //          primechanie_kp ≠ 'лучшее предложение по цене' (это ручное ЛКП)
    // ========================================================================
    async POST_MANUAL_BEST_KP(req, res) {
        try {
            const d = await parseBody(req);
            const kpId = d.kpId;
            if (!kpId) return send(res, 400, { error: 'Не указан ID КП' });

            // ✅ Комментарий обязателен
            const primechanieKp = (d.primechanieKp || '').trim();
            if (!primechanieKp) {
                return send(res, 400, {
                    error: 'Обязательно заполните комментарий к ручному назначению лучшего КП',
                    code: 'PRIMECHANIE_REQUIRED'
                });
            }

            // 1. Получаем КП (с reshenie и primechanie_kp для режима onlyComment)
            // ✅ T19-ISKLYUCHEN: + isklyuchen — исключённое КП нельзя назначить лучшим
            const kp = await db.get(
                'SELECT id, id_plana, id_zaprosa_kp, reshenie, primechanie_kp, isklyuchen FROM kp WHERE id = ?',
                [kpId]
            );
            if (!kp) return send(res, 404, { error: 'КП не найдено' });

            // ✅ T19-ISKLYUCHEN: исключённое из расчётов КП нельзя назначить лучшим
            // (иначе оно не попадёт в заказ: генератор пропускает исключённые КП)
            if (String(kp.isklyuchen || '') === '1') {
                return send(res, 403, {
                    error: 'КП исключено из расчётов (флаг «исключён»). Снимите исключение в карточке КП, чтобы назначить его лучшим.',
                    code: 'KP_ISKLYUCHEN'
                });
            }

            // ✅ Режим onlyComment=true — обновить только комментарий
            if (d.onlyComment === true) {
                if (kp.reshenie !== 'лучшее предложение') {
                    return send(res, 403, {
                        error: 'Невозможно обновить комментарий: КП не назначено лучшим',
                        code: 'NOT_BEST_KP'
                    });
                }
                // Это должно быть ручное ЛКП (не автоназначение)
                if (kp.primechanie_kp === 'лучшее предложение по цене') {
                    return send(res, 403, {
                        error: 'Невозможно изменить комментарий автоназначения',
                        code: 'AUTO_BEST_CANNOT_EDIT'
                    });
                }
                await db.run(
                    'UPDATE kp SET primechanie_kp = ? WHERE id = ?',
                    [primechanieKp, kpId]
                );
                console.log(`[POST_MANUAL_BEST_KP] onlyComment: обновлён комментарий КП ${kpId}`);

                wsManager.notifyDataChange('kp', 'update', kpId);
                wsManager.notifyDataChange('zapros_kp', 'update', kp.id_zaprosa_kp);

                return send(res, 200, {
                    ok: true,
                    message: 'Комментарий обновлён',
                    kpId: kpId,
                    onlyComment: true
                });
            }

            // ============ Полный режим назначения ============

            // 2. Получаем план КП
            const targetPlan = await db.get(
                `SELECT id, parent_plan_id, is_child_plan, id_osnastka, god, zapros_kp_id
                 FROM plan WHERE id = ?`,
                [kp.id_plana]
            );
            if (!targetPlan) return send(res, 404, { error: 'Позиция плана не найдена' });

            // 3. Проверка: КП должно быть на корневом плане
            if (targetPlan.is_child_plan === 1) {
                return send(res, 403, {
                    error: 'Невозможно назначить лучшее КП для дочерней (разделённой) позиции. Выберите корневую позицию детали.',
                    code: 'KP_ON_CHILD_PLAN'
                });
            }

            // 4. Проверка: запрос должен быть в статусе "выбраны лучшие КП"
            const zapros = await db.get(
                'SELECT statys, n_zaprosa, data_form FROM zapros_kp WHERE id = ?',
                [kp.id_zaprosa_kp]
            );
            if (!zapros) return send(res, 404, { error: 'Запрос КП не найден' });

            // ✅ T19-MANUAL: ручное назначение разрешено и в статусах отправки —
            // после отката при отказе фирмы статус запроса откатывается
            // («отправлено Всем/не Всем контрагентам»), но ручное назначение и
            // редактирование комментария для сохранившихся КП должны работать.
            const MANUAL_OK_STATUSES = ['выбраны лучшие КП', 'отправлено Всем контрагентам', 'отправлено не Всем контрагентам'];
            if (!MANUAL_OK_STATUSES.includes(zapros.statys)) {
                return send(res, 403, {
                    error: `Ручное назначение возможно после выбора лучших КП (статусы «выбраны лучшие КП», «отправлено Всем/не Всем контрагентам»). Текущий статус: «${zapros.statys || '—'}».`,
                    code: 'BEST_KP_NOT_DONE'
                });
            }

            // 5. Находим корень цепочки
            let rootPlanId = targetPlan.id;
            let currentPlan = targetPlan;
            let guard = 0;
            while (currentPlan.parent_plan_id && guard < 100) {
                const parent = await db.get(
                    'SELECT id, parent_plan_id FROM plan WHERE id = ?',
                    [currentPlan.parent_plan_id]
                );
                if (!parent) break;
                rootPlanId = parent.id;
                currentPlan = parent;
                guard++;
            }

            // 6. Проверка: ни одна позиция цепочки не должна быть в заказе
            // ✅ T19C-FIX: раньше цепочка искалась по zapros_kp_id+id_osnastka+god,
            // но у КОРНЕВЫХ позиций plan.zapros_kp_id ПУСТ (связь корня с запросом
            // — через kp.id_plana), поэтому проверка не видела корень и назначение
            // «просачивалось» на позицию, уже включённую в заказ (рассинхрон:
            // plan.id_kp переписывался при живой poz_zakaz_dogovora). Строим
            // цепочку по parent_plan_id (корень + все потомки), как в
            // POST_SET_ISKLYUCHEN.
            const chainPlans = await db.all(`
                WITH RECURSIVE chain AS (
                    SELECT id FROM plan WHERE id = ?
                    UNION ALL
                    SELECT p.id FROM plan p INNER JOIN chain c ON p.parent_plan_id = c.id
                )
                SELECT id FROM chain
            `, [rootPlanId]);
            const chainPlanIds = chainPlans.map(p => p.id);
            const chainPlaceholders = chainPlanIds.map(() => '?').join(',');

            const inOrderCheck = await db.get(`
                SELECT COUNT(*) as cnt
                FROM poz_zakaz_dogovora
                WHERE id_plana IN (${chainPlaceholders})
                  AND COALESCE(status_poz_zd, '') NOT IN ('отказ фирмы', 'отказ УЭБ') -- ✅ T31
            `, chainPlanIds);

            if (inOrderCheck.cnt > 0) {
                return send(res, 403, {
                    error: `🚫 Невозможно назначить лучшее КП! Эта деталь уже включена в Заказ к договору. Сначала удалите позиции из заказа.`,
                    code: 'CHAIN_IN_ORDER',
                    detail: `В заказе находится позиций из цепочки: ${inOrderCheck.cnt}`
                });
            }

            // 7. Транзакция: откат цепочки → установка выбранного КП
            console.log(`[POST_MANUAL_BEST_KP] kpId=${kpId}, planId=${kp.id_plana}, rootPlanId=${rootPlanId}, zaprosId=${kp.id_zaprosa_kp}`);

            await db.run('BEGIN TRANSACTION');
            try {
                // 7a. Откат цепочки
                await this._autoRollbackPlanChain(kp.id_plana, kp.id_zaprosa_kp, false);

                // 7b. Устанавливаем выбранное КП как лучшее
                await db.run(
                    'UPDATE plan SET id_kp = ? WHERE id = ?',
                    [kpId, rootPlanId]
                );
                await db.run(
                    "UPDATE kp SET reshenie = 'лучшее предложение', primechanie_kp = ? WHERE id = ?",
                    [primechanieKp, kpId]
                );

                await db.run('COMMIT');
                console.log('[POST_MANUAL_BEST_KP] ===== УСПЕШНО =====');
            } catch (txErr) {
                await db.run('ROLLBACK').catch(() => {});
                console.error('[POST_MANUAL_BEST_KP] Транзакция отменена:', txErr.message);
                send(res, 409, {
                    error: `Назначение не выполнено (откат цепочки не выполнен): ${txErr.message}`
                });
                return;
            }

            // 8. WS-уведомления
            wsManager.notifyDataChange('kp', 'update', kpId);
            wsManager.notifyDataChange('zapros_kp', 'update', kp.id_zaprosa_kp);
            wsManager.notifyDataChange('plan', 'update', kp.id_zaprosa_kp);

            send(res, 200, {
                ok: true,
                message: 'Назначено лучшее КП вручную',
                kpId: kpId,
                planId: rootPlanId
            });
        } catch (e) {
            console.error('[POST_MANUAL_BEST_KP] Error:', e.message);
            console.error('[POST_MANUAL_BEST_KP] Stack:', e.stack);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ T19-ISKLYUCHEN: POST_SET_ISKLYUCHEN — установить/снять флаг «исключён»
    //   URL: POST /api/kom-predl/set-isklyuchen
    //   Тело: { kpId, isklyuchen: '1' | '' }
    //
    //   Семантика:
    //     isklyuchen='1' — КП исключается из расчётов: не участвует в выборе
    //       лучших КП (авто-выбор и каскад) и не попадает в новые заказы.
    //       Если КП было назначено лучшим для своей позиции, привязка
    //       освобождается (plan.id_kp = NULL), назначение сбрасывается и
    //       статус запроса откатывается для перерасчёта (кнопка «Выбрать
    //       лучшие КП» становится активной).
    //     isklyuchen=''  — КП возвращается в расчёт (авто-восстановления
    //       назначения нет: его вернёт перерасчёт или ручное назначение).
    // ========================================================================
    async POST_SET_ISKLYUCHEN(req, res) {
        try {
            const d = await parseBody(req);
            const kpId = d.kpId;
            if (!kpId) return send(res, 400, { error: 'Не указан ID КП' });
            const newVal = (d.isklyuchen === '1' || d.isklyuchen === 1) ? '1' : '';

            const kp = await db.get(
                'SELECT id, id_plana, id_zaprosa_kp, reshenie, primechanie_kp, isklyuchen FROM kp WHERE id = ?',
                [kpId]
            );
            if (!kp) return send(res, 404, { error: 'КП не найдено' });

            const oldVal = String(kp.isklyuchen || '') === '1' ? '1' : '';
            if (oldVal === newVal) {
                return send(res, 200, {
                    ok: true,
                    noop: true,
                    isklyuchen: newVal,
                    message: newVal === '1' ? 'КП уже исключено из расчётов' : 'КП уже участвует в расчёте'
                });
            }

            const planRow = await db.get(
                'SELECT id, parent_plan_id, id_osnastka, god, id_kp FROM plan WHERE id = ?',
                [kp.id_plana]
            );
            if (!planRow) return send(res, 404, { error: 'Позиция плана не найдена' });

            // Корень цепочки детали (позиция может быть дочерней после разделения)
            let rootId = planRow.id;
            let cur = planRow;
            let guard = 0;
            while (cur.parent_plan_id && guard < 100) {
                const parent = await db.get('SELECT id, parent_plan_id FROM plan WHERE id = ?', [cur.parent_plan_id]);
                if (!parent) break;
                rootId = parent.id;
                cur = parent;
                guard++;
            }
            const chainPlans = await db.all(`
                WITH RECURSIVE chain AS (
                    SELECT id FROM plan WHERE id = ?
                    UNION ALL
                    SELECT p.id FROM plan p INNER JOIN chain c ON p.parent_plan_id = c.id
                )
                SELECT id FROM chain
            `, [rootId]);
            const chainIds = chainPlans.map(p => p.id);
            const chainPh = chainIds.map(() => '?').join(',');
            const inOrder = await db.get(
                `SELECT COUNT(*) AS cnt FROM poz_zakaz_dogovora WHERE id_plana IN (${chainPh}) AND COALESCE(status_poz_zd, '') NOT IN ('отказ фирмы', 'отказ УЭБ') -- ✅ T31`,
                chainIds
            );
            if (inOrder.cnt > 0) {
                return send(res, 403, {
                    error: '🚫 Нельзя изменить исключение: эта деталь включена в Заказ к договору. Сначала удалите позиции из заказа.',
                    code: 'CHAIN_IN_ORDER'
                });
            }

            let freed = false;
            let newStatus = null;

            await db.run('BEGIN TRANSACTION');
            try {
                await db.run('UPDATE kp SET isklyuchen = ? WHERE id = ?', [newVal, kpId]);

                if (newVal === '1' && planRow.id_kp === kpId) {
                    // КП было назначено лучшим — освобождаем позицию, сбрасываем назначение
                    await db.run('UPDATE plan SET id_kp = NULL WHERE id = ? AND id_kp = ?', [planRow.id, kpId]);
                    await db.run("UPDATE kp SET reshenie = '', primechanie_kp = '' WHERE id = ?", [kpId]);
                    freed = true;

                    // ✅ Статус запроса откатывается для перерасчёта (аналог fix A)
                    const z = await db.get('SELECT statys FROM zapros_kp WHERE id = ?', [kp.id_zaprosa_kp]);
                    if (z && z.statys === 'выбраны лучшие КП') {
                        const notSent = await db.get(
                            `SELECT COUNT(*) AS cnt FROM kp
                             WHERE id_zaprosa_kp = ? AND (date_otpravki IS NULL OR date_otpravki = '')`,
                            [kp.id_zaprosa_kp]
                        );
                        newStatus = (notSent && notSent.cnt > 0)
                            ? 'отправлено не Всем контрагентам'
                            : 'отправлено Всем контрагентам';
                        await db.run('UPDATE zapros_kp SET statys = ? WHERE id = ?', [newStatus, kp.id_zaprosa_kp]);
                    }
                }

                await db.run('COMMIT');
            } catch (txErr) {
                await db.run('ROLLBACK').catch(() => {});
                console.error('[POST_SET_ISKLYUCHEN] Транзакция отменена:', txErr.message);
                return send(res, 409, { error: 'Изменение не применено (транзакция отменена): ' + txErr.message });
            }

            wsManager.notifyDataChange('kp', 'update', kpId);
            wsManager.notifyDataChange('plan', 'update', kp.id_zaprosa_kp);
            if (newStatus) wsManager.notifyDataChange('zapros_kp', 'update', kp.id_zaprosa_kp);

            const message = newVal === '1'
                ? (freed
                    ? 'КП исключено из расчётов. Позиция освобождена, статус запроса откатен — запустите «Выбрать лучшие КП».'
                    : 'КП исключено из расчётов (не будет участвовать в выборе лучших КП и в заказах).')
                : 'КП возвращено в расчёт.';

            console.log(`[POST_SET_ISKLYUCHEN] КП ${kpId}: isklyuchen=${newVal}, freed=${freed}, newStatus=${newStatus}`);
            send(res, 200, { ok: true, kpId, isklyuchen: newVal, freed, newStatus, message });
        } catch (e) {
            console.error('[POST_SET_ISKLYUCHEN] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ НОВОЕ: POST_EXPORT_SUMMARY — экспорт сводной таблицы КП в Excel
    //   URL: POST /api/kom-predl/export-summary
    //   Тело: JSON с подготовленными на клиенте данными (rows + metadata).
    //   Сервер генерирует .xlsx через excel-service.exportSummaryTableKP()
    //   и сохраняет в public/Заявки/{baseYear}/Выбор поставщика заявка№{n}.xlsx
    //   Возвращает: { path, relativePath, fileName }
    // ========================================================================
    async POST_EXPORT_SUMMARY(req, res) {
        try {
            // Читаем тело запроса вручную (как в POST_IMPORT_EXCEL),
            // т.к. это приложение использует свой getRawBody-стиль.
            const rawBody = await new Promise((resolve, reject) => {
                let body = '';
                req.on('data', chunk => {
                    body += chunk.toString();
                    if (body.length > 1e7) {  // 10 МБ лимит
                        reject(new Error('Тело запроса слишком большое (лимит 10 МБ)'));
                        req.destroy();
                    }
                });
                req.on('end', () => resolve(body));
                req.on('error', reject);
            });

            let data;
            try {
                data = JSON.parse(rawBody);
            } catch (parseErr) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Некорректный JSON: ' + parseErr.message }));
            }

            // Минимальная валидация
            if (!data || !Array.isArray(data.rows) || data.rows.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Нет данных для экспорта (rows пуст)' }));
            }
            if (!Array.isArray(data.firmsList) || data.firmsList.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Нет фирм для экспорта' }));
            }
            if (!Array.isArray(data.baseCols) ||
                !Array.isArray(data.firmColsTpl) ||
                !Array.isArray(data.resultCols)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Некорректная конфигурация колонок' }));
            }

            // Делегируем генерацию в excel-service
            const result = await excelService.exportSummaryTableKP(data);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            console.error('[POST_EXPORT_SUMMARY] Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Ошибка генерации Excel: ' + e.message }));
        }
    },

    // ========================================================================
    // GET_KP_SUMMARY — сводная таблица КП
    // ========================================================================
    async GET_KP_SUMMARY(req, res, url) {
        try {
        const zaprosId = url.searchParams.get('zaprosId');
        if (!zaprosId) return send(res, 400, { error: 'Не указан zaprosId' });
        
        const sql = `
            SELECT 
            kp.*,
            o.nomer_chertezha,
            o.naimenovanie as osn_naimenovanie,
            p.plan_god_kolvo,
            p.cena_pto,
            p.plan_izgot,
            f.naimenovanie as firma_nazvanie,
            d.nom_dogovor
            FROM kp
            LEFT JOIN plan p ON kp.id_plana = p.id
            LEFT JOIN osnastka o ON p.id_osnastka = o.id
            LEFT JOIN firmy f ON kp.id_firma = f.id_firmy
            LEFT JOIN dogovor d ON kp.id_dogovor = d.id_dogovor
            WHERE kp.id_zaprosa_kp = ?
            ORDER BY f.naimenovanie, o.nomer_chertezha
        `;
        
        const rows = await db.all(sql, [zaprosId]);
        
        const firms = new Map();
        rows.forEach(row => {
            if (!firms.has(row.id_firma)) {
            firms.set(row.id_firma, {
                id: row.id_firma,
                name: row.firma_nazvanie,
                kp: []
            });
            }
            firms.get(row.id_firma).kp.push(row);
        });
        
        send(res, 200, {
            zaprosId,
            firms: Array.from(firms.values()),
            allKP: rows
        });
        } catch (e) {
        console.error('[GET_KP_SUMMARY] Error:', e.message);
        send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // 🗄 АРХИВ ГРАФИКОВ (grafik_archive)
    // Графики удаляются при разделении и при откате; чтобы их можно было вернуть,
    // перед каждым DELETE FROM grafik строки сохраняются в grafik_archive.
    // Payload хранится как JSON — способ не зависит от набора колонок grafik.
    // ========================================================================
    async _ensureGrafikArchive() {
        await db.run(`
        CREATE TABLE IF NOT EXISTS grafik_archive (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            id_plana TEXT,
            batch_id TEXT,
            payload TEXT,
            archived_at TEXT,
            restored INTEGER DEFAULT 0
        )
        `);
    },

    async _archiveGrafik(planIds, batchId) {
        if (!planIds || planIds.length === 0) return 0;
        await this._ensureGrafikArchive();
        const ph = planIds.map(() => '?').join(',');
        const rows = await db.all(`SELECT * FROM grafik WHERE id_plana IN (${ph})`, planIds);
        for (const row of rows) {
        await db.run(
            'INSERT INTO grafik_archive (id_plana, batch_id, payload, archived_at, restored) VALUES (?, ?, ?, ?, 0)',
            [row.id_plana, batchId, JSON.stringify(row), new Date().toISOString()]
        );
        }
        if (rows.length > 0) {
        console.log(`[GrafikArchive] 🗄 Заархивировано строк графиков: ${rows.length} (batch ${batchId})`);
        }
        return rows.length;
    },

    async _restoreGrafikArchive(planId) {
        await this._ensureGrafikArchive();

        // График можно вернуть только ЖИВОЙ позиции — не воскресаем графики для
        // уже удалённых планов (их снимки остаются в архиве как история).
        const planExists = await db.get('SELECT id FROM plan WHERE id = ?', [planId]);
        if (!planExists) return 0;

        // ✅ ИСПРАВЛЕНО (G1): снимок выбирается FIFO — самый СТАРЫЙ необработанный.
        // Раньше (ORDER BY id DESC) первым находился пакет, заархивированный самим
        // откатом строкой выше (RB_...): «восстанавливались» устаревшие строки,
        // а исходный снимок (SPLIT_...) навсегда оставался в архиве — снаружи это
        // выглядело как «восстановление графика из архива не срабатывает».
        const batchRow = await db.get(
        'SELECT batch_id FROM grafik_archive WHERE id_plana = ? AND restored = 0 ORDER BY id ASC LIMIT 1',
        [planId]
        );
        if (!batchRow) return 0;

        const rows = await db.all(
        'SELECT id, payload FROM grafik_archive WHERE id_plana = ? AND batch_id = ? AND restored = 0 ORDER BY id',
        [planId, batchRow.batch_id]
        );

        // Разрешаем только колонки, реально существующие в grafik, — расхождение
        // схем (после миграций) не должно убивать восстановление целиком.
        let grafikCols = null;
        try {
        grafikCols = (await db.all('PRAGMA table_info(grafik)')).map((c) => c.name);
        } catch (e) { /* PRAGMA недоступна — вставляем все колонки как есть */ }

        let restoredCount = 0;
        const failedIds = [];
        for (const r of rows) {
        try {
            const obj = JSON.parse(r.payload);
            let keys = Object.keys(obj);
            if (Array.isArray(grafikCols) && grafikCols.length > 0) {
            keys = keys.filter((k) => grafikCols.includes(k));
            }
            if (keys.length === 0) throw new Error('архивная строка не содержит ни одной актуальной колонки grafik');
            const ph = keys.map(() => '?').join(',');
            await db.run(
            `INSERT INTO grafik (${keys.join(',')}) VALUES (${ph})`,
            keys.map((k) => obj[k])
            );
            restoredCount++;
        } catch (e) {
            failedIds.push(r.id);
            console.warn(`[GrafikArchive] ⚠ Строка графика НЕ восстановлена (архивная запись id=${r.id} сохранена для разбора):`, e.message);
        }
        }

        // ✅ ИЗМЕНЕНО (G8): использованные снимки УДАЛЯЮТСЯ из архива — хранить
        // восстановленное больше незачем. Удаляется вся необработанная история
        // позиции (включая устаревшие промежуточные снимки), КРОМЕ строк, вставить
        // которые не удалось: они остаются в архиве и видны в логе, чтобы их можно
        // было разобрать вручную без потери данных.
        if (restoredCount > 0) {
        const failedPh = failedIds.length ? ` AND id NOT IN (${failedIds.map(() => '?').join(',')})` : '';
        await db.run(
            `DELETE FROM grafik_archive WHERE id_plana = ? AND restored = 0${failedPh}`,
            failedIds.length ? [planId, ...failedIds] : [planId]
        );
        console.log(`[GrafikArchive] ♻ Восстановлено строк графиков для ${planId}: ${restoredCount} (batch ${batchRow.batch_id}); использованные снимки удалены из архива`);
        }
        return restoredCount;
    },

    // ========================================================================
    // 🔁 САМОВОССТАНОВЛЕНИЕ ГРАФИКОВ ЗАПРОСА (G3)
    // Ищет позиции запроса, у которых график ПУСТ, а в grafik_archive лежит
    // необработанный снимок — и возвращает график. Критично для DELETE_WITH_KP:
    // откат может завершиться ранним выходом («нечего откатывать», «минимальный
    // сброс») и до цикла восстановления графиков дело не дойдёт, хотя снимок
    // в архиве есть. Метод сам глотает ошибки — не должен ломать основную
    // операцию удаления.
    // ========================================================================
    async _restoreMissingGrafikForZapros(zaprosId) {
        try {
        await this._ensureGrafikArchive();
        // ✅ НОВОЕ (G10): сначала чистим мёртвые записи (см. _purgeOrphanGrafikArchive)
        await this._purgeOrphanGrafikArchive();
        // Кандидаты — все позиции, относящиеся к запросу: напрямую
        // (plan.zapros_kp_id), через КП запроса (kp.id_plana) и корни цепочек
        // (родители детей запроса).
        const candidates = await db.all(`
            SELECT DISTINCT p.id AS id
            FROM plan p
            WHERE p.zapros_kp_id = ?
                OR p.id IN (SELECT id_plana FROM kp WHERE id_zaprosa_kp = ?)
                OR p.id IN (
                    SELECT parent_plan_id FROM plan
                    WHERE is_child_plan = 1 AND zapros_kp_id = ? AND parent_plan_id IS NOT NULL
                )
        `, [zaprosId, zaprosId, zaprosId]);

        let restoredPlans = 0;
        for (const cand of candidates) {
            const g = await db.get('SELECT COUNT(*) AS cnt FROM grafik WHERE id_plana = ?', [cand.id]);
            if (g && g.cnt > 0) continue; // график на месте
            const a = await db.get('SELECT COUNT(*) AS cnt FROM grafik_archive WHERE id_plana = ? AND restored = 0', [cand.id]);
            if (!a || a.cnt === 0) continue; // снимка нет — восстанавливать нечего
            const n = await this._restoreGrafikArchive(cand.id);
            if (n > 0) {
            restoredPlans++;
            console.log(`[GrafikArchive] ♻ [SELF-HEAL] График позиции ${cand.id} восстановлен из архива (${n} строк)`);
            }
        }
        return restoredPlans;
        } catch (e) {
        console.error('[GrafikArchive] ❌ SELF-HEAL ошибка:', e.message);
        return 0;
        }
    },

    // ========================================================================
    // 🧹 ЧИСТКА АРХИВА (G10)
    // Удаляет из grafik_archive заведомо мёртвые записи: снимки позиций,
    // которых больше нет в plan (восстановить их невозможно — план удалён),
    // и строки с restored=1, оставшиеся от прежних версий патча.
    // Архив хранит только то, что реально может быть восстановлено.
    // ========================================================================
    async _purgeOrphanGrafikArchive() {
        try {
        await db.run(`
            DELETE FROM grafik_archive
            WHERE restored = 1
            OR id_plana NOT IN (SELECT id FROM plan)
        `);
        } catch (e) {
        // чистка не должна мешать основной операции
        console.warn('[GrafikArchive] 🧹 Очистка архива не выполнена:', e.message);
        }
    },
    // ========================================================================
    // 🔧 Вспомогательный метод: сброс статусов и обнуление привязок КП
    // Вызывается как в случае "дочерних позиций нет", так и после их удаления
    // ========================================================================
    async _resetZaprosStatuses(zaprosId) {
        // ✅ ИЗМЕНЕНО: обнуляем и primechanie_kp
        await db.run("UPDATE kp SET reshenie = '', primechanie_kp = '' WHERE id_zaprosa_kp = ?", [zaprosId]);
        await db.run(`
        UPDATE plan SET id_kp = NULL
        WHERE id IN (SELECT id_plana FROM kp WHERE id_zaprosa_kp = ?)
        `, [zaprosId]);
        const z = await db.get('SELECT statys FROM zapros_kp WHERE id = ?', [zaprosId]);
        const sentStatuses = ['выбраны лучшие КП', 'отправлено Всем контрагентам', 'отправлено не Всем контрагентам'];
        if (z && sentStatuses.includes(z.statys)) {
        const notSent = await db.get(
            `SELECT COUNT(*) AS cnt FROM kp
            WHERE id_zaprosa_kp = ? AND (date_otpravki IS NULL OR date_otpravki = '')`,
            [zaprosId]
        );
        const prevStatus = (notSent && notSent.cnt > 0)
            ? 'отправлено не Всем контрагентам'
            : 'отправлено Всем контрагентам';
        await db.run('UPDATE zapros_kp SET statys = ? WHERE id = ?', [prevStatus, zaprosId]);
        }
    },

    // ========================================================================
    // 🔥 ОТКАТ ЦЕПОЧКИ КОНКРЕТНОЙ ПОЗИЦИИ (не всего запроса!)
    // Используется при изменении КП одной позиции — откатываем только её цепочку
    // ========================================================================
    async _autoRollbackPlanChain(planId, zaprosId, useOwnTransaction = true) {
        // ✅ ИСПРАВЛЕНО (D4): параметр useOwnTransaction позволяет вызвать откат
        // внутри ЧУЖОЙ транзакции (PUT_KOM_PREDL), а ошибки больше не глотаются.
        const beginTx = async () => { if (useOwnTransaction) await db.run('BEGIN TRANSACTION'); };
        const commitTx = async () => { if (useOwnTransaction) await db.run('COMMIT'); };
        const rollbackTx = async () => { if (useOwnTransaction) await db.run('ROLLBACK'); };

        try {
            console.log(`[AutoRollbackChain] ===== НАЧАЛО ===== planId: ${planId}, zaprosId: ${zaprosId}`);

            await beginTx();

            try {
                // 1. Находим саму позицию плана
                const targetPlan = await db.get(
                    'SELECT id, plan_god_kolvo, parent_plan_id, is_child_plan, zapros_kp_id FROM plan WHERE id = ?',
                    [planId]
                );

                if (!targetPlan) {
                    await rollbackTx();
                    console.log('[AutoRollbackChain] Позиция не найдена');
                    return;
                }

                // 2. Определяем корень цепочки (самый верхний родитель)
                let rootPlanId = planId;
                let currentPlan = targetPlan;
                while (currentPlan.parent_plan_id) {
                    const parent = await db.get(
                        'SELECT id, parent_plan_id FROM plan WHERE id = ?',
                        [currentPlan.parent_plan_id]
                    );
                    if (!parent) break;
                    rootPlanId = parent.id;
                    currentPlan = parent;
                }

                console.log(`[AutoRollbackChain] Корень цепочки: ${rootPlanId}`);

                // 3. Рекурсивно находим ВСЕ позиции цепочки (корень + все его дети, внуки и т.д.)
                // КРОМЕ самого корня (его не удаляем, только очищаем)
                const chainNodes = await db.all(`
                    WITH RECURSIVE chain AS (
                        SELECT id, parent_plan_id, plan_god_kolvo
                        FROM plan
                        WHERE id = ?
                        UNION ALL
                        SELECT p.id, p.parent_plan_id, p.plan_god_kolvo
                        FROM plan p
                        INNER JOIN chain c ON p.parent_plan_id = c.id
                    )
                    SELECT id, parent_plan_id, plan_god_kolvo FROM chain
                    WHERE id != ?  -- исключаем сам корень
                `, [rootPlanId, rootPlanId]);

                console.log(`[AutoRollbackChain] Найдено узлов цепочки для удаления: ${chainNodes.length}`);

                // 4. Суммируем количество всех удаляемых узлов
                let totalQtyToRestore = 0;
                const chainIds = [];
                for (const node of chainNodes) {
                    totalQtyToRestore += parseFloat(node.plan_god_kolvo) || 0;
                    chainIds.push(node.id);
                }

                // 5. Возвращаем количество корню
                if (chainIds.length > 0) {
                    const root = await db.get(
                        'SELECT plan_god_kolvo FROM plan WHERE id = ?',
                        [rootPlanId]
                    );
                    if (root) {
                        const currentQty = parseFloat(root.plan_god_kolvo) || 0;
                        const newQty = currentQty + totalQtyToRestore;

                        await db.run(
                            'UPDATE plan SET plan_god_kolvo = ?, id_kp = NULL WHERE id = ?',
                            [String(newQty), rootPlanId]
                        );
                        console.log(`[AutoRollbackChain] ✅ Корень ${rootPlanId}: ${currentQty} + ${totalQtyToRestore} = ${newQty}`);
                    }
                }

                // 6. Удаляем зависимые записи и сами позиции цепочки
                if (chainIds.length > 0) {
                    const placeholders = chainIds.map(() => '?').join(',');

                    // ✅ ИЗМЕНЕНО (G9): архивируем ТОЛЬКО график корня — его снимок
                    // нужен для восстановления. Графики удаляемых узлов цепочки
                    // не сохраняем: позиции удаляются навсегда, эти записи
                    // вечно лежали в архиве мёртвым грузом.
                    const grafikBatch = 'CHAIN_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                    await this._archiveGrafik([rootPlanId], grafikBatch);

                    await db.run(`DELETE FROM poz_zakaz_dogovora WHERE id_plana IN (${placeholders})`, chainIds);
                    await db.run(`DELETE FROM kp WHERE id_plana IN (${placeholders})`, chainIds);
                    await db.run(`DELETE FROM plan_perevozok WHERE id_plana IN (${placeholders})`, chainIds);
                    await db.run(`DELETE FROM shagi_marshruta WHERE id_det IN (${placeholders})`, chainIds);
                    await db.run(`DELETE FROM grafik WHERE id_plana IN (${placeholders})`, chainIds);
                    await db.run(`UPDATE plan SET parent_plan_id = NULL WHERE id IN (${placeholders})`, chainIds);
                    await db.run(`DELETE FROM plan WHERE id IN (${placeholders})`, chainIds);
                    // ✅ ИЗМЕНЕНО: график корня не теряется — восстанавливаем из архива
                    // (количество вернулось, график на полное количество снова актуален)
                    await db.run('DELETE FROM grafik WHERE id_plana = ?', [rootPlanId]);
                    await this._restoreGrafikArchive(rootPlanId);

                    console.log(`[AutoRollbackChain] ✅ Удалено позиций цепочки: ${chainIds.length}, график корня восстановлен из архива`);
                }

                // 7. Очищаем id_kp у корня
                await db.run('UPDATE plan SET id_kp = NULL WHERE id = ?', [rootPlanId]);

                // 8. ✅ ИЗМЕНЕНО: обнуляем reshenie И primechanie_kp у всех КП этого запроса,
                //    которые относятся к корню цепочки (но НЕ трогаем КП других позиций запроса!)
                await db.run(`
                    UPDATE kp SET reshenie = '', primechanie_kp = ''
                    WHERE id_zaprosa_kp = ?
                    AND id_plana IN (
                        WITH RECURSIVE chain AS (
                            SELECT id FROM plan WHERE id = ?
                            UNION ALL
                            SELECT p.id FROM plan p INNER JOIN chain c ON p.parent_plan_id = c.id
                        )
                        SELECT id FROM chain
                    )
                `, [zaprosId, rootPlanId]);

                await commitTx();
                console.log('[AutoRollbackChain] ===== УСПЕШНО =====');

            } catch (innerErr) {
                await rollbackTx();
                console.error('[AutoRollbackChain] ❌ ОШИБКА ВНУТРИ ТРАНЗАКЦИИ:', innerErr.message);
                throw innerErr;
            }
        } catch (e) {
            console.error('[AutoRollbackChain] ❌ КРИТИЧЕСКАЯ ОШИБКА:', e.message);
            console.error('[AutoRollbackChain] Stack:', e.stack);
            // ✅ ИСПРАВЛЕНО (D4): ошибка пробрасывается вызывающему коду —
            // клиент должен узнать, что откат не выполнен
            throw e;
        }
    },

    // ========================================================================
    // 🔥 АВТООТКАТ: вызывается при любом изменении КП или запроса
    // ИСПРАВЛЕНО: Рекурсивный поиск, строгий порядок удаления, полная транзакция
    // ========================================================================
    async _autoRollbackZapros(zaprosId, opts = {}) {
        // ✅ ИСПРАВЛЕНО (D2): кэш 2 сек применяется ТОЛЬКО по явному запросу
        // вызывающего (PUT_WITH_KP гасит им каскадные повторы). Для POST_BEST_KP
        // и DELETE_WITH_KP откат обязателен всегда: пропуск оставлял старых
        // дочерних позиций и портил количества при повторном разделении.
        const useCache = opts.useCache !== false;
        if (useCache) {
            const lastRollback = _rollbackCache.get(zaprosId) || 0;
            if (Date.now() - lastRollback < 2000) {
                console.log(`[AutoRollback] ⏭ Пропуск (уже откатан ${Date.now() - lastRollback}мс назад)`);
                return;
            }
        }
        console.log('[AutoRollback] ===== НАЧАЛО ===== zaprosId:', zaprosId);

        // 0. Начинаем транзакцию. Если что-то пойдёт не так, всё отменится.
        await db.run('BEGIN TRANSACTION');

        try {
            // ✅ ИСПРАВЛЕНО (D5): statys добавлен в выборку — без него ранняя
            // ветка «Нечего откатывать» никогда не срабатывала (undefined !== 'создание')
            const zapros = await db.get('SELECT n_zaprosa, data_form, statys FROM zapros_kp WHERE id = ?', [zaprosId]);
            if (!zapros) {
                await db.run('ROLLBACK');
                console.log('[AutoRollback] Запрос не найден, откат отменён.');
                return;
            }

            // 1. 🔥 РЕКУРСИВНЫЙ ПОИСК: Находим ВСЁ поддерево (позицию + всех её детей и внуков) этого запроса
            const children = await db.all(`
                WITH RECURSIVE subtree AS (
                    -- Базовый случай: прямые дочерние позиции этого запроса
                    SELECT id, parent_plan_id, plan_god_kolvo
                    FROM plan
                    WHERE is_child_plan = 1 AND zapros_kp_id = ?

                    UNION ALL

                    -- Рекурсивный шаг: находим детей найденных детей (внуков и т.д.)
                    SELECT p.id, p.parent_plan_id, p.plan_god_kolvo
                    FROM plan p
                    INNER JOIN subtree s ON p.parent_plan_id = s.id
                )
                SELECT id, parent_plan_id, plan_god_kolvo FROM subtree
            `, [zaprosId]);

            if (children.length === 0) {
                // ✅ Проверяем, нужен ли вообще сброс
                const kpWithDecision = await db.get(
                    `SELECT COUNT(*) as cnt FROM kp
                    WHERE id_zaprosa_kp = ?
                    AND reshenie != '' AND reshenie IS NOT NULL`,
                    [zaprosId]
                );

                if (kpWithDecision.cnt === 0 &&
                    (zapros.statys === 'создание' || zapros.statys === '')) {
                    // Нечего откатывать — выходим БЕЗ reset
                    await db.run('ROLLBACK');
                    console.log('[AutoRollback] ⏭ Нечего откатывать');
                    // ✅ НОВОЕ (G3): количества трогать не нужно, но график мог
                    // остаться в архиве с прошлого отката — возвращаем его.
                    await this._restoreMissingGrafikForZapros(zaprosId);
                    if (useCache) _rollbackCache.set(zaprosId, Date.now());
                    return;
                }

                // Минимальный сброс
                await this._resetZaprosStatuses(zaprosId);
                await db.run('COMMIT');
                // ✅ НОВОЕ (G3): самовосстановление графиков после раннего выхода
                await this._restoreMissingGrafikForZapros(zaprosId);
                if (useCache) _rollbackCache.set(zaprosId, Date.now());
                console.log('[AutoRollback] ===== Минимальный сброс статусов =====');
                return;
            }

            console.log(`[AutoRollback] Найдено позиций для удаления: ${children.length}`);

            // 2. ✅ ИСПРАВЛЕНО (D3): количество ВСЕГО поддерева возвращается КОРНЮ
            // цепочки — единый алгоритм с _autoRollbackPlanChain. Раньше количество
            // возвращалось прямому родителю каждого узла: количество внуков уходило
            // промежуточному родителю и терялось вместе с его удалением.
            const nodeById = new Map();
            for (const node of children) nodeById.set(node.id, node);

            const rootQtyMap = new Map();
            for (const node of children) {
                // Поднимаемся до корня цепочки (узел, не входящий в множество детей)
                let current = node;
                let guard = 0; // защита от зацикливания на испорченных данных
                while (nodeById.has(current.parent_plan_id) && guard < 100) {
                    current = nodeById.get(current.parent_plan_id);
                    guard++;
                }
                const rootId = current.parent_plan_id;
                if (!rootId) {
                    console.warn(`[AutoRollback] ⚠ У узла ${node.id} не найден корень цепочки (parent_plan_id отсутствует) — его количество ${node.plan_god_kolvo} НЕ возвращено. См. диагностический SQL «дети-сироты».`);
                    continue;
                }
                rootQtyMap.set(rootId, (rootQtyMap.get(rootId) || 0) + (parseFloat(node.plan_god_kolvo) || 0));
            }

            const childrenIds = children.map((c) => c.id);
            const parentIds = Array.from(rootQtyMap.keys());

            // 3. Возвращаем количество корням и сбрасываем id_kp ДО удаления детей
            for (const [rootId, addQty] of rootQtyMap) {
                const root = await db.get('SELECT plan_god_kolvo FROM plan WHERE id = ?', [rootId]);
                if (root) {
                    const currentQty = parseFloat(root.plan_god_kolvo) || 0;
                    const newQty = currentQty + addQty;
                    await db.run(
                        'UPDATE plan SET plan_god_kolvo = ?, id_kp = NULL WHERE id = ?',
                        [String(newQty), rootId]
                    );
                    console.log(`[AutoRollback] ✅ Корень ${rootId}: ${currentQty} + ${addQty} = ${newQty}`);
                } else {
                    console.warn(`[AutoRollback] ⚠ Корень ${rootId} не найден — количество ${addQty} НЕ возвращено`);
                }
            }

            // 4. 🔥 СТРОГИЙ ПОРЯДОК УДАЛЕНИЯ ЗАВИСИМОСТЕЙ (сначала дочерние таблицы)
            console.log('[AutoRollback] 🗑 Очистка зависимых таблиц...');

            // ✅ ИЗМЕНЕНО (G9): архивируем ТОЛЬКО графики корней — их снимки
            // нужны для восстановления. Графики удаляемых детей не сохраняем:
            // позиции удаляются навсегда, записи были бы мёртвым грузом.
            const grafikBatch = 'RB_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            await this._archiveGrafik(parentIds, grafikBatch);

            const placeholders = childrenIds.map(() => '?').join(',');
            await db.run(`DELETE FROM poz_zakaz_dogovora WHERE id_plana IN (${placeholders})`, childrenIds);
            await db.run(`DELETE FROM kp WHERE id_plana IN (${placeholders})`, childrenIds);
            await db.run(`DELETE FROM plan_perevozok WHERE id_plana IN (${placeholders})`, childrenIds);
            await db.run(`DELETE FROM shagi_marshruta WHERE id_det IN (${placeholders})`, childrenIds);
            await db.run(`DELETE FROM grafik WHERE id_plana IN (${placeholders})`, childrenIds);
            // ✅ ИЗМЕНЕНО: графики корней не теряются — восстанавливаем из архива
            for (const rootId of parentIds) {
                await db.run('DELETE FROM grafik WHERE id_plana = ?', [rootId]);
                await this._restoreGrafikArchive(rootId);
            }
            // ✅ НОВОЕ (G5): честная диагностика — если графику корня неоткуда
            // вернуться, пишем это прямо в лог, а не молчим.
            for (const rootId of parentIds) {
                const gCnt = await db.get('SELECT COUNT(*) AS cnt FROM grafik WHERE id_plana = ?', [rootId]);
                if (!gCnt || !gCnt.cnt) {
                    console.warn(`[AutoRollback] ⚠ График корня ${rootId} НЕ восстановлен: в grafik_archive нет необработанного снимка. Вероятная причина — график был удалён старым кодом ДО внедрения архива (автоматически такой график восстановить нельзя, только перезаполнить вручную).`);
                }
            }
            console.log(`[AutoRollback] ♻ Графики ${parentIds.length} корневых позиций обработаны (восстановление из архива)`);

            // 5. 🔥 КРИТИЧЕСКИ ВАЖНО: Обнуляем parent_plan_id у удаляемых записей.
            // Это на 100% предотвращает ошибку FOREIGN KEY constraint failed внутри самой таблицы plan.
            await db.run(`UPDATE plan SET parent_plan_id = NULL WHERE id IN (${placeholders})`, childrenIds);

            // 6. Теперь безопасно удаляем сами позиции плана
            await db.run(`DELETE FROM plan WHERE id IN (${placeholders})`, childrenIds);
            console.log(`[AutoRollback] ✅ Удалено позиций плана: ${childrenIds.length}`);

            // 7. Сброс статусов и обнуление привязок КП в оставшихся позициях запроса
            await this._resetZaprosStatuses(zaprosId);

            // 8. Фиксируем все изменения
            await db.run('COMMIT');
            // ✅ НОВОЕ (G3): страховка — снимок мог остаться у позиции, не попавшей
            // в parentIds (например, её дети удалены предыдущей операцией).
            await this._restoreMissingGrafikForZapros(zaprosId);
            if (useCache) _rollbackCache.set(zaprosId, Date.now());
            console.log('[AutoRollback] ===== УСПЕШНО ЗАВЕРШЁН =====');

        } catch (innerErr) {
            // При любой ошибке внутри блока откатываем все изменения, чтобы база не сломалась
            await db.run('ROLLBACK');
            console.error('[AutoRollback] ❌ ОШИБКА ВНУТРИ ТРАНЗАКЦИИ (выполнен ROLLBACK):', innerErr.message);
            // ✅ ИСПРАВЛЕНО (D4): ошибка пробрасывается — вызывающий обработчик
            // вернёт клиенту 409/500 вместо молчаливого «успеха»
            throw innerErr;
        }
    },

    // ========================================================================
    // Копирование КП для новой дочерней позиции плана
    // ========================================================================
    async _copyRemainingKPForNewPlan(newPlanId, selectedKP, originalPlanId, exhaustedFirmas, zaprosId) {
        try {
        const selectedGroup = getGroupNum(selectedKP.tip_izgotovleniya);
        const allKP = await db.all(
            'SELECT * FROM kp WHERE id_plana = ? AND id_zaprosa_kp = ?',
            [originalPlanId, zaprosId]
        );
        
        for (const kp of allKP) {
            if (getGroupNum(kp.tip_izgotovleniya) !== selectedGroup) continue;
            if (kp.id_firma !== selectedKP.id_firma && exhaustedFirmas.has(kp.id_firma)) continue;
            
            const newId = generateId('KP');
            await db.run(`
            INSERT INTO kp (id, id_plana, id_zaprosa_kp, id_firma, id_dogovor,
                trudoemkost_postavshika, cena_postavshika, moshchnost_kolvo,
                srok_vipolneniya, tip_izgotovleniya, reshenie, date_otv, link_dok,
                email_otpravki, date_otpravki, isklyuchen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)
            `, [
            newId, newPlanId, zaprosId, kp.id_firma, kp.id_dogovor,
            kp.trudoemkost_postavshika, kp.cena_postavshika, kp.moshchnost_kolvo,
            kp.srok_vipolneniya, kp.tip_izgotovleniya, kp.date_otv, kp.link_dok,
            kp.email_otpravki, kp.date_otpravki, kp.isklyuchen
            ]);
        }
        } catch (e) {
        console.error('[copyRemainingKP] Error:', e.message);
        }
    },


    // ========================================================================
    // 🔥 АВТООТКАТ ПРИ ИЗМЕНЕНИИ КП
    // Откатывает ТОЛЬКО цепочку конкретной позиции, не весь запрос!
    // ========================================================================
    async _handleKPChange(kpId, opts = {}) {
        try {
            const kp = await db.get('SELECT id_plana, id_zaprosa_kp FROM kp WHERE id = ?', [kpId]);
            if (kp && kp.id_plana && kp.id_zaprosa_kp) {
                // ✅ ИСПРАВЛЕНО: откатываем только цепочку этой позиции, а не весь запрос.
                // useOwnTransaction=false — транзакцию открывает вызывающий (PUT_KOM_PREDL).
                await this._autoRollbackPlanChain(
                    kp.id_plana,
                    kp.id_zaprosa_kp,
                    opts.useOwnTransaction !== false
                );
                wsManager.notifyDataChange('zapros_kp', 'update', kp.id_zaprosa_kp);
                wsManager.notifyDataChange('plan', 'update', kp.id_zaprosa_kp);
            }
        } catch (e) {
            console.error('[_handleKPChange] Error:', e.message);
            // ✅ ИСПРАВЛЕНО (D4): ошибка пробрасывается — вызывающий код обязан
            // сообщить клиенту, что откат не выполнен (раньше проглатывалась)
            throw e;
        }
    },

    // ========================================================================
    // DELETE_POSITION — удаление позиции с каскадным объединением количеств
    // ========================================================================
    async DELETE_POSITION(req, res, url) {
        const parts = url.pathname.split('/');
        const zaprosId = parts[3];
        const targetPlanId = parts[5];

        if (!zaprosId || !targetPlanId) {
            return send(res, 400, { error: 'Не указаны ID запроса или позиции' });
        }

        try {
            console.log('\n[DELETE_POSITION] ========================================');
            console.log(`[DELETE_POSITION] 🎯 zaprosId: ${zaprosId}`);
            console.log(`[DELETE_POSITION] 🎯 targetPlanId: ${targetPlanId}`);

            await db.run('BEGIN TRANSACTION');

            try {
                // 1. Получаем информацию о целевой позиции
                const targetPlan = await db.get(
                    'SELECT id, is_child_plan, parent_plan_id, plan_god_kolvo, zapros_kp_id FROM plan WHERE id = ?',
                    [targetPlanId]
                );

                if (!targetPlan) {
                    await db.run('ROLLBACK');
                    return send(res, 404, { error: 'Позиция не найдена' });
                }

                const parentId = targetPlan.parent_plan_id;

                // 2. 🔥 РЕКУРСИВНЫЙ ЗАПРОС: Находим ВСЁ поддерево (позицию + всех её детей и внуков)
                const subtreeQuery = `
                    WITH RECURSIVE subtree AS (
                        -- Базовый случай: сама удаляемая позиция
                        SELECT id, parent_plan_id, plan_god_kolvo
                        FROM plan
                        WHERE id = ?
                        UNION ALL
                        -- Рекурсивный шаг: все позиции, чей parent_plan_id равен id из предыдущего шага
                        SELECT p.id, p.parent_plan_id, p.plan_god_kolvo
                        FROM plan p
                        INNER JOIN subtree s ON p.parent_plan_id = s.id
                    )
                    SELECT id, parent_plan_id, plan_god_kolvo FROM subtree
                `;

                const subtreeNodes = await db.all(subtreeQuery, [targetPlanId]);

                if (subtreeNodes.length === 0) {
                    await db.run('ROLLBACK');
                    return send(res, 404, { error: 'Позиция не найдена' });
                }

                // 3. Суммируем количество ВСЕХ узлов в поддереве и собираем их ID
                let totalQtyToRestore = 0;
                const allPlanIdsToDelete = [];

                for (const node of subtreeNodes) {
                    totalQtyToRestore += parseFloat(node.plan_god_kolvo) || 0;
                    allPlanIdsToDelete.push(node.id);
                }

                console.log(`[DELETE_POSITION] 🌳 Найдено узлов для удаления: ${allPlanIdsToDelete.length}`);
                console.log(`[DELETE_POSITION] 📊 Суммарное количество для возврата родителю: ${totalQtyToRestore}`);

                // 4. Возвращаем СУММАРНОЕ количество родителю (если он существует)
                if (parentId) {
                    const parent = await db.get('SELECT plan_god_kolvo FROM plan WHERE id = ?', [parentId]);
                    if (parent) {
                        const currentParentQty = parseFloat(parent.plan_god_kolvo) || 0;
                        const newParentQty = currentParentQty + totalQtyToRestore;

                        await db.run(
                            'UPDATE plan SET plan_god_kolvo = ? WHERE id = ?',
                            [String(newParentQty), parentId]
                        );
                        console.log(`[DELETE_POSITION] ✅ Родитель ${parentId}: ${currentParentQty} + ${totalQtyToRestore} = ${newParentQty}`);
                    } else {
                        console.warn(`[DELETE_POSITION] ⚠️ Родитель ${parentId} не найден!`);
                    }
                }

                // 5. Подготовка плейсхолдеров для массового удаления
                const placeholders = allPlanIdsToDelete.map(() => '?').join(',');

                // 6. Последовательное удаление связанных записей для ВСЕХ узлов поддерева
                console.log('[DELETE_POSITION] 🗑 Очистка связанных таблиц...');
                
                await db.run(`DELETE FROM kp WHERE id_plana IN (${placeholders})`, allPlanIdsToDelete);
                await db.run(`DELETE FROM poz_zakaz_dogovora WHERE id_plana IN (${placeholders})`, allPlanIdsToDelete);
                await db.run(`DELETE FROM plan_perevozok WHERE id_plana IN (${placeholders})`, allPlanIdsToDelete);
                await db.run(`DELETE FROM shagi_marshruta WHERE id_det IN (${placeholders})`, allPlanIdsToDelete);
                // ✅ ИСПРАВЛЕНО (G6): графики поддерева И родителя перед удалением
                // архивируются; после удаления график родителя возвращается из
                // архива — количество вернулось, актуален график на полное
                // количество. Раньше график родителя удалялся навсегда.
                const grafikBatch = 'POS_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                // ✅ ИЗМЕНЕНО (G9): архивируем только график родителя — его снимок
                // нужен для восстановления. Графики удаляемого поддерева не храним.
                if (parentId) {
                    await this._archiveGrafik([parentId], grafikBatch);
                }
                await db.run(`DELETE FROM grafik WHERE id_plana IN (${placeholders})`, allPlanIdsToDelete);
                if (parentId) {
                    await db.run('DELETE FROM grafik WHERE id_plana = ?', [parentId]);
                    const restoredGrafik = await this._restoreGrafikArchive(parentId);
                    if (restoredGrafik > 0) {
                        console.log(`[DELETE_POSITION] ♻ График родителя ${parentId} восстановлен из архива (${restoredGrafik} строк)`);
                    } else {
                        console.warn(`[DELETE_POSITION] ⚠ График родителя ${parentId} удалён, а в grafik_archive снимка для него нет — восстановить нечего (вероятно, график был удалён старым кодом до внедрения архива).`);
                    }
                }
                // 7. 🔥 КРИТИЧЕСКИ ВАЖНО: Перед удалением самих записей plan, обнуляем их parent_plan_id.
                // Это предотвращает ошибку FOREIGN KEY constraint failed, так как SQLite видит, 
                // что мы удаляем родителя, на которого всё ещё ссылаются дети в этом же списке.
                await db.run(`UPDATE plan SET parent_plan_id = NULL WHERE id IN (${placeholders})`, allPlanIdsToDelete);
                
                // Теперь безопасно удаляем сами записи плана
                await db.run(`DELETE FROM plan WHERE id IN (${placeholders})`, allPlanIdsToDelete);
                console.log(`[DELETE_POSITION] ✅ Удалено позиций плана: ${allPlanIdsToDelete.length}`);

                // 8. Проверяем, не стал ли запрос пустым
                const remainingKP = await db.get(
                    'SELECT COUNT(*) as cnt FROM kp WHERE id_zaprosa_kp = ?',
                    [zaprosId]
                );

                if (remainingKP.cnt === 0) {
                    await db.run(
                        "UPDATE zapros_kp SET statys = 'создание' WHERE id = ?",
                        [zaprosId]
                    );
                    console.log(`[DELETE_POSITION] 📝 Запрос ${zaprosId} стал пустым, статус сброшен`);
                }

                // 9. Фиксируем транзакцию
                await db.run('COMMIT');
                console.log('[DELETE_POSITION] ✅ ТРАНЗАКЦИЯ ЗАФИКСИРОВАНА');

                wsManager.notifyDataChange('kp', 'delete', targetPlanId);
                wsManager.notifyDataChange('plan', 'update', parentId || targetPlanId);
                wsManager.notifyDataChange('zapros_kp', 'update', zaprosId);

                console.log('[DELETE_POSITION] ========================================\n');

                send(res, 200, {
                    ok: true,
                    message: `Позиция и все её вложенные дети успешно удалены. Общее количество (${totalQtyToRestore}) возвращено родителю.`,
                    remainingPositions: remainingKP.cnt
                });

            } catch (innerErr) {
                console.error('\n[DELETE_POSITION] ❌ ОШИБКА ВНУТРИ ТРАНЗАКЦИИ:');
                console.error(`[DELETE_POSITION] Сообщение: ${innerErr.message}`);
                console.error(`[DELETE_POSITION] Stack: ${innerErr.stack}`);
                await db.run('ROLLBACK');
                console.log('[DELETE_POSITION] 🔙 ROLLBACK выполнен');
                console.log('[DELETE_POSITION] ========================================\n');
                throw innerErr;
            }
        } catch (e) {
            await db.run('ROLLBACK').catch(() => {});
            console.error('\n[DELETE_POSITION] ❌ ОШИБКА (выполнен ROLLBACK):');
            console.error(`[DELETE_POSITION] ${e.message}`);
            console.error(`[DELETE_POSITION] Stack: ${e.stack}`);
            console.log('[DELETE_POSITION] ========================================\n');
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // 🔒 ПРОВЕРКА ЗАВИСИМОСТЕЙ: можно ли редактировать/удалять запрос?
    // ========================================================================
    async _checkZaprosDependencies(zaprosId) {
        try {
            // 1. Находим все дочерние позиции, созданные ЭТИМ запросом
            const children = await db.all(`
                SELECT id, parent_plan_id, plan_god_kolvo, is_no_kp_plan
                FROM plan
                WHERE is_child_plan = 1
                AND zapros_kp_id = ?
            `, [zaprosId]);

            if (children.length === 0) {
                return { ok: true }; // Нет дочерних — можно редактировать
            }

            const childrenIds = children.map(c => c.id);
            if (childrenIds.length === 0) return { ok: true };

            const placeholders = childrenIds.map(() => '?').join(',');

            // 2. ✅ КЛЮЧЕВОЙ ЗАПРОС: находим все зависимые запросы с номерами и чертежами
            const dependentPositions = await db.all(`
                SELECT 
                    p.id as child_plan_id,
                    p.parent_plan_id,
                    p.plan_god_kolvo,
                    p.is_no_kp_plan,
                    o.nomer_chertezha,
                    o.naimenovanie as osn_naimenovanie,
                    kp.id as kp_id,
                    kp.id_zaprosa_kp as dependent_zapros_id,
                    z.n_zaprosa as dependent_zapros_number,
                    z.data_form as dependent_zapros_date,
                    z.statys as dependent_zapros_status
                FROM plan p
                LEFT JOIN osnastka o ON p.id_osnastka = o.id
                LEFT JOIN kp ON p.id = kp.id_plana
                LEFT JOIN zapros_kp z ON kp.id_zaprosa_kp = z.id
                WHERE p.id IN (${placeholders})
                AND kp.id_zaprosa_kp IS NOT NULL
                AND kp.id_zaprosa_kp != ?
            `, [...childrenIds, zaprosId]);

            if (dependentPositions.length === 0) {
                return { ok: true };
                }

            // 3. Группируем по зависимым запросам
            const zaprosMap = new Map();
            dependentPositions.forEach(pos => {
                if (!pos.dependent_zapros_id) return;

                if (!zaprosMap.has(pos.dependent_zapros_id)) {
                    zaprosMap.set(pos.dependent_zapros_id, {
                        zaprosId: pos.dependent_zapros_id,
                        zaprosNumber: pos.dependent_zapros_number,
                        zaprosDate: pos.dependent_zapros_date,
                        zaprosStatus: pos.dependent_zapros_status,
                        positions: []
                    });
                }

                zaprosMap.get(pos.dependent_zapros_id).positions.push({
                    childPlanId: pos.child_plan_id,
                    parentPlanId: pos.parent_plan_id,
                    kolvo: pos.plan_god_kolvo,
                    kpId: pos.kp_id,
                    nomerChertezha: pos.nomer_chertezha || '—',
                    naimenovanie: pos.osn_naimenovanie || '',
                    isNoKP: pos.is_no_kp_plan === 1
                });
            });

            // 4. ✅ ФОРМИРУЕМ ПОДРОБНОЕ СООБЩЕНИЕ С НОМЕРАМИ ЗАПРОСОВ И ЧЕРТЕЖАМИ
            const details = Array.from(zaprosMap.values()).map(z => {
                const positionsList = z.positions.map(p => {
                    const marker = p.isNoKP ? '⚠️[без КП] ' : '';
                    return `    • ${marker}Чертёж: ${p.nomerChertezha} (${p.naimenovanie}) — ${p.kolvo} шт.`;
                }).join('\n');

                return `  🔒 Запрос №${z.zaprosNumber} от ${z.zaprosDate} (статус: "${z.statys || 'создание'}"):\n${positionsList}`;
            }).join('\n\n');

            // 5. Формируем массив для UI (для кнопки "Удалить проблемные позиции")
            const dependentZaprosy = Array.from(zaprosMap.values()).map(z => ({
                zaprosId: z.zaprosId,
                zaprosNumber: z.zaprosNumber,
                zaprosDate: z.zaprosDate,
                zaprosStatus: z.zaprosStatus,
                positions: z.positions.map(p => ({
                    childPlanId: p.childPlanId,
                    kpId: p.kpId,
                    nomerChertezha: p.nomerChertezha,
                    kolvo: p.kolvo
                }))
            }));

            return {
                ok: false,
                error: `Невозможно изменить запрос: существуют зависимые позиции в других запросах.\n\n${details}\n\n💡 Решение: удалите указанные позиции из зависимых запросов, затем попробуйте снова.`,
                code: 'DEPENDENT_POSITIONS_EXIST',
                dependentZaprosy
            };
        } catch (e) {
            console.error('[checkZaprosDependencies] Error:', e.message);
            // В случае ошибки проверки — разрешаем операцию (не блокируем работу)
            return { ok: true };
        }
    }
});
