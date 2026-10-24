// ============================================================
// src/routes/cexRoutes.js
// API: СПРАВОЧНИК ЦЕХОВ ЗАТРАТ
// GET через buildSyntheticQuery, мутации через notifyWithDependencies
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');

module.exports = (db, wsManager) => ({

    // ========================================================================
    // GET — список цехов с серверной фильтрацией
    // ========================================================================
    async GET(req, res, url) {
        try {
            const { sql, params } = buildSyntheticQuery('cex.list', {
                id: url.searchParams.get('id'), 
                ceh: url.searchParams.get('ceh'),
                peredel: url.searchParams.get('peredel'),
                nazvanie: url.searchParams.get('nazvanie'),
                nach_ceha: url.searchParams.get('nach_ceha')
            });
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[cexRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST — создание цеха
    // ========================================================================
    async POST(req, res) {
        try {
            const d = await parseBody(req);
            if (!d.ceh || !d.peredel || !d.nazvanie) {
                return send(res, 400, {
                    error: 'Заполните обязательные поля: Цех, Передел, Название'
                });
            }

            const id = generateId('CEX');
            await db.run(
                'INSERT INTO cex_zatrat VALUES(?,?,?,?,?,?,?)',
                [
                    id,
                    d.ceh || '',
                    d.peredel || '',
                    d.nazvanie || '',
                    d.nach_ceha || '',
                    d.telefon || '',
                    d.email || ''
                ]
            );

           wsManager.notifyDataChange('cex_zatrat', 'add', id);

            send(res, 201, { id });
        } catch (e) {
            console.error('[cexRoutes.POST] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // PUT — обновление цеха
    // ========================================================================
    async PUT(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });

            const d = await parseBody(req);
            await db.run(
                `UPDATE cex_zatrat SET
                    ceh=?, peredel=?, nazvanie=?,
                    nach_ceha=?, telefon=?, email=?
                WHERE id=?`,
                [
                    d.ceh || '',
                    d.peredel || '',
                    d.nazvanie || '',
                    d.nach_ceha || '',
                    d.telefon || '',
                    d.email || '',
                    id
                ]
            );

             wsManager.notifyDataChange('cex_zatrat', 'update', id);

            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[cexRoutes.PUT] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // DELETE — удаление цеха
    // ========================================================================
    async DELETE(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });

            await db.run('DELETE FROM cex_zatrat WHERE id=?', [id]);

             wsManager.notifyDataChange('cex_zatrat', 'delete', id);

            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[cexRoutes.DELETE] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    }
});