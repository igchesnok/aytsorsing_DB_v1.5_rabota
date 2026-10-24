// ============================================================
// src/routes/planRoutes.js
// API: ПЛАН ПРОИЗВОДСТВА
// GET через buildSyntheticQuery, мутации через notifyWithDependencies
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { validateFk, safeNum, safeStr } = require('./helpers/fkHelpers');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');

module.exports = (db, wsManager) => ({

    // ========================================================================
    // GET — список позиций плана с серверной фильтрацией
    // ========================================================================
    async GET(req, res, url) {
        try {
            const { sql, params } = buildSyntheticQuery('plan.list', {
                id: url.searchParams.get('id'),   // ✅ НОВОЕ
                god: url.searchParams.get('god'),
                nomer_chertezha: url.searchParams.get('nomer_chertezha'),
                // ✅ FIX: клиент (FilterableTable) шлёт фильтр «Наименование» под
                // именем поля osn_naimenovanie (ключ из plan.config.js) —
                // принимаем оба варианта, иначе фильтр молча не работает
                naimenovanie: url.searchParams.get('naimenovanie') || url.searchParams.get('osn_naimenovanie'),
                // ✅ T94: обобщённый поиск VirtualSelect (route-editor) — ИЛИ по № чертежа / наименованию
                search: url.searchParams.get('search'),
                // ✅ Кир→Лат: hg=0 — строгий поиск без гомоглифов (переключатель «Кир→Лат»)
                hg: url.searchParams.get('hg'),
                avto_mob_det: url.searchParams.get('avto_mob_det'),
                firma: url.searchParams.get('firma'),
                // t72: фильтр «№ запроса» (fltZapros -> dbField zapros_nomer):
                // позиция включена в запрос КП с этим номером
                zapros_nomer: url.searchParams.get('zapros_nomer'),
                zakalka: url.searchParams.get('zakalka'),
                ppd: url.searchParams.get('ppd'),
                tisnenie: url.searchParams.get('tisnenie'),
                pokrytie: url.searchParams.get('pokrytie'),
                nitrocementaciya: url.searchParams.get('nitrocementaciya'),
            });
            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[planRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },
    // GET /api/plan/detail?id=XXX — полная запись со всеми полями
    async GET_DETAIL(req, res, url) {
        try {
            const id = url.searchParams.get('id');
            if (!id) return send(res, 400, { error: 'id обязателен' });

            const { sql, params } = buildSyntheticQuery('plan.list', { god: '' });
            // Берём базовый запрос и добавляем WHERE по ID
            const detailSql = sql.replace('WHERE 1=1', 'WHERE 1=1 AND p.id = ?');
            const row = await db.get(detailSql, [...params, id]);

            if (!row) return send(res, 404, { error: 'Запись не найдена' });
            send(res, 200, row);
        } catch (e) {
            send(res, 500, { error: e.message });
        }
    },
    // ========================================================================
    // POST — создание позиции плана
    // ========================================================================
    async POST(req, res) {
        try {
            const d = await parseBody(req);
            const id = generateId('PPG');

            if (!d.god || !d.id_osnastka || !d.plan_god_kolvo) {
                return send(res, 400, { error: 'Заполните обязательные поля: Год, Деталь, План кол-во' });
            }

            const osnCheck = await validateFk(db, 'osnastka', 'id', d.id_osnastka, 'Оснастка');
            if (!osnCheck.ok) return send(res, 400, { error: osnCheck.error });

            if (d.id_kp) {
                const kpCheck = await validateFk(db, 'kp', 'id', d.id_kp, 'КП');
                if (!kpCheck.ok) return send(res, 400, { error: kpCheck.error });
            }

            await db.run(
                `INSERT INTO plan (id, god, id_osnastka, id_kp, cena_pto, plan_god_kolvo,
                    stoim_zagot, zak_pto, data_zak, kol_fakt_got, data_yes_zagot, cex_zatrat,
                    peredel, stat_poz, plan_izgot, primechanie, n_nazv_osnovn_det_zakaza)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    // ✅ ИСПРАВЛЕНО: было d.id_kp || '' — позиции без КП получали
                    // пустую строку и проходили SQL-фильтры `id_kp IS NOT NULL`
                    // (пустая строка — не NULL) в списках доступных перевозок
                    id, safeStr(d.god), d.id_osnastka, d.id_kp || null, d.cena_pto || '',
                    safeNum(d.plan_god_kolvo), d.stoim_zagot || '', d.zak_pto || '',
                    d.data_zak || '', d.kol_fakt_got || '', d.data_yes_zagot || '',
                    d.cex_zatrat || '', d.peredel || '', d.stat_poz || '',
                    d.plan_izgot || '', d.primechanie || '', d.n_nazv_osnovn_det_zakaza || ''
                ]
            );

             wsManager.notifyDataChange('plan', 'add', id);

            send(res, 201, { id });
        } catch (e) {
            console.error('[planRoutes.POST] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // PUT — обновление позиции плана
    // ========================================================================
    async PUT(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });
            const d = await parseBody(req);

            await db.run(
                `UPDATE plan SET
                    god=?, id_osnastka=?, cena_pto=?, plan_god_kolvo=?,
                    stoim_zagot=?, zak_pto=?, data_zak=?, kol_fakt_got=?,
                    data_yes_zagot=?, cex_zatrat=?, stat_poz=?,
                    plan_izgot=?, primechanie=?, n_nazv_osnovn_det_zakaza=?
                WHERE id=?`,
                [
                    d.god, d.id_osnastka, d.cena_pto || '',
                    d.plan_god_kolvo, d.stoim_zagot || '', d.zak_pto || '',
                    d.data_zak || '', d.kol_fakt_got || '', d.data_yes_zagot || '',
                    d.cex_zatrat || '', d.stat_poz || '',
                    d.plan_izgot || '', d.primechanie || '', d.n_nazv_osnovn_det_zakaza || '',
                    id
                ]
            );


            wsManager.notifyDataChange('plan', 'update', id);

            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[planRoutes.PUT] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    },

    // ========================================================================
    // DELETE — удаление позиции плана
    // ========================================================================
    async DELETE(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            if (!id) return send(res, 400, { error: 'ID не указан' });

            // Проверка: позиция не используется в КП
            try {
                const kpCheck = await db.get('SELECT id FROM kp WHERE id_plana = ?', [id]);
                if (kpCheck) {
                    return send(res, 400, { error: 'Позиция плана используется в КП, удаление запрещено' });
                }
            } catch (e) {
                // Таблица kp может не существовать — игнорируем
            }

            await db.run('DELETE FROM plan WHERE id=?', [id]);


            wsManager.notifyDataChange('plan', 'delete', id);

            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[planRoutes.DELETE] Error:', e.message);
            send(res, 400, { error: e.message });
        }
    }
});