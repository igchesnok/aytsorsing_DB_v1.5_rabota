// ============================================================
// src/routes/transportTypesRoutes.js
// API: ТИПЫ ПЕРЕВОЗОК
// GET через buildSyntheticQuery, мутации через notifyWithDependencies
// ============================================================
const { parseBody, send } = require('../utils');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');

// Автовычисление учёта в остатке по направлению
function calcUchet(napravlenie) {
    return napravlenie === 'Входящая' ? -1 : 1;
}

module.exports = (db, wsManager) => ({
    // ========================================================================
    // GET — список типов перевозок с серверной фильтрацией
    // ========================================================================
    async GET(req, res, url) {
        try {
            const { sql, params } = buildSyntheticQuery('transportTypes.list', {
                id_tipa:            url.searchParams.get('id_tipa'),
                nazvanie_operatsii: url.searchParams.get('nazvanie_operatsii'),
                napravlenie:        url.searchParams.get('napravlenie'),
            });
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[transportTypesRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST — создание типа перевозки
    // ========================================================================
    async POST(req, res) {
        const d = await parseBody(req);
        if (!d.id_tipa || !d.id_tipa.trim()) {
            return send(res, 400, { error: 'Заполните ID типа перевозки' });
        }
        if (!d.nazvanie_operatsii || !d.nazvanie_operatsii.trim()) {
            return send(res, 400, { error: 'Заполните название операции' });
        }
        if (!d.napravlenie || !['Входящая', 'Исходящая'].includes(d.napravlenie)) {
            return send(res, 400, { error: 'Направление должно быть "Входящая" или "Исходящая"' });
        }

        const uchet = calcUchet(d.napravlenie);
        const idTipa = d.id_tipa.trim().toUpperCase().replace(/\s+/g, '_');

        try {
            await db.run(
                `INSERT INTO transport_types (id_tipa, nazvanie_operatsii, napravlenie, uchet_v_ostatke)
                 VALUES (?,?,?,?)`,
                [idTipa, d.nazvanie_operatsii.trim(), d.napravlenie, uchet]
            );
            // Авто-уведомление по всем зависимостям
            wsManager.notifyDataChange('transport_types', 'add', idTipa);
            send(res, 201, { id: idTipa });
        } catch (e) {
            if (e.message.includes('UNIQUE') || e.message.includes('PRIMARY')) {
                send(res, 400, { error: `ID типа "${idTipa}" уже существует` });
            } else {
                send(res, 400, { error: e.message });
            }
        }
    },

    // ========================================================================
    // PUT — обновление типа перевозки
    // ========================================================================
    async PUT(req, res, url) {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        if (!id) return send(res, 400, { error: 'ID не указан' });

        const d = await parseBody(req);
        if (!d.nazvanie_operatsii || !d.nazvanie_operatsii.trim()) {
            return send(res, 400, { error: 'Заполните название операции' });
        }
        if (!d.napravlenie || !['Входящая', 'Исходящая'].includes(d.napravlenie)) {
            return send(res, 400, { error: 'Направление должно быть "Входящая" или "Исходящая"' });
        }

        const uchet = calcUchet(d.napravlenie);

        try {
            const result = await db.run(
                `UPDATE transport_types
                 SET nazvanie_operatsii=?, napravlenie=?, uchet_v_ostatke=?
                 WHERE id_tipa=?`,
                [d.nazvanie_operatsii.trim(), d.napravlenie, uchet, id]
            );
            if (result.changes === 0) {
                return send(res, 404, { error: 'Тип перевозки не найден' });
            }
            wsManager.notifyDataChange('transport_types', 'update', id);
            send(res, 200, { ok: true });
        } catch (e) {
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // DELETE — удаление типа перевозки
    // ========================================================================
    async DELETE(req, res, url) {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        if (!id) return send(res, 400, { error: 'ID не указан' });

        try {
            await db.run('DELETE FROM transport_types WHERE id_tipa=?', [id]);
            wsManager.notifyDataChange('transport_types', 'delete', id);
            send(res, 200, { ok: true });
        } catch (e) {
            send(res, 400, { error: e.message });
        }
    }
});