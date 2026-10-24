// src/routes/osnastkaRoutes.js
const { parseBody, send, generateId } = require('../utils');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');

module.exports = (db, wsManager) => ({
    // ========================================================================
    // GET с поддержкой серверной фильтрации через buildSyntheticQuery
    // ========================================================================
    async GET(req, res, url) {
        try {
            const filters = {};
            const textFields = ['nomer_chertezha', 'naimenovanie', 'avto_mob_det'];
            const boolFields = ['zakalka', 'ppd', 'tisnenie', 'pokrytie', 'nitrocementaciya'];
            
            if (url && url.searchParams) {
                // ✅ НОВОЕ: поддержка фильтра по id (для checkForExternalChanges)
                const id = url.searchParams.get('id');
                if (id) filters.id = id;

                // ✅ НОВОЕ: обобщённый поиск VirtualSelect (OR: № чертежа / наименование)
                const search = url.searchParams.get('search');
                if (search) filters.search = search;

                // ✅ Кир→Лат: hg=0 — строгий поиск без гомоглифов (переключатель «Кир→Лат»)
                const hg = url.searchParams.get('hg');
                if (hg) filters.hg = hg;
                
                textFields.forEach(field => {
                    const value = url.searchParams.get(field);
                    if (value !== null && value !== '') {
                        filters[field] = value;
                    }
                });
                boolFields.forEach(field => {
                    const value = url.searchParams.get(field);
                    if (value === '1') {
                        filters[field] = '1';
                    }
                });
            }
            
            const { sql, params } = buildSyntheticQuery('osnastka.list', filters);
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[osnastkaRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST — создание оснастки
    // ========================================================================
    async POST(req, res) {
        const d = await parseBody(req);
        const id = generateId('OSN');
        try {
            // T56-b: явный список колонок (добавлена marka_materiala —
            // марка материала, заложенная конструктором)
            await db.run(`INSERT INTO osnastka
                (id, nomer_chertezha, naimenovanie, avto_mob_det, ves_det, ves_zag, trudoemkost_pto,
                 dlina, shirina, vysota, nitrocementaciya, zakalka, ppd, pokrytie, tisnenie,
                 cena_zagotovki, trudoemkost_frez_universal, trudoemkost_frez_chpu,
                 trudoemkost_tokarn, trudoemkost_tokarn_chpu, marka_materiala)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
                id, d.nomer_chertezha, d.naimenovanie, d.avto_mob_det,
                d.ves_det, d.ves_zag, d.trudoemkost_pto,
                d.dlina, d.shirina, d.vysota,
                d.nitrocementaciya ? 1 : 0, d.zakalka ? 1 : 0, d.ppd ? 1 : 0,
                d.pokrytie ? 1 : 0, d.tisnenie ? 1 : 0,
                parseFloat(d.cena_zagotovki) || 0,
                parseFloat(d.trudoemkost_frez_universal) || 0,
                parseFloat(d.trudoemkost_frez_chpu) || 0,
                parseFloat(d.trudoemkost_tokarn) || 0,
                parseFloat(d.trudoemkost_tokarn_chpu) || 0,
                String(d.marka_materiala || '').trim()
            ]);
            
            // Авто-уведомление по всем зависимостям (включая plan)
            wsManager.notifyDataChange('osnastka', 'add', id);
            send(res, 201, { id });
        } catch (e) {
            if (e.message.includes('UNIQUE')) {
                send(res, 400, { error: `№ чертежа "${d.nomer_chertezha}" уже существует` });
            } else {
                send(res, 400, { error: e.message });
            }
        }
    },

    // ========================================================================
    // PUT — обновление оснастки
    // ========================================================================
    async PUT(req, res, url) {
        const id = url.pathname.split('/')[3];
        const d = await parseBody(req);
        try {
            // T56-b: marka_materiala — COALESCE: ключа нет в payload (импорт из
            // буфера) — прежнее значение сохраняется; '' из формы — явная очистка
            const markaVal = (d.marka_materiala === undefined) ? null
                : String(d.marka_materiala || '').trim();
            await db.run(`UPDATE osnastka SET
                nomer_chertezha=?, naimenovanie=?, avto_mob_det=?,
                ves_det=?, ves_zag=?, trudoemkost_pto=?,
                dlina=?, shirina=?, vysota=?,
                nitrocementaciya=?, zakalka=?, ppd=?, pokrytie=?, tisnenie=?,
                cena_zagotovki=?, trudoemkost_frez_universal=?,
                trudoemkost_frez_chpu=?, trudoemkost_tokarn=?, trudoemkost_tokarn_chpu=?,
                marka_materiala = COALESCE(?, marka_materiala)
                WHERE id=?`, [
                d.nomer_chertezha, d.naimenovanie, d.avto_mob_det,
                d.ves_det, d.ves_zag, d.trudoemkost_pto,
                d.dlina, d.shirina, d.vysota,
                d.nitrocementaciya ? 1 : 0, d.zakalka ? 1 : 0, d.ppd ? 1 : 0,
                d.pokrytie ? 1 : 0, d.tisnenie ? 1 : 0,
                parseFloat(d.cena_zagotovki) || 0,
                parseFloat(d.trudoemkost_frez_universal) || 0,
                parseFloat(d.trudoemkost_frez_chpu) || 0,
                parseFloat(d.trudoemkost_tokarn) || 0,
                parseFloat(d.trudoemkost_tokarn_chpu) || 0,
                markaVal,
                id
            ]);

            wsManager.notifyDataChange('osnastka', 'update', id);
            send(res, 200, { ok: true });
        } catch (e) {
            if (e.message.includes('UNIQUE')) {
                send(res, 400, { error: `№ чертежа "${d.nomer_chertezha}" уже существует` });
            } else {
                send(res, 400, { error: e.message });
            }
        }
    },

    // ========================================================================
    // DELETE — удаление оснастки
    // ========================================================================
    async DELETE(req, res, url) {
        const id = url.pathname.split('/')[3];
        try {
            await db.run('DELETE FROM osnastka WHERE id=?', [id]);

            wsManager.notifyDataChange('osnastka', 'delete', id);
            send(res, 200, { ok: true });
        } catch (e) {
            send(res, 400, { error: e.message });
        }
    }
});