// ============================================================
// src/routes/adresRoutes.js
// API: СПРАВОЧНИК АДРЕСОВ
// GET через buildSyntheticQuery, мутации через notifyWithDependencies
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');
const { normalizeFk, validateFk, safeStr } = require('./helpers/fkHelpers');

module.exports = (db, wsManager) => ({

    // ========================================================================
    // GET — список адресов (ИСПОЛЬЗУЕТ buildSyntheticQuery)
    // Фильтры: id_firmy, fakt_adres
    // ========================================================================
    async GET(req, res, url) {
        try {
            const filters = {};
            const idFirmy = url.searchParams.get('id_firmy');
            const faktAdres = url.searchParams.get('fakt_adres');

            if (idFirmy) filters.id_firmy = idFirmy;
            if (faktAdres) filters.fakt_adres = faktAdres;

            const { sql, params } = buildSyntheticQuery('adres.list', filters);
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[adresRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST — создание адреса
    // ========================================================================
    async POST(req, res) {
        try {
            const d = await parseBody(req);

            // Валидация FK фирмы
            const firmaId = normalizeFk(d.id_firmy);
            const firmaCheck = await validateFk(db, 'firmy', 'id_firmy', firmaId, 'Фирма');
            if (!firmaCheck.ok) return send(res, 400, { error: firmaCheck.error });

            const id = generateId('FFA');
            await db.run(
                'INSERT INTO fakt_adres (id_adres, id_firmy, fakt_adres) VALUES (?,?,?)',
                [id, firmaId, safeStr(d.fakt_adres)]
            );

            const deps = new Set([
                'fakt_adres',
                ...getDependencies('adres.list')
            ]);
            wsManager.notifyWithDependencies(deps, 'add', id);
            send(res, 201, { id });
        } catch (e) {
            console.error('[adresRoutes.POST] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // PUT — обновление адреса
    // ========================================================================
    async PUT(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });
            const d = await parseBody(req);

            await db.run(
                'UPDATE fakt_adres SET fakt_adres=? WHERE id_adres=?',
                [safeStr(d.fakt_adres), id]
            );

            const deps = new Set([
                'fakt_adres',
                ...getDependencies('adres.list')
            ]);
            wsManager.notifyWithDependencies(deps, 'update', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[adresRoutes.PUT] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // DELETE — удаление адреса
    // ========================================================================
    async DELETE(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });

            await db.run('DELETE FROM fakt_adres WHERE id_adres=?', [id]);

            const deps = new Set([
                'fakt_adres',
                ...getDependencies('adres.list')
            ]);
            wsManager.notifyWithDependencies(deps, 'delete', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[adresRoutes.DELETE] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    }
});