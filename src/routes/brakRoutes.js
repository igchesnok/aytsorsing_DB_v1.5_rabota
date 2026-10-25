// ============================================================
// src/routes/brakRoutes.js
// API: ОТК (приёмка) и ТЕХНОЛОГ (решения по браку)
//
// Таблицы: braki, otk_zamery, braki_files, resheniya_tehnologa, braki_history
//
// ДВИЖЕНИЕ ПОЗИЦИЙ ЧЕРЕЗ ОТК (бизнес-правило):
//   на приёмку ОТК попадают ВСЕ грузовые позиции, приехавшие на ПТО, —
//   это всегда ВХОДЯЩИЕ транспортные операции (transport_oper.napravlenie =
//   'Входящая'; четность этапа маршрута производна: направление хранится в
//   справочнике transport_types.napravlenie и тянется через shagi_marshruta;
//   фильтр по napravlenie надёжнее и индексирован — используем его).
//
// ПРАВИЛА БРАКОВКИ (по количеству переданному на замеры):
//   1) передана ЧАСТЬ партии (sht_peredano < всего в позиции) и выявлен брак
//      хотя бы по 1 шт — BRAKYUETSA VYA PARTIYA (sht_braka = вся партия);
//   2) переданы ВСЕ детали партии (sht_peredano >= всего) — бракуется только
//      то, где выявлен брак (sht_braka = zabakovano_sht).
//
// WORKFLOW (braki.status_workflow):
//   vyavlen -> peredan_tehnologu -> reshenie_prinyato -> zakryt
//   Каждая смена статуса пишется в braki_history (аудит).
// ============================================================
const fs = require('fs');
const path = require('path');
const { parseBody, send, generateId } = require('../utils');
const { validateToken, extractToken } = require('../authUtils');

const OTK_ROLES  = ['otk', 'admin'];
const TECH_ROLES = ['teholog', 'admin'];

module.exports = (db, wsManager) => {

    // ---------- авторизация ----------
    async function authUser(req) {
        const auth = await validateToken(db, extractToken(req));
        return auth ? auth.user : null;
    }

    // ---------- аудит workflow ----------
    async function addHistory(idBraka, action, oldValue, newValue, user, kommentariy = '') {
        try {
            await db.run(
                `INSERT INTO braki_history (id_braka, action, old_value, new_value, user_id, user_login, kommentariy)
                 VALUES (?,?,?,?,?,?,?)`,
                [idBraka, action, oldValue ?? null, newValue ?? null,
                 user ? user.id : null, user ? (user.login || '') : '', kommentariy]
            );
        } catch (e) {
            console.error('[brakRoutes.addHistory]', e.message);
        }
    }

    // ---------- карточка брака (детали + замеры + файлы + история + решения) ----------
    async function getBrakFull(idBraka) {
        const brak = await db.get(`
            SELECT b.*,
                   o.nomer_chertezha, o.naimenovanie AS osn_naimenovanie,
                   gp.kolvo_no_br, gp.kolvo_yes_br,
                   COALESCE(gp.kolvo_no_br,0)+COALESCE(gp.kolvo_yes_br,0) AS vsego_sht,
                   t.napravlenie AS oper_napravlenie, t.otgruzka_data, t.pribytie_data,
                   t.nomer_reisa, t.status AS oper_status,
                   fir.naimenovanie AS firm_name,
                   u.fio AS kontroler_fio
              FROM braki b
              JOIN gryz_poz gp             ON gp.id = b.id_gp
              LEFT JOIN plan_perevozok pp  ON pp.id = gp.id_plana
              LEFT JOIN plan p             ON p.id  = pp.id_plana
              LEFT JOIN osnastka o         ON o.id  = p.id_osnastka
              LEFT JOIN transport_oper t   ON t.id = gp.id_transporta
              LEFT JOIN firmy fir          ON fir.id_firmy = t.id_firma
              LEFT JOIN users u            ON u.id  = b.id_kontrolera
             WHERE b.id_braka = ?`, [idBraka]);
        if (!brak) return null;

        const zamery = await db.all(`
            SELECT z.*, u.fio AS kontroler_fio
              FROM otk_zamery z
              LEFT JOIN braki b2 ON b2.id_braka = z.id_braka
              LEFT JOIN users u  ON u.id = b2.id_kontrolera
             WHERE z.id_braka = ? ORDER BY z.rowid`, [idBraka]);

        const files = await db.all(`
            SELECT f.*, u.fio AS uploaded_by_fio
              FROM braki_files f
              LEFT JOIN users u ON u.id = f.uploaded_by
             WHERE f.id_braka = ? ORDER BY f.created_at`, [idBraka]);

        const history = await db.all(`
            SELECT h.* FROM braki_history h
             WHERE h.id_braka = ? ORDER BY h.rowid DESC LIMIT 200`, [idBraka]);

        const resheniya = await db.all(`
            SELECT r.*, u.fio AS tehnolog_fio, c.ceh AS cex_name
              FROM resheniya_tehnologa r
              LEFT JOIN users u      ON u.id = r.id_tehnologa
              LEFT JOIN cex_zatrat c ON c.id = r.id_cex_izgotovitel
             WHERE r.id_braka = ? ORDER BY r.created_at DESC`, [idBraka]);

        return { brak, zamery, files, history, resheniya };
    }

    return {

        // ====================================================================
        // СПИСОК ПРИЁМКИ ОТК: грузовые позиции, прибывшие на ПТО (Входящая)
        // GET /api/otk/prikhod?napravlenie=Входящая&q=&status=
        // status: pribylo | na_otk | proshlo | vse
        // ====================================================================
        async GET_PRIKHOD(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            try {
                const q = (url.searchParams.get('q') || '').toLowerCase();
                const statusF = url.searchParams.get('status') || 'pribylo';

                const rows = await db.all(`
                    SELECT gp.id AS id_gp,
                           gp.kolvo_no_br, gp.kolvo_yes_br,
                           COALESCE(gp.kolvo_no_br,0) + COALESCE(gp.kolvo_yes_br,0) AS vsego_sht,
                           gp.primechanie, gp.marka_materiala, gp.tip_gruza, gp.kolvo_zagotovok,
                           t.id AS id_oper, t.napravlenie, t.status AS oper_status,
                           t.otgruzka_data, t.pribytie_data, t.nomer_reisa, t.gruz_name,
                           fir.naimenovanie AS firm_name,
                           o.nomer_chertezha, o.naimenovanie AS osn_naimenovanie,
                           p.cex_zatrat, pz.plan_data, pz.id_shag, sm.nom_shag,
                           tt.nazvanie_operatsii AS tip_perevozki,
                           (SELECT COUNT(*) FROM braki b WHERE b.id_gp = gp.id) AS kol_brakov,
                           (SELECT MAX(b2.status_workflow) FROM braki b2 WHERE b2.id_gp = gp.id) AS brak_status
                      FROM gryz_poz gp
                      JOIN transport_oper t   ON t.id = gp.id_transporta
                      LEFT JOIN firmy fir     ON fir.id_firmy = t.id_firma
                      LEFT JOIN plan_perevozok pz ON pz.id = gp.id_plana
                      LEFT JOIN shagi_marshruta sm ON sm.id_shag = pz.id_shag
                      LEFT JOIN transport_types tt ON tt.id_tipa = sm.id_tipa_perevozki
                      LEFT JOIN plan p        ON p.id = pz.id_plana
                      LEFT JOIN osnastka o    ON o.id = p.id_osnastka
                     WHERE t.napravlenie = ?`, ['Входящая']);

                const result = [];
                for (const r of rows) {
                    let st;
                    if (r.kol_brakov > 0 && String(r.brak_status || '') !== 'zakryt') st = 'na_otk';
                    else if (r.kol_brakov > 0) st = 'proshlo';
                    else st = 'pribylo';
                    r.otk_status = st;
                    if (statusF !== 'vse' && st !== statusF) continue;
                    if (q) {
                        const hay = [r.nomer_chertezha, r.osn_naimenovanie, r.firm_name,
                                     r.gruz_name, r.nomer_reisa].join(' ').toLowerCase();
                        if (!hay.includes(q)) continue;
                    }
                    result.push(r);
                }
                send(res, 200, result);
            } catch (e) {
                console.error('[brakRoutes.GET_PRIKHOD]', e.message);
                send(res, 500, { error: e.message });
            }
        },

        // ====================================================================
        // ЗАМЕРЫ ОТК
        // GET  /api/otk/zamery?id_gp=...            — карта замеров позиции
        // POST /api/otk/zamery                      — сохранить замеры (массово)
        // DELETE /api/otk/zamery/<id>               — удалить строку замера
        // ====================================================================
        async GET_ZAMERY(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            try {
                const idGp = url.searchParams.get('id_gp');
                const idBraka = url.searchParams.get('id_braka');
                if (!idGp && !idBraka) return send(res, 400, { error: 'Не указан id_gp или id_braka' });
                const rows = await db.all(`
                    SELECT * FROM otk_zamery
                     WHERE ${idBraka ? 'id_braka = ?' : 'id_gryz_poz = ?'}
                     ORDER BY rowid`, [idBraka || idGp]);
                send(res, 200, rows);
            } catch (e) {
                send(res, 500, { error: e.message });
            }
        },

        async POST_ZAMERY(req, res) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            if (!OTK_ROLES.includes(user.role) && !TECH_ROLES.includes(user.role)) {
                return send(res, 403, { error: 'Замерывать может только контролёр ОТК' });
            }
            try {
                const d = await parseBody(req);
                const idGp = d.id_gp;
                const idBraka = d.id_braka || null;
                const zamery = Array.isArray(d.zamery) ? d.zamery : [];
                if (!idGp) return send(res, 400, { error: 'Не указана грузовая позиция' });

                const gp = await db.get(`
                    SELECT gp.id, COALESCE(gp.kolvo_no_br,0)+COALESCE(gp.kolvo_yes_br,0) AS vsego
                      FROM gryz_poz gp WHERE gp.id = ?`, [idGp]);
                if (!gp) return send(res, 404, { error: 'Грузовая позиция не найдена' });

                let idBrak = idBraka;
                if (idBrak) {
                    // редактирование существующего брака — пересчёт забраковано
                    const b = await db.get('SELECT * FROM braki WHERE id_braka = ?', [idBrak]);
                    if (!b) return send(res, 404, { error: 'Брак не найден' });
                    if (b.status_workflow !== 'vyavlen')
                        return send(res, 400, { error: 'Изменять замеры можно только до передачи технологу' });
                    await db.run('DELETE FROM otk_zamery WHERE id_braka = ?', [idBrak]);
                } else {
                    // новый брак: id_braka ещё нет — временный ключ строк замеров
                    idBrak = null;
                }

                const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
                let shtBraka = 0;       // сколько штук выявлено бракованных
                let peredanoMax = 0;    // макс. «передано на замеры» по строкам

                for (const z of zamery) {
                    const parametr = String(z.parametr || '').trim();
                    if (!parametr) continue;
                    const rezultat = String(z.rezultat || 'godno').trim();
                    const shtZ = parseFloat(z.sht_brakovannye) || 0;
                    const shtP = parseFloat(z.sht_peredano) || 0;
                    if (rezultat === 'brak') shtBraka += shtZ;
                    if (shtP > peredanoMax) peredanoMax = shtP;

                    const numOrNull = (v) => {
                        const n = parseFloat(v);
                        return Number.isFinite(n) ? n : null;
                    };
                    await db.run(`
                        INSERT INTO otk_zamery (id, id_braka, id_gryz_poz, data_zamera,
                                                parametr, nominal, fakt, otklonenie,
                                                dopusk_verh, dopusk_niz, rezultat, kommentariy)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                        [generateId('ZAM'), idBrak || 'TMP', idGp, z.data_zamera || now.slice(0, 10),
                         parametr, numOrNull(z.nominal), numOrNull(z.fakt), numOrNull(z.otklonenie),
                         numOrNull(z.dopusk_verh), numOrNull(z.dopusk_niz), rezultat, z.kommentariy || '']);
                }

                // ----- ПРАВИЛО БРАКОВКИ -----
                // часть партии на замере + есть брак -> бракуется ВСЯ партия;
                // вся партия на замере -> бракуется только бракованные штуки
                let zabrakovano = 0;
                if (shtBraka > 0) {
                    zabrakovano = (peredanoMax >= gp.vsego) ? shtBraka : Math.max(gp.vsego, shtBraka);
                }

                if (idBrak) {
                    await db.run('UPDATE braki SET zabrakovano_sht = ?, data_zamera = ?, kommentariy_kontrolera = ? WHERE id_braka = ?',
                        [zabrakovano, now.slice(0, 10), d.kommentariy_kontrolera ?? '', idBrak]);
                    await addHistory(idBrak, 'zamery_upd', null, `забраковано=${zabrakovano}`, user, d.kommentariy_kontrolera || '');
                } else {
                    idBrak = generateId('BRK');
                    await db.run(`
                        INSERT INTO braki (id_braka, id_gp, zabrakovano_sht, id_kontrolera,
                                           data_zamera, kommentariy_kontrolera, status_workflow)
                        VALUES (?,?,?,?,?,?, 'vyavlen')`,
                        [idBrak, idGp, zabrakovano, user.id, now.slice(0, 10), d.kommentariy_kontrolera || '']);
                    // перепривязать временные замеры к созданному браку
                    await db.run(`UPDATE otk_zamery SET id_braka = ? WHERE id_gryz_poz = ? AND id_braka = 'TMP'`, [idBrak, idGp]);
                    await addHistory(idBrak, 'vyavlen', null, `забраковано=${zabrakovano}`, user, d.kommentariy_kontrolera || '');
                }

                wsManager.notifyDataChange('braki', 'update', idBrak);
                send(res, 200, { ok: true, id_braka: idBrak, zabrakovano_sht: zabrakovano });
            } catch (e) {
                console.error('[brakRoutes.POST_ZAMERY]', e.message);
                send(res, 400, { error: e.message });
            }
        },

        async DELETE_ZAMERY(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            if (!OTK_ROLES.includes(user.role)) return send(res, 403, { error: 'Только ОТК' });
            const id = url.pathname.split('/')[3];
            try {
                const z = await db.get('SELECT * FROM otk_zamery WHERE id = ?', [id]);
                if (!z) return send(res, 404, { error: 'Замер не найден' });
                const b = await db.get('SELECT status_workflow FROM braki WHERE id_braka = ?', [z.id_braka]);
                if (b && b.status_workflow !== 'vyavlen')
                    return send(res, 400, { error: 'Нельзя удалять замеры после передачи технологу' });
                await db.run('DELETE FROM otk_zamery WHERE id = ?', [id]);
                wsManager.notifyDataChange('braki', 'update', z.id_braka);
                send(res, 200, { ok: true });
            } catch (e) {
                send(res, 400, { error: e.message });
            }
        },

        // ====================================================================
        // ФАЙЛЫ БРАКА (фото дефектов, сканы карт замеров)
        // POST /api/braki/files/upload?name=&id_braka=   — сырая загрузка (как orders/oplata)
        // DELETE /api/braki/files/<id>
        // ====================================================================
        async POST_FILE_UPLOAD(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            if (!OTK_ROLES.includes(user.role) && !TECH_ROLES.includes(user.role))
                return send(res, 403, { error: 'Недостаточно прав' });
            try {
                const idBraka = url.searchParams.get('id_braka');
                const name = url.searchParams.get('name') || 'file';
                if (!idBraka) return send(res, 400, { error: 'Не указан id_braka' });
                const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(-120) || 'file';
                const dir = path.join(__dirname, '..', '..', 'public', 'uploads', 'braki');
                fs.mkdirSync(dir, { recursive: true });

                const chunks = [];
                let size = 0;
                await new Promise((resolve, reject) => {
                    req.on('data', c => {
                        size += c.length;
                        if (size > 25 * 1024 * 1024) { reject(new Error('Файл больше 25 МБ')); req.destroy(); return; }
                        chunks.push(c);
                    });
                    req.on('error', reject);
                    req.on('end', resolve);
                });
                if (!chunks.length) return send(res, 400, { error: 'Пустое тело запроса' });

                const fname = Date.now() + '_' + safe;
                fs.writeFileSync(path.join(dir, fname), Buffer.concat(chunks));
                const ext = path.extname(safe).toLowerCase().replace('.', '');

                const id = generateId('BRF');
                await db.run(`
                    INSERT INTO braki_files (id, id_braka, file_name, file_path, file_type, uploaded_by)
                    VALUES (?,?,?,?,?,?)`,
                    [id, idBraka, safe, '/uploads/braki/' + encodeURIComponent(fname), ext, user.id]);
                await addHistory(idBraka, 'file_add', null, safe, user);
                wsManager.notifyDataChange('braki', 'update', idBraka);
                send(res, 200, { ok: true, id, path: '/uploads/braki/' + encodeURIComponent(fname), name: safe });
            } catch (e) {
                console.error('[brakRoutes.POST_FILE_UPLOAD]', e.message);
                send(res, 400, { error: e.message });
            }
        },

        async DELETE_FILE(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            const id = url.pathname.split('/')[3];
            try {
                const f = await db.get('SELECT * FROM braki_files WHERE id = ?', [id]);
                if (!f) return send(res, 404, { error: 'Файл не найден' });
                if (!OTK_ROLES.includes(user.role) && !TECH_ROLES.includes(user.role) && user.role !== 'admin')
                    return send(res, 403, { error: 'Недостаточно прав' });
                await db.run('DELETE FROM braki_files WHERE id = ?', [id]);
                try {
                    const abs = path.join(__dirname, '..', '..', 'public',
                        decodeURIComponent(f.file_path.replace(/^\//, '')));
                    if (abs.startsWith(path.join(__dirname, '..', '..', 'public', 'uploads')) && fs.existsSync(abs))
                        fs.unlinkSync(abs);
                } catch (e) { /* файл мог быть удалён ранее */ }
                await addHistory(f.id_braka, 'file_del', f.file_name, null, user);
                wsManager.notifyDataChange('braki', 'update', f.id_braka);
                send(res, 200, { ok: true });
            } catch (e) {
                send(res, 400, { error: e.message });
            }
        },

        // ====================================================================
        // ПЕРЕДАЧА БРАКА ТЕХНОЛОГУ
        // POST /api/braki/<id>/peredat-tehnologu  { id_tehnologa, kom }
        // ====================================================================
        async POST_PEREDAT(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            if (!OTK_ROLES.includes(user.role)) return send(res, 403, { error: 'Передавать может только контролёр ОТК' });
            const idBraka = url.pathname.split('/')[2];
            try {
                const d = await parseBody(req);
                const b = await db.get('SELECT * FROM braki WHERE id_braka = ?', [idBraka]);
                if (!b) return send(res, 404, { error: 'Брак не найден' });
                if (b.status_workflow !== 'vyavlen')
                    return send(res, 400, { error: `Статус «${b.status_workflow}» — передать можно только из «vyavlen»` });
                if (!d.id_tehnologa) return send(res, 400, { error: 'Выберите технолога' });
                const teh = await db.get("SELECT id, fio FROM users WHERE id = ? AND aktivnost = 1", [d.id_tehnologa]);
                if (!teh) return send(res, 400, { error: 'Технолог не найден или не активен' });

                const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
                await db.run(`UPDATE braki SET status_workflow='peredan_tehnologu', data_peredachi_tehnologu=?,
                               id_resheniya=NULL, id_tehnologa_naznachen=? WHERE id_braka=?`,
                    [now, d.id_tehnologa, idBraka]);
                await addHistory(idBraka, 'peredan_tehnologu', 'vyavlen', 'peredan_tehnologu', user,
                    `Технолог: ${teh.fio}. ${d.kommentariy || ''}`.trim());
                wsManager.notifyDataChange('braki', 'update', idBraka);
                send(res, 200, { ok: true });
            } catch (e) {
                console.error('[brakRoutes.POST_PEREDAT]', e.message);
                send(res, 400, { error: e.message });
            }
        },

        // ====================================================================
        // ОЧЕРЕДЬ ТЕХНОЛОГА
        // GET /api/tehnolog/ochered?all=1 — все открытые; по умолчанию — назначенные мне
        // ====================================================================
        async GET_OCHERED(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            try {
                const showAll = url.searchParams.get('all') === '1';
                const params = [];
                let where = `b.status_workflow IN ('vyavlen','peredan_tehnologu','reshenie_prinyato')`;
                if (!showAll && user.role !== 'admin') {
                    // очередь «назначено мне»: technolog назначен ОТК при передаче,
                    // либо решение принято этим технологом
                    where += ` AND (COALESCE(b.id_tehnologa_naznachen, b.id_resheniya) IS NULL
                                     OR b.id_tehnologa_naznachen = ?
                                     OR EXISTS (SELECT 1 FROM resheniya_tehnologa r
                                                WHERE r.id = b.id_resheniya AND r.id_tehnologa = ?))`;
                    params.push(user.id, user.id);
                }
                const rows = await db.all(`
                    SELECT b.*,
                           o.nomer_chertezha, o.naimenovanie AS osn_naimenovanie,
                           COALESCE(gp.kolvo_no_br,0)+COALESCE(gp.kolvo_yes_br,0) AS vsego_sht,
                           fir.naimenovanie AS firm_name,
                           uc.fio AS kontroler_fio,
                           rt.tip_resheniya AS tekushchee_reshenie,
                           rt.status_resheniya AS status_resheniya,
                           ut.fio AS tehnolog_fio
                      FROM braki b
                      JOIN gryz_poz gp             ON gp.id = b.id_gp
                      LEFT JOIN transport_oper t   ON t.id = gp.id_transporta
                      LEFT JOIN firmy fir          ON fir.id_firmy = t.id_firma
                      LEFT JOIN plan_perevozok pz  ON pz.id = gp.id_plana
                      LEFT JOIN plan p             ON p.id = pz.id_plana
                      LEFT JOIN osnastka o         ON o.id = p.id_osnastka
                      LEFT JOIN users uc           ON uc.id = b.id_kontrolera
                      LEFT JOIN resheniya_tehnologa rt ON rt.id = b.id_resheniya
                      LEFT JOIN users ut           ON ut.id = rt.id_tehnologa
                     WHERE ${where}
                     ORDER BY b.data_peredachi_tehnologu ASC, b.rowid ASC`, params);
                send(res, 200, rows);
            } catch (e) {
                console.error('[brakRoutes.GET_OCHERED]', e.message);
                send(res, 500, { error: e.message });
            }
        },

        // ====================================================================
        // ПОЛНАЯ ИСТОРИЯ РЕШЕНИЙ ПО БРАКУ (для дефектов: активные + отменённые)
        // GET /api/braki/<id>/resheniya
        // ====================================================================
        async GET_RESHENIYA(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            const idBraka = url.pathname.split('/')[2];
            try {
                const rows = await db.all(`
                    SELECT r.*, u.fio AS tehnolog_fio,
                           cz.ceh || ' — ' || cz.nazvanie AS cex_name
                      FROM resheniya_tehnologa r
                      LEFT JOIN users u      ON u.id = r.id_tehnologa
                      LEFT JOIN cex_zatrat cz ON cz.id = r.id_cex_izgotovitel
                     WHERE r.id_braka = ?
                     ORDER BY r.data_resheniya DESC`, [idBraka]);
                send(res, 200, rows);
            } catch (e) {
                console.error('[brakRoutes.GET_RESHENIYA]', e.message);
                send(res, 500, { error: e.message });
            }
        },

        // ====================================================================
        // ПРИНЯТЬ В РАБОТУ (технолог открыл брак)
        // PUT /api/braki/<id>/prinyat
        // ====================================================================
        async PUT_PRINYAT(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            if (!TECH_ROLES.includes(user.role)) return send(res, 403, { error: 'Только технолог' });
            const idBraka = url.pathname.split('/')[2];
            try {
                const b = await db.get('SELECT * FROM braki WHERE id_braka = ?', [idBraka]);
                if (!b) return send(res, 404, { error: 'Брак не найден' });
                if (b.status_workflow !== 'peredan_tehnologu')
                    return send(res, 400, { error: 'Принять можно только брак со статусом «передан технологу»' });
                const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
                await db.run('UPDATE braki SET data_polucheniya_tehnologom=? WHERE id_braka=?', [now, idBraka]);
                await addHistory(idBraka, 'prinyat_technologom', 'peredan_tehnologu', 'v_rabote', user);
                wsManager.notifyDataChange('braki', 'update', idBraka);
                send(res, 200, { ok: true });
            } catch (e) {
                send(res, 400, { error: e.message });
            }
        },

        // ====================================================================
        // РЕШЕНИЕ ТЕХНОЛОГА
        // POST /api/braki/<id>/reshenie
        // { tip_resheniya, kommentariy, kto_oplachivaet_transport, srok_vozvrata,
        //   id_cex_izgotovitel, summa_uscherba, kto_neset_ubutki, nomer_pisma_kontragentu_o_brake,
        //   chya_povtornaya_zagotovka }
        // Старое активное решение помечается 'otmeneno', новое — 'aktivno';
        // braki.status_workflow -> 'reshenie_prinyato'.
        // ====================================================================
        async POST_RESHENIE(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            if (!TECH_ROLES.includes(user.role)) return send(res, 403, { error: 'Решение принимает только технолог' });
            const idBraka = url.pathname.split('/')[2];
            try {
                const d = await parseBody(req);
                const b = await db.get('SELECT * FROM braki WHERE id_braka = ?', [idBraka]);
                if (!b) return send(res, 404, { error: 'Брак не найден' });
                if (b.status_workflow === 'vyavlen')
                    return send(res, 400, { error: 'Брак ещё не передан технологу' });
                if (b.status_workflow === 'zakryt')
                    return send(res, 400, { error: 'Брак закрыт' });

                const TIPY = ['spisat_okonchatelno', 'otpravit_podryadchiku', 'peredelat_v_pto', 'dopustit_kak_godnoe'];
                if (!TIPY.includes(d.tip_resheniya)) return send(res, 400, { error: 'Неверный тип решения' });

                // валидация атрибутов по типу
                if (d.tip_resheniya === 'otpravit_podryadchiku' && !d.kto_oplachivaet_transport)
                    return send(res, 400, { error: 'Укажите, кто оплачивает транспорт (подрядчик/заказчик)' });
                if (d.tip_resheniya === 'peredelat_v_pto' && !d.id_cex_izgotovitel)
                    return send(res, 400, { error: 'Укажите цех ПТО для переделки' });
                if (d.tip_resheniya === 'spisat_okonchatelno' && !d.kto_neset_ubutki)
                    return send(res, 400, { error: 'Укажите, кто несёт убытки (подрядчик/заказчик)' });

                const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
                // отменить прежнее активное решение
                await db.run(`UPDATE resheniya_tehnologa SET status_resheniya='otmeneno', updated_at=? WHERE id_braka=? AND status_resheniya='aktivno'`,
                    [now, idBraka]);

                const idResh = generateId('RES');
                await db.run(`
                    INSERT INTO resheniya_tehnologa (
                        id, id_braka, id_tehnologa, data_priyoma, data_resheniya,
                        tip_resheniya, kommentariy,
                        kto_oplachivaet_transport, srok_vozvrata,
                        id_cex_izgotovitel, data_peredachi_v_cex,
                        summa_uscherba, kto_neset_ubutki,
                        status_resheniya, nomer_pisma_kontragentu_o_brake, chya_povtornaya_zagotovka)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [idResh, idBraka, user.id, b.data_polucheniya_tehnologom || now, now,
                     d.tip_resheniya, d.kommentariy || '',
                     d.tip_resheniya === 'otpravit_podryadchiku' ? (d.kto_oplachivaet_transport || '') : '',
                     d.tip_resheniya === 'otpravit_podryadchiku' ? (d.srok_vozvrata || '') : '',
                     d.tip_resheniya === 'peredelat_v_pto' ? (d.id_cex_izgotovitel || '') : '',
                     d.tip_resheniya === 'peredelat_v_pto' ? now : null,
                     d.tip_resheniya === 'spisat_okonchatelno' ? (parseFloat(d.summa_uscherba) || 0) : 0,
                     d.tip_resheniya === 'spisat_okonchatelno' ? (d.kto_neset_ubutki || '') : '',
                     'aktivno', d.nomer_pisma_kontragentu_o_brake || '', d.chya_povtornaya_zagotovka || '']);

                await db.run(`UPDATE braki SET status_workflow='reshenie_prinyato', id_resheniya=? WHERE id_braka=?`,
                    [idResh, idBraka]);
                await addHistory(idBraka, 'reshenie_prinyato', b.status_workflow, 'reshenie_prinyato', user,
                    `Решение: ${d.tip_resheniya}. ${d.kommentariy || ''}`.trim());
                wsManager.notifyDataChange('braki', 'update', idBraka);
                wsManager.notifyDataChange('resheniya_tehnologa', 'add', idResh);
                send(res, 200, { ok: true, id_resheniya: idResh });
            } catch (e) {
                console.error('[brakRoutes.POST_RESHENIE]', e.message);
                send(res, 400, { error: e.message });
            }
        },

        // ====================================================================
        // ИСПОЛНЕНО / ЗАКРЫТИЕ БРАКА
        // PUT /api/braki/<id>/zakryt  { kom }
        // ====================================================================
        async PUT_ZAKRYT(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            if (!TECH_ROLES.includes(user.role) && !OTK_ROLES.includes(user.role))
                return send(res, 403, { error: 'Недостаточно прав' });
            const idBraka = url.pathname.split('/')[2];
            try {
                const b = await db.get('SELECT * FROM braki WHERE id_braka = ?', [idBraka]);
                if (!b) return send(res, 404, { error: 'Брак не найден' });
                if (b.status_workflow !== 'reshenie_prinyato')
                    return send(res, 400, { error: 'Закрывать можно только после принятия решения' });
                const d = await parseBody(req).catch(() => ({}));
                const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
                if (b.id_resheniya) {
                    await db.run(`UPDATE resheniya_tehnologa SET status_resheniya='ispolneno', updated_at=? WHERE id=?`,
                        [now, b.id_resheniya]);
                }
                await db.run(`UPDATE braki SET status_workflow='zakryt', data_zakrytiya=? WHERE id_braka=?`, [now, idBraka]);
                await addHistory(idBraka, 'zakryt', 'reshenie_prinyato', 'zakryt', user, (d && d.kommentariy) || '');
                wsManager.notifyDataChange('braki', 'update', idBraka);
                send(res, 200, { ok: true });
            } catch (e) {
                send(res, 400, { error: e.message });
            }
        },

        // ====================================================================
        // КАРТОЧКА БРАКА (для обеих страниц)
        // GET /api/braki/<id>
        // ====================================================================
        async GET_BRAK(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            const idBraka = url.pathname.split('/')[2];
            try {
                const full = await getBrakFull(idBraka);
                if (!full) return send(res, 404, { error: 'Брак не найден' });
                send(res, 200, full);
            } catch (e) {
                send(res, 500, { error: e.message });
            }
        },

        // ====================================================================
        // СПИСОК БРАКОВ (журнал ОТК)
        // GET /api/braki?status=&id_gp=
        // ====================================================================
        async GET_LIST(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            try {
                const status = url.searchParams.get('status') || '';
                const idGp = url.searchParams.get('id_gp') || '';
                const conds = [], params = [];
                if (status) { conds.push('b.status_workflow = ?'); params.push(status); }
                if (idGp)   { conds.push('b.id_gp = ?'); params.push(idGp); }
                const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
                const rows = await db.all(`
                    SELECT b.*,
                           o.nomer_chertezha, o.naimenovanie AS osn_naimenovanie,
                           COALESCE(gp.kolvo_no_br,0)+COALESCE(gp.kolvo_yes_br,0) AS vsego_sht,
                           fir.naimenovanie AS firm_name,
                           uc.fio AS kontroler_fio,
                           rt.tip_resheniya, ut.fio AS tehnolog_fio
                      FROM braki b
                      JOIN gryz_poz gp             ON gp.id = b.id_gp
                      LEFT JOIN transport_oper t   ON t.id = gp.id_transporta
                      LEFT JOIN firmy fir          ON fir.id_firmy = t.id_firma
                      LEFT JOIN plan_perevozok pz  ON pz.id = gp.id_plana
                      LEFT JOIN plan p             ON p.id = pz.id_plana
                      LEFT JOIN osnastka o         ON o.id = p.id_osnastka
                      LEFT JOIN users uc           ON uc.id = b.id_kontrolera
                      LEFT JOIN resheniya_tehnologa rt ON rt.id = b.id_resheniya
                      LEFT JOIN users ut           ON ut.id = rt.id_tehnologa
                      ${where}
                     ORDER BY b.rowid DESC LIMIT 500`, params);
                send(res, 200, rows);
            } catch (e) {
                send(res, 500, { error: e.message });
            }
        },

        // ====================================================================
        // СПРАВОЧНИКИ ДЛЯ ФОРМ СТРАНИЦ
        // GET /api/braki/refs — технологи (роль teholog), цеха
        // ====================================================================
        async GET_REFS(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            try {
                const technologs = await db.all(
                    "SELECT id, login, fio FROM users WHERE role = 'teholog' AND aktivnost = 1 ORDER BY fio");
                const cexi = await db.all(
                    `SELECT id, ceh, peredel, nazvanie FROM cex_zatrat ORDER BY ceh, nazvanie`);
                send(res, 200, { technologs, cexi });
            } catch (e) {
                send(res, 500, { error: e.message });
            }
        },

        // ====================================================================
        // УДАЛИТЬ БРАК (только из 'vyavlen', ОТК) — каскадно чистит замеры/файлы/историю
        // DELETE /api/braki/<id>
        // ====================================================================
        async DELETE_BRAK(req, res, url) {
            const user = await authUser(req);
            if (!user) return send(res, 401, { error: 'Требуется авторизация' });
            if (!OTK_ROLES.includes(user.role)) return send(res, 403, { error: 'Удалить брак может только ОТК' });
            const idBraka = url.pathname.split('/')[2];
            try {
                const b = await db.get('SELECT * FROM braki WHERE id_braka = ?', [idBraka]);
                if (!b) return send(res, 404, { error: 'Брак не найден' });
                if (b.status_workflow !== 'vyavlen')
                    return send(res, 400, { error: 'Нельзя удалять брак, переданный технологу' });
                await db.run('DELETE FROM braki WHERE id_braka = ?', [idBraka]);
                wsManager.notifyDataChange('braki', 'delete', idBraka);
                send(res, 200, { ok: true });
            } catch (e) {
                send(res, 400, { error: e.message });
            }
        }
    };
};
