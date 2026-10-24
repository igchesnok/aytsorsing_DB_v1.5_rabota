// ============================================================
// src/routes/perevozchikRoutes.js
// API: СПРАВОЧНИК ПЕРЕВОЗЧИКОВ
// GET через buildSyntheticQuery, мутации через notifyWithDependencies
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');

module.exports = (db, wsManager) => ({
    // ========================================================================
    // GET — список перевозчиков с серверной фильтрацией
    // ========================================================================
    async GET(req, res, url) {
        try {
            const { sql, params } = buildSyntheticQuery('perevozchik.list', {
                id: url.searchParams.get('id'),
                firma: url.searchParams.get('firma'),
                gos_n: url.searchParams.get('gos_n'),
                fio_vodit: url.searchParams.get('fio_vodit')
            });
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[perevozchikRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST — создание перевозчика
    // ========================================================================
    async POST(req, res) {
        const d = await parseBody(req);
        if (!d.gos_n || !d.vodit_ud || !d.firma) {
            return send(res, 400, {
                error: 'Заполните обязательные поля: Гос. номер, Водит. уд., Фирма'
            });
        }
        // Проверка дубликата по бизнес-ключу (gos_n + vodit_ud)
        if (d.gos_n.trim() && d.vodit_ud.trim()) {
            const dup = await db.get(
                `SELECT id FROM perevozchik
                 WHERE LOWER(TRIM(gos_n)) = LOWER(?) AND LOWER(TRIM(vodit_ud)) = LOWER(?)`,
                [d.gos_n.trim(), d.vodit_ud.trim()]
            );
            if (dup) {
                return send(res, 400, {
                    error: 'Перевозчик с таким Гос. номером и водительским уд. уже существует'
                });
            }
        }
        const id = generateId('PER');
        try {
            await db.run(
                `INSERT INTO perevozchik (id, marka_tc, gos_n, vodit_ud, fio_vodit, kontakt, firma)
                 VALUES (?,?,?,?,?,?,?)`,
                [id, d.marka_tc || '', d.gos_n.trim(), d.vodit_ud.trim(),
                 d.fio_vodit || '', d.kontakt || '', d.firma.trim()]
            );
            wsManager.notifyDataChange('perevozchik', 'add', id);
            send(res, 201, { id });
        } catch (e) {
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // PUT — обновление перевозчика
    // ========================================================================
    async PUT(req, res, url) {
        const id = url.pathname.split('/')[3];
        if (!id) return send(res, 400, { error: 'ID не указан' });
        const d = await parseBody(req);
        if (!d.gos_n || !d.vodit_ud || !d.firma) {
            return send(res, 400, {
                error: 'Заполните обязательные поля: Гос. номер, Водит. уд., Фирма'
            });
        }
        if (d.gos_n.trim() && d.vodit_ud.trim()) {
            const dup = await db.get(
                `SELECT id FROM perevozchik
                 WHERE LOWER(TRIM(gos_n)) = LOWER(?) AND LOWER(TRIM(vodit_ud)) = LOWER(?) AND id != ?`,
                [d.gos_n.trim(), d.vodit_ud.trim(), id]
            );
            if (dup) {
                return send(res, 400, {
                    error: 'Невозможно сохранить: такая комбинация Гос. номера и водит. уд. уже существует'
                });
            }
        }
        try {
            await db.run(
                `UPDATE perevozchik SET marka_tc=?, gos_n=?, vodit_ud=?, fio_vodit=?, kontakt=?, firma=? WHERE id=?`,
                [d.marka_tc || '', d.gos_n.trim(), d.vodit_ud.trim(),
                 d.fio_vodit || '', d.kontakt || '', d.firma.trim(), id]
            );

            wsManager.notifyDataChange('perevozchik', 'update', id);
            send(res, 200, { ok: true });
        } catch (e) {
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // DELETE — удаление перевозчика
    // ========================================================================
    async DELETE(req, res, url) {
        const id = url.pathname.split('/')[3];
        if (!id) return send(res, 400, { error: 'ID не указан' });
        try {
            await db.run('DELETE FROM perevozchik WHERE id=?', [id]);
            wsManager.notifyDataChange('perevozchik', 'delete', id);
            send(res, 200, { ok: true });
        } catch (e) {
            send(res, 400, { error: e.message });
        }
    }
});