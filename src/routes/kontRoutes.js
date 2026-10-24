// ============================================================
// src/routes/kontRoutes.js
// API: СПРАВОЧНИК КОНТАКТОВ
// GET через buildSyntheticQuery, мутации через notifyWithDependencies
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');
const { normalizeFk, validateFk, safeStr, safeBool } = require('./helpers/fkHelpers');

module.exports = (db, wsManager) => ({

    // ========================================================================
    // GET — список контактов (ИСПОЛЬЗУЕТ buildSyntheticQuery)
    // Фильтры: id_firmy, firma_kod, fio, email, aktivnost, withEmail, ptoOnly
    // ========================================================================
    async GET(req, res, url) {
        try {
            const filters = {};
            const idFirmy = url.searchParams.get('id_firmy');
            const firmaKod = url.searchParams.get('firma_kod');
            const fio = url.searchParams.get('fio');
            const email = url.searchParams.get('email');
            const aktivnost = url.searchParams.get('aktivnost');
            const withEmail = url.searchParams.get('withEmail');
            const ptoOnly = url.searchParams.get('ptoOnly');

            if (idFirmy) filters.id_firmy = idFirmy;
            if (firmaKod) filters.firma_kod = firmaKod;
            if (fio) filters.fio = fio;
            if (email) filters.email = email;
            if (aktivnost !== null && aktivnost !== undefined) filters.aktivnost = aktivnost;
            if (withEmail) filters.withEmail = withEmail;
            if (ptoOnly) {
                filters.ptoOnly = true;
                // Для ПТО — фильтруем по коду фирмы 1F964
                if (!filters.firma_kod) filters.firma_kod = '1F964';
            }

            const { sql, params } = buildSyntheticQuery('kont.list', filters);
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[kontRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST — создание контакта
    // ========================================================================
    async POST(req, res) {
        try {
            const d = await parseBody(req);

            // Валидация FK фирмы
            const firmaId = normalizeFk(d.id_firmy);
            const firmaCheck = await validateFk(db, 'firmy', 'id_firmy', firmaId, 'Фирма');
            if (!firmaCheck.ok) return send(res, 400, { error: firmaCheck.error });

            const id = generateId('FK');
            await db.run(
                'INSERT INTO kont (id_kont, id_firmy, fio, tel, email, aktivnost) VALUES (?,?,?,?,?,?)',
                [id, firmaId, safeStr(d.fio), safeStr(d.tel), safeStr(d.email), safeBool(d.aktivnost)]
            );

            const deps = new Set([
                'kont',
                ...getDependencies('kont.list')
            ]);
            wsManager.notifyWithDependencies(deps, 'add', id);
            send(res, 201, { id });
        } catch (e) {
            console.error('[kontRoutes.POST] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // PUT — обновление контакта
    // ========================================================================
    async PUT(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });
            const d = await parseBody(req);

            await db.run(
                'UPDATE kont SET fio=?, tel=?, email=?, aktivnost=? WHERE id_kont=?',
                [safeStr(d.fio), safeStr(d.tel), safeStr(d.email), safeBool(d.aktivnost), id]
            );

            const deps = new Set([
                'kont',
                ...getDependencies('kont.list')
            ]);
            wsManager.notifyWithDependencies(deps, 'update', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[kontRoutes.PUT] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // DELETE — удаление контакта
    // ========================================================================
    async DELETE(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });

            await db.run('DELETE FROM kont WHERE id_kont=?', [id]);

            const deps = new Set([
                'kont',
                ...getDependencies('kont.list')
            ]);
            wsManager.notifyWithDependencies(deps, 'delete', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[kontRoutes.DELETE] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    }
});