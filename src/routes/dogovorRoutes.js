// ============================================================
// src/routes/dogovorRoutes.js
// API: СПРАВОЧНИК ДОГОВОРОВ
// GET через buildSyntheticQuery, мутации через notifyWithDependencies
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');
const { normalizeFk, validateFk, safeStr } = require('./helpers/fkHelpers');

module.exports = (db, wsManager) => ({

    // ========================================================================
    // GET — список договоров (ИСПОЛЬЗУЕТ buildSyntheticQuery)
    // Фильтры: id_firmy, id_dogovor, nom_dogovor, god, yearFrom, yearTo
    // ========================================================================
    async GET(req, res, url) {
        try {
            const filters = {};
            const idFirmy = url.searchParams.get('id_firmy');
            const idDogovor = url.searchParams.get('id_dogovor');
            const nomDogovor = url.searchParams.get('nom_dogovor');
            const god = url.searchParams.get('god');
            const yearFrom = url.searchParams.get('yearFrom');
            const yearTo = url.searchParams.get('yearTo');

            if (idFirmy) filters.id_firmy = idFirmy;
            if (idDogovor) filters.id_dogovor = idDogovor;
            if (nomDogovor) filters.nom_dogovor = nomDogovor;
            if (god) filters.god = god;
            if (yearFrom) filters.yearFrom = yearFrom;
            if (yearTo) filters.yearTo = yearTo;

            const { sql, params } = buildSyntheticQuery('dogovor.list', filters);
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[dogovorRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST — создание договора
    // ========================================================================
    async POST(req, res) {
        try {
            const d = await parseBody(req);

            // Валидация FK фирмы
            const firmaId = normalizeFk(d.id_firmy);
            const firmaCheck = await validateFk(db, 'firmy', 'id_firmy', firmaId, 'Фирма');
            if (!firmaCheck.ok) return send(res, 400, { error: firmaCheck.error });

            const id = generateId('D');
            await db.run(`
                INSERT INTO dogovor (
                    id_dogovor, id_firmy, nom_dogovor, data_dogovor, data_ok,
                    rasch_schet, ssylka_na_dok, id_vid_rabot, predoplata_pr,
                    id_predoplata_yclov, predoplata_data, hdc, ctoimost,
                    priemka_data, oplata_rabot_data, otschet_priemka,
                    otschet_oplata, data_oplata_avanca
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `, [
                id, firmaId, safeStr(d.nom_dogovor), safeStr(d.data_dogovor), safeStr(d.data_ok),
                safeStr(d.rasch_schet), safeStr(d.ssylka_na_dok), safeStr(d.id_vid_rabot),
                safeStr(d.predoplata_pr), safeStr(d.id_predoplata_yclov), safeStr(d.predoplata_data),
                safeStr(d.hdc), safeStr(d.ctoimost),
                safeStr(d.priemka_data), safeStr(d.oplata_rabot_data),
                safeStr(d.otschet_priemka), safeStr(d.otschet_oplata), safeStr(d.data_oplata_avanca)
            ]);

            const deps = new Set([
                'dogovor',
                ...getDependencies('dogovor.list')
            ]);
            wsManager.notifyWithDependencies(deps, 'add', id);
            send(res, 201, { id });
        } catch (e) {
            console.error('[dogovorRoutes.POST] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // PUT — обновление договора
    // ========================================================================
    async PUT(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });
            const d = await parseBody(req);

            await db.run(`
                UPDATE dogovor SET
                    nom_dogovor=?, data_dogovor=?, data_ok=?,
                    rasch_schet=?, ssylka_na_dok=?, id_vid_rabot=?,
                    predoplata_pr=?, id_predoplata_yclov=?, predoplata_data=?,
                    hdc=?, ctoimost=?,
                    priemka_data=?, oplata_rabot_data=?,
                    otschet_priemka=?, otschet_oplata=?, data_oplata_avanca=?
                WHERE id_dogovor=?
            `, [
                safeStr(d.nom_dogovor), safeStr(d.data_dogovor), safeStr(d.data_ok),
                safeStr(d.rasch_schet), safeStr(d.ssylka_na_dok), safeStr(d.id_vid_rabot),
                safeStr(d.predoplata_pr), safeStr(d.id_predoplata_yclov), safeStr(d.predoplata_data),
                safeStr(d.hdc), safeStr(d.ctoimost),
                safeStr(d.priemka_data), safeStr(d.oplata_rabot_data),
                safeStr(d.otschet_priemka), safeStr(d.otschet_oplata), safeStr(d.data_oplata_avanca),
                id
            ]);

            const deps = new Set([
                'dogovor',
                ...getDependencies('dogovor.list')
            ]);
            wsManager.notifyWithDependencies(deps, 'update', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[dogovorRoutes.PUT] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // DELETE — удаление договора
    // ========================================================================
    async DELETE(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });

            await db.run('DELETE FROM dogovor WHERE id_dogovor=?', [id]);

            const deps = new Set([
                'dogovor',
                ...getDependencies('dogovor.list')
            ]);
            wsManager.notifyWithDependencies(deps, 'delete', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[dogovorRoutes.DELETE] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    }
});