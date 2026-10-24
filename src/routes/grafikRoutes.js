const { parseBody, send, generateId } = require('../utils');
// ✅ Кир→Лат: JS-сравнение через общий хелпер гомоглифов
const { matches: hgMatches } = require('./helpers/homoglyphs');

// ============================================================
// СЕРВЕРНАЯ ФИЛЬТРАЦИЯ ПО СТРАНИЦЕ ГРАФИКА (наименование /
// номер чертежа). ВАЖНО про регистр:
//   * Встроенные UPPER()/LOWER() в SQLite работают только с ASCII,
//     поэтому LIKE не даёт регистронезависимости для кириллицы;
//   * Драйвер sqlite3 не поддерживает пользовательские SQL-функции
//     (Database.prototype.function отсутствует), и обёртка Database.js
//     — общий модуль, который трогать нельзя.
// Поэтому используется гибрид:
//   1) ASCII-запросы (латиница/цифры) фильтруются прямо в SQL
//      через UPPER()+LIKE (быстрый путь, с экранированием % и _);
//   2) запросы с кириллицей: SQL отбирает строки года, а
//      регистронезависимое сравнение выполняется в самом обработчике
//      (на сервере) средствами JS — объёмы годового плана это позволяют.
// Клиенту в обоих случаях возвращается уже отфильтрованный массив.
// ============================================================

// Запрос целиком в ASCII (латиница, цифры, знаки)?
function isAsciiOnly(s) {
  return /^[\x00-\x7F]*$/.test(s);
}

// Экранирование спецсимволов LIKE (%, _, \), чтобы пользовательский
// ввод сравнивался буквально, а не как маска
function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

module.exports = (db, wsManager) => ({
  // ============================================================
  // СЕРВЕРНАЯ ФИЛЬТРАЦИЯ ПОЗИЦИЙ ПЛАНА ДЛЯ СТРАНИЦЫ ГРАФИКА
  // GET /api/grafik/plans?god=2026&naimenovanie=...&nomer_chertezha=...
  //   god             — обязательный параметр (год планирования)
  //   naimenovanie    — фильтр по osnastka.naimenovanie (подстрока, без учёта регистра)
  //   nomer_chertezha — фильтр по osnastka.nomer_chertezha (подстрока, без учёта регистра)
  // Возвращает массив записей плана той же формы, что и /api/plan
  // (поля оснастки подтянуты JOIN-ом: nomer_chertezha, osn_naimenovanie),
  // поэтому saveAll по-прежнему может целиком раскладывать {...p}
  // в PUT /api/plan/:id без каких-либо изменений.
  // ============================================================
  async GET_PLANS(req, res, url) {
    const god = (url.searchParams.get('god') || '').trim();
    const naimenovanie = (url.searchParams.get('naimenovanie') || '').trim();
    const nomerChertezha = (url.searchParams.get('nomer_chertezha') || '').trim();

    if (!god) {
      return send(res, 400, { error: 'Не указан год (god)' });
    }

    // Если оба текстовых фильтра — чистый ASCII, всё делаем в SQL.
    // Иначе (кириллица) SQL-условия по тексту не добавляем:
    // UPPER() в SQLite не приводит русские буквы к одному регистру.
    const asciiFilterable =
      (naimenovanie === '' || isAsciiOnly(naimenovanie)) &&
      (nomerChertezha === '' || isAsciiOnly(nomerChertezha));

    const where = ['pl.god = ?'];
    const params = [god];

    if (asciiFilterable) {
      if (naimenovanie) {
        where.push("UPPER(COALESCE(o.naimenovanie, '')) LIKE UPPER(?) ESCAPE '\\'");
        params.push(`%${escapeLike(naimenovanie)}%`);
      }
      if (nomerChertezha) {
        where.push("UPPER(COALESCE(o.nomer_chertezha, '')) LIKE UPPER(?) ESCAPE '\\'");
        params.push(`%${escapeLike(nomerChertezha)}%`);
      }
    }

    const sql = `
      SELECT pl.*,
             o.nomer_chertezha AS nomer_chertezha,
             o.naimenovanie    AS osn_naimenovanie,
             f.naimenovanie    AS firma_name
        FROM plan pl
        LEFT JOIN osnastka o ON o.id = pl.id_osnastka
        LEFT JOIN kp ON kp.id = pl.id_kp
        LEFT JOIN firmy f ON f.id_firmy = kp.id_firma
       WHERE ${where.join(' AND ')}
       ORDER BY pl.god, pl.id
    `;

    try {
      let rows = await db.all(sql, params);

      // Кириллица: регистронезависимое сравнение на сервере средствами JS.
      // Набор уже ограничен годом, поэтому доп. выборка не требуется.
      if (!asciiFilterable) {
        // ✅ Кир→Лат: сравнение через общий хелпер гомоглифов (homoglyphs.js) —
        // «швеллер» находит «ШBEЛЛЕР», регистр кириллицы не важен
        rows = rows.filter(r =>
          (!naimenovanie || hgMatches(r.osn_naimenovanie, naimenovanie)) &&
          (!nomerChertezha || hgMatches(r.nomer_chertezha, nomerChertezha))
        );
      }

      send(res, 200, rows);
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  },

  // Получить все этапы графика для указанного плана
  async GET(req, res, url) {
    const idPlana = url.searchParams.get('id_plana');
    const sql = idPlana
      ? 'SELECT * FROM grafik WHERE id_plana = ? ORDER BY CAST(etap_nomer AS INTEGER)'
      : 'SELECT * FROM grafik ORDER BY id_plana, CAST(etap_nomer AS INTEGER)';
    const rows = await db.all(sql, idPlana ? [idPlana] : []);
    send(res, 200, rows);
  },

  // Получить этапы для НЕСКОЛЬКИХ планов (массовая загрузка)
  async POST_BULK(req, res) {
    const { planIds } = await parseBody(req);
    if (!Array.isArray(planIds) || planIds.length === 0) {
      return send(res, 200, { data: {} });
    }
    const placeholders = planIds.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT * FROM grafik WHERE id_plana IN (${placeholders}) ORDER BY id_plana, CAST(etap_nomer AS INTEGER)`,
      planIds
    );
    // Группируем по id_plana
    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.id_plana]) grouped[r.id_plana] = [];
      grouped[r.id_plana].push(r);
    });
    send(res, 200, { data: grouped });
  },

  // Сохранить график для плана (UPSERT — обновить или вставить)
   // Сохранить график для плана (UPSERT — последовательные await)
  async POST_SAVE(req, res) {
    const { id_plana, god, stages } = await parseBody(req);
    if (!id_plana || !Array.isArray(stages)) {
      return send(res, 400, { error: 'Неверный формат данных' });
    }

    try {
      // Начинаем транзакцию
      await db.run('BEGIN TRANSACTION');

      try {
        // Получаем существующие этапы для этого плана
        const existing = await db.all(
          'SELECT * FROM grafik WHERE id_plana = ?', [id_plana]
        );

        // Создаём карту существующих этапов по etap_nomer
        const existingMap = {};
        existing.forEach(e => {
          existingMap[e.etap_nomer] = e;
        });

        const baseYear = parseInt(god);

        // Обрабатываем каждый этап последовательно
        for (const s of stages) {
          // Пропускаем пустые этапы
          if (!s.plan_kolvo || parseFloat(s.plan_kolvo) === 0) continue;

          const monthNum = parseInt(s.etap_nomer);
          const year = baseYear + Math.floor((monthNum - 1) / 12);
          const month = ((monthNum - 1) % 12) + 1;
          const plan_data = `${year}-${String(month).padStart(2, '0')}-01`;

          if (existingMap[s.etap_nomer]) {
            // ОБНОВЛЯЕМ существующий этап
            await db.run(
              `UPDATE grafik SET plan_data=?, plan_kolvo=?, fact_data=?, fact_kolvo=?, status_etapa=?, primechanie=? WHERE id=?`,
              [plan_data, s.plan_kolvo, s.fact_data || '', s.fact_kolvo || '',
               s.status_etapa || '', s.primechanie || '', existingMap[s.etap_nomer].id]
            );
          } else {
            // ВСТАВЛЯЕМ новый этап
            const id = generateId('GI');
            await db.run(
              `INSERT INTO grafik VALUES(?,?,?,?,?,?,?,?,?)`,
              [id, id_plana, s.etap_nomer, plan_data, s.plan_kolvo,
               s.fact_data || '', s.fact_kolvo || '', s.status_etapa || '', s.primechanie || '']
            );
          }
        }

        // Удаляем этапы, которые были в БД, но отсутствуют в новых данных
        const newEtapNomers = stages
          .filter(s => s.plan_kolvo && parseFloat(s.plan_kolvo) > 0)
          .map(s => s.etap_nomer);

        for (const existingEtap of existing) {
          if (!newEtapNomers.includes(existingEtap.etap_nomer)) {
            await db.run('DELETE FROM grafik WHERE id = ?', [existingEtap.id]);
          }
        }

        // Фиксируем транзакцию
        await db.run('COMMIT');
        wsManager.notifyDataChange('grafik', 'update', id_plana);
        send(res, 200, { ok: true });

      } catch (innerErr) {
        // Откатываем транзакцию при ошибке
        await db.run('ROLLBACK');
        throw innerErr;
      }

    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },
  // Удалить график для плана
  async DELETE(req, res, url) {
    const idPlana = url.searchParams.get('id_plana');
    if (!idPlana) return send(res, 400, { error: 'Не указан id_plana' });
    await db.run('DELETE FROM grafik WHERE id_plana = ?', [idPlana]);
    wsManager.notifyDataChange('grafik', 'delete', idPlana);
    send(res, 200, { ok: true });
  }
});