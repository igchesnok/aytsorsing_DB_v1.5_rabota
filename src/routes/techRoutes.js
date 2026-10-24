// ============================================================
// src/routes/techRoutes.js
// API: СПРАВОЧНИК ТЕХНОЛОГОВ
// GET через buildSyntheticQuery, мутации через notifyWithDependencies
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');

module.exports = (db, wsManager) => ({

    // ========================================================================
    // GET — список технологов с серверной фильтрацией
    // ========================================================================
    async GET(req, res, url) {
        try {
            const { sql, params } = buildSyntheticQuery('tech.list', {
                id: url.searchParams.get('id'), 
                fio: url.searchParams.get('fio'),
                email: url.searchParams.get('email'),
                telefon: url.searchParams.get('telefon'),
                tip_osnastki: url.searchParams.get('tip_osnastki')
            });
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[techRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST — создание технолога
    // ========================================================================
    async POST(req, res) {
        const d = await parseBody(req);
        if (!d.fio || !d.fio.trim()) {
            return send(res, 400, { error: 'Заполните ФИО технолога' });
        }
        const id = generateId('TECH');
        try {
            await db.run(
                `INSERT INTO tech (id, fio, email, telefon, tip_osnastki) VALUES (?,?,?,?,?)`,
                [id, d.fio.trim(), d.email || '', d.telefon || '', d.tip_osnastki || '']
            );

             wsManager.notifyDataChange('tech', 'add', id);

            send(res, 201, { id });
        } catch (e) {
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // PUT — обновление технолога
    // ========================================================================
    async PUT(req, res, url) {
        const id = url.pathname.split('/')[3];
        if (!id) return send(res, 400, { error: 'ID не указан' });
        const d = await parseBody(req);
        if (!d.fio || !d.fio.trim()) {
            return send(res, 400, { error: 'Заполните ФИО технолога' });
        }
        try {
            await db.run(
                `UPDATE tech SET fio=?, email=?, telefon=?, tip_osnastki=? WHERE id=?`,
                [d.fio.trim(), d.email || '', d.telefon || '', d.tip_osnastki || '', id]
            );

            wsManager.notifyDataChange('tech', 'update', id);

            send(res, 200, { ok: true });
        } catch (e) {
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // DELETE — удаление технолога
    // ========================================================================
    async DELETE(req, res, url) {
        const id = url.pathname.split('/')[3];
        if (!id) return send(res, 400, { error: 'ID не указан' });
        try {
            await db.run('DELETE FROM tech WHERE id=?', [id]);

             wsManager.notifyDataChange('tech', 'delete', id);

            send(res, 200, { ok: true });
        } catch (e) {
            send(res, 400, { error: e.message });
        }
    }
});