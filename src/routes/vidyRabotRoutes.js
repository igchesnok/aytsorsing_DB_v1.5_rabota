// src/routes/vidyRabotRoutes.js
// API: ВИДЫ РАБОТ ПО ДОГОВОРАМ
const { parseBody, send, generateId } = require('../utils');
const { normalizeFk, validateFk, safeNum, safeStr } = require('./helpers/fkHelpers');

module.exports = (db, wsManager) => ({
  // ========================================================================
  // GET /api/sprav-vidy-rabot — справочник видов работ (для комбобокса)
  // ========================================================================
  async GET_SPRAV(req, res) {
    try {
      const rows = await db.all('SELECT * FROM sprav_vidy_rabot ORDER BY naimenovanie');
      send(res, 200, rows);
    } catch (e) {
      console.error('[vidyRabotRoutes.GET_SPRAV]', e);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // GET /api/vidy-rabot?id_dogovor=XXX — виды работ договора
  // ========================================================================
  async GET(req, res, url) {
    try {
      const idDogovor = url.searchParams.get('id_dogovor');
      if (!idDogovor) return send(res, 200, []);
      const rows = await db.all(
        `SELECT v.*, d.nom_dogovor, d.data_dogovor, f.naimenovanie AS firma_nazvanie
         FROM vidy_rabot_dogovor v
         LEFT JOIN dogovor d ON v.id_dogovor = d.id_dogovor
         LEFT JOIN firmy f ON d.id_firmy = f.id_firmy
         WHERE v.id_dogovor = ?
         ORDER BY v.naimenovanie`,
        [idDogovor]
      );
      send(res, 200, rows);
    } catch (e) {
      console.error('[vidyRabotRoutes.GET]', e);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // POST /api/vidy-rabot — добавить вид работ в договор
  // ========================================================================
  async POST(req, res) {
    try {
      const d = await parseBody(req);
      const idDogovor = normalizeFk(d.id_dogovor);
      if (!idDogovor) return send(res, 400, { error: 'Не указан договор' });
      if (!d.naimenovanie || !d.naimenovanie.trim()) {
        return send(res, 400, { error: 'Не указано наименование' });
      }
      const dogCheck = await validateFk(db, 'dogovor', 'id_dogovor', idDogovor, 'Договор');
      if (!dogCheck.ok) return send(res, 400, { error: dogCheck.error });

      // Проверка дубликата в рамках договора
      const dup = await db.get(
        `SELECT id FROM vidy_rabot_dogovor
         WHERE id_dogovor = ? AND LOWER(TRIM(naimenovanie)) = LOWER(?)`,
        [idDogovor, d.naimenovanie.trim()]
      );
      if (dup) return send(res, 400, { error: 'Такой вид работ уже есть в договоре' });

      const id = generateId('VRD');
      await db.run(
        `INSERT INTO vidy_rabot_dogovor (id, id_dogovor, id_sprav_vid, naimenovanie, stoimost)
         VALUES (?,?,?,?,?)`,
        [id, idDogovor, normalizeFk(d.id_sprav_vid), safeStr(d.naimenovanie), safeNum(d.stoimost)]
      );
      wsManager.notifyDataChange('vidy_rabot_dogovor', 'add', id);
      send(res, 201, { id });
    } catch (e) {
      console.error('[vidyRabotRoutes.POST]', e);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // PUT /api/vidy-rabot/:id — обновить вид работ
  // ========================================================================
  async PUT(req, res, url) {
    try {
      const id = url.pathname.split('/')[3];
      if (!id) return send(res, 400, { error: 'ID не указан' });
      const d = await parseBody(req);
      if (!d.naimenovanie || !d.naimenovanie.trim()) {
        return send(res, 400, { error: 'Не указано наименование' });
      }
      await db.run(
        `UPDATE vidy_rabot_dogovor
         SET naimenovanie=?, stoimost=?, id_sprav_vid=?
         WHERE id=?`,
        [safeStr(d.naimenovanie), safeNum(d.stoimost), normalizeFk(d.id_sprav_vid), id]
      );
      wsManager.notifyDataChange('vidy_rabot_dogovor', 'update', id);
      send(res, 200, { ok: true });
    } catch (e) {
      console.error('[vidyRabotRoutes.PUT]', e);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // DELETE /api/vidy-rabot/:id — удалить вид работ
  // ========================================================================
  async DELETE(req, res, url) {
    try {
      const id = url.pathname.split('/')[3];
      if (!id) return send(res, 400, { error: 'ID не указан' });
      await db.run('DELETE FROM vidy_rabot_dogovor WHERE id=?', [id]);
      wsManager.notifyDataChange('vidy_rabot_dogovor', 'delete', id);
      send(res, 200, { ok: true });
    } catch (e) {
      console.error('[vidyRabotRoutes.DELETE]', e);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // POST /api/vidy-rabot/copy — копирование видов работ между договорами
  // (групповая операция, аналог POST /api/routes/copy)
  // ========================================================================
  async POST_COPY(req, res) {
    try {
      const d = await parseBody(req);
      if (!d.source_dogovor_id || !d.target_dogovor_id) {
        return send(res, 400, { error: 'Укажите источник и приёмник' });
      }
      if (d.source_dogovor_id === d.target_dogovor_id) {
        return send(res, 400, { error: 'Источник и приёмник — один и тот же договор' });
      }
      const srcCheck = await validateFk(db, 'dogovor', 'id_dogovor', d.source_dogovor_id, 'Договор-источник');
      if (!srcCheck.ok) return send(res, 400, { error: srcCheck.error });
      const tgtCheck = await validateFk(db, 'dogovor', 'id_dogovor', d.target_dogovor_id, 'Договор-приёмник');
      if (!tgtCheck.ok) return send(res, 400, { error: tgtCheck.error });

      // Получаем виды работ источника
      const sourceRows = await db.all(
        'SELECT naimenovanie, stoimost, id_sprav_vid FROM vidy_rabot_dogovor WHERE id_dogovor=?',
        [d.source_dogovor_id]
      );
      if (sourceRows.length === 0) {
        return send(res, 400, { error: 'В договоре-источнике нет видов работ' });
      }

      // Получаем уже существующие виды работ приёмника (для дедупликации)
      const existingRows = await db.all(
        'SELECT LOWER(TRIM(naimenovanie)) AS key FROM vidy_rabot_dogovor WHERE id_dogovor=?',
        [d.target_dogovor_id]
      );
      const existingSet = new Set(existingRows.map(r => r.key));

      let copied = 0, skipped = 0;
      await db.run('BEGIN TRANSACTION');
      try {
        for (const row of sourceRows) {
          const key = (row.naimenovanie || '').trim().toLowerCase();
          if (existingSet.has(key)) { skipped++; continue; }
          const id = generateId('VRD');
          await db.run(
            `INSERT INTO vidy_rabot_dogovor (id, id_dogovor, id_sprav_vid, naimenovanie, stoimost)
             VALUES (?,?,?,?,?)`,
            [id, d.target_dogovor_id, row.id_sprav_vid, row.naimenovanie, row.stoimost]
          );
          existingSet.add(key);
          copied++;
        }
        await db.run('COMMIT');
      } catch (innerErr) {
        await db.run('ROLLBACK').catch(() => {});
        throw innerErr;
      }

      wsManager.notifyDataChange('vidy_rabot_dogovor', 'copy', d.target_dogovor_id);
      send(res, 200, {
        ok: true,
        copied,
        skipped,
        message: `Скопировано: ${copied}, пропущено (дубликаты): ${skipped}`
      });
    } catch (e) {
      console.error('[vidyRabotRoutes.POST_COPY]', e);
      send(res, 500, { error: e.message });
    }
  },
});