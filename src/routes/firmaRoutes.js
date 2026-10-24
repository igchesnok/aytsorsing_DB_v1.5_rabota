// ============================================================
// src/routes/firmaRoutes.js
// API: СПРАВОЧНИК ФИРМ
// GET через buildSyntheticQuery, мутации через notifyWithDependencies
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');
const { normalizeFk, safeStr } = require('./helpers/fkHelpers');

module.exports = (db, wsManager) => ({

    // ========================================================================
    // GET — список фирм (ИСПОЛЬЗУЕТ buildSyntheticQuery)
    // Фильтры: id_firmy, kod, search, yearFrom, yearTo, hasCargo
    // ========================================================================
    async GET(req, res, url) {
        try {
            const idFirmy = url.searchParams.get('id_firmy');
            const yearFrom = url.searchParams.get('yearFrom');
            const yearTo = url.searchParams.get('yearTo');
            const hasCargo = url.searchParams.get('hasCargo');
            const kod = url.searchParams.get('kod');
            const search = url.searchParams.get('search');
            const naimenovanie = url.searchParams.get('naimenovanie');

            // Выбираем синтетическую таблицу:
            // - firms.withContracts — если есть фильтры по году или hasCargo
            // - firms.list — простой список
            const useContracts = (yearFrom || yearTo || hasCargo === '1');
            const syntheticKey = useContracts ? 'firms.withContracts' : 'firms.list';

            const filters = {};
            if (idFirmy) filters.id_firmy = idFirmy;
            if (kod) filters.kod = kod;
            if (search) filters.search = search;
            if (naimenovanie) filters.naimenovanie = naimenovanie;
            if (yearFrom) filters.yearFrom = yearFrom;
            if (yearTo) filters.yearTo = yearTo;
            if (hasCargo) filters.hasCargo = hasCargo;

            const { sql, params } = buildSyntheticQuery(syntheticKey, filters);
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[firmaRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST — создание фирмы
    // ========================================================================
    async POST(req, res) {
        try {
            const d = await parseBody(req);
            if (!d.kod || !d.naimenovanie || !d.inn) {
                return send(res, 400, { error: 'Заполните обязательные поля: Код, Наименование, ИНН' });
            }
            const id = generateId('F');
            // ✅ T84: город и цена перевозки сохраняются при создании
            await db.run(
                'INSERT INTO firmy (id_firmy, kod, naimenovanie, inn, ur_adres, gorod, cena_perevozki) VALUES (?,?,?,?,?,?,?)',
                [id, safeStr(d.kod), safeStr(d.naimenovanie), safeStr(d.inn), safeStr(d.ur_adres), safeStr(d.gorod), safeStr(d.cena_perevozki)]
            );
            // Уведомляем все синтетические таблицы, зависящие от firmy
            const deps = new Set([
                'firmy',
                ...getDependencies('firms.list'),
                ...getDependencies('firms.withContracts')
            ]);
            wsManager.notifyWithDependencies(deps, 'add', id);
            send(res, 201, { id });
        } catch (e) {
            console.error('[firmaRoutes.POST] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // PUT — обновление фирмы
    // ========================================================================
    async PUT(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });
            const d = await parseBody(req);
            // ✅ T84: город и цена перевозки сохраняются при изменении
            await db.run(
                'UPDATE firmy SET kod=?, naimenovanie=?, inn=?, ur_adres=?, gorod=?, cena_perevozki=? WHERE id_firmy=?',
                [safeStr(d.kod), safeStr(d.naimenovanie), safeStr(d.inn), safeStr(d.ur_adres), safeStr(d.gorod), safeStr(d.cena_perevozki), id]
            );
            const deps = new Set([
                'firmy',
                ...getDependencies('firms.list'),
                ...getDependencies('firms.withContracts')
            ]);
            wsManager.notifyWithDependencies(deps, 'update', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[firmaRoutes.PUT] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // DELETE — удаление фирмы с каскадом
    // ========================================================================
    async DELETE(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });

            await db.run('BEGIN TRANSACTION');
            try {
                await db.run('DELETE FROM dogovor WHERE id_firmy=?', [id]);
                await db.run('DELETE FROM kont WHERE id_firmy=?', [id]);
                await db.run('DELETE FROM fakt_adres WHERE id_firmy=?', [id]);
                await db.run('DELETE FROM firmy WHERE id_firmy=?', [id]);
                await db.run('COMMIT');
            } catch (innerErr) {
                await db.run('ROLLBACK');
                throw innerErr;
            }

            // Уведомляем ВСЕ зависимые таблицы
            const deps = new Set([
                'firmy', 'dogovor', 'kont', 'fakt_adres',
                ...getDependencies('firms.list'),
                ...getDependencies('firms.withContracts'),
                ...getDependencies('dogovor.list'),
                ...getDependencies('kont.list'),
                ...getDependencies('adres.list')
            ]);
            wsManager.notifyWithDependencies(deps, 'delete', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[firmaRoutes.DELETE] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    }
});