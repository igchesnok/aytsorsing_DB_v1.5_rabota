// ============================================================
// src/routes/transportOperRoutes.js
// API: ТРАНСПОРТНЫЕ ОПЕРАЦИИ
// ВСЕ GET через buildSyntheticQuery, мутации через notifyWithDependencies
// ============================================================

const { parseBody, send, generateId } = require('../utils');
const {
  normalizeFk,
  validateFk,
  validateFkArray,
  safeNum,
  safeStr
} = require('./helpers/fkHelpers');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');
// ✅ Кир→Лат: JS-сравнение через общий хелпер гомоглифов
const { matches: hgMatches } = require('./helpers/homoglyphs');
// ✅ T37-B: СЗ в ЭДО АВТОВАЗа (tportal.vaz.ru) — порт VBA modEDO
// (Create_doc/KartEdit/DocumentSave/filesave) и modExcelZavkaOtgryz
// (файл заявки из шаблона; исправление порчи shared-формул/calcChain)
const edo = require('./helpers/edoPortal');
const szExcel = require('./helpers/szExcel');
// ✅ T57: движок расчёта тарных мест по трём типам груза
const tarnCalc = require('./helpers/tarnCalc');
const sipora = require('./helpers/siporaNaklad'); // ✅ T38: накладные М-15 в системе ВАЗ (SIPORA tportal.vaz.ru/sipora/ou38)
const browserLauncher = require('./helpers/browserLauncher'); // ✅ T44: открытие документа в браузере по умолчанию (Яндекс Браузер, референс nak_M_15)
// ✅ T59: конвертер xlsx -> HTML для предпросмотра СЗ в браузере
const { generatePreviewHTML } = require('../excelService');

const fs = require('fs');
const path = require('path');

// ================================================================
// ✅ ЗАТРАТЫ (перенос логики VBA frmTransportOper + modSHPZ_Peredel):
// - ШПЗ позиции вычисляется из plan.zak_pto: 3-я..5-я цифры заказа
//   (VBA Mid(zak,3,3)) ищутся в списках «с»/«о», иначе «ошибка»;
// - «с»/«о» подменяются полными наименованиями (cmdAvtozapPar_Click);
// - Сч/Б — параллельный список (cbShPZ_Change: cbSB.ListIndex =
//   cbShPZ.ListIndex), ровно ДВА значения. Значения в коде VBA не
//   хранятся (заданы в дизайнере формы) — при расхождении править
//   ТОЛЬКО список SHPZ_SB_LIST ниже;
// - Передел автоназначается по цеху-изготовителю (txtCexIzgot_Change);
//   цех в веб-БД хранится КОДОМ cex_zatrat.ceh (НЕ id).
// ================================================================
const ZAK_SHZ_LISTS = {
  s: ['208', '209', '210', '217', '310', '324', '330', '370', '395', '508', '509', '510', '530', '561', '570'],
  o: ['204', '205', '214', '224', '225', '229', '365', '367', '419', '421', '422', '428', '519', '521', '901', '902', '903', '905', '908', '911', '918']
};
const SHPZ_NAME = { 'с': 'ШПЗ - 230510220', 'о': 'ШПЗ - 230520220' };
const SHPZ_SB_LIST = [
  { shpz: 'ШПЗ - 230510220', sb: '230510220' },
  { shpz: 'ШПЗ - 230520220', sb: '230520220' }
];

// ================================================================
// ✅ ТИПЫ ГРУЗА (виды заготовок) — бизнес-логика пользователя:
// - «Детали на деревянной таре» — VBA CalculatePalletCountByOrder
//   (поддон 1200x800, негабарит = штука/поддон);
// - «Заготовки в листах» — гильотинный раскрой листа, припуск 4 мм;
// - «Заготовки в прутках» — резка прутка по длине детали, припуск 5 мм.
// - «Смешанный груз» (T56) — тип каждой позиции по её параметрам:
//   лист -> раскрой листа, пруток -> связка, иначе штучная (поддоны);
//   места с листами ограничены высотой 1000 мм (штабель делится).
// Параметры листа/прутка хранятся в plan (list_dlina/list_shirina/
// list_tolshina/prutok_dlina); пусто = деталь/заготовка ШТУЧНЫЕ.
// ================================================================
const LIST_PRIPUSK_MM = 0;     // T56-f/T57-d: припуск на рез (0 = ВСТЫК, как в ручном раскрое цеха)
const PRUTOK_PRIPUSK_MM = 5;   // припуск на рез при резке прутка
const PALLET_W_MM = 1200, PALLET_H_MM = 800; // поддон (VBA CalculatePalletCountByOrder)
const STEEL_DENSITY_KG_MM3 = 7.85e-6;        // fallback плотности (сталь 7850 кг/м3)
const VID_GRUZA_LIST = ['tara', 'listy', 'prutki'];
const LIST_STACK_LIMIT_MM = 1000; // T56: лимит высоты стопки листов на тарное место

// VBA Mid(zakPTOStr, 3, 3) — 1-символьные коды «с»/«о»/«ошибка»/''
function zakToShz(zak) {
  const s = String(zak == null ? '' : zak).trim();
  if (s.length < 5) return '';
  const mid = s.slice(2, 5);
  if (ZAK_SHZ_LISTS.s.includes(mid)) return 'с';
  if (ZAK_SHZ_LISTS.o.includes(mid)) return 'о';
  return 'ошибка';
}

// числа бывают строками с запятой ('40,9') — как в SafeConvertToDouble VBA
function safeNumRu(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function round3(v) { return Math.round(v * 1000) / 1000; }

// ✅ T57: производные ОБЩИЕ поля операции из таблицы тарных мест
// (кол-во мест = Σ, вес = Σ, габариты = макс, объём = Σ Д×Ш×В×кол-во,
//  штабелируемость = «да» если есть штабелируемые места; в UI общих
//  полей больше нет — источник истина tarn_mesta из модального диалога)
function tarnMestaDerived(tm) {
  let arr = tm;
  if (typeof tm === 'string') { try { arr = JSON.parse(tm); } catch { return null; } }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const n = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(x) ? 0 : x; };
  let mest = 0, ves = 0, L = 0, W = 0, H = 0, obem = 0, shtabil = 'нет';
  const tips = new Set();
  for (const g of arr) {
    mest += Math.round(n(g.kolvo));
    ves += n(g.ves_kg);
    L = Math.max(L, n(g.dlina_m)); W = Math.max(W, n(g.shirina_m)); H = Math.max(H, n(g.vysota_m));
    obem += n(g.dlina_m) * n(g.shirina_m) * n(g.vysota_m) * n(g.kolvo);
    if (String(g.shtabil) === 'да') shtabil = 'да';
    if (g.tip) tips.add(String(g.tip));
  }
  return {
    tarn_places: String(mest),
    brutto_ves_kg: String(Math.round(ves * 100) / 100),
    dlina_m: L ? String(Math.round(L * 1000) / 1000) : '',
    shirina_m: W ? String(Math.round(W * 1000) / 1000) : '',
    vysota_m: H ? String(Math.round(H * 1000) / 1000) : '',
    obem_m3: String(Math.round(obem * 1000) / 1000),
    shtabil_gryz: shtabil,
    vid_gruza: tips.size === 1 ? [...tips][0] : (tips.size > 1 ? 'smesh' : '')
  };
}

// T56-b: конструкторская марка материала для партии плана (оснастка позиции)
async function osnMarkaForPlan(db, planPerevozokId) {
  if (!planPerevozokId) return '';
  const r = await db.get(`
    SELECT o.marka_materiala AS m
    FROM plan_perevozok pp
    JOIN plan p ON pp.id_plana = p.id
    JOIN osnastka o ON p.id_osnastka = o.id
    WHERE pp.id = ?
  `, [planPerevozokId]);
  return (r && r.m != null) ? String(r.m).trim() : '';
}

// T56-b: марка-факт грузовой позиции: из запроса, иначе конструкторская
function pozMarkaFact(v, osnMarka) {
  const s = String(v == null ? '' : v).trim();
  return s || String(osnMarka || '').trim() || '';
}

// Построчные параметры позиции (BuildTransportArray): итоговые веса
// (вес единицы x количество), объём позиции, ШПЗ и его наименование
function enrichPozRow(r, qty) {
  const q = safeNumRu(qty);
  r.ves_det_tot = safeNumRu(r.ves_det) * q;
  r.ves_zag_tot = safeNumRu(r.ves_zag) * q;
  const v = round3((safeNumRu(r.dlina) * safeNumRu(r.shirina) * safeNumRu(r.vysota)) / 1000000000);
  r.obem_poz = round3(v * q);
  r.shpz = zakToShz(r.zak_pto);
  r.shpz_name = SHPZ_NAME[r.shpz] || '';
  // ✅ ТИПЫ ГРУЗА: строка «Лист Д×Ш×Т» для колонки таблицы (1500×6000×3)
  const lD = safeNumRu(r.list_dlina), lW = safeNumRu(r.list_shirina), lT = safeNumRu(r.list_tolshina);
  r.list_params = (lD > 0 && lW > 0 && lT > 0) ? `${lD}×${lW}×${lT}` : '';
  // T56-b: марка материала — факт (грузовая позиция) или конструкторская (оснастка)
  r.marka_eff = String(r.marka_materiala || '').trim() || String(r.marka_materiala_osn || '').trim();
  return r;
}

// ================================================================
// НОВЫЙ АЛГОРИТМ ПРОДВИЖЕНИЯ ПО МАРШРУТУ (фактическое перемещение):
// физическое состояние позиции плана (сколько на ПТО, сколько у контрагента,
// какой шаг готов к перемещению) вычисляется ТОЛЬКО по факту —
// партиям gryz_poz, размещённым в рейсах transport_oper.
// Рейс доставлен: transport_oper.status = 'Выполнена' (канон статусов:
// Новая -> Ожидает отправки -> В пути -> Выполнена) либо заполнена pribytie_data.
// Если партии позиции нет в transport_oper/gryz_poz и есть КП — она на ПТО,
// готовая к 1-му шагу маршрута.
// Заявки plan_perevozok физику НЕ двигают — только резервируют количество.
// Шаг закрывается ТОЛЬКО доставкой (доставлено >= запланировано).
// Незавершёнка (запланировано/в пути без доставки) делает шаг АКТИВНЫМ
// с available = 0 (blockedStep) — заявки этого шага видны для загрузки
// партиями в рейсы, а следующий шаг не наступил.
// ГОТОВНОСТЬ К ОТПРАВКЕ (бизнес-правило) — доставка рейса НЕ равна готовности:
// - 1-й шаг (отправка заготовки с ПТО) доступен, только если в позиции плана
//   заполнена дата готовности заготовки (plan.data_yes_zagot);
// - следующий шаг доступен, когда шаг-поставщик ЗАВЕРШЁН на стороне получателя:
//   последняя (по порядку добавления) операция шага имеет фактическую дату
//   окончания в fakt_marshruta (data_fakt_end) для доставленной партии;
//   строки факта создаются автоматически при добавлении партии в рейс
//   (createFaktForPoz ниже);
// - шаг без операций или партия без строк факта (легаси-данные) —
//   готовность принимается по факту доставки рейса.
// v8 (пул по последней операции): готовое количество партии = ВЫПОЛНЕННОЕ
// КОЛИЧЕСТВО ПОСЛЕДНЕЙ операции шага (kolvo_vypolneno по rowid; NULL/легаси
// = полное количество партии) — только оно попадает в доступные перевозки;
// количества промежуточных операций пул не ограничивают.
// ВАЖНО: копия хелпера дублируется в planPerevozokRoutes.js и
// transportOperRoutes.js — при изменении алгоритма править в ОБОИХ.
// ================================================================
async function computePositionFlow(db, idPlana, planQty) {
  const steps = await db.all(`
    SELECT sm.id_shag, sm.nom_shag, tp.id_tipa, tp.nazvanie_operatsii, tp.napravlenie
    FROM shagi_marshruta sm
    JOIN transport_types tp ON sm.id_tipa_perevozki = tp.id_tipa
    WHERE sm.id_det = ?
    ORDER BY sm.nom_shag
  `, [idPlana]);

  // ФАКТ перемещения: партии позиции, размещённые в рейсах
  // (шаг известен через заявку: gryz_poz.id_plana -> plan_perevozok.id_shag)
  // + ГОТОВНОСТЬ партии к следующему шагу:
  //   ops_total        — сколько операций в шаге партии;
  //   fakt_cnt         — сколько строк факта (fakt_marshruta) заведено партии по шагу;
  //   last_op_fakt_end — фактическая дата окончания ПОСЛЕДНЕЙ операции шага
  //                      (по порядку добавления, rowid) для этой партии.
  const moves = await db.all(`
    SELECT ppr.id_shag,
           COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0) as qty,
           CASE WHEN t.status = 'Выполнена'
                  OR (t.pribytie_data IS NOT NULL AND TRIM(t.pribytie_data) != '')
                THEN 1 ELSE 0 END as delivered,
           (SELECT COUNT(*) FROM operatsii_marshruta om
             WHERE om.id_shag = ppr.id_shag) as ops_total,
           (SELECT COUNT(*) FROM fakt_marshruta fm
             JOIN operatsii_marshruta om2 ON om2.id_oper = fm.id_oper
             WHERE fm.id_gryz_poz = gp.id AND om2.id_shag = ppr.id_shag) as fakt_cnt,
           (SELECT fm3.data_fakt_end
             FROM operatsii_marshruta om3
             LEFT JOIN fakt_marshruta fm3
               ON fm3.id_oper = om3.id_oper AND fm3.id_gryz_poz = gp.id
             WHERE om3.id_shag = ppr.id_shag
             ORDER BY om3.rowid DESC LIMIT 1) as last_op_fakt_end,
           (SELECT fm5.kolvo_vypolneno
             FROM operatsii_marshruta om5
             LEFT JOIN fakt_marshruta fm5
               ON fm5.id_oper = om5.id_oper AND fm5.id_gryz_poz = gp.id
            WHERE om5.id_shag = ppr.id_shag
            ORDER BY om5.rowid DESC LIMIT 1) as done_qty
    FROM gryz_poz gp
    JOIN transport_oper t ON gp.id_transporta = t.id
    JOIN plan_perevozok ppr ON gp.id_plana = ppr.id
    WHERE ppr.id_plana = ?
  `, [idPlana]);

  // Резерв: заявки плана (в т.ч. без партий — рейс ещё не сформирован)
  const orders = await db.all(`
    SELECT id_shag,
           COALESCE(kolvo_no_br, 0) + COALESCE(kolvo_yes_br, 0) as qty
    FROM plan_perevozok
    WHERE id_plana = ?
  `, [idPlana]);

  // ГОТОВНОСТЬ ЗАГОТОВКИ на ПТО: дата готовности заготовки (plan.data_yes_zagot).
  // Не заполнена — отправлять нечего: первая Исходящая недоступна.
  const planExt = await db.get('SELECT data_yes_zagot FROM plan WHERE id = ?', [idPlana]);
  const zagotovkaReady = !!(planExt && planExt.data_yes_zagot && String(planExt.data_yes_zagot).trim() !== '');

  // Партия ГОТОВА к следующему шагу, когда: рейс доставлен И
  // (в шаге нет операций ИЛИ у партии ещё нет строк факта — легаси ИЛИ
  //  последняя операция шага закрыта фактом И выполненное количество
  //  последней операции довело партию до полного объёма — v9/v11;
  //  NULL-количество = полное количество партии, совместимость).
  const isReady = m => !!m.delivered && (
    m.ops_total === 0 ||
    (m.fakt_cnt || 0) === 0 ||
    (m.last_op_fakt_end != null && String(m.last_op_fakt_end).trim() !== '' &&
      ((parseFloat(m.done_qty != null ? m.done_qty : m.qty) || 0) >=
       (parseFloat(m.qty) || 0)))
  );

  let naPto = parseFloat(planQty) || 0;   // физически на ПТО
  let uKontr = 0;                          // физически у контрагента
  let readyPto = zagotovkaReady ? (parseFloat(planQty) || 0) : 0; // ГОТОВО к отправке с ПТО
  let readyKontr = 0;                      // ГОТОВО к отправке от контрагента
  let moved = false;                       // было ли первое перемещение партий
  let notReadyReason = null;               // причина, почему доступного количества нет

  // v9: ГОТОВОЕ количество по шагу — партия считается готовой только при
  // ПОЛНОМ выполненном количестве последней операции (>= количества
  // партии) и даёт в пул выполненное количество ПОСЛЕДНЕЙ операции шага
  // (kolvo_vypolneno последней по rowid; NULL/легаси = полное количество).
  // Частично выполненная партия остаётся «В работе» и в пул не попадает,
  // пока не доделана; количества промежуточных операций пул не ограничивают.
  const countReady = idShag => moves
    .filter(m => m.id_shag === idShag && isReady(m))
    .reduce((s, m) => s + (parseFloat(m.done_qty != null ? m.done_qty : m.qty) || 0), 0);

  for (const step of steps) {
    const reserved = orders
      .filter(r => r.id_shag === step.id_shag)
      .reduce((s, r) => s + (parseFloat(r.qty) || 0), 0);
    const delivered = moves
      .filter(m => m.id_shag === step.id_shag && m.delivered)
      .reduce((s, m) => s + (parseFloat(m.qty) || 0), 0);
    const ready = countReady(step.id_shag);

    // ГОТОВНОСТЬ != НАЛИЧИЕ: объясняем корневую причину отсутствия доступного
    if (!notReadyReason) {
      if (!moved && step.napravlenie === 'Исходящая' && !zagotovkaReady) {
        notReadyReason = 'Заготовка не готова к отправке: в позиции плана не заполнена дата готовности заготовки (data_yes_zagot)';
      } else if (ready < delivered) {
        notReadyReason = 'Партии доставлены, но шаг завершён не полностью на стороне получателя: не у всего количества закрыта дата факта последней операции (fakt_marshruta.data_fakt_end) и/или выполненное количество (kolvo_vypolneno) меньше количества партии';
      }
    }

    if (step.napravlenie === 'Исходящая') {
      // точка отправления — ПТО: доступно ГОТОВОЕ к отправке минус резерв заявками
      const available = readyPto - reserved;
      if (available > 0) {
        return { naPto, uKontr, readyPto, readyKontr, currentStep: step, available, blockedStep: null, notReadyReason: null };
      }
      if (delivered > 0) {
        naPto -= delivered;   // ФАКТ: доставлено контрагенту
        uKontr += delivered;
      }
      // ГОТОВО: с ПТО уходят ВСЕ доставленные (готовые и нет),
      // к контрагенту готовы только завершённые шагом партии
      readyPto -= Math.min(readyPto, delivered);
      readyKontr += ready;
      if (reserved - delivered > 0) {
        // запланировано/в пути без доставки: шаг активен, но доступного нет
        return { naPto, uKontr, readyPto, readyKontr, currentStep: step, available: 0, blockedStep: step, notReadyReason };
      }
      moved = moved || delivered > 0 || ready > 0;
    } else {
      // точка отправления — контрагент
      const available = readyKontr - reserved;
      if (available > 0) {
        return { naPto, uKontr, readyPto, readyKontr, currentStep: step, available, blockedStep: null, notReadyReason: null };
      }
      if (delivered > 0) {
        uKontr -= delivered;  // ФАКТ: доставлено на ПТО
        naPto += delivered;
      }
      // ГОТОВО: от контрагента уходят ВСЕ доставленные, на ПТО возвращаются
      // готовые (завершённые шагом) партии
      readyKontr -= Math.min(readyKontr, delivered);
      readyPto += ready;
      if (reserved - delivered > 0) {
        return { naPto, uKontr, readyPto, readyKontr, currentStep: step, available: 0, blockedStep: step, notReadyReason };
      }
      moved = moved || delivered > 0 || ready > 0;
    }
  }
  return { naPto, uKontr, readyPto, readyKontr, currentStep: null, blockedStep: null, notReadyReason };
}

// ================================================================
// АВТОСОЗДАНИЕ СТРОК ФАКТА (fakt_marshruta) для новой партии:
// при добавлении партии в рейс для каждой операции шага заявки
// (operatsii_marshruta.id_shag = plan_perevozok.id_shag) создаётся
// строка факта со статусом 'ожидание'. По этим строкам цех/ОТК
// заполняют плановые/фактические даты; data_fakt_end ПОСЛЕДНЕЙ
// операции шага — признак завершения шага на стороне получателя
// и готовности партии к следующему шагу (см. computePositionFlow).
// Повторный вызов не дублирует строки (защита id_gryz_poz + id_oper);
// при удалении партии строки факта удаляются FK ON DELETE CASCADE.
// ================================================================
async function createFaktForPoz(db, pozId, planPerevozokId) {
  const ops = await db.all(`
    SELECT om.id_oper
    FROM operatsii_marshruta om
    JOIN plan_perevozok pp ON pp.id_shag = om.id_shag
    WHERE pp.id = ?
    ORDER BY om.rowid
  `, [planPerevozokId]);
  for (const op of ops) {
    const exists = await db.get(
      'SELECT id FROM fakt_marshruta WHERE id_gryz_poz = ? AND id_oper = ?',
      [pozId, op.id_oper]
    );
    if (!exists) {
      await db.run(
        `INSERT INTO fakt_marshruta (id, id_gryz_poz, id_oper, status_operatsii)
         VALUES (?, ?, ?, 'ожидание')`,
        [generateId('FM'), pozId, op.id_oper]
      );
    }
  }
}

// Проверка заявки плана перевозок при добавлении партии в рейс:
// остаток заявки (заявка минус партии других рейсов) + направление шага =
// направлению рейса; для обычных заявок — КП позиции плана и заявка на
// активном шаге позиции (по факту рейсов). Заявки брака (id_plana пуст)
// проверяются только на остаток и направление.
async function checkPlanPozForTrip(db, pozId, addNo, addYes, excludeTripId, tripDirection) {
  const ppr = await db.get(`
    SELECT id, id_plana, id_brak, id_shag,
           COALESCE(kolvo_no_br, 0) as kolvo_no_br,
           COALESCE(kolvo_yes_br, 0) as kolvo_yes_br
    FROM plan_perevozok WHERE id = ?
  `, [pozId]);
  if (!ppr) return 'Заявка плана перевозок не найдена';

  const addQty = (parseFloat(addNo) || 0) + (parseFloat(addYes) || 0);
  if (addQty <= 0) return 'Количество партии должно быть больше 0';

  const qtyPlan = (parseFloat(ppr.kolvo_no_br) || 0) + (parseFloat(ppr.kolvo_yes_br) || 0);
  const loadedRow = await db.get(`
    SELECT COALESCE(SUM(gp.kolvo_no_br), 0) + COALESCE(SUM(gp.kolvo_yes_br), 0) as loaded
    FROM gryz_poz gp
    WHERE gp.id_plana = ? AND gp.id_transporta != ?
  `, [pozId, excludeTripId || '']);
  const loaded = parseFloat(loadedRow?.loaded) || 0;
  if (addQty > qtyPlan - loaded) {
    return `Остаток заявки ${qtyPlan - loaded} шт. (заявка на ${qtyPlan} шт., в рейсах уже ${loaded} шт.) — нельзя добавить ${addQty} шт.`;
  }

  // Направление шага заявки должно совпадать с направлением рейса
  const dir = await db.get(`
    SELECT tp.napravlenie
    FROM shagi_marshruta sm
    JOIN transport_types tp ON sm.id_tipa_perevozki = tp.id_tipa
    WHERE sm.id_shag = ?
  `, [ppr.id_shag]);
  if (dir && tripDirection && dir.napravlenie !== tripDirection) {
    return `Шаг заявки имеет направление «${dir.napravlenie}», а рейс — «${tripDirection}»`;
  }

  // Обычная заявка: позиция плана с КП и заявка на активном шаге позиции
  if (ppr.id_plana) {
    const planRow = await db.get('SELECT id_kp, is_no_kp_plan, plan_god_kolvo FROM plan WHERE id = ?', [ppr.id_plana]);
    if (!planRow) return 'Позиция плана не найдена';
    if (!planRow.id_kp || planRow.is_no_kp_plan === 1) {
      return 'Позиция плана не имеет КП (подрядчика) — перевозка не планируется';
    }
    const flow = await computePositionFlow(db, ppr.id_plana, planRow.plan_god_kolvo);
    if (!flow.currentStep || flow.currentStep.id_shag !== ppr.id_shag) {
      if (flow.notReadyReason) return flow.notReadyReason;
      return `Заявка не на активном шаге маршрута позиции${flow.currentStep ? ` (активный шаг — №${flow.currentStep.nom_shag} (${flow.currentStep.nazvanie_operatsii}))` : ''} — добавление в рейс запрещено`;
    }
  }
  return null;
}

// ================================================================
// ✅ T43: хелперы письма «СЗ в СБ об отгрузке» (шаблон ЭДО 65133697) —
// общие для POST_SZ_SB_PREVIEW (предпросмотр в модальном окне) и
// POST_CREATE_SZ_SB (создание письма на портале).
// ================================================================

// Выборка заказов по транспортным позициям: gryz_poz -> plan_perevozok ->
// plan -> poz_zakaz_dogovora -> zakaz_po_dogovoru -> dogovor -> firmy.
// У заказа свой договор; ssylka_reshenie — файл ПОДПИСАННОГО заказа
// (страница «Заказы по договорам», шаг 2 «Решение контрагента») — именно
// он прикрепляется к письму (T43; генерация Excel отменена).
function szSbCollectRows(db, transId) {
  return db.all(`
    SELECT DISTINCT f.naimenovanie AS firma_name,
           z.id AS zakaz_id, z.nomer_zakaza, z.data_zakaza,
           z.ssylka_reshenie,
           d.nom_dogovor, d.data_dogovor
    FROM gryz_poz gp
    JOIN plan_perevozok pp ON pp.id = gp.id_plana
    JOIN plan p ON p.id = pp.id_plana
    JOIN poz_zakaz_dogovora pzd ON pzd.id_plana = p.id
    JOIN zakaz_po_dogovoru z ON z.id = pzd.id_zakaza_po_dogovoru
    JOIN dogovor d ON d.id_dogovor = z.id_dogovora
    JOIN firmy f ON f.id_firmy = d.id_firmy
    WHERE gp.id_transporta = ?
    ORDER BY f.naimenovanie, z.data_zakaza, z.nomer_zakaza
  `, [transId]);
}

// Группировка: Map «фирма» -> её заказы (порядок вставки = порядок фирм)
function szSbGroupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.firma_name)) groups.set(r.firma_name, []);
    groups.get(r.firma_name).push(r);
  }
  return groups;
}

// Файл подписанного заказа по ssylka_reshenie. В БД — ОТНОСИТЕЛЬНЫЙ путь
// от директории работы скрипта: «/uploads/zakaz/<имя>» (от каталога
// public), возможны варианты «public/uploads/...»/«uploads/...» от корня.
// Возвращаем абсолютный путь первого существующего файла или null.
function szSbResolveFile(appRoot, rel) {
  const s = String(rel || '').trim();
  if (!s) return null;
  let dec = s;
  try { dec = decodeURIComponent(s); } catch (e) { /* оставляем как есть */ }
  const pub = path.join(appRoot, 'public');
  const clean = dec.replace(/^\/+/, '');
  const cands = [
    path.normalize(path.join(pub, clean)),     // /uploads/zakaz/x — от public
    path.normalize(path.join(appRoot, clean))  // public/... или uploads/... — от корня приложения
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (e) { /* пробуем следующий вариант */ }
  }
  return null;
}

// HTML-текст письма (разметка как в письмах портала): приветствие
// «Уважаемый …!» — ПО ЦЕНТРУ, у абзацев первая строка — отступ 10
// пробелов (&nbsp; × 10).
const SZ_SB_INDENT = '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;';
function szSbBuildLetter(rows, groups, vidGruza) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const toRuDate = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v || '').trim();
  };
  const vid = String(vidGruza || '').trim().toLowerCase();
  const fraza = vid === 'listy'
    ? 'заготовок в листах проложенных деревянным брусом из подручных материалов'
    : (vid === 'prutki'
      ? 'заготовок в прутках проложенных деревянным брусом из подручных материалов'
      : 'заготовок на деревянной таре изготовленной из подручных материалов');
  const AVTOVAZ_NAME = 'АО "АВТОВАЗ"';
  const parts = [];
  parts.push('<div align="center" style="text-align: center;">Уважаемый Александр Викторович!</div>');
  parts.push('<div><br /></div>');
  for (const [firmaName, orders] of groups) {
    // у фирмы несколько заказов — каждый со своим договором, «, а также»
    const seg = orders.map((o, i) => {
      const t = `на основании договора № ${esc(o.nom_dogovor)} от ${esc(toRuDate(o.data_dogovor))}` +
        ` и оформленного заказа № ${esc(o.nomer_zakaza)} от ${esc(toRuDate(o.data_zakaza))}`;
      return i === 0 ? t : ' , а также ' + t;
    }).join(' ');
    parts.push(`<div>${SZ_SB_INDENT}Прошу Вас, разрешить отгрузку с производственной площадки ПТО ${esc(AVTOVAZ_NAME)}` +
      ` в г. Ульяновск ${esc(firmaName)} ${fraza} для выполнения механической обработки` +
      ` и возврата готовых деталей после выполнения работ ${seg} .</div>`);
  }
  parts.push('<div><br /></div>');
  const pril = rows.map((o) =>
    `заказ № ${esc(o.nomer_zakaza)} от ${esc(toRuDate(o.data_zakaza))} к договору ${esc(o.nom_dogovor)}`
  ).join(', ');
  parts.push(`<div>${SZ_SB_INDENT}Приложение:  ${pril}.</div>`);
  return parts.join('\r\n');
}

module.exports = (db, wsManager) => ({

  // ========================================================================
  // GET — список операций (ИСПОЛЬЗУЕТ buildSyntheticQuery).
  // ✅ СТАТУС — ВЫЧИСЛЯЕМОЕ ПОЛЕ по датам отправки/прибытия от текущей
  // даты (TRANSPORT_STATUS_SQL в syntheticTables.js); фильтр по статусу
  // идёт в SQL по тому же выражению.
  // ========================================================================
  async GET(req, res, url) {
    try {
      const { sql, params } = buildSyntheticQuery('transportOps.list', {
        napravlenie: url.searchParams.get('napravlenie'),
        idFirma: url.searchParams.get('id_firma'),
        status: url.searchParams.get('status')
      });

      const result = await db.all(sql, params);
      send(res, 200, result);
    } catch (e) {
      console.error('[transportOperRoutes.GET] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // GET_POZ — позиции операции (ИСПОЛЬЗУЕТ buildSyntheticQuery).
  // ✅ НОВАЯ СХЕМА: выборка описана в syntheticTables.js ->
  // 'transportOps.positions': tip_perevozki и nom_shag берутся через
  // заявку -> shagi_marshruta -> transport_types, detal_status_pto удалена.
  // ========================================================================
  async GET_POZ(req, res, url) {
    try {
      const transId = url.searchParams.get('transId');
      if (!transId) return send(res, 400, { error: 'transId не указан' });

      const { sql, params } = buildSyntheticQuery('transportOps.positions', { transId });
      const rows = await db.all(sql, params);
      // ✅ ЗАТРАТЫ: построчные параметры (VBA BuildTransportArray)
      rows.forEach(r => enrichPozRow(r, safeNumRu(r.kolvo_no_br) + safeNumRu(r.kolvo_yes_br)));
      send(res, 200, rows);
    } catch (e) {
      console.error('[transportOperRoutes.GET_POZ] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // GET_AVAILABLE — доступные позиции (ИСПОЛЬЗУЕТ buildSyntheticQuery).
  // Базовая выборка — syntheticTables.js -> 'transportOps.available'
  // (НОВАЯ СХЕМА: тип/№ этапа через shagi_marshruta; только позиции с КП;
  // остаток = заявка минус партии, уже загруженные в рейсы).
  // В роуте остаётся то, что SQL не умеет:
  // - АКТИВНЫЙ ШАГ позиции по факту рейсов (computePositionFlow):
  //   показывается только текущий шаг, не наступившие шаги скрыты;
  // - текстовые фильтры в JS: SQLite LIKE регистрозависим для кириллицы.
  // Заявки брака (id_plana пуст) — без требований КП/шага.
  // ========================================================================
  async GET_AVAILABLE(req, res, url) {
    try {
      const direction = url.searchParams.get('direction');
      if (!direction) {
        return send(res, 400, { error: 'direction обязателен' });
      }

      const { sql, params } = buildSyntheticQuery('transportOps.available', { direction });
      const rows = await db.all(sql, params);

      const idFirma = url.searchParams.get('id_firma') || '';
      const nomerChertezha = (url.searchParams.get('nomer_chertezha') || '').toLowerCase();
      const naimenovanie = (url.searchParams.get('naimenovanie') || '').toLowerCase();
      const nomDogovor = (url.searchParams.get('nom_dogovor') || '').toLowerCase();

      const flowCache = {};
      const result = [];
      for (const r of rows) {
        const availNo = (parseFloat(r.plan_kolvo_no_br) || 0) - (parseFloat(r.loaded_no_br) || 0);
        const availYes = (parseFloat(r.plan_kolvo_yes_br) || 0) - (parseFloat(r.loaded_yes_br) || 0);
        if (availNo <= 0 && availYes <= 0) continue;   // страховка поверх SQL-фильтра остатка

        if (r.id_plana) {
          // обычная заявка: у КП должна быть фирма-подрядчик
          if (!r.plan_id || !r.id_firma) continue;
          // шаг заявки должен быть активным шагом позиции (по факту рейсов)
          if (!(r.id_plana in flowCache)) {
            const planRow = await db.get('SELECT plan_god_kolvo FROM plan WHERE id = ?', [r.id_plana]);
            flowCache[r.id_plana] = planRow
              ? await computePositionFlow(db, r.id_plana, planRow.plan_god_kolvo)
              : null;
          }
          const flow = flowCache[r.id_plana];
          if (!flow || !flow.currentStep || flow.currentStep.id_shag !== r.id_shag) continue;
        }

        if (idFirma && r.id_firma !== idFirma) continue;
        // ✅ Кир→Лат: гомоглифы через общий хелпер (homoglyphs.js)
        if (nomerChertezha && !hgMatches(r.nomer_chertezha, nomerChertezha)) continue;
        if (naimenovanie && !hgMatches(r.osn_naimenovanie, naimenovanie)) continue;
        if (nomDogovor && !hgMatches(r.nom_dogovor, nomDogovor)) continue;

        // ✅ ЗАТРАТЫ: построчные параметры по ОСТАТКУ заявки (VBA BuildTransportArray)
        enrichPozRow(r, availNo + availYes);
        result.push({
          ...r,
          available_no_br: availNo,
          available_yes_br: availYes
        });
      }

      send(res, 200, result);
    } catch (e) {
      console.error('[transportOperRoutes.GET_AVAILABLE] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // POST — создание операции (транзакция + notifyWithDependencies)
  // ========================================================================
  async POST(req, res) {
    try {
      const d = await parseBody(req);

      if (!d.napravlenie || !d.otgruzka_data) {
        return send(res, 400, { error: 'Обязательные поля: направление, дата отгрузки' });
      }
      if (!d.positions || !Array.isArray(d.positions) || d.positions.length === 0) {
        return send(res, 400, { error: 'Добавьте хотя бы одну позицию' });
      }

      const idFirma = normalizeFk(d.id_firma);
      const idPerevozchik = normalizeFk(d.id_perevozchik);

      const firmaCheck = await validateFk(db, 'firmy', 'id_firmy', idFirma, 'Фирма');
      if (!firmaCheck.ok) return send(res, 400, { error: firmaCheck.error });

      const pervozCheck = await validateFk(db, 'perevozchik', 'id', idPerevozchik, 'Перевозчик');
      if (!pervozCheck.ok) return send(res, 400, { error: pervozCheck.error });

      // ✅ T57: tarn_mesta — производные общие поля вычисляются ДО сборки
      // параметров INSERT (в UI общих полей нет; tarn_places/brutto/габариты/
      // объём/штабелируемость/vid_gruza выводятся из групп тарных мест)
      const tarnDerivedPost = tarnMestaDerived(d.tarn_mesta);
      if (tarnDerivedPost) {
        d.tarn_places = tarnDerivedPost.tarn_places;
        d.brutto_ves_kg = tarnDerivedPost.brutto_ves_kg;
        d.dlina_m = tarnDerivedPost.dlina_m;
        d.shirina_m = tarnDerivedPost.shirina_m;
        d.vysota_m = tarnDerivedPost.vysota_m;
        d.obem_m3 = tarnDerivedPost.obem_m3;
        d.shtabil_gryz = tarnDerivedPost.shtabil_gryz;
        if (tarnDerivedPost.vid_gruza) d.vid_gruza = tarnDerivedPost.vid_gruza;
      }

      // ✅ ИСПРАВЛЕНО: проверяем FK в plan_perevozok, а не в plan!
      const planPerevozokIds = d.positions.map(p => p.id_plana).filter(id => id);
      const plansCheck = await validateFkArray(db, 'plan_perevozok', 'id', planPerevozokIds, 'Позиции плана перевозок');
      if (!plansCheck.ok) return send(res, 400, { error: plansCheck.error });

      // ✅ НОВЫЙ АЛГОРИТМ: каждая позиция — заявка на активном шаге позиции
      // плана, с КП и в пределах остатка; направление шага = направлению рейса
      for (const pos of d.positions) {
        const errPoz = await checkPlanPozForTrip(
          db, pos.id_plana,
          parseFloat(pos.kolvo_no_br) || 0, parseFloat(pos.kolvo_yes_br) || 0,
          null, d.napravlenie
        );
        if (errPoz) return send(res, 400, { error: errPoz });
      }

      await db.run('BEGIN TRANSACTION');
      let operId;
      try {
        operId = generateId('TO');
        await db.run(`
          INSERT INTO transport_oper (
            id, napravlenie, id_firma, gruz_name, opasnost_class, tarn_places,
            dlina_m, shirina_m, vysota_m, obem_m3, shtabil_gryz, brutto_ves_kg,
            otgruzka_data, otgruzka_vremya, pribytie_data, pribytie_vremya,
            nomer_reisa, transport_tip, zagruzka_sposob, temp_rezhim, tn_oformlenie,
            kommentariy, platelshchik, stoimost_perovozki, form_m15upd,
            tn_nomer, id_perevozchik, zatrata_prisvoenie,
            sz_transport_nomer, sz_transport_data, sz_sb_otgruzka, sz_sb_otgruzka_data,
            status, otv_pto_fio, otv_pog_pto_fio, otv_pog_firm_fio,
            adres_pog_firm, cex_izgot, vid_gruza, tarn_mesta
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
          operId, d.napravlenie, idFirma, d.gruz_name || '', d.opasnost_class || '',
          d.tarn_places || '', d.dlina_m || '', d.shirina_m || '', d.vysota_m || '',
          d.obem_m3 || '', d.shtabil_gryz || '', d.brutto_ves_kg || '',
          d.otgruzka_data || '', d.otgruzka_vremya || '', d.pribytie_data || '',
          d.pribytie_vremya || '', d.nomer_reisa || '', d.transport_tip || '',
          d.zagruzka_sposob || '', d.temp_rezhim || '', d.tn_oformlenie || '',
          d.kommentariy || '', d.platelshchik || '', d.stoimost_perovozki || '',
          d.form_m15upd || '', d.tn_nomer || '', idPerevozchik,
          d.zatrata_prisvoenie || '', d.sz_transport_nomer || '',
          d.sz_transport_data || '', d.sz_sb_otgruzka || '', d.sz_sb_otgruzka_data || '',
          d.status || 'Новая', d.otv_pto_fio || '', d.otv_pog_pto_fio || '',
          d.otv_pog_firm_fio || '', d.adres_pog_firm || '', d.cex_izgot || '',
          d.vid_gruza || '',
          // ✅ T57: tarn_mesta (производные уже вычислены выше, до INSERT)
          typeof d.tarn_mesta === 'string' ? d.tarn_mesta
            : (Array.isArray(d.tarn_mesta) ? JSON.stringify(d.tarn_mesta) : '')
        ]);

        const addedPozIds = [];
        for (const pos of d.positions) {
          if (!pos.id_plana) throw new Error(`Позиция без id_plana`);
          const pozId = generateId('GP');
          // T56-b: марка-факт — из запроса, иначе конструкторская из оснастки
          const markaFact = pozMarkaFact(pos.marka_materiala, await osnMarkaForPlan(db, pos.id_plana));
          await db.run(`
            INSERT INTO gryz_poz (id, id_transporta, id_plana, kolvo_no_br, kolvo_yes_br, primechanie, kolvo_zagotovok, marka_materiala, tip_gruza, prutok_diametr, tara_dlina, tara_shirina, tara_vysota, ukladka)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `, [
            pozId, operId, pos.id_plana,
            parseFloat(pos.kolvo_no_br) || 0,
            parseFloat(pos.kolvo_yes_br) || 0,
            pos.primechanie || '',
            String(pos.kolvo_zagotovok || '').trim(), // T24B: кол-во заготовок грузовой позиции ('' = авто)
            markaFact, // T56-b: марка материала (факт)
            // ✅ T57: тип груза позиции (listy/prutki/zagotovki) + параметры типа
            String(pos.tip_gruza || '').trim(),
            String(pos.prutok_diametr == null ? '' : pos.prutok_diametr).trim(),
            String(pos.tara_dlina == null ? '' : pos.tara_dlina).trim(),
            String(pos.tara_shirina == null ? '' : pos.tara_shirina).trim(),
            String(pos.tara_vysota == null ? '' : pos.tara_vysota).trim(),
            String(pos.ukladka || '').trim()
          ]);
          // ✅ СТРОКИ ФАКТА: операции шага заявки -> fakt_marshruta ('ожидание')
          await createFaktForPoz(db, pozId, pos.id_plana);

          addedPozIds.push(pozId);
        }

        await db.run('COMMIT');

        // ✅ ИСПОЛЬЗУЕМ notifyWithDependencies
        const deps = new Set([
          ...getDependencies('transportOps.list'),
          ...getDependencies('transportOps.positions'),
          ...getDependencies('transportOps.available')
        ]);
        wsManager.notifyWithDependencies(deps, 'add', operId);

        send(res, 201, {
          id: operId,
          positionsCount: addedPozIds.length,
          message: `Операция создана. Позиций: ${addedPozIds.length}`
        });
      } catch (innerErr) {
        await db.run('ROLLBACK');
        send(res, 500, { error: `Ошибка создания: ${innerErr.message}`, rolledBack: true });
      }
    } catch (e) {
      console.error('[transportOperRoutes.POST] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // PUT — обновление операции (транзакция + notifyWithDependencies)
  // ========================================================================
  async PUT(req, res, url) {
    try {
      const transId = url.pathname.split('/')[3];
      if (!transId) return send(res, 400, { error: 'ID не указан' });

      const existing = await db.get('SELECT id, napravlenie FROM transport_oper WHERE id = ?', [transId]);
      if (!existing) return send(res, 404, { error: 'Операция не найдена' });

      const d = await parseBody(req);
      const idFirma = normalizeFk(d.id_firma);
      const idPerevozchik = normalizeFk(d.id_perevozchik);

      const firmaCheck = await validateFk(db, 'firmy', 'id_firmy', idFirma, 'Фирма');
      if (!firmaCheck.ok) return send(res, 400, { error: firmaCheck.error });

      const pervozCheck = await validateFk(db, 'perevozchik', 'id', idPerevozchik, 'Перевозчик');
      if (!pervozCheck.ok) return send(res, 400, { error: pervozCheck.error });

      // ✅ T57: tarn_mesta — производные общие поля ДО сборки параметров UPDATE
      const tarnDerivedPut = tarnMestaDerived(d.tarn_mesta);
      if (tarnDerivedPut) {
        d.tarn_places = tarnDerivedPut.tarn_places;
        d.brutto_ves_kg = tarnDerivedPut.brutto_ves_kg;
        d.dlina_m = tarnDerivedPut.dlina_m;
        d.shirina_m = tarnDerivedPut.shirina_m;
        d.vysota_m = tarnDerivedPut.vysota_m;
        d.obem_m3 = tarnDerivedPut.obem_m3;
        d.shtabil_gryz = tarnDerivedPut.shtabil_gryz;
        if (tarnDerivedPut.vid_gruza) d.vid_gruza = tarnDerivedPut.vid_gruza;
      }

      if (d.positions && Array.isArray(d.positions)) {
        if (d.positions.length === 0) {
          return send(res, 400, { error: 'Нельзя сохранить без позиций' });
        }
        // ✅ ИСПРАВЛЕНО: проверяем FK в plan_perevozok
        const planPerevozokIds = d.positions.map(p => p.id_plana).filter(id => id);
        const plansCheck = await validateFkArray(db, 'plan_perevozok', 'id', planPerevozokIds, 'Позиции плана перевозок');
        if (!plansCheck.ok) return send(res, 400, { error: plansCheck.error });

        // ✅ НОВЫЙ АЛГОРИТМ: заявки — на активном шаге, с КП, в пределах остатка
        // (партии самого рейса исключаются из расчёта: они пересоздаются)
        for (const pos of d.positions) {
          const errPoz = await checkPlanPozForTrip(
            db, pos.id_plana,
            parseFloat(pos.kolvo_no_br) || 0, parseFloat(pos.kolvo_yes_br) || 0,
            transId, d.napravlenie || existing.napravlenie
          );
          if (errPoz) return send(res, 400, { error: errPoz });
        }
      }

      await db.run('BEGIN TRANSACTION');
      try {
        // ✅ СТАТУС НЕ ПИШЕМ: transport_oper.status — вычисляемое поле по
        // датам отправки/прибытия от текущей даты (TRANSPORT_STATUS_SQL в
        // syntheticTables.js). Прежний код при КАЖДОМ сохранении записывал
        // d.status || 'Изменена' — статуса «Изменена» нет в бизнес-логике
        // (его нет в комбобоксе фильтра статуса), и он ломал фильтрацию
        // списка. Хранимая колонка при правке не перезаписывается.
        await db.run(`
          UPDATE transport_oper SET
            id_firma=?, gruz_name=?, opasnost_class=?, tarn_places=?,
            dlina_m=?, shirina_m=?, vysota_m=?, obem_m3=?, shtabil_gryz=?,
            brutto_ves_kg=?, otgruzka_data=?, otgruzka_vremya=?,
            pribytie_data=?, pribytie_vremya=?, nomer_reisa=?,
            transport_tip=?, zagruzka_sposob=?, temp_rezhim=?, tn_oformlenie=?,
            kommentariy=?, platelshchik=?, stoimost_perovozki=?, form_m15upd=?,
            tn_nomer=?, id_perevozchik=?, zatrata_prisvoenie=?,
            sz_transport_nomer=?, sz_transport_data=?, sz_sb_otgruzka=?, sz_sb_otgruzka_data=?,
            sz_transport_id=?, sz_sb_id=?,
            otv_pto_fio=?, otv_pog_pto_fio=?, otv_pog_firm_fio=?,
            adres_pog_firm=?, cex_izgot=?, vid_gruza=?, tarn_mesta=?
          WHERE id=?
        `, [
          idFirma, d.gruz_name || '', d.opasnost_class || '', d.tarn_places || '',
          d.dlina_m || '', d.shirina_m || '', d.vysota_m || '', d.obem_m3 || '',
          d.shtabil_gryz || '', d.brutto_ves_kg || '', d.otgruzka_data || '',
          d.otgruzka_vremya || '', d.pribytie_data || '', d.pribytie_vremya || '',
          d.nomer_reisa || '', d.transport_tip || '', d.zagruzka_sposob || '',
          d.temp_rezhim || '', d.tn_oformlenie || '', d.kommentariy || '',
          d.platelshchik || '', d.stoimost_perovozki || '', d.form_m15upd || '',
          d.tn_nomer || '', idPerevozchik, d.zatrata_prisvoenie || '',
          d.sz_transport_nomer || '', d.sz_transport_data || '', d.sz_sb_otgruzka || '', d.sz_sb_otgruzka_data || '',
          // ✅ T86: ID документов — trim(), случайный пробел не ломает
          // ссылку портала docs.vaz.ru/main.aspx?d_kod=
          String(d.sz_transport_id || '').trim(), String(d.sz_sb_id || '').trim(),
          d.otv_pto_fio || '', d.otv_pog_pto_fio || '',
          d.otv_pog_firm_fio || '', d.adres_pog_firm || '', d.cex_izgot || '',
          d.vid_gruza || '',
          // ✅ T57: tarn_mesta (производные уже вычислены выше, до UPDATE)
          typeof d.tarn_mesta === 'string' ? d.tarn_mesta
            : (Array.isArray(d.tarn_mesta) ? JSON.stringify(d.tarn_mesta) : ''),
          transId
        ]);

        let addedPozIds = [];
        if (d.positions) {
          await db.run('DELETE FROM gryz_poz WHERE id_transporta = ?', [transId]);
          for (const pos of d.positions) {
            const pozId = generateId('GP');
            // T56-b: марка-факт — из запроса, иначе конструкторская из оснастки
            const markaFact = pozMarkaFact(pos.marka_materiala, await osnMarkaForPlan(db, pos.id_plana));
            await db.run(`
              INSERT INTO gryz_poz (id, id_transporta, id_plana, kolvo_no_br, kolvo_yes_br, primechanie, kolvo_zagotovok, marka_materiala)
              VALUES (?,?,?,?,?,?,?,?)
            `, [
              pozId, transId, pos.id_plana,
              parseFloat(pos.kolvo_no_br) || 0,
              parseFloat(pos.kolvo_yes_br) || 0,
              pos.primechanie || '',
              String(pos.kolvo_zagotovok || '').trim(), // T24B: кол-во заготовок грузовой позиции ('' = авто)
              markaFact // T56-b: марка материала (факт)
            ]);
            // ✅ СТРОКИ ФАКТА: партии пересозданы -> fakt_marshruta заново
            await createFaktForPoz(db, pozId, pos.id_plana);

            addedPozIds.push(pozId);
          }
        }

        await db.run('COMMIT');

        // ✅ ИСПОЛЬЗУЕМ notifyWithDependencies
        const deps = new Set([
          ...getDependencies('transportOps.list'),
          ...getDependencies('transportOps.positions'),
          ...getDependencies('transportOps.available')
        ]);
        wsManager.notifyWithDependencies(deps, 'update', transId);

        send(res, 200, { ok: true, positionsCount: addedPozIds.length });
      } catch (innerErr) {
        await db.run('ROLLBACK');
        send(res, 500, { error: `Ошибка сохранения: ${innerErr.message}`, rolledBack: true });
      }
    } catch (e) {
      console.error('[transportOperRoutes.PUT] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // DELETE — удаление с каскадом + notifyWithDependencies
  // ========================================================================
  async DELETE(req, res, url) {
    try {
      const transId = url.pathname.split('/')[3];
      if (!transId) return send(res, 400, { error: 'ID не указан' });

      await db.run('BEGIN TRANSACTION');
      await db.run('DELETE FROM transport_oper WHERE id = ?', [transId]);
      await db.run('COMMIT');

      // ✅ ИСПОЛЬЗУЕМ notifyWithDependencies
      const deps = new Set([
        ...getDependencies('transportOps.list'),
        ...getDependencies('transportOps.positions'),
        ...getDependencies('transportOps.available')
      ]);
      wsManager.notifyWithDependencies(deps, 'delete', transId);

      send(res, 200, { ok: true });
    } catch (e) {
      await db.run('ROLLBACK').catch(() => {});
      console.error('[transportOperRoutes.DELETE] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ ТИПЫ ГРУЗА: GET_GRUZ_NAMES — ранее введённые значения «Наименование»
  // (VBA cbGruzName: fmStyleDropDownCombo — свободный ввод не заблокирован;
  // список наполняется из СОХРАНЁННЫХ операций, фильтр «по содержимому» —
  // на клиенте). Новое введённое значение попадает в список после записи.
  // ========================================================================
  async GET_GRUZ_NAMES(req, res) {
    try {
      const rows = await db.all(`
        SELECT DISTINCT gruz_name
        FROM transport_oper
        WHERE TRIM(COALESCE(gruz_name, '')) != ''
        ORDER BY gruz_name
        LIMIT 200
      `);
      send(res, 200, { names: rows.map(r => r.gruz_name) });
    } catch (e) {
      console.error('[transportOperRoutes.GET_GRUZ_NAMES] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ ПАРАМЕТРЫ ПЕРЕВОЗКИ: GET_SELECT_LISTS — ранее введённые значения
  // «Тип транспорта», «Способ загрузки» и ФРАГМЕНТЫ «Комментария»
  // (VBA cbTransportTip / cbZagruzkaSposob / cbListKomment: списки дизайнера
  // формы невосстановимы — источник два: базовые значения из кода VBA на
  // клиенте + история СОХРАНЁННЫХ операций здесь; комментарий хранится
  // строкой «треб1;треб2;...» — разбирается на фрагменты, как Split в
  // cmdDelTreb). Свободный ввод не заблокирован (fmStyleDropDownCombo).
  // ========================================================================
  async GET_SELECT_LISTS(req, res) {
    try {
      const tips = await db.all(`
        SELECT DISTINCT transport_tip AS v
        FROM transport_oper
        WHERE TRIM(COALESCE(transport_tip, '')) != ''
        ORDER BY v
        LIMIT 200
      `);
      const sposoby = await db.all(`
        SELECT DISTINCT zagruzka_sposob AS v
        FROM transport_oper
        WHERE TRIM(COALESCE(zagruzka_sposob, '')) != ''
        ORDER BY v
        LIMIT 200
      `);
      const rawKomments = await db.all(`
        SELECT DISTINCT kommentariy AS v
        FROM transport_oper
        WHERE TRIM(COALESCE(kommentariy, '')) != ''
        LIMIT 500
      `);
      // комментарий = комбинация требований через «;» (VBA: Split/join)
      const seen = new Set();
      const komments = [];
      rawKomments.forEach(r => {
        String(r.v || '').split(';').forEach(frag => {
          const tr = frag.trim();
          if (!tr || seen.has(tr.toLowerCase())) return;
          seen.add(tr.toLowerCase());
          komments.push(tr);
        });
      });
      komments.sort((a, b) => a.localeCompare(b, 'ru'));
      send(res, 200, {
        transport_tips: tips.map(r => r.v),
        zagruzka_sposoby: sposoby.map(r => r.v),
        komments
      });
    } catch (e) {
      console.error('[transportOperRoutes.GET_SELECT_LISTS] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ ТИПЫ ГРУЗА: POST_POZ_PARAMS — параметры раскроя заготовки по позиции
  // плана (лист: длина/ширина/толщина, мм; пруток: длина, мм).
  // T24B: kolvo_zagotovok — ручное кол-во заготовок ГРУЗОВОЙ ПОЗИЦИИ
  // (gryz_poz, поле id_poz запроса; у каждой части партии/рейса своё);
  // пусто = авто по раскрою; для ШТУЧНЫХ равно кол-ву отправляемых деталей.
  // Размеры заготовки (лист/пруток) — свойство позиции плана, общее для рейсов.
  // Пустые поля = деталь/заготовка ШТУЧНЫЕ (расчёт на поддонах).
  // ========================================================================
  async POST_POZ_PARAMS(req, res) {
    try {
      const d = await parseBody(req);
      const planId = String(d.id_plana || '').trim();
      if (!planId) return send(res, 400, { error: 'id_plana не указан' });

      const planRow = await db.get('SELECT id FROM plan WHERE id = ?', [planId]);
      if (!planRow) return send(res, 404, { error: 'Позиция плана не найдена: ' + planId });

      // T24B: «Кол-во заготовок» — атрибут ГРУЗОВОЙ ПОЗИЦИИ (gryz_poz), не плана:
      // партию плана возят частями (несколько рейсов), и у каждой части своё
      // количество заготовок — иначе значения рейсов затирают друг друга.
      // Валидация id_poz ДО записи: 404 не должен частично применить запрос.
      const pozId = String(d.id_poz || '').trim();
      if (pozId) {
        const pozRow = await db.get(`
          SELECT gp.id FROM gryz_poz gp
          JOIN plan_perevozok pp ON pp.id = gp.id_plana
          WHERE gp.id = ? AND pp.id_plana = ?
        `, [pozId, planId]);
        if (!pozRow) return send(res, 404, { error: 'Грузовая позиция не найдена: ' + pozId });
      }

      await db.run(`
        UPDATE plan SET
          list_dlina = ?, list_shirina = ?, list_tolshina = ?, prutok_dlina = ?
        WHERE id = ?
      `, [
        String(d.list_dlina || '').trim(),
        String(d.list_shirina || '').trim(),
        String(d.list_tolshina || '').trim(),
        String(d.prutok_dlina || '').trim(),
        planId
      ]);

      if (pozId) {
        // T56-b: марка материала — факт (что везём); пусто = как в оснастке
        await db.run('UPDATE gryz_poz SET kolvo_zagotovok = ?, marka_materiala = ? WHERE id = ?', [
          String(d.kolvo_zagotovok || '').trim(), // '' = авто по раскрою
          String(d.marka_materiala == null ? '' : d.marka_materiala).trim(),
          pozId
        ]);
      }

      const deps = new Set([
        ...getDependencies('transportOps.available'),
        ...getDependencies('transportOps.positions')
      ]);
      wsManager.notifyWithDependencies(deps, 'update', pozId || planId);

      send(res, 200, { ok: true, id_plana: planId, id_poz: pozId || '' });
    } catch (e) {
      console.error('[transportOperRoutes.POST_POZ_PARAMS] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ ТИПЫ ГРУЗА: POST_CALC_TARA — расчёт тарных мест по виду груза.
  // tara: VBA CalculatePalletCountByOrder (поддон 1200x800; основание =
  //       грань с макс. площадью; негабарит = штука/поддон); габариты и вес
  //       НЕ трогаем (как в VBA).
  // listy: гильотинный раскрой (припуск LIST_PRIPUSK_MM на деталь):
  //       штук на листе = max двух ориентаций равномерной сетки;
  //       T56-b: позиции с ОДИНАКОВЫМ листом (Д×Ш×Т + марка материала)
  //       режутся ОБЩИМ раскроем: сортировка от крупной детали к мелкой,
  //       каждая позиция сначала добирает обрезки уже разрезанных листов
  //       группы (свободные прямоугольники после сетки), затем открывает
  //       новые листы; «листов» = фактически разрезанных;
  //       экономия = Σ(ceil по позициям без обмена) − разрезанных листов;
  //       места = ceil(Σ высоты стопок / LIST_STACK_LIMIT_MM) — листы
  //       штабелируются, лимит высоты места 1000 мм;
  //       вес листа = Д×Ш×Т×плотность (плотность из ves_zag оснастки,
  //       fallback — сталь).
  // prutki: резка прутка (припуск PRUTOK_PRIPUSK_MM):
  //       штук в прутке = floor(длина_прутка / (длина_детали + припуск));
  //       прутков = ceil(кол-во / штук-в-прутке); длина = макс. пруток,
  //       сечение = квадрат со стороной sqrt(Σ сечений прутков);
  //       вес прутка = (ves_zag / длина_детали) × длина_прутка.
  // T24B: ручное кол-во заготовок ГРУЗОВОЙ позиции (gryz_poz.kolvo_zagotovok > 0)
  //      перекрывает авторасчёт раскроя (листов/прутков).
  // Позиции БЕЗ параметров листа/прутка считаются ШТУЧНЫМИ (поддоны)
  // и добавляются к тарным местам операции (бизнес-правило).
  // T56 «Смешанный груз» (smesh): тип каждой позиции — по её параметрам
  // (лист -> листовая, пруток -> прутковая, иначе штучная); итог =
  // поддоны + места с листами (лимит 1000 мм) + 1 связка прутков.
  // ========================================================================
  async POST_CALC_TARA(req, res) {
    // ✅ T57: расчёт тарных мест НОВОГО модального диалога — по ТИПУ ГРУЗА
    // каждой позиции (listy / prutki / zagotovki). Движок — helpers/tarnCalc.js:
    //   listy     — групповой раскрой листов (T56-b) + ОДНО место «Пачки
    //               листов» (листы разных типоразмеров штабелируются:
    //               габарит = МАКС длина × МАКС ширина, лимит высоты стопки);
    //   prutki    — связки по Ø (prutok_diametr) — «Связки прутков» (штабел. да);
    //   zagotovki — деревянная тара: укладка (sloy/piramida/stoyma) — ручной
    //               параметр, КАЖДЫЙ типоразмер тары = ОТДЕЛЬНОЕ место (штабел. нет);
    //   правило нулей — лист из остатка приписывается позиции, режущей остаток.
    // Правило «больше N деталей → ящик» отменено (укладку задаёт пользователь).
    try {
      const d = await parseBody(req);
      const positions = Array.isArray(d.positions) ? d.positions : [];
      if (positions.length === 0) return send(res, 400, { error: 'Нет позиций для расчёта' });
      const r = tarnCalc.calcTarnMesta(positions);
      send(res, 200, r);
    } catch (e) {
      console.error('[transportOperRoutes.POST_CALC_TARA] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T57: POST_TARN_APPLY — «Применить и закрыть» модального диалога
  // «Расчёт тарных мест». Сохраняет в транзакции:
  //   1) transport_oper.tarn_mesta = JSON групп тарных мест;
  //   2) ПРОИЗВОДНЫЕ общие поля операции (в UI их больше нет):
  //      tarn_places = Σ мест, brutto_ves_kg = Σ вес, габариты = макс,
  //      объём = Σ (Д×Ш×В×кол-во), штабелируемость = «да» если есть
  //      штабелируемые места (нужно для строки 6 СЗ и совместимости);
  //   3) параметры позиций: tip_gruza / prutok_diametr / tara_* / ukladka /
  //      kolvo_zagotovok (авто-расчёт листов/прутков — пишется в «Заготовки»);
  //   4) параметры раскроя ПЛАНА (list_dlina/list_shirina/list_tolshina/
  //      prutok_dlina) — общие для рейсов, обновляются по id_plana.
  // Без id_transporta (режим создания) — только план-параметры; остальное
  // уйдёт с POST операции (pending позиции + tarn_mesta).
  // ========================================================================
  async POST_TARN_APPLY(req, res) {
    try {
      const d = await parseBody(req);
      const transId = String(d.id_transporta || '').trim();
      const positions = Array.isArray(d.positions) ? d.positions : [];
      const tm = d.tarn_mesta;
      let tmJson = '';
      if (Array.isArray(tm)) tmJson = JSON.stringify(tm);
      else if (typeof tm === 'string' && tm.trim().startsWith('[')) tmJson = tm.trim();

      await db.run('BEGIN TRANSACTION');
      try {
        // --- 1+2: операция (если сохранена)
        if (transId) {
          const oper = await db.get('SELECT id FROM transport_oper WHERE id = ?', [transId]);
          if (!oper) throw new Error('Операция не найдена');
          const derived = tarnMestaDerived(tmJson || []);
          await db.run(
            `UPDATE transport_oper SET tarn_mesta = ?, gruz_name = ?,
              tarn_places = ?, brutto_ves_kg = ?, dlina_m = ?, shirina_m = ?,
              vysota_m = ?, obem_m3 = ?, shtabil_gryz = ?, vid_gruza = ?
             WHERE id = ?`,
            [
              tmJson,
              String(d.gruz_name == null ? '' : d.gruz_name),
              derived ? derived.tarn_places : '',
              derived ? derived.brutto_ves_kg : '',
              derived ? derived.dlina_m : '',
              derived ? derived.shirina_m : '',
              derived ? derived.vysota_m : '',
              derived ? derived.obem_m3 : '',
              derived ? derived.shtabil_gryz : '',
              derived ? derived.vid_gruza : '',
              transId
            ]);
        }

        // --- 3+4: позиции
        for (const pos of positions) {
          const gpId = String(pos.id || '').trim();
          const planPozId = String(pos.id_plana || '').trim();
          // 4) план-параметры раскроя (лист/пруток) — общие для рейсов
          const planParams = {};
          ['list_dlina', 'list_shirina', 'list_tolshina', 'prutok_dlina'].forEach(k => {
            if (pos[k] !== undefined && pos[k] !== null) planParams[k] = String(pos[k]).trim();
          });
          const planKeys = Object.keys(planParams);
          if (planPozId && planKeys.length) {
            await db.run(
              `UPDATE plan SET ${planKeys.map(k => `${k} = ?`).join(', ')}
                WHERE id = (SELECT id_plana FROM plan_perevozok WHERE id = ?)`,
              [...planKeys.map(k => planParams[k]), planPozId]);
          }
          // 3) параметры грузовой позиции
          if (gpId && transId) {
            const exists = await db.get('SELECT id FROM gryz_poz WHERE id = ?', [gpId]);
            if (exists) {
              await db.run(
                `UPDATE gryz_poz SET tip_gruza = ?, prutok_diametr = ?,
                   tara_dlina = ?, tara_shirina = ?, tara_vysota = ?,
                   ukladka = ?, kolvo_zagotovok = ?, marka_materiala = ?
                 WHERE id = ?`,
                [
                  String(pos.tip_gruza || '').trim(),
                  String(pos.prutok_diametr == null ? '' : pos.prutok_diametr).trim(),
                  String(pos.tara_dlina == null ? '' : pos.tara_dlina).trim(),
                  String(pos.tara_shirina == null ? '' : pos.tara_shirina).trim(),
                  String(pos.tara_vysota == null ? '' : pos.tara_vysota).trim(),
                  String(pos.ukladka || '').trim(),
                  String(pos.kolvo_zagotovok == null ? '' : pos.kolvo_zagotovok).trim(),
                  String(pos.marka_materiala == null ? '' : pos.marka_materiala).trim(),
                  gpId
                ]);
            }
          }
        }

        await db.run('COMMIT');

        // --- WS: обновить списки операций/позиций/плана у всех клиентов
        const deps = new Set([
          ...getDependencies('transportOps.list'),
          ...getDependencies('transportOps.positions'),
          ...getDependencies('transportOps.available')
        ]);
        if (transId) wsManager.notifyWithDependencies(deps, 'update', transId);

        send(res, 200, {
          ok: true,
          tarn_mesta: tmJson,
          message: transId ? 'Тарные места сохранены' : 'Параметры позиций сохранены'
        });
      } catch (innerErr) {
        await db.run('ROLLBACK');
        send(res, 500, { error: `Ошибка сохранения тарных мест: ${innerErr.message}` });
      }
    } catch (e) {
      console.error('[transportOperRoutes.POST_TARN_APPLY] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // GET_ZATRAT_LISTS — справочники блока «Затраты» (ШПЗ/СБ пары, переделы,
  // цехи cex_zatrat). ЕДИНЫЙ источник для селектов вкладки «Параметры».
  // ========================================================================
  async GET_ZATRAT_LISTS(req, res) {
    try {
      const rows = await db.all('SELECT ceh, peredel, nazvanie FROM cex_zatrat ORDER BY ceh');
      const peredel = [];
      for (const r of rows) {
        const v = String(r.peredel || '').trim();
        if (v && !peredel.includes(v)) peredel.push(v);
      }
      send(res, 200, {
        shpz_sb: SHPZ_SB_LIST,
        peredel: peredel,
        ceh: rows.map(r => ({ ceh: r.ceh, peredel: r.peredel, nazvanie: r.nazvanie }))
      });
    } catch (e) {
      console.error('[GET_ZATRAT_LISTS] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // POST_AUTO_FILL — автозаполнение из позиций
  // ========================================================================
  async POST_AUTO_FILL(req, res) {
    try {
      const d = await parseBody(req);
      if (!d.positions || d.positions.length === 0) {
        return send(res, 400, { error: 'Нет позиций для расчёта' });
      }

      // ✅ АЛГОРИТМ VBA GetTransportSummary (modSHPZ_Peredel):
      // тип веса — по типу перевозки ПЕРВОЙ строки («Отправка заготовки» ->
      // вес заготовки, иначе вес детали); доминирующие ШПЗ/Передел/Цех —
      // по суммарной массе; общие масса и объём по всем позициям.
      const positions = d.positions;
      const weightType = String(positions[0].tip_perevozki || '').trim() === 'Отправка заготовки' ? 'zag' : 'det';
      const qtyOf = p => safeNumRu(p.kolvo_no_br) + safeNumRu(p.kolvo_yes_br);
      // ✅ T64 (баг 1): ШПЗ pending-позиций режима создания приходит в
      // поле shpz ('с'/'о'), у позиций редактирования — по заказу ПТО
      // (zak_pto). Принимаем ОБА источника — раньше только zak_pto,
      // и в режиме создания было «ШПЗ не определен».
      const shzOf = p => {
        const s = String(p.shpz == null ? '' : p.shpz).trim();
        return (s === 'с' || s === 'о') ? s : zakToShz(p.zak_pto);
      };
      // ✅ T64 (баг 1): масса — по единичному весу; если его нет
      // (pending старых сборок), берём уже посчитанный суммарный
      // вес ves_det_tot/ves_zag_tot (= единичный × кол-во).
      const massOf = p => {
        const unit = safeNumRu(weightType === 'det' ? p.ves_det : p.ves_zag);
        if (unit > 0) return unit * qtyOf(p);
        return safeNumRu(weightType === 'det' ? p.ves_det_tot : p.ves_zag_tot);
      };
      const volOf = p => round3(round3((safeNumRu(p.dlina) * safeNumRu(p.shirina) * safeNumRu(p.vysota)) / 1000000000) * qtyOf(p));

      let totalMass = 0;
      let totalVolume = 0;
      const shzMass = {};
      for (const p of positions) {
        totalMass += massOf(p);
        totalVolume += volOf(p);
        const shz = shzOf(p);   // ✅ T64: + shpz pending-позиций
        if (shz && shz !== 'ошибка') shzMass[shz] = (shzMass[shz] || 0) + massOf(p);
      }

      const argmax = dict => {
        let best = '', bestV = -1;
        for (const k of Object.keys(dict)) {
          if (dict[k] > bestV) { bestV = dict[k]; best = k; }
        }
        return best;
      };

      const dominantShz = argmax(shzMass);
      let dominantPeredel = '';
      let dominantCex = '';
      let noData = false;
      if (!dominantShz) {
        // VBA: если ни у одной позиции нет ШПЗ — результат пустой, суммы нулевые
        totalMass = 0;
        totalVolume = 0;
        noData = true;
      } else {
        const peredelMass = {};
        const cexMass = {};
        for (const p of positions) {
          if (shzOf(p) !== dominantShz) continue;   // ✅ T64
          const m = massOf(p);
          const per = String(p.peredel_poz || '').trim();
          const cex = String(p.ceh_izg || '').trim();
          if (per) peredelMass[per] = (peredelMass[per] || 0) + m;
          if (cex) cexMass[cex] = (cexMass[cex] || 0) + m;
        }
        dominantPeredel = argmax(peredelMass);
        dominantCex = argmax(cexMass);   // КОД цеха (ceh), не id!
      }

      const shpzName = SHPZ_NAME[dominantShz] || '';
      const sbPair = SHPZ_SB_LIST.find(x => x.shpz === shpzName);
      const sb = sbPair ? sbPair.sb : '';
      // VBA: zatrataPrisvoenie = ШПЗ ; Передел ; СБ
      const zatrata = [shpzName, dominantPeredel, sb].map(x => String(x || '').trim()).join(';');

      // VBA GetUniqueFromThirdColumn: уникальные НАИМЕНОВАНИЯ позиций
      const uniqueNaim = [];
      for (const p of positions) {
        const v = String(p.osn_naimenovanie || '').trim();
        if (v && !uniqueNaim.includes(v)) uniqueNaim.push(v);
      }

      send(res, 200, {
        no_data: noData,
        ves_type: weightType === 'zag' ? 'Заготовка' : 'Деталь',
        // ✅ T64 (баг 4): «Детали на деревянной таре» — как в VBA
        // CalculatePalletCountByOrder (комментарий в шапке файла),
        // а не «Детали на поддонах»
        gruz_name: `Детали на деревянной таре: ${uniqueNaim.join('; ')}`,
        shpz: shpzName,
        peredel: dominantPeredel,
        sb: sb,
        zatrata_prisvoenie: zatrata,
        cex_izgot: dominantCex,
        brutto_ves_kg: totalMass.toFixed(2),
        obem_m3: totalVolume.toFixed(3),
        nomer_reisa: 'FLEX',
        opasnost_class: 'нет',
        shtabil_gryz: 'нет',
        temp_rezhim: 'нет',
        platelshchik: 'АВТОВАЗ',
        tn_oformlenie: 'ТН оформляет Экспедитор/Перевозчик',
        transport_tip: 'Тентованный',
        zagruzka_sposob: 'Задняя/Боковая',
        kommentariy: (String(d.napravlenie || '').trim() === 'Входящая')
          ? 'Наличие перетяжки для креплений ТМЦ. ;Перевозчику предоставить: доверенность,ТН. '
          : 'Наличие перетяжки для креплений ТМЦ. ;Перевозчику предоставить: ТН. '
      });
    } catch (e) {
      console.error('[POST_AUTO_FILL] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // POST_POZ — добавление позиции + notifyWithDependencies
  // ========================================================================
  async POST_POZ(req, res) {
    try {
      const d = await parseBody(req);
      if (!d.id_transporta || !d.id_plana) {
        return send(res, 400, { error: 'id_transporta и id_plana обязательны' });
      }

      const oper = await db.get('SELECT id, napravlenie FROM transport_oper WHERE id = ?', [d.id_transporta]);
      if (!oper) return send(res, 404, { error: 'Операция не найдена' });

      // ✅ ИСПРАВЛЕНО: проверяем FK в plan_perevozok
      const planPerevozokCheck = await validateFk(db, 'plan_perevozok', 'id', d.id_plana, 'Позиция плана перевозок');
      if (!planPerevozokCheck.ok) return send(res, 400, { error: planPerevozokCheck.error });

      // ✅ НОВЫЙ АЛГОРИТМ: заявка — на активном шаге позиции, с КП, в пределах остатка
      const errPoz = await checkPlanPozForTrip(
        db, d.id_plana,
        parseFloat(d.kolvo_no_br) || 0, parseFloat(d.kolvo_yes_br) || 0,
        d.id_transporta, oper.napravlenie
      );
      if (errPoz) return send(res, 400, { error: errPoz });

      const pozId = generateId('GP');
      // T56-b: марка-факт — из запроса, иначе конструкторская из оснастки
      const markaFact = pozMarkaFact(d.marka_materiala, await osnMarkaForPlan(db, d.id_plana));
      await db.run(`
        INSERT INTO gryz_poz (id, id_transporta, id_plana, kolvo_no_br, kolvo_yes_br, primechanie, kolvo_zagotovok, marka_materiala)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        pozId, d.id_transporta, d.id_plana,
        parseFloat(d.kolvo_no_br) || 0,
        parseFloat(d.kolvo_yes_br) || 0,
        d.primechanie || '',
        String(d.kolvo_zagotovok || '').trim(), // T24B: кол-во заготовок грузовой позиции ('' = авто)
        markaFact // T56-b: марка материала (факт)
      ]);

      // ✅ СТРОКИ ФАКТА: операции шага заявки -> fakt_marshruta ('ожидание')
      await createFaktForPoz(db, pozId, d.id_plana);

      // ✅ ИСПОЛЬЗУЕМ notifyWithDependencies
      const deps = new Set([
        ...getDependencies('transportOps.positions'),
        ...getDependencies('transportOps.available')
      ]);
      wsManager.notifyWithDependencies(deps, 'add', pozId);

      send(res, 201, { id: pozId });
    } catch (e) {
      console.error('[POST_POZ] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // DELETE_POZ — удаление позиции + notifyWithDependencies
  // ========================================================================
  async DELETE_POZ(req, res, url) {
    try {
      const pozId = url.pathname.split('/')[4];
      if (!pozId) return send(res, 400, { error: 'ID позиции не указан' });

      const poz = await db.get('SELECT id_transporta FROM gryz_poz WHERE id = ?', [pozId]);
      if (!poz) return send(res, 404, { error: 'Позиция не найдена' });

      await db.run('DELETE FROM gryz_poz WHERE id = ?', [pozId]);

      // ✅ ИСПОЛЬЗУЕМ notifyWithDependencies
      const deps = new Set([
        ...getDependencies('transportOps.positions'),
        ...getDependencies('transportOps.available')
      ]);
      wsManager.notifyWithDependencies(deps, 'delete', pozId);

      send(res, 200, { ok: true });
    } catch (e) {
      console.error('[DELETE_POZ] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T37-B: POST_CREATE_SZ — «Создать СЗ в системе» (кнопка btnCreateDokSB
  // вкладки «Документы»). ПОЛНЫЙ ПОРТ VBA CommandButton12_Click
  // (frmTransportOper): «система» = ЭДО АВТОВАЗа на tportal.vaz.ru.
  // Алгоритм 1:1 как в VBA (изменён только транспорт: WinHttp -> Node):
  //   1) guard-и VBA: операция не выбрана; «Письмо уже было создано»
  //      (transOp.szTransportID <> "");
  //   2) krat_sod = "Срочная заявка на " & sDate & sSender & " - " & sReceiver
  //      (sSender/sReceiver по opbSender: Исходящая = АО "АВТОВАЗ" отправляет);
  //   3) POST /kisp/Create_doc_on_template.aspx (win1251, Basic-аутент.) ->
  //      kod = Split(Split(response, "d_kod=")(1), "'")(0);
  //   4) KartEdit: GET /kisp/KartEdit.aspx?d_kod -> карточка заполняется из
  //      HTML-полей, SetDefaults (подписант «Ломакин А.Н.» код 4663,
  //      O_OTV_ISP «Начальник отдела», PRIVACY D), POST
  //      /kisp/ajax/DocumentSave.aspx (ответ должен содержать "Error":null);
  //   5) D_NOM/DATE_DOC карточки -> поля операции (VBA: txtSzTransportNomer /
  //      txtSzTransportData);
  //   6) SaveZavkaOtgryz -> SaveShipmentFile: файл из шаблона «Заявка на
  //      отгрузку.XLSX», лист «Заявка NEW!»: B6:Z6 = DataArray1(1..25),
  //      AG6:BD6 = DataArray2(32..55) (элемент 56 «+», как и в VBA, НЕ
  //      вставляется); DataArray2(53) = номер & " от " & дата; имя файла
  //      «Заявка на отгрузку (S-R от D).xlsx»; папка «отгрузка» =
  //      public/uploads/sz/ (веб-аналог <база>\отгрузка\);
  //   7) TestUploadProduction -> POST /kisp/filesave.aspx?doc_id=<kod>
  //      (multipart/form-data, поле files, имя файла в windows-1251);
  //      неудача загрузки НЕ прерывает цепочку (в VBA — MsgBox «Ошибка при
  //      загрузке файла», затем всё равно UpdateIDTrOp);
  //   8) UpdateIDTrOp: sz_transport_id = kod (d_kod, для перехода в ИДО
  //      docs.vaz.ru/main.aspx?d_kod=kod), sz_transport_nomer = D_NOM
  //      (записывается в шаблон), sz_transport_data = DATE_DOC (в шаблон).
  // Учётные данные портала: config/edo.json (в VBA — лист «настройки» E4/E5).
  // Таблица dok_sz из ошибочной T37 НЕ используется — служебная записка
  // живёт в ЭДО АВТОВАЗа, в БД только три поля transport_oper.
  // ========================================================================
  async POST_CREATE_SZ(req, res) {
    try {
      const d = await parseBody(req);
      const transId = String(d.id_transporta || '').trim();
      // VBA: If Me.lstTransportOper.ListIndex <= 0 Then «Транспортная опреация не выбрана»
      if (!transId) return send(res, 400, { error: 'Транспортная операция не выбрана' });
      const oper = await db.get('SELECT * FROM transport_oper WHERE id = ?', [transId]);
      if (!oper) return send(res, 404, { error: 'Транспортная операция не выбрана' });
      // VBA: If transOp.szTransportID <> "" Then «Письмо уже было создано»
      if (String(oper.sz_transport_id || '').trim() !== '') {
        return send(res, 400, { error: 'Письмо уже было создано' });
      }

      // --- Учётные данные портала (VBA: лист «настройки», E4/E5) ---
      const cfg = edo.loadEdoConfig();
      if (!cfg.username || !cfg.password) {
        return send(res, 500, { error: 'Не заданы учётные данные портала ЭДО (config/edo.json: username, password)' });
      }
      const edoOpts = { cfg, rejectUnauthorized: cfg.reject_unauthorized };

      // --- VBA: даты в форме — текст ДД.ММ.ГГГГ; в веб-БД — ISO ---
      const toRuDate = (v) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
        return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v || '').trim();
      };
      // ✅ T37-C: дата портала ВАЗ — ДД.ММ.ГГГГ (возможен хвост времени —
      // берём дату в начале строки); уже-ISO yyyy-mm-dd проходит как есть
      const toIsoDate = (v) => {
        const s = String(v || '').trim();
        const ru = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
        if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
        const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
        return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : '';
      };
      // ✅ T47: русский Excel — десятичный разделитель ЗАПЯТАЯ (как в VBA,
      // где габариты/вес приходили из текстовых полей формы с запятой).
      // В БД числа хранятся с ТОЧКОЙ — в шаблон «Заявка на отгрузку»
      // отдаём текст с запятой; формулы шаблона (объём AM) и русский
      // Excel интерпретируют такой текст как число корректно.
      const toRuNumber = (v) => {
        const s = String(v == null ? '' : v).trim();
        if (s === '') return '';
        // только «настоящие» числа (10 / 10.5 / 10,5) — остальное как есть
        return /^\d+([.,]\d+)?$/.test(s) ? s.replace('.', ',') : s;
      };

      // --- Фирмы/контакты (VBA: cbFioOtvets из контактов кода 1F964,
      //     tfSupplier* из фирмы поставщика, ShowContactFioOtvets) ---
      const firma = oper.id_firma
        ? await db.get('SELECT id_firmy, kod, naimenovanie, inn, ur_adres FROM firmy WHERE id_firmy = ?', [oper.id_firma])
        : null;
      const ptoFirma = await db.get(`SELECT id_firmy FROM firmy WHERE TRIM(kod) = '1F964' LIMIT 1`);
      const ptoId = ptoFirma ? ptoFirma.id_firmy : '';
      // В VBA комбобоксы контактов хранили ФИО; в веб-версии transport_oper
      // хранит id_kont — резолвим ФИО/телефон по справочнику.
      const kontInfo = async (idFirma, idKont) => {
        if (!idFirma || !idKont) return { fio: '', tel: 'нет данных' };
        const k = await db.get('SELECT fio, tel FROM kont WHERE id_kont = ?', [idKont]);
        if (!k) return { fio: '', tel: 'нет данных' };
        return { fio: k.fio || '', tel: (k.tel && String(k.tel).trim() !== '') ? k.tel : 'нет данных' };
      };
      const otvPTO    = await kontInfo(ptoId, oper.otv_pto_fio);       // cbFioOtvets / tfOtvetstTel
      const otvPogPTO = await kontInfo(ptoId, oper.otv_pog_pto_fio);   // cbFioOtvetsPog / tfOtvetstPogTel
      const otvFirm   = await kontInfo(oper.id_firma, oper.otv_pog_firm_fio); // cbContact / tfContactPhone

      // --- Направление (VBA opbSender: Исходящая = «МЫ ОТПРАВЛЯЕМ») ---
      const isSending = String(oper.napravlenie || '').trim() === 'Исходящая';
      const AVTOVAZ = {
        code: '1F964',
        name: 'АО "АВТОВАЗ"',
        inn: '6320002223',
        addr: 'Россия, Самарская область, Тольятти, Южное шоссе, 36'
      };
      const sSender = isSending ? AVTOVAZ.name : (firma ? (firma.naimenovanie || '') : '');
      const sReceiver = isSending ? (firma ? (firma.naimenovanie || '') : '') : AVTOVAZ.name;
      const sDate = toRuDate(oper.otgruzka_data);
      // VBA CommandButton12: krat_sod = "Срочная заявка на " & sDate & sSender & " - " & sReceiver
      // (пример результата из комментария VBA: «Срочная заявка на 04.06.2026 НЬЮВЭЛД - ПТО»)
      const kratSod =
        // ✅ T52: тема — из настроек (config/edo.json → tema.sz_transport)
        // с подстановками {дата}/{отправитель}/{получатель}; пример VBA:
        // «Срочная заявка на 04.06.2026 НЬЮВЭЛД - ПТО»
        edo.applyTema(
          (cfg.tema && cfg.tema.sz_transport) || 'Срочная заявка на {дата} {отправитель} - {получатель}',
          { 'дата': sDate, 'отправитель': sSender, 'получатель': sReceiver });

      // --- ШАГ 3 (VBA): POST Create_doc_on_template.aspx -> kod = d_kod ---
      // ✅ T51: идентификатор шаблона — из настроек (config/edo.json →
      // shablon.sz_transport; дефолт — прежний захардкоженный 65555751)
      const SZ_TRANSPORT_TEMPLATE_ID = String(
        cfg.shablon && cfg.shablon.sz_transport ? cfg.shablon.sz_transport : '65555751');
      const postData = 'krat_sod=' + edo.urlEncodeWin1251(kratSod) +
        '&rd=1&data_doc=&DELO=1F010-00&privacy=D&d_kod=' + SZ_TRANSPORT_TEMPLATE_ID + '&d_type=V01&ch_txt=1&ch_otl=1&ch_rez=0&ch_ree=1&ch_mrsh=1';
      const response = await edo.sendPostRequest(cfg.username, cfg.password, cfg.url + '/kisp/Create_doc_on_template.aspx', postData, edoOpts);
      // VBA: kod = Split(Split(response, "d_kod=")(1), "'")(0)
      let kod;
      try { kod = edo.parseDkodFromResponse(response); }
      catch (e) {
        return send(res, 502, { error: 'Создание документа в ЭДО не удалось: ' + e.message });
      }

      // --- ШАГ 4 (VBA): KartEdit — карточка документа, подписант Ломакин ---
      const card = edo.createCardParams();
      try { await edo.kartEdit(cfg.username, cfg.password, kod, card, edoOpts); }
      catch (e) {
        return send(res, 502, { error: 'Ошибка сохранения карточки ЭДО: ' + e.message });
      }
      // VBA: txtSzTransportNomer.text = card("D_NOM"); txtSzTransportData.text = card("DATE_DOC")
      const szNomer = String(card.D_NOM == null ? '' : card.D_NOM).trim();
      const szDataRaw = String(card.DATE_DOC == null ? '' : card.DATE_DOC).trim(); // как вернул портал — уходит в шаблон (VBA)
      const szDataIso = toIsoDate(szDataRaw) || szDataRaw;                          // для поля даты вкладки (веб-БД — ISO)

      // --- DataArray1 (B6:Z6) — VBA SaveZavkaOtgryz ---
      const a1 = new Array(26).fill('');
      a1[1] = 'ПТО';
      a1[2] = otvPTO.fio;
      a1[3] = otvPTO.tel;
      if (isSending) {
        // МЫ ОТПРАВЛЯЕМ (АВТОВАЗ — Грузоотправитель)
        a1[4] = AVTOVAZ.code; a1[5] = AVTOVAZ.name; a1[6] = AVTOVAZ.inn;
        a1[7] = AVTOVAZ.addr; a1[8] = AVTOVAZ.addr;
        a1[9] = otvPogPTO.fio; a1[10] = otvPogPTO.tel;
        // Данные клиента в блок Грузополучателя
        a1[15] = firma ? (firma.kod || '') : '';
        a1[16] = firma ? (firma.naimenovanie || '') : '';
        a1[17] = firma ? (firma.inn || '') : '';
        a1[18] = firma ? (firma.ur_adres || '') : '';
        a1[19] = String(oper.adres_pog_firm || '');
        a1[20] = otvFirm.fio;
        a1[21] = otvFirm.tel;
      } else {
        // МЫ ПОЛУЧАЕМ (АВТОВАЗ — Грузополучатель)
        a1[15] = AVTOVAZ.code; a1[16] = AVTOVAZ.name; a1[17] = AVTOVAZ.inn;
        a1[18] = AVTOVAZ.addr; a1[19] = AVTOVAZ.addr;
        a1[20] = otvPogPTO.fio; a1[21] = otvPogPTO.tel;
        // Данные клиента в блок Грузоотправителя
        a1[4] = firma ? (firma.kod || '') : '';
        a1[5] = firma ? (firma.naimenovanie || '') : '';
        a1[6] = firma ? (firma.inn || '') : '';
        a1[7] = firma ? (firma.ur_adres || '') : '';
        a1[8] = String(oper.adres_pog_firm || '');
        a1[9] = otvFirm.fio;
        a1[10] = otvFirm.tel;
      }
      // 11-14, 22-25 остаются пустыми (как в VBA)

      // --- DataArray2 (AG6:BD6) — VBA SaveZavkaOtgryz ---
      const a2 = {};
      a2[32] = String(oper.gruz_name || '');
      a2[33] = String(oper.opasnost_class || '');
      // ✅ T47: запятая вместо точки (русский Excel)
      a2[34] = toRuNumber(oper.tarn_places);
      a2[35] = toRuNumber(oper.dlina_m);
      a2[36] = toRuNumber(oper.shirina_m);
      a2[37] = toRuNumber(oper.vysota_m);
      // ✅ T37-D: объём в колонку AM НЕ пишем — в шаблоне там формула,
      // Excel посчитает объём сам (ячейка AM6 шаблона не трогается)
      a2[39] = String(oper.shtabil_gryz || '');
      a2[40] = toRuNumber(oper.brutto_ves_kg); // ✅ T47: запятая
      a2[41] = sDate;
      a2[42] = String(oper.otgruzka_vremya || '');
      a2[43] = toRuDate(oper.pribytie_data);
      a2[44] = String(oper.pribytie_vremya || '');
      a2[45] = String(oper.nomer_reisa || '');
      a2[46] = String(oper.transport_tip || '');
      a2[47] = String(oper.zagruzka_sposob || '');
      a2[48] = String(oper.temp_rezhim || '');
      a2[49] = String(oper.tn_oformlenie || '');
      a2[50] = String(oper.kommentariy || '');
      a2[51] = String(oper.platelshchik || '');
      // VBA: cbShPZ.Value & "; " & cbPeredel.Value & "; " & cbSB.Value
      // (в БД zatrata_prisvoenie = "ШПЗ;Передел;СБ")
      a2[52] = String(oper.zatrata_prisvoenie || '').split(';').map(x => x.trim()).join('; ');
      // VBA: DataArray2(53) = txtSzTransportNomer.text & " от " & txtSzTransportData.text
      // (номер и дата — из карточки ЭДО, шаг 4-5)
      a2[53] = `${szNomer} от ${szDataRaw}`;
      a2[54] = '';
      a2[55] = '';
      // a2[56] = '+' — как и в VBA НЕ вставляется (Resize(1, 24) из AG6)

      // --- ШАГ 6 (VBA): SaveZavkaOtgryz -> SaveShipmentFile ---
      // (имя файла — VBA: sSender=DataArray1(5), sReceiver=DataArray1(16),
      //  sDate=DataArray2(41); кавычки удалены, «/» -> «-»)
      const templatePath = path.join(__dirname, '..', '..', 'templates', 'Заявка на отгрузку.XLSX');
      const outDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'sz');
      // ✅ T57-f: СЗ на транспорт — СТРОКА НА КАЖДЫЙ ТИП ТАРНОГО МЕСТА,
      // «просто следующая строка»: ПЕРВЫЙ тип — строка 6 (через DataArray2,
      // как в VBA: AI=кол-во, AJ/AK/AL=длина/ширина/высота, AN=штабелируемость,
      // AO=вес), каждый СЛЕДУЮЩИЙ тип — следующая строка 7, 8, 9…, пока не
      // кончатся типы (в шаблоне строки 7..32 скрыты — раскрываются, примеры
      // очищаются, пишутся данные). Объём каждой строки считает ФОРМУЛА
      // шаблона AM (Д×Ш×В×места) — общий объём в AM6 НЕ пишется (T37-D).
      // Пустой tarn_mesta — прежнее поведение 1:1 (одна строка).
      const tarnRows = [];
      let hasTarn = false;
      try {
        const tmArr = JSON.parse(oper.tarn_mesta || '[]');
        if (Array.isArray(tmArr) && tmArr.length) {
          hasTarn = true;
          // ✅ T57-e: ДОЗАПОЛНЕНИЕ групп с пустыми габаритом/весом по составу
          // позиций (габарит = МАКС по позициям места, вес = Σ деталей) —
          // строка СЗ каждого типа тарного места должна быть полной.
          try {
            const pozRows = await db.all(`
              SELECT gz.id, gz.tip_gruza,
                     COALESCE(gz.kolvo_no_br, 0) AS kolvo_no_br,
                     COALESCE(gz.kolvo_yes_br, 0) AS kolvo_yes_br,
                     gz.tara_dlina, gz.tara_shirina, gz.tara_vysota, gz.prutok_diametr,
                     p.list_dlina, p.list_shirina, p.list_tolshina, p.prutok_dlina,
                     os.dlina, os.shirina, os.vysota, os.ves_zag
              FROM gryz_poz gz
              LEFT JOIN plan_perevozok pp ON gz.id_plana = pp.id
              LEFT JOIN plan p ON pp.id_plana = p.id
              LEFT JOIN osnastka os ON p.id_osnastka = os.id
              WHERE gz.id_transporta = ?`, [transId]);
            tarnCalc.fillTarnGroups(tmArr, pozRows);
          } catch (fillErr) {
            console.error('[POST_CREATE_SZ] tarn fill:', fillErr.message);
          }
          // ✅ T57-f: раскладка «строка 6 = первый тип, далее 7, 8, 9…»
          const szMap = tarnCalc.szRows(tmArr, oper, toRuNumber, a1, a2);
          Object.keys(szMap.a2Updates).forEach(k => { a2[k] = szMap.a2Updates[k]; });
          szMap.tarnRows.forEach(r => tarnRows.push(r));
        }
      } catch (tmErr) {
        console.error('[POST_CREATE_SZ] tarn_mesta parse:', tmErr.message);
      }
      let gen;
      try {
        gen = await szExcel.generateShipmentFile(a1, a2, templatePath, outDir, tarnRows);
      } catch (e) {
        return send(res, 500, { error: 'Ошибка создания файла заявки: ' + e.message });
      }

      // ✅ T59: РЕЖИМ ПРЕДПРОСМОТРА (клиент передаёт preview:true). Шаги 3-6
      // VBA выполнены (документ в ЭДО создан, файл заявки сформирован), но
      // ШАГИ 7-8 НЕ выполняются: файл НЕ грузится на портал, sz_transport_*
      // НЕ пишутся в БД. Клиенту возвращаются HTML-предпросмотр листа
      // «Заявка NEW!» и жетоны (kod/номер/дата/имя файла) — файл показывается
      // в браузере с запросом дальнейших действий, как «Отправить заказы
      // контрагентам» на странице «Заказы по договорам». Подтверждение ->
      // POST_SZ_CONFIRM (create-sz-confirm: шаги 7-8), отмена -> удаление
      // локального файла (документ в ЭДО остаётся черновиком — как при
      // неудаче загрузки в VBA/старом потоке).
      if (d.preview === true) {
        let previewHtml = null;
        try {
          // кэш формул шаблона снят, объём AM пересчитан -> честный предпросмотр
          const pvBuf = await szExcel.buildPreviewBuffer(gen.filePath);
          previewHtml = await generatePreviewHTML(pvBuf, { sheet: 'Заявка NEW!' });
        } catch (pvErr) {
          console.error('[POST_CREATE_SZ] preview:', pvErr.message);
        }
        return send(res, 200, {
          preview: true,
          id_sz: kod,                      // d_kod документа в ЭДО
          sz_transport_nomer: szNomer,     // D_NOM карточки
          sz_transport_data: szDataIso,    // ISO
          sz_transport_data_ru: toRuDate(szDataIso) || szDataRaw,
          krat_sod: kratSod,
          file_name: gen.fileName,
          file_url: '/uploads/sz/' + encodeURIComponent(gen.fileName),
          preview_html: previewHtml
        });
      }

      // --- ШАГ 7 (VBA): TestUploadProduction -> filesave.aspx?doc_id=<kod> ---
      let uploadOk = false, uploadErr = '';
      try {
        uploadOk = await edo.uploadFileToPortal(gen.filePath, kod, cfg.username, cfg.password, edoOpts);
        if (!uploadOk) uploadErr = 'Портал вернул статус, отличный от 200';
      } catch (e) {
        uploadErr = e.message;
      }

      // --- ШАГ 8 (VBA): UpdateIDTrOp — sz_transport_* в transport_oper ---
      try {
        await db.run(`
          UPDATE transport_oper
          SET sz_transport_id = ?, sz_transport_nomer = ?, sz_transport_data = ?
          WHERE id = ?
        `, [kod, szNomer, szDataIso, transId]);
      } catch (dbErr) {
        return send(res, 500, { error: 'Ошибка при сохранении индификатора письма. ' + dbErr.message });
      }

      // WS: список операций (sz_transport_*) обновится у всех клиентов
      const deps = new Set(getDependencies('transportOps.list'));
      wsManager.notifyWithDependencies(deps, 'update', transId);

      send(res, 200, {
        ok: true,
        id_sz: kod,                      // d_kod документа в ЭДО
        sz_transport_nomer: szNomer,     // D_NOM карточки
        sz_transport_data: szDataIso,    // ISO — для input type=date
        sz_transport_data_ru: toRuDate(szDataIso) || szDataRaw,
        krat_sod: kratSod,
        file_name: gen.fileName,
        file_url: '/uploads/sz/' + encodeURIComponent(gen.fileName),
        upload_ok: uploadOk,
        upload_error: uploadErr
      });
    } catch (e) {
      console.error('[POST_CREATE_SZ] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T59: POST_SZ_CONFIRM — второй шаг «Создать СЗ в системе». После
  // предпросмотра (create-sz с preview:true — выполнены шаги 3-6 VBA:
  // документ в ЭДО создан, файл заявки сформирован, но на портал НЕ
  // загружен и в БД НЕ записан) клиент вызывает ЭТОТ эндпоинт:
  //   cancel:false -> ШАГ 7 (TestUploadProduction: файл -> портал) +
  //                   ШАГ 8 (UpdateIDTrOp: sz_transport_* в transport_oper);
  //   cancel:true  -> отмена: локальный файл заявки удаляется; документ в
  //                   ЭДО остаётся черновиком (как при неудаче загрузки),
  //                   sz_transport_* в БД НЕ пишутся — СЗ можно создать
  //                   заново (новый документ в ЭДО).
  // ========================================================================
  async POST_SZ_CONFIRM(req, res) {
    try {
      const d = await parseBody(req);
      const transId = String(d.id_transporta || '').trim();
      // VBA: If Me.lstTransportOper.ListIndex <= 0 Then «Транспортная опреация не выбрана»
      if (!transId) return send(res, 400, { error: 'Транспортная операция не выбрана' });
      const oper = await db.get('SELECT * FROM transport_oper WHERE id = ?', [transId]);
      if (!oper) return send(res, 404, { error: 'Транспортная операция не выбрана' });

      const outDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'sz');
      // имя файла — только basename (без перехода пути)
      const reqName = String(d.file_name || '').trim();
      const safeName = path.basename(reqName);
      const filePath = safeName ? path.join(outDir, safeName) : '';

      // --- ОТМЕНА: файл заявки удалить, БД и портал не трогать ---
      if (d.cancel === true) {
        if (safeName && safeName === reqName && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (e) { /* уже удалён */ }
        }
        return send(res, 200, { ok: true, cancelled: true });
      }

      // guard «Письмо уже было создано» — как в POST_CREATE_SZ
      if (String(oper.sz_transport_id || '').trim() !== '') {
        return send(res, 400, { error: 'Письмо уже было создано' });
      }
      const kod = String(d.kod || '').trim();
      if (!kod) return send(res, 400, { error: 'Нет идентификатора документа ЭДО — создайте СЗ заново' });
      if (!safeName || safeName !== reqName) {
        return send(res, 400, { error: 'Некорректное имя файла заявки' });
      }
      if (!fs.existsSync(filePath)) {
        return send(res, 500, { error: 'Файл заявки не найден — создайте СЗ заново' });
      }
      const cfg = edo.loadEdoConfig();
      if (!cfg.username || !cfg.password) {
        return send(res, 500, { error: 'Не заданы учётные данные портала ЭДО (config/edo.json: username, password)' });
      }
      const edoOpts = { cfg, rejectUnauthorized: cfg.reject_unauthorized };

      // --- ШАГ 7 (VBA): TestUploadProduction -> filesave.aspx?doc_id=<kod> ---
      let uploadOk = false, uploadErr = '';
      try {
        uploadOk = await edo.uploadFileToPortal(filePath, kod, cfg.username, cfg.password, edoOpts);
        if (!uploadOk) uploadErr = 'Портал вернул статус, отличный от 200';
      } catch (e) {
        uploadErr = e.message;
      }

      // --- ШАГ 8 (VBA): UpdateIDTrOp — sz_transport_* в transport_oper ---
      const szNomer = String(d.sz_nomer || '').trim();
      const szDataIso = String(d.sz_data || '').trim();
      try {
        await db.run(`
          UPDATE transport_oper
          SET sz_transport_id = ?, sz_transport_nomer = ?, sz_transport_data = ?
          WHERE id = ?
        `, [kod, szNomer, szDataIso, transId]);
      } catch (dbErr) {
        return send(res, 500, { error: 'Ошибка при сохранении индификатора письма. ' + dbErr.message });
      }

      // WS: список операций (sz_transport_*) обновится у всех клиентов
      const deps = new Set(getDependencies('transportOps.list'));
      wsManager.notifyWithDependencies(deps, 'update', transId);

      send(res, 200, {
        ok: true,
        id_sz: kod,                      // d_kod документа в ЭДО
        sz_transport_nomer: szNomer,     // D_NOM карточки
        sz_transport_data: szDataIso,    // ISO — для input type=date
        sz_transport_data_ru: String(d.sz_data_ru || '').trim(),
        krat_sod: String(d.krat_sod || '').trim(),
        file_name: safeName,
        file_url: '/uploads/sz/' + encodeURIComponent(safeName),
        upload_ok: uploadOk,
        upload_error: uploadErr
      });
    } catch (e) {
      console.error('[POST_SZ_CONFIRM] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T43: POST_SZ_SB_PREVIEW — предпросмотр текста письма «СЗ в СБ об
  // отгрузке» БЕЗ обращения к порталу ЭДО. Кнопка «Создать СЗ в СБ об
  // отгрузке» сначала вызывает ЭТОТ эндпоинт: сервер собирает текст из БД
  // (фирмы/заказы/договоры транспортных позиций, фраза по vid_gruza) и
  // список файлов подписанных заказов (zakaz_po_dogovoru.ssylka_reshenie,
  // страница «Заказы по договорам», шаг 2 «Решение контрагента»); текст
  // открывается в модальном окне WYSIWYG (T39-C), пользователь правит его
  // и кнопкой «Создать СЗ в СБ» отправляет в POST_CREATE_SZ_SB (letter).
  // ========================================================================
  async POST_SZ_SB_PREVIEW(req, res) {
    try {
      const d = await parseBody(req);
      const transId = String(d.id_transporta || '').trim();
      // VBA: If Me.lstTransportOper.ListIndex <= 0 Then «Транспортная опреация не выбрана»
      if (!transId) return send(res, 400, { error: 'Транспортная операция не выбрана' });
      const oper = await db.get('SELECT * FROM transport_oper WHERE id = ?', [transId]);
      if (!oper) return send(res, 404, { error: 'Транспортная операция не выбрана' });
      // аналог VBA «Письмо уже было создано» — у СБ-письма свой идентификатор
      if (String(oper.sz_sb_id || '').trim() !== '') {
        return send(res, 400, { error: 'СЗ в СБ уже была создана' });
      }
      const rows = await szSbCollectRows(db, transId);
      if (!rows.length) {
        return send(res, 400, { error: 'По позициям операции не найдено заказов (нет связки позиция -> заказ -> договор)' });
      }
      const groups = szSbGroupRows(rows);
      const letter = szSbBuildLetter(rows, groups, oper.vid_gruza);
      // ✅ T52: тема письма — из настроек (config/edo.json → tema.sz_sb),
      // те же подстановки, что в POST_CREATE_SZ_SB, чтобы пользователь
      // видел в модалке РЕАЛЬНУЮ тему создаваемого письма
      const cfgPreview = edo.loadEdoConfig();
      const toRuDatePrev = (v) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
        return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v || '').trim();
      };
      const isSendingPrev = String(oper.napravlenie || '').trim() === 'Исходящая';
      const AVTOVAZ_NAME_PREV = 'АО "АВТОВАЗ"';
      const firmaPrev = oper.id_firma
        ? await db.get('SELECT naimenovanie FROM firmy WHERE id_firmy = ?', [oper.id_firma])
        : null;
      const temaSb = edo.applyTema(
        (cfgPreview.tema && cfgPreview.tema.sz_sb) || 'об отгрузке {дата} {отправитель} - {получатель}',
        {
          'дата': toRuDatePrev(oper.otgruzka_data),
          'отправитель': isSendingPrev ? AVTOVAZ_NAME_PREV : (firmaPrev ? (firmaPrev.naimenovanie || '') : ''),
          'получатель': isSendingPrev ? (firmaPrev ? (firmaPrev.naimenovanie || '') : '') : AVTOVAZ_NAME_PREV
        });
      // файлы подписанных заказов: есть/нет на диске (проверка ДО создания СЗ)
      const appRoot = path.join(__dirname, '..', '..');
      const files = rows.map((r) => {
        const f = { zakaz_id: r.zakaz_id, nomer_zakaza: r.nomer_zakaza,
                    file_url: String(r.ssylka_reshenie || ''), file_name: '', exists: false, error: '' };
        if (!f.file_url.trim()) {
          f.error = 'Нет файла подписанного заказа (Заказы по договорам, шаг 2 «Решение контрагента»)';
          return f;
        }
        const abs = szSbResolveFile(appRoot, r.ssylka_reshenie);
        if (!abs) { f.error = 'Файл не найден: ' + f.file_url; return f; }
        f.file_name = path.basename(abs);
        f.exists = true;
        return f;
      });
      send(res, 200, {
        ok: true,
        letter: letter,
        tema: temaSb,
        firms: Array.from(groups.keys()),
        orders: rows.map((r) => ({ nomer_zakaza: r.nomer_zakaza, nom_dogovor: r.nom_dogovor })),
        files: files
      });
    } catch (e) {
      console.error('[POST_SZ_SB_PREVIEW] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T42: POST_CREATE_SZ_SB — «Создать СЗ в СБ об отгрузке» (кнопка
  // btnCreateSzSb вкладки «Документы»). Аналог POST_CREATE_SZ (VBA
  // CommandButton12_Click), но по ДРУГОМУ шаблону ЭДО — d_kod=65133697.
  // Подписант письма — «Савченко В.М.» — устанавливается ЖЁСТКО (код
  // 16385, O_OTV_ISP «Заместитель директора по производству», PRIVACY
  // 'D'): порт VBA setDefaultsOtgryz — значения ПОДМЕНЯЮТ то, что отдала
  // страница карточки (там мог остаться исполнитель Чесноков И.И.);
  // kartEdit (opts.defaults) применяет их ПОСЛЕ разбора страницы.
  // SetDefaults с «Ломакиным А.Н.» (код 4663) НЕ применяется.
  // Отличия от «СЗ на транспорт»:
  //   - krat_sod = «СЗ в СБ об отгрузке <дата> <отправитель> - <получатель>»
  //     (формула VBA CommandButton12 с названием из поля вкладки);
  //   - текст письма (LETTER) формируется АВТОМАТИЧЕСКИ из БД по
  //     транспортным позициям операции: gryz_poz -> plan_perevozok ->
  //     plan -> poz_zakaz_dogovora -> zakaz_po_dogovoru -> dogovor ->
  //     firmy; позиции группируются по фирмам, внутри фирмы — по заказам
  //     (у заказа свой договор; несколько заказов фирмы — «, а также»);
  //     фраза о таре — по vid_gruza операции:
  //       listy  -> «заготовок в листах проложенных деревянным брусом из
  //                  подручных материалов»;
  //       prutki -> «заготовок в прутках проложенных деревянным брусом из
  //                  подручных материалов»;
  //       иначе  -> «заготовок на деревянной таре изготовленной из
  //                  подручных материалов» (текст шаблона);
  //   - текст письма собирается на сервере (POST sz-sb-preview, БЕЗ
  //     обращения к порталу) и открывается в модальном окне WYSIWYG
  //     (T39-C): пользователь правит текст, кнопка «Создать СЗ в СБ»
  //     отправляет его в create-sz-sb (поле letter; пустой -> автосборка
  //     szSbBuildLetter); разметка: «Уважаемый …!» по центру, у абзацев
  //     первая строка — отступ 10 пробелов (&nbsp; × 10);
  //   - текст сохраняется на портал через ViewShablon.aspx/SaveShablon.aspx
  //     (механизм T39-B: ВСЕ поля страницы + LETTER, multipart, win1251);
  //   - к письму прикрепляются файлы ПОДПИСАННЫХ заказов со страницы
  //     «Заказы по договорам», шаг 2 «Решение контрагента» (поле
  //     zakaz_po_dogovoru.ssylka_reshenie, относительный путь; Excel
  //     больше НЕ генерируется; неудача загрузки одного файла не
  //     прерывает цепочку);
  //   - результат: sz_sb_id (d_kod письма), sz_sb_otgruzka (номер),
  //     sz_sb_otgruzka_data (дата) в transport_oper.
  // ========================================================================
  async POST_CREATE_SZ_SB(req, res) {
    try {
      const d = await parseBody(req);
      const transId = String(d.id_transporta || '').trim();
      // VBA: If Me.lstTransportOper.ListIndex <= 0 Then «Транспортная опреация не выбрана»
      if (!transId) return send(res, 400, { error: 'Транспортная операция не выбрана' });
      const oper = await db.get('SELECT * FROM transport_oper WHERE id = ?', [transId]);
      if (!oper) return send(res, 404, { error: 'Транспортная операция не выбрана' });
      // аналог VBA «Письмо уже было создано» — у СБ-письма свой идентификатор
      if (String(oper.sz_sb_id || '').trim() !== '') {
        return send(res, 400, { error: 'СЗ в СБ уже была создана' });
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

      // --- Фирма операции (VBA: cbFirm; направление opbSender) ---
      const firma = oper.id_firma
        ? await db.get('SELECT id_firmy, kod, naimenovanie FROM firmy WHERE id_firmy = ?', [oper.id_firma])
        : null;
      const isSending = String(oper.napravlenie || '').trim() === 'Исходящая';
      const AVTOVAZ_NAME = 'АО "АВТОВАЗ"';
      const sSender = isSending ? AVTOVAZ_NAME : (firma ? (firma.naimenovanie || '') : '');
      const sReceiver = isSending ? (firma ? (firma.naimenovanie || '') : '') : AVTOVAZ_NAME;
      const sDate = toRuDate(oper.otgruzka_data);
      // Формула VBA CommandButton12 с названием документа из поля
      // «№ СЗ в СБ об отгрузке» вкладки.
      // ✅ T51: из темы письма убрана аббревиатура «СЗ в СБ» —
      // осталось «об отгрузке <дата> <отправитель> - <получатель>»
      const kratSod =
        // ✅ T52: тема — из настроек (config/edo.json → tema.sz_sb)
        // с подстановками {дата}/{отправитель}/{получатель}
        edo.applyTema(
          (cfg.tema && cfg.tema.sz_sb) || 'об отгрузке {дата} {отправитель} - {получатель}',
          { 'дата': sDate, 'отправитель': sSender, 'получатель': sReceiver });

      // --- Позиции -> фирмы -> заказы (у заказа свой договор; ✅ T43:
      //     выборка/группировка вынесены в хелперы szSbCollectRows/
      //     szSbGroupRows — общий код с POST_SZ_SB_PREVIEW) ---
      const rows = await szSbCollectRows(db, transId);
      if (!rows.length) {
        return send(res, 400, { error: 'По позициям операции не найдено заказов (нет связки позиция -> заказ -> договор)' });
      }
      const groups = szSbGroupRows(rows);

      // --- Текст письма: ✅ T43 — ИЗ МОДАЛЬНОГО ОКНА (пользователь правит
      //     предпросмотр и отправляет отредактированный текст); пустой ->
      //     автосборка из БД (szSbBuildLetter: «Уважаемый …!» по центру,
      //     у абзацев отступ первой строки 10 пробелов) ---
      const letter = String(d.letter || '').trim() !== ''
        ? String(d.letter)
        : szSbBuildLetter(rows, groups, oper.vid_gruza);

      // --- ШАГ: POST Create_doc_on_template.aspx ---
      // ✅ T51: идентификатор шаблона — из настроек (config/edo.json →
      // shablon.sz_sb; дефолт — прежний захардкоженный 65133697)
      const SZ_SB_TEMPLATE_ID = String(
        cfg.shablon && cfg.shablon.sz_sb ? cfg.shablon.sz_sb : '65133697');
      // ✅ T55: тип присвоения номера — из настроек (config/edo.json → блок
      // sz_nomer, ключ sz_sb; редактируется на странице «Настройки ЭДО»):
      //   'otlozh' (дефолт) — ОТЛОЖЕННОЕ присвоение номера: rd=2, ch_otl=2;
      //   'avto'            — автосоздание (прежнее поведение): rd=1, ch_otl=1.
      // krat_sod в обоих режимах уходит в cp1251-URL-кодировке (как раньше).
      const szNomerMode = (cfg.sz_nomer && String(cfg.sz_nomer.sz_sb) === 'avto') ? 'avto' : 'otlozh';
      const szRd = szNomerMode === 'avto' ? '1' : '2';
      const szOtl = szNomerMode === 'avto' ? '1' : '2';
      const postData = 'krat_sod=' + edo.urlEncodeWin1251(kratSod) +
        '&rd=' + szRd + '&data_doc=&DELO=1F010-00&privacy=D&d_kod=' + SZ_SB_TEMPLATE_ID +
        '&d_type=V01&ch_txt=1&ch_otl=' + szOtl + '&ch_rez=0&ch_ree=1&ch_mrsh=1';
      const response = await edo.sendPostRequest(cfg.username, cfg.password,
        cfg.url + '/kisp/Create_doc_on_template.aspx', postData, edoOpts);
      // VBA: kod = Split(Split(response, "d_kod=")(1), "'")(0)
      let kod;
      try { kod = edo.parseDkodFromResponse(response); }
      catch (e) {
        return send(res, 502, { error: 'Создание СЗ в СБ в ЭДО не удалось: ' + e.message });
      }

      // --- KartEdit: подписант «Савченко В.М.» — ЖЁСТКО (✅ T43, порт VBA
      //     setDefaultsOtgryz: PRIVACY/PODP/PODP_KOD/O_OTV_ISP подменяют
      //     то, что отдала страница карточки — там мог остаться исполнитель
      //     Чесноков И.И.); SetDefaults с «Ломакиным» НЕ применяется ---
      const card = edo.createCardParams();
      try {
        // ✅ T51: параметры подписывающего — из настроек (config/edo.json →
        // podpisant.sz_sb; дефолт — прежние «Савченко В.М.», 16385)
        const podpSb = (cfg.podpisant && cfg.podpisant.sz_sb) || {};
        await edo.kartEdit(cfg.username, cfg.password, kod, card,
          Object.assign({}, edoOpts, {
            keepSignatory: true,
            defaults: {
              PRIVACY: 'D',
              PODP: podpSb.PODP !== undefined ? podpSb.PODP : 'Савченко В.М.',
              PODP_KOD: podpSb.PODP_KOD !== undefined ? podpSb.PODP_KOD : '16385',
              O_OTV_ISP: podpSb.O_OTV_ISP !== undefined ? podpSb.O_OTV_ISP : 'Заместитель директора по производству'
            }
          }));
      } catch (e) {
        return send(res, 502, { error: 'Ошибка сохранения карточки ЭДО: ' + e.message });
      }

      // VBA: txtSzTransportNomer.text = card("D_NOM") — номер/дата письма
      const szSbNomer = String(card.D_NOM == null ? '' : card.D_NOM).trim();
      const szSbDataRaw = String(card.DATE_DOC == null ? '' : card.DATE_DOC).trim();
      const szSbDataIso = toIsoDate(szSbDataRaw) || szSbDataRaw;

      // --- ТЕКСТ письма на портал (механизм T39-B: все поля страницы) ---
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
        fs.writeFileSync(path.join(logsDir, 'edo_viewshablon_sb_last.html'), String(html), 'utf8');
      } catch (e) { /* диагностика не должна ломать алгоритм */ }
      const pageFields = edo.collectShablonFormFields(html);
      if (!pageFields.length) {
        return send(res, 502, { error: 'ViewShablon: портал вернул пустую страницу после ' + maxAttempts + ' запросов (баг портала ВАЗ). Повторите позже' });
      }
      // ✅ T53: имя-отчество адресата — из строки «Уважаемый …!» ТЕЛА
      // ПИСЬМА, которое портал собрал из ШАБЛОНА для ЭТОГО документа
      // (LETTER среди полей страницы). СЗ адресуются разным людям —
      // заменяем одно и то же имя из автосборки/модалки на персональное:
      // «Уважаемый <Имя Отчество>!» — как в скачанном шаблоне письма.
      // Строки приветствия в шаблоне нет — текст остаётся как был.
      const tplLetterPair = pageFields.find((p) => String(p[0]).toUpperCase() === 'LETTER');
      const uvazhaemyi = edo.extractGreetingName(tplLetterPair ? tplLetterPair[1] : '');
      const letterFinal = uvazhaemyi ? edo.applyGreetingName(letter, uvazhaemyi) : letter;
      // LETTER -> сгенерированный текст; остальные поля — со страницы
      // (подписант/исполнитель/адресаты не затираются)
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

      // --- Вложения: файлы ПОДПИСАННЫХ заказов (✅ T43: поле
      //     zakaz_po_dogovoru.ssylka_reshenie — страница «Заказы по
      //     договорам», шаг 2 «Решение контрагента»; относительный путь
      //     от директории работы скрипта; генерация Excel отменена).
      //     Неудача одного файла не прерывает цепочку — как в VBA:
      //     MsgBox об ошибке, затем UpdateIDTrOp
      const appRoot = path.join(__dirname, '..', '..');
      const uploads = [];
      for (const r of rows) {
        const u = { zakaz_id: r.zakaz_id, nomer_zakaza: r.nomer_zakaza,
                    file_name: '', file_url: String(r.ssylka_reshenie || ''), ok: false, error: '' };
        const abs = szSbResolveFile(appRoot, r.ssylka_reshenie);
        if (!String(r.ssylka_reshenie || '').trim()) {
          u.error = 'Нет файла подписанного заказа (Заказы по договорам, шаг 2 «Решение контрагента»)';
        } else if (!abs) {
          u.error = 'Файл не найден: ' + r.ssylka_reshenie;
        } else {
          u.file_name = path.basename(abs);
          try {
            u.ok = await edo.uploadFileToPortal(abs, kod, cfg.username, cfg.password, edoOpts);
            if (!u.ok) u.error = 'Портал вернул статус, отличный от 200';
          } catch (e) {
            u.error = e.message;
          }
        }
        uploads.push(u);
      }

      // --- Финал (VBA UpdateIDTrOp): sz_sb_* в transport_oper ---
      try {
        await db.run(
          'UPDATE transport_oper SET sz_sb_id = ?, sz_sb_otgruzka = ?, sz_sb_otgruzka_data = ? WHERE id = ?',
          [kod, szSbNomer, szSbDataIso, transId]
        );
      } catch (dbErr) {
        return send(res, 500, { error: 'Ошибка при сохранении идентификатора письма СБ. ' + dbErr.message });
      }

      // WS: список операций (sz_sb_*) обновится у всех клиентов
      const deps = new Set(getDependencies('transportOps.list'));
      wsManager.notifyWithDependencies(deps, 'update', transId);

      send(res, 200, {
        ok: true,
        id_sz_sb: kod,                   // d_kod СЗ в СБ в ЭДО
        sz_sb_nomer: szSbNomer,          // D_NOM карточки
        sz_sb_data: szSbDataIso,         // ISO — для input type=date
        sz_sb_data_ru: toRuDate(szSbDataIso) || szSbDataRaw,
        podp: card.PODP || '',           // подписант: Савченко В.М. (defaults T43)
        podp_kod: card.PODP_KOD || '',
        krat_sod: kratSod,
        sz_nomer_mode: szNomerMode,      // ✅ T55: 'otlozh' | 'avto'
        letter: letterFinal,             // ✅ T53: текст с персональным приветствием
        uvazhaemyi: uvazhaemyi || '',    // ✅ T53: имя-отчество, взятое из шаблона
        firms: Array.from(groups.keys()),
        orders: rows.map((r) => ({ nomer_zakaza: r.nomer_zakaza, nom_dogovor: r.nom_dogovor })),
        letter_saved: letterSaved,
        letter_error: letterErr,
        uploads: uploads
      });
    } catch (e) {
      console.error('[POST_CREATE_SZ_SB] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T39: GET_SZ_LETTER — текст тела СЗ (LETTER) для модального окна
  // «Редактировать текст СЗ» (вкладка «Документы»). Загрузка с портала —
  // GET /kisp/ViewShablon.aspx?mode=edit&d_kod=<kod>: закомментированная
  // строка VBA frmTransportOper (SendGetRequest(...ViewShablon.aspx?mode=edit
  // &d_kod=...) + Call ParseHTMLPage(response)) — здесь доведена до рабочей:
  // значения полей читаются FillFromHTML (✅ T37-C токенайзер, TEXTAREA ->
  // .value). ✅ T37-C: первый GET портал отвечает пустой страницей (баг
  // портала ВАЗ) — запрос повторяется, пока не придёт HTML с полем LETTER
  // (та же логика, что в kartEdit); последний HTML сохраняется в
  // logs/edo_viewshablon_last.html (диагностика). D_NOM/DATE_DOC/D_NAME —
  // с той же страницы; если поля на ней нет — из transport_oper (D_NAME —
  // krat_sod, формула VBA CommandButton12).
  // ========================================================================
  async GET_SZ_LETTER(req, res, url) {
    try {
      // ✅ T44: параметр d_kod — загрузка текста ЛЮБОГО письма по
      // идентификатору портала (кнопка «Редактировать» строки «СЗ в СБ
      // об отгрузке»). Без d_kod — прежний поток T39 (id_transporta ->
      // sz_transport_id операции).
      const dkodParam = String(url.searchParams.get('d_kod') || '').trim();
      let oper = null;
      let kod = '';
      if (dkodParam) {
        kod = dkodParam;
      } else {
      const transId = url.searchParams.get('id_transporta');
      // VBA: If Me.lstTransportOper.ListIndex <= 0 Then «Транспортная опреация не выбрана»
      if (!transId) return send(res, 400, { error: 'Транспортная операция не выбрана' });
      oper = await db.get(`
        SELECT t.id, t.napravlenie, t.id_firma, t.otgruzka_data,
               t.sz_transport_id, t.sz_transport_nomer, t.sz_transport_data,
               f.naimenovanie AS firma_name
        FROM transport_oper t
        LEFT JOIN firmy f ON f.id_firmy = t.id_firma
        WHERE t.id = ?
      `, [transId]);
      if (!oper) return send(res, 404, { error: 'Транспортная операция не выбрана' });
      // VBA (CommandButton9): If transOp.szTransportID = "" Then «Письмо не создано»
      if (String(oper.sz_transport_id || '').trim() === '') {
        return send(res, 400, { error: 'Письмо не создано' });
      }
      kod = String(oper.sz_transport_id).trim();
      } // ✅ T44: конец ветки id_transporta

      // --- Учётные данные портала (VBA: лист «настройки», E4/E5) ---
      const cfg = edo.loadEdoConfig();
      if (!cfg.username || !cfg.password) {
        return send(res, 500, { error: 'Не заданы учётные данные портала ЭДО (config/edo.json: username, password)' });
      }
      const edoOpts = { cfg, rejectUnauthorized: cfg.reject_unauthorized };

      // --- GET ViewShablon.aspx?mode=edit&d_kod=<kod>; ✅ T37-C: пустой
      //     ответ — повторить запрос (до 3 раз), как в kartEdit ---
      const letterCard = { LETTER: undefined, D_NOM: '', DATE_DOC: '', D_NAME: '' };
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
        edo.fillFromHTML(letterCard, html);
        // ✅ T39-B: LETTER — RCDATA-извлечение из ИСХОДНИКА страницы
        // (extractTextareaRaw): тело письма — HTML-разметка, теги и
        // сущности не должны разбираться (fillFromHTML терял <div>/<br />
        // — разметка слетала). Поля нет на странице — страница-заглушка,
        // повторить запрос (баг портала ВАЗ)
        const rawLetter = edo.extractTextareaRaw(html, 'LETTER');
        if (rawLetter !== null) letterCard.LETTER = rawLetter;
        if (letterCard.LETTER !== undefined) break;
      }
      // ✅ T37-C: диагностика — последний HTML страницы текста СЗ
      try {
        const logsDir = path.join(__dirname, '..', '..', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(path.join(logsDir, 'edo_viewshablon_last.html'), String(html), 'utf8');
      } catch (e) { /* диагностика не должна ломать алгоритм */ }
      if (letterCard.LETTER === undefined) {
        // ✅ T61: поля LETTER на странице нет. Но если портал вернул
        // <div id="LetterDiv"> с текстом — документ ПОДПИСАН на портале:
        // редактируемой формы больше нет, тело письма отдаётся только на
        // просмотр. Отдаём клиенту письмо с признаком signed=true — модалка
        // откроется в режиме «Только просмотр» (без кнопки сохранения).
        const signedHTML = edo.extractLetterDivHTML(html);
        if (signedHTML) {
          return send(res, 200, {
            id_sz: kod,
            letter: signedHTML,
            d_nom: String(letterCard.D_NOM || '').trim(),
            date_doc: String(letterCard.DATE_DOC || '').trim(),
            d_name: String(letterCard.D_NAME || '').trim(),
            signed: true
          });
        }
        return send(res, 502, { error: 'ViewShablon: портал вернул пустую страницу после ' + maxAttempts + ' запросов (баг портала ВАЗ). Повторите позже' });
      }

      // --- D_NOM/DATE_DOC/D_NAME: со страницы, иначе из transport_oper ---
      const toRuDate = (v) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
        return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v || '').trim();
      };
      // krat_sod — формула VBA CommandButton12:
      // «Срочная заявка на " & sDate & sSender & " - " & sReceiver»
      // ✅ T44: при прямом d_kod (СЗ в СБ) операция может не выбираться
      const isSending = oper && String(oper.napravlenie || '').trim() === 'Исходящая';
      const AVTOVAZ = 'АО "АВТОВАЗ"';
      const sSender = isSending ? AVTOVAZ : ((oper && oper.firma_name) || '');
      const sReceiver = isSending ? ((oper && oper.firma_name) || '') : AVTOVAZ;
      const kratSod = oper
        ? `Срочная заявка на ${toRuDate(oper.otgruzka_data)} ${sSender} - ${sReceiver}`
        : '';

      const dNom = String(letterCard.D_NOM || '').trim() ||
        (oper ? String(oper.sz_transport_nomer || '').trim() : '');
      const dateDoc = String(letterCard.DATE_DOC || '').trim() ||
        (oper ? toRuDate(oper.sz_transport_data) : '');
      const dName = String(letterCard.D_NAME || '').trim() || kratSod;

      send(res, 200, {
        id_sz: kod,
        letter: String(letterCard.LETTER == null ? '' : letterCard.LETTER),
        d_nom: dNom,
        date_doc: dateDoc,
        d_name: dName
      });
    } catch (e) {
      console.error('[GET_SZ_LETTER] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T39-B: POST_SAVE_SZ_TEMPLATE — сохранение ОТРЕДАКТИРОВАННОГО текста
  // СЗ на портал (SaveShablon.aspx). Эталон — захват POST браузера со
  // страницы ViewShablon.aspx?mode=edit&d_kod=: multipart/form-data в
  // windows-1251 (разделители ------WebKitFormBoundary…), Basic-аутент.,
  // результат = HTTP 200 (VBA: SaveTemplateToPortal = (status = 200)).
  // d_kod = sz_transport_id (VBA transOp.szTransportID); ВСЕ параметры
  // POST — значения именованных полей СТРАНИЦЫ (collectShablonFormFields):
  // подписант PODP/PODP_KOD, исполнитель D_ISPOLN/D_ISPOLN_KOD/TEL_ISP,
  // должность O_OTV_ISP, адресаты DESTINATION_LIST, категория PRIVACY,
  // DATE_DOC/D_NOM/D_NAME — уходят со страницы и порталом не затираются
  // (раньше пустые умолчания VBA затирали их). LETTER — отредактированный
  // текст из модального окна (HTML-разметка тела, RCDATA-извлечение).
  // ========================================================================
  async POST_SAVE_SZ_TEMPLATE(req, res) {
    try {
      const d = await parseBody(req);
      const letter = String(d.letter == null ? '' : d.letter);
      // ✅ T44: d_kod в теле — сохранение текста ЛЮБОГО письма (кнопка
      // «Редактировать» строки «СЗ в СБ об отгрузке»). Без d_kod —
      // прежний поток T39-B (id_transporta -> sz_transport_id операции).
      const dkodBody = String(d.d_kod || '').trim();
      let kod = '';
      if (dkodBody) {
        kod = dkodBody;
      } else {
      const transId = String(d.id_transporta || '').trim();
      // VBA: If Me.lstTransportOper.ListIndex <= 0 Then «Транспортная опреация не выбрана»
      if (!transId) return send(res, 400, { error: 'Транспортная операция не выбрана' });
      const oper = await db.get(`
        SELECT t.id, t.napravlenie, t.id_firma, t.otgruzka_data,
               t.sz_transport_id, t.sz_transport_nomer, t.sz_transport_data,
               f.naimenovanie AS firma_name
        FROM transport_oper t
        LEFT JOIN firmy f ON f.id_firmy = t.id_firma
        WHERE t.id = ?
      `, [transId]);
      if (!oper) return send(res, 404, { error: 'Транспортная операция не выбрана' });
      // VBA (CommandButton9): If transOp.szTransportID = "" Then «Письмо не создано»
      if (String(oper.sz_transport_id || '').trim() === '') {
        return send(res, 400, { error: 'Письмо не создано' });
      }
      kod = String(oper.sz_transport_id).trim();
      } // ✅ T44: конец ветки id_transporta

      // --- Учётные данные портала (VBA: лист «настройки», E4/E5) ---
      const cfg = edo.loadEdoConfig();
      if (!cfg.username || !cfg.password) {
        return send(res, 500, { error: 'Не заданы учётные данные портала ЭДО (config/edo.json: username, password)' });
      }
      const edoOpts = { cfg, rejectUnauthorized: cfg.reject_unauthorized };

      // --- ✅ T39-B: POST формируется из ВСЕХ полей страницы
      // ViewShablon.aspx?mode=edit&d_kod= (эталон — захват POST
      // SaveShablon.aspx браузера, multipart): GET страницы (с ретраем
      // пустого первого GET, ✅ T37-C) -> collectShablonFormFields -> все
      // именованные поля (d_kod, kod_proizv, kod_podr, prinadl,
      // registrator, IS_DEST_LIST, DATE_DOC, D_NOM, NA_NOM, OT, D_NAME,
      // DESTINATION_LIST, DOLGN, KOMY, FIO, LETTER, O_OTV_ISP, PODP,
      // PODP_KOD, D_ISPOLN, D_ISPOLN_KOD, TEL_ISP, PRIVACY) уходят СО
      // СТРАНИЦЫ -> LETTER заменяется отредактированным текстом из
      // модального окна. Пустых умолчаний VBA (PODP="", D_ISPOLN="" и
      // т.д.) больше нет — подписант/исполнитель не затираются.
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
      // ✅ T37-C: диагностика — последний HTML страницы перед сохранением
      try {
        const logsDir = path.join(__dirname, '..', '..', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(path.join(logsDir, 'edo_viewshablon_save_last.html'), String(html), 'utf8');
      } catch (e) { /* диагностика не должна ломать алгоритм */ }
      const pageFields = edo.collectShablonFormFields(html);
      if (!pageFields.length) {
        return send(res, 502, { error: 'ViewShablon: портал вернул пустую страницу после ' + maxAttempts + ' запросов (баг портала ВАЗ). Повторите позже' });
      }

      // --- VBA: SaveTemplateToPortal(d_kod, LETTER_content, username, password, ...) ---
      let okSaved = false;
      try {
        okSaved = await edo.saveTemplateToPortal(
          kod,                                                          // d_kod
          letter,                                                       // LETTER_content (из модала)
          cfg.username, cfg.password,
          Object.assign({}, edoOpts, { fields: pageFields })
        );
      } catch (e) {
        return send(res, 502, { error: 'Ошибка сохранения текста СЗ: ' + e.message });
      }
      // VBA: SaveTemplateToPortal = (HttpReq.status = 200)
      if (!okSaved) {
        return send(res, 502, { error: 'Портал вернул статус, отличный от 200' });
      }
      send(res, 200, { ok: true });
    } catch (e) {
      console.error('[POST_SAVE_SZ_TEMPLATE] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T44: POST_OPEN_SZ_BROWSER — «Открыть сайт с документом» (СЗ).
  // Референс nak_M_15 (переход к накладной М-15): документ открывается в
  // браузере ПО УМОЛЧАНИЮ (Яндекс Браузер) — запуск browser.exe --app=URL
  // через puppeteer-core, Basic-аутентификация вводится в браузер
  // (page.authenticate — аналог VBA AuthPopup), окно выводится вперёд.
  // VBA-прототип CommandButton9_Click:
  //   targetUrl = "https://docs.vaz.ru/main.aspx?d_kod=" & transOp.szTransportID
  //   ie.Navigate targetUrl (+ AuthPopup)
  // d_kod = toSzTransportID (СЗ на транспорт) или toSzSbId (СЗ в СБ).
  // ========================================================================
  async POST_OPEN_SZ_BROWSER(req, res) {
    try {
      const d = await parseBody(req);
      const kod = String(d.d_kod || '').trim();
      // VBA (CommandButton9): If transOp.szTransportID = "" Then «Письмо не создано»
      if (!kod) return send(res, 400, { error: 'Документ не создан' });
      const cfg = edo.loadEdoConfig();
      if (!cfg.username || !cfg.password) {
        return send(res, 500, { error: 'Не заданы учётные данные портала ЭДО (config/edo.json: username, password)' });
      }
      // VBA: cfg.docs_url = "https://docs.vaz.ru/main.aspx?d_kod="
      const targetUrl = String(cfg.docs_url || 'https://docs.vaz.ru/main.aspx?d_kod=') +
        encodeURIComponent(kod);
      const out = await browserLauncher.openDocument(targetUrl, {
        username: cfg.username,
        password: cfg.password
      });
      // ✅ T46: warning (нет связи с сайтом / окно закрыто) — в ответ
      // клиенту с кодом 200, НЕ исключение: сервер продолжает работу
      send(res, 200, out.warning
        ? { ok: true, url: targetUrl, warning: out.warning }
        : { ok: true, url: targetUrl });
    } catch (e) {
      console.error('[POST_OPEN_SZ_BROWSER] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T44: POST_OPEN_NAKL_BROWSER — «Открыть сайт с документом» (М-15).
  // ПОЛНЫЙ АНАЛОГ референса nak_M_15 POST /api/open-in-yandex: портал
  // SIPORA (tportal.vaz.ru/sipora/ou38) открывается в Яндекс Браузере,
  // номер накладной вводится в поле A-F-SB01_NOMWB, клик по кнопке
  // поиска _findsub. Номера на форме через «, » (или «0») — для поиска
  // берётся первый; пусто/«0» — сайт открывается без поиска.
  // ========================================================================
  async POST_OPEN_NAKL_BROWSER(req, res) {
    try {
      const d = await parseBody(req);
      const raw = String(d.nomer || '').trim();
      const first = raw.split(',')[0].trim();
      const nomer = (first && first !== '0') ? first : '';
      const cfg = edo.loadEdoConfig();
      if (!cfg.username || !cfg.password) {
        return send(res, 500, { error: 'Не заданы учётные данные портала ЭДО (config/edo.json: username, password)' });
      }
      const targetUrl = sipora.getBaseUrl(cfg);
      // Референс: waitForSelector('#A-F-SB01_NOMWB') -> click(clickCount:3)
      // -> type(waybillNumber) -> click('#_findsub')
      const fill = nomer
        ? { selector: '#A-F-SB01_NOMWB', value: nomer, searchButton: '#_findsub' }
        : null;
      const out = await browserLauncher.openDocument(targetUrl, {
        username: cfg.username,
        password: cfg.password,
        fill
      });
      // ✅ T46: warning (нет связи с сайтом / окно закрыто) — в ответ
      // клиенту с кодом 200, НЕ исключение: сервер продолжает работу
      const resp = { ok: true, url: targetUrl, searched: !!fill, nomer: nomer };
      if (out.warning) resp.warning = out.warning;
      send(res, 200, resp);
    } catch (e) {
      console.error('[POST_OPEN_NAKL_BROWSER] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },
  // ========================================================================
  // ✅ T47: POST_DELETE_SZ — «Удалить СЗ» (красный крестик у строк СЗ).
  // Алгоритм (по пользователю): 1) простой GET-запрос в систему ВАЗ
  //   https://docs.vaz.ru/document_delete.aspx?d_kod=<id>
  // (Basic-аутентификация, как во всех запросах к порталу);
  // 2) при успехе — очистка полей СЗ в transport_oper:
  //    СЗ на транспорт: sz_transport_id / sz_transport_nomer / sz_transport_data;
  //    СЗ в СБ:         sz_sb_id / sz_sb_otgruzka / sz_sb_otgruzka_data;
  // 3) интерфейс обновляется через WS; поля строки очищает клиент.
  // ВАЖНО: при ошибке портала БД НЕ очищается (документ остаётся и в
  // системе ВАЗ, и в базе — можно повторить попытку после восстановления
  // связи). id СЗ берётся из БД, а не из тела запроса — защита от
  // рассинхрона интерфейса.
  // ========================================================================
  async POST_DELETE_SZ(req, res) {
    try {
      const d = await parseBody(req);
      const transId = String(d.id_transporta || '').trim();
      const tip = String(d.tip || 'transport').trim() === 'sb' ? 'sb' : 'transport';
      if (!transId) return send(res, 400, { error: 'Транспортная операция не выбрана' });
      const oper = await db.get('SELECT * FROM transport_oper WHERE id = ?', [transId]);
      if (!oper) return send(res, 404, { error: 'Транспортная операция не выбрана' });
      const fieldId = tip === 'sb' ? oper.sz_sb_id : oper.sz_transport_id;
      if (String(fieldId || '').trim() === '') {
        return send(res, 400, { error: tip === 'sb' ? 'СЗ в СБ об отгрузке не создана' : 'Письмо не создано' });
      }
      const kod = String(fieldId).trim();
      // ID из интерфейса, если передан, должен совпадать с базой
      if (d.d_kod && String(d.d_kod).trim() !== kod) {
        return send(res, 409, { error: 'ID СЗ в интерфейсе не совпадает с базой — обновите операцию (F5) и повторите' });
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
      try {
        const logsDir = path.join(__dirname, '..', '..', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(path.join(logsDir, 'edo_document_delete_last.html'), String(body), 'utf8');
      } catch (e) { /* диагностика не должна ломать алгоритм */ }
      // Очистка полей СЗ в БД (как до создания письма)
      if (tip === 'sb') {
        await db.run('UPDATE transport_oper SET sz_sb_id = \'\', sz_sb_otgruzka = \'\', sz_sb_otgruzka_data = \'\' WHERE id = ?', [transId]);
      } else {
        await db.run('UPDATE transport_oper SET sz_transport_id = \'\', sz_transport_nomer = \'\', sz_transport_data = \'\' WHERE id = ?', [transId]);
      }
      // WS: список операций (sz_*) обновится у всех клиентов
      const deps = new Set(getDependencies('transportOps.list'));
      wsManager.notifyWithDependencies(deps, 'update', transId);
      send(res, 200, { ok: true, d_kod: kod, tip });
    } catch (e) {
      console.error('[POST_DELETE_SZ] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },


  // ========================================================================
  // ✅ T37-B: GET_SZ_INFO — данные СЗ выбранной операции для вкладки
  // «Документы»: sz_transport_id/nomer/data из transport_oper (как в VBA —
  // хранятся в записи Транспортные_операции), ссылка на файл заявки в папке
  // «отгрузка» (public/uploads/sz, имя вычисляется по VBA) и адрес карточки
  // документа в ИДО (docs.vaz.ru/main.aspx?d_kod=ID, VBA CommandButton9).
  // ========================================================================
  async GET_SZ_INFO(req, res, url) {
    try {
      const transId = url.searchParams.get('id_transporta');
      if (!transId) return send(res, 400, { error: 'id_transporta не указан' });

      const oper = await db.get(`
        SELECT t.id, t.napravlenie, t.id_firma, t.otgruzka_data,
               t.sz_transport_id, t.sz_transport_nomer, t.sz_transport_data,
               f.naimenovanie AS firma_name
        FROM transport_oper t
        LEFT JOIN firmy f ON f.id_firmy = t.id_firma
        WHERE t.id = ?
      `, [transId]);
      if (!oper) return send(res, 200, null);

      const toRuDate = (v) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
        return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v || '').trim();
      };
      const isSending = String(oper.napravlenie || '').trim() === 'Исходящая';
      const AVTOVAZ = 'АО "АВТОВАЗ"';
      const sSender = isSending ? AVTOVAZ : (oper.firma_name || '');
      const sReceiver = isSending ? (oper.firma_name || '') : AVTOVAZ;
      const sDate = toRuDate(oper.otgruzka_data);
      const fileName = szExcel.buildFileName(sSender, sReceiver, sDate);

      const cfg = edo.loadEdoConfig();
      let fileUrl = '';
      if (oper.sz_transport_id) {
        try {
          const p = path.join(__dirname, '..', '..', 'public', 'uploads', 'sz', fileName);
          if (fs.existsSync(p)) fileUrl = '/uploads/sz/' + encodeURIComponent(fileName);
        } catch (e) { /* нет доступа к диску — без ссылки на файл */ }
      }

      send(res, 200, {
        id_sz: oper.sz_transport_id || '',
        d_nom: oper.sz_transport_nomer || '',
        date_doc: oper.sz_transport_data || '',
        file_name: oper.sz_transport_id ? fileName : '',
        file_url: fileUrl,
        edo_url: oper.sz_transport_id ? (cfg.docs_url + encodeURIComponent(oper.sz_transport_id)) : ''
      });
    } catch (e) {
      console.error('[GET_SZ_INFO] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T38: СОЗДАНИЕ НАКЛАДНЫХ М-15 В СИСТЕМЕ ВАЗ (SIPORA tportal.vaz.ru)
  // ПОЛНЫЙ ПОРТ VBA cmdAddNakl_M15_Click (frmTransportOper) + modNaklad.Add:
  //   1) guard-и: цех-изготовитель (txtCexIzgot); код получателя
  //      (tfSupplierCode, «нет данных» = не указан); дата отгрузки
  //      (txtOtgruzkaData); наличие позиций (ListCount <= 1);
  //   2) группировка позиций по основанию (договору, col 18 = DogOsnov):
  //      без основания — в список пропущенных; нулевое количество — мимо;
  //      оснастка с «/» РАЗДЕЛЯЕТСЯ на ДВЕ позиции с полным количеством
  //      (VBA: art1 = слева от «/»; art2 = Left(левая, Len(левая) -
  //      Len(правая)) & правая, а если правая длиннее — она целиком);
  //   3) по каждой группе (порядок словаря = порядок вставки, как VBA
  //      dict.Keys) — sipora.add: lookup отправителя/получателя/поставщика
  //      (1F010)/основания + номенклатуры артикулов; удаление существующих
  //      накладных (дата+отпр+получ); /ins/mask/A; повторная загрузка
  //      (SB01_NOMWB + SB01_RECID); /ins/mask/B на каждую позицию;
  //   4) поля формы: номера через «, » (или «0») + дата отгрузки —
  //      в VBA кнопка заполняет txtFormM15UPD/_D, а в таблицу пишет
  //      СОХРАНЕНИЕ ФОРМЫ; в веб-версии поля заполняет клиент из ответа,
  //      запись в transport_oper.form_m15upd — при сохранении операции
  //      (клиент собирает композит «номера от дата» как VBA).
  // Учётные данные: config/edo.json (те же E4/E5, что у ЭДО);
  // адрес SIPORA — cfg.sipora_url (по умолчанию
  // https://tportal.vaz.ru/sipora/ou38 — Const BASE_URL из VBA).
  // ========================================================================
  async POST_CREATE_M15(req, res) {
    try {
      const d = await parseBody(req);
      const transId = String(d.id_transporta || '').trim();
      // VBA: выбор операции проверяется на форме; в веб — id_transporta
      if (!transId) return send(res, 400, { error: 'Транспортная операция не выбрана' });
      const oper = await db.get('SELECT * FROM transport_oper WHERE id = ?', [transId]);
      if (!oper) return send(res, 404, { error: 'Транспортная операция не выбрана' });

      // --- Учётные данные портала (VBA: лист «настройки», E4/E5) ---
      const cfg = edo.loadEdoConfig();
      if (!cfg.username || !cfg.password) {
        return send(res, 500, { error: 'Не заданы учётные данные портала ЭДО (config/edo.json: username, password)' });
      }

      // --- 1. Общие параметры (VBA: senderCode/receiverCode/shippingDate) ---
      // VBA: senderCode = Me.txtCexIzgot.text
      const senderCode = String(oper.cex_izgot || '').trim();
      if (!senderCode) {
        return send(res, 400, { error: 'Не указан цех-изготовитель' });
      }
      // VBA: receiverCode = Me.tfSupplierCode.Caption (код фирмы-поставщика)
      const firmaRow = oper.id_firma
        ? await db.get('SELECT kod FROM firmy WHERE id_firmy = ?', [oper.id_firma])
        : null;
      const receiverCode = firmaRow ? String(firmaRow.kod || '').trim() : '';
      if (!receiverCode || receiverCode === 'нет данных') {
        return send(res, 400, { error: 'Не указан код получателя' });
      }
      // VBA: shippingDate = Me.txtOtgruzkaData.text (текст ДД.ММ.ГГГГ)
      const toRuDate = (v) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
        return m ? m[3] + '.' + m[2] + '.' + m[1] : String(v || '').trim();
      };
      const shippingDate = toRuDate(oper.otgruzka_data);
      if (!shippingDate) {
        return send(res, 400, { error: 'Не указана дата отгрузки' });
      }
      // ISO для input type=date на вкладке (веб-БД — ISO)
      const toIsoDate = (v) => {
        const s = String(v || '').trim();
        const ru = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
        if (ru) return ru[3] + '-' + ru[2] + '-' + ru[1];
        const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
        return iso ? iso[1] + '-' + iso[2] + '-' + iso[3] : '';
      };
      const dataIso = toIsoDate(oper.otgruzka_data) || shippingDate;

      // VBA: throughWhom = cbFIO_Vodit; transNum = cblblGosN (перевозчик операции)
      let throughWhom = '', transNum = '';
      if (oper.id_perevozchik) {
        const pv = await db.get('SELECT fio_vodit, gos_n FROM perevozchik WHERE id = ?', [oper.id_perevozchik]);
        if (pv) { throughWhom = String(pv.fio_vodit || ''); transNum = String(pv.gos_n || ''); }
      }
      const postCode = '1F010';   // VBA Const postCode = "1F010"
      const typeMove = '1';       // VBA typeMove = "1"
      const trailNum = '';        // VBA trailNum = ""

      // --- 3. Проверка наличия позиций (VBA ListCount <= 1) ---
      // VBA-колонки списка: 1 = № чертежа (osnastka), 5 = Годн,шт (no_br),
      // 6 = Брак,шт (yes_br), 18 = Док. осн. (DogOsnov) — BuildTransportArray.
      // ✅ T55: добавлены os.naimenovanie (наименование из БД — уйдёт в М-15
      // вместо имени из справочника SIPORA), gz.kolvo_zagotovok («Кол-во
      // заготовок», T24B) и параметры раскроя плана (лист/пруток).
      const poz = await db.all(
        'SELECT os.nomer_chertezha, os.naimenovanie, ' +
        'COALESCE(gz.kolvo_no_br, 0) AS kolvo_no_br, ' +
        'COALESCE(gz.kolvo_yes_br, 0) AS kolvo_yes_br, gz.kolvo_zagotovok, ' +
        'gz.tip_gruza, ' + // ✅ T57: персональный тип груза позиции
        'pp.dog_osnov, ' +
        'p.list_dlina, p.list_shirina, p.list_tolshina, p.prutok_dlina, ' +
        'os.dlina, os.shirina, os.vysota, os.ves_zag ' +
        'FROM gryz_poz gz ' +
        'JOIN plan_perevozok pp ON gz.id_plana = pp.id ' +
        'LEFT JOIN plan p ON pp.id_plana = p.id ' +
        'LEFT JOIN osnastka os ON p.id_osnastka = os.id ' +
        'WHERE gz.id_transporta = ?',
        [transId]
      );
      if (!poz.length) {
        return send(res, 400, { error: 'Нет позиций в списке транспортной операции!' });
      }

      // VBA SafeConvertToDouble: текст в число, пусто/ошибка -> 0
      const safeDouble = (v) => {
        if (v == null) return 0;
        const s = String(v).trim();
        if (s === '') return 0;
        const n = parseFloat(s.replace(',', '.'));
        return isNaN(n) ? 0 : n;
      };

      // ✅ T55: КОЛИЧЕСТВО позиции М-15 — по типу груза операции:
      //   'tara' (отдельные заготовки) — годн + брак (как в VBA);
      //   'listy' / 'prutki'           — «Кол-во заготовок»: ручное
      //       gz.kolvo_zagotovok (>0), иначе АВТО-раскрой теми же формулами,
      //       что POST_CALC_TARA (лист — гильотина, припуск 4 мм; пруток —
      //       припуск 5 мм); параметры раскроя не заданы -> штучная
      //       (годн + брак) + предупреждение в итоговом сообщении.
      // T56: 'smesh' — тип каждой позиции по её параметрам (лист > пруток > штучная).
      const vidRaw = String(oper.vid_gruza || '').trim();
      // T56: 'smesh' (смешанный) — тип каждой позиции определяется в m15QtyFor
      const vidGruza = (vidRaw === 'smesh' || VID_GRUZA_LIST.includes(vidRaw)) ? vidRaw : 'tara';
      const m15Warnings = [];
      const m15QtyFor = (row) => {
        const pieces = safeDouble(row.kolvo_no_br) + safeDouble(row.kolvo_yes_br);
        // ✅ T57: тип позиции — ПЕРСОНАЛЬНЫЙ (gryz_poz.tip_gruza, 3 типа);
        // пусто — совместимость: старая логика по vid_gruza операции/параметрам
        let vidRow = String(row.tip_gruza || '').trim();
        if (!['listy', 'prutki', 'zagotovki'].includes(vidRow)) {
          vidRow = vidGruza;
          if (vidRow === 'smesh') {
            const hasListPoz = safeDouble(row.list_dlina) > 0 && safeDouble(row.list_shirina) > 0 && safeDouble(row.list_tolshina) > 0;
            vidRow = hasListPoz ? 'listy' : (safeDouble(row.prutok_dlina) > 0 ? 'prutki' : 'tara');
          }
        }
        // zagotovki (отдельные заготовки) = прежний 'tara': годн + брак
        if (vidRow === 'tara' || vidRow === 'zagotovki') return pieces;
        const manual = safeDouble(row.kolvo_zagotovok);   // T24B: ручное «Кол-во заготовок»
        if (manual > 0) return manual;
        if (vidRow === 'listy') {
          const SL = safeDouble(row.list_dlina), SW = safeDouble(row.list_shirina), ST = safeDouble(row.list_tolshina);
          const DL = safeDouble(row.dlina), DW = safeDouble(row.shirina);
          if (SL > 0 && SW > 0 && ST > 0 && DL > 0 && DW > 0) {
            const pa = DL + LIST_PRIPUSK_MM, pb = DW + LIST_PRIPUSK_MM;
            const nA = Math.floor(SL / pa) * Math.floor(SW / pb);   // ориентация 1
            const nB = Math.floor(SL / pb) * Math.floor(SW / pa);   // ориентация 2
            const perSheet = Math.max(nA, nB);
            if (perSheet > 0) return Math.ceil(pieces / perSheet);
          }
          m15Warnings.push((row.nomer_chertezha || 'Позиция') + ': нет параметров листа — количество = годн+брак');
          return pieces;
        }
        const BL = safeDouble(row.prutok_dlina), DLp = safeDouble(row.dlina);
        if (BL > 0 && DLp > 0) {
          const perBar = Math.floor(BL / (DLp + PRUTOK_PRIPUSK_MM));
          if (perBar > 0) return Math.ceil(pieces / perBar);
        }
        m15Warnings.push((row.nomer_chertezha || 'Позиция') + ': нет параметров прутка — количество = годн+брак');
        return pieces;
      };

      // --- 4. Группировка по basisNum + сбор пропущенных (VBA 1:1) ---
      const groups = new Map();          // basisPos -> [{art, qty, name}]
      let missingBasisList = '';
      for (const row of poz) {
        const artRaw = String(row.nomer_chertezha == null ? '' : row.nomer_chertezha);
        // ✅ T55: количество — по типу груза (см. m15QtyFor)
        const totalQty = m15QtyFor(row);
        if (totalQty <= 0) continue;     // VBA GoTo nextRow
        const basisPos = String(row.dog_osnov == null ? '' : row.dog_osnov);
        if (!basisPos) {
          // Запоминаем пропущенные артикулы для отчёта (VBA 1:1)
          missingBasisList = missingBasisList ? missingBasisList + ', ' + artRaw : artRaw;
          continue;
        }
        if (!groups.has(basisPos)) groups.set(basisPos, []);
        const colPos = groups.get(basisPos);
        // ✅ T55: наименование детали — из БД (osnastka.naimenovanie по
        // чертёжному номеру грузовой позиции); пустое — в М-15 уйдёт имя
        // из справочника номенклатуры SIPORA (прежнее поведение)
        const posName = String(row.naimenovanie == null ? '' : row.naimenovanie).trim();
        // VBA: slashPos = InStr(artRaw, "/") — InStr 1-базная, 0 = не найдено
        const slashPos = artRaw.indexOf('/');
        if (slashPos !== -1) {
          const leftPart = artRaw.slice(0, slashPos);
          const rightPart = artRaw.slice(slashPos + 1);
          const art1 = leftPart;
          // VBA: If Len(leftPart) >= Len(rightPart) Then
          //        art2 = Left(leftPart, Len(leftPart) - Len(rightPart)) & rightPart
          //      Else art2 = rightPart
          let art2;
          if (leftPart.length >= rightPart.length) {
            art2 = leftPart.slice(0, leftPart.length - rightPart.length) + rightPart;
          } else {
            art2 = rightPart;
          }
          const qty = String(totalQty);  // VBA CStr(totalQty) — обе позиции с ПОЛНЫМ количеством
          colPos.push({ art: art1, qty, name: posName });
          colPos.push({ art: art2, qty, name: posName });
        } else {
          colPos.push({ art: artRaw, qty: String(totalQty), name: posName });
        }
      }

      // --- 5. Если нет ни одной группы (VBA 1:1) ---
      if (groups.size === 0) {
        const msgNoBasis = missingBasisList
          ? 'Нет позиций с указанным основанием (basisNum).\nПропущенные артикулы: ' + missingBasisList
          : 'Нет позиций с ненулевым количеством!';
        return send(res, 400, { error: msgNoBasis });
      }

      // --- 6. Создание накладных по группам (VBA: For Each vKey In dict.Keys) ---
      const resultNaklNumbers = [];
      const errorsList = [];
      for (const [basisNumGroup, colGroup] of groups) {
        const arts = colGroup.map(x => x.art);
        const qtys = colGroup.map(x => x.qty);
        const r = await sipora.add(cfg, {
          senderCode, receiverCode, postCode, basisNum: basisNumGroup,
          shippingDate, throughWhom, typeMove, transNum, trailNum,
          pozArticuls: arts, pozQuantities: qtys,
          pozNames: colGroup.map((x) => x.name || '')   // ✅ T55: наименования из БД
        });
        if (r.number) resultNaklNumbers.push(r.number);
        else errorsList.push('Основание «' + basisNumGroup + '»: ' + (r.error || ''));
      }

      // --- 7. Поля формы (VBA: только успешные; иначе «0») ---
      const numbers = resultNaklNumbers.join(', ');

      // --- 8. Итоговое сообщение с полными причинами (VBA finalMsg) ---
      const successCount = resultNaklNumbers.length;
      let finalMsg = 'Создано накладных: ' + successCount + ' из ' + groups.size;
      if (numbers) finalMsg += '. Номера: ' + numbers;
      if (missingBasisList) finalMsg += '. Позиции пропущены из-за отсутствия основания (basisNum): ' + missingBasisList;
      // ✅ T55: предупреждения о количестве (listy/prutki без параметров раскроя)
      if (m15Warnings.length) finalMsg += '. Количество: ' + [...new Set(m15Warnings)].join('; ');
      if (errorsList.length) finalMsg += '. Ошибки при создании накладных: ' + errorsList.join('\n');
      // VBA: ok, если нет ошибок и пропущенных; иначе warning
      const msgType = (errorsList.length === 0 && !missingBasisList) ? 'success' : 'warning';

      return send(res, 200, {
        numbers,                       // '' если ни одной — клиент ставит «0»
        data_ru: shippingDate,         // ДД.ММ.ГГГГ — для композита «номера от дата»
        data_iso: dataIso,             // для input type=date
        created: successCount,
        total: groups.size,
        missing: missingBasisList,
        errors: errorsList,
        warnings: [...new Set(m15Warnings)],   // ✅ T55
        message: finalMsg,
        message_type: msgType
      });
    } catch (e) {
      console.error('[POST_CREATE_M15] Error:', e.message);
      return send(res, 500, { error: e.message });
    }
  }
});