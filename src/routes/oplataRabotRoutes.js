// ============================================================
// src/routes/oplataRabotRoutes.js
// ОПЛАТА РАБОТ (✅ T102) — ✅ T104: распределение суммы оплаты
// по грузовым позициям (связь М:М с суммой).
//
// Связь «оплата ↔ грузовые позиции» (T102 → T104):
//   T102: gryz_poz.id_oplata_rabot  (1 оплата — несколько позиций,
//         вся сумма оплаты засчитывалась КАЖДОЙ позиции — некорректно);
//   T104: таблица oplata_poz (id, id_oplata_rabot, id_gryz_poz, summa):
//         одна позиция может входить в НЕСКОЛЬКО платежек (аванс +
//         окончательный расчёт), и по каждой платежке на позицию
//         относится только ЧАСТЬ суммы документа. Сумма всех
//         распределений одной оплаты ≤ сумма документа БЕЗ НДС
//         (✅ T105: НДС — расчётная величина, в сравнении не участвует).
//         gryz_poz.id_oplata_rabot остаётся как совместимость
//         (заполняется первой оплатой позиции).
// Оплата создаётся оператором в контексте транспортной операции:
//   • фильтры «фирма» и «№ зак. дог.» ОБЯЗАТЕЛЬНЫ (✅ T104: платежка
//     жёстко привязана к фирме и заказу к договору);
//   • тип оплаты «аванс» → операции с № эт. = 1 (фильтр nomshag),
//     «окончательный расчёт» → тип перевозки «Получение готовой
//     продукции» (автофильтры на клиенте);
//   • сумма НДС берётся ИЗ ДОГОВОРА (dogovor.hdc по dog_osnov позиций);
//   • оператор отмечает позиции и распределяет сумму документа
//     по позициям (частями, без превышения суммы документа).
//
// Эндпоинты:
//   GET    /api/oplata/operatsii?firma=&data=&tip=&zakdog=&zakpto=&nomshag=
//   GET    /api/oplata/pozicii?operId=             — позиции (+оплачено всеми платёжками)
//   GET    /api/oplata/zapisi?operId=              — оплаты операции (+распределено)
//   GET    /api/oplata/raspredelenie?oplId=        — распределение оплаты по позициям (✅ T104)
//   POST   /api/oplata/zapisi                      — создать оплату + распределить по позициям
//   PUT    /api/oplata/zapisi/:id                  — обновить поля оплаты
//   DELETE /api/oplata/zapisi/:id                  — удалить оплату (сняв привязки)
//   POST   /api/oplata/privyazat                   — привязать позиции + суммы (UPSERT)
//   POST   /api/oplata/otvyazat                    — снять привязку позиций (у оплаты oplId)
//   PUT    /api/oplata/zapisi/:id/step             — поля шагов платежки (✅ T106)
//   POST   /api/oplata/upload-file                 — прикрепить PDF (шаги 1/4) (✅ T106)
//   POST   /api/oplata/send-email                  — отправить PDF платежки на почту (✅ T106)
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { cyrGlobPattern } = require('./helpers/queryBuilder'); // ✅ T103 fix1: регистронезависимый поиск (кириллица)
const fs = require('fs');                                     // ✅ T106: upload PDF шагов 1/4
const path = require('path');                                 // ✅ T106
const { sendEmail, normalizeAddressList } = require('../emailService');       // ✅ T106: шаг 2 (аванс)
const { SIGNATURE } = require('./helpers/emailSignature');                    // ✅ T106: подпись письма

// tip_oplaty — фиксированный набор (см. Database.js и «Плоскую таблицу»:
// отчёт различает avans — строка отправки, okonchatelny_raschet — приход)
const TIP_OPLATY = ['avans', 'okonchatelny_raschet'];

function round2(n) { return Math.round(n * 100) / 100; }

// Валидация полей оплаты (tip_oplaty и summa_k_oplate обязательны)
function validateFields(d) {
    if (!TIP_OPLATY.includes(d.tip_oplaty)) return 'Не выбран тип оплаты';
    const s = parseFloat(d.summa_k_oplate);
    if (!Number.isFinite(s) || s < 0) return 'Сумма к оплате должна быть числом ≥ 0';
    return null;
}

// ✅ T104: нормализация распределения { id_gryz_poz: summa } | [{id, summa}]
// → Map(число id → число summa ≥ 0); null при некорректных данных
function parsePozSum(raw) {
    const map = new Map();
    const push = (id, s) => {
        const pid = String(id ?? '').trim();
        const ps = parseFloat(String(s).replace(',', '.'));
        if (!pid || !Number.isFinite(ps) || ps < 0) return false;
        map.set(pid, round2(ps));
        return true;
    };
    if (Array.isArray(raw)) {
        for (const it of raw) {
            if (!it || !push(it.id, it.summa)) return null;
        }
    } else if (raw && typeof raw === 'object') {
        for (const k of Object.keys(raw)) {
            if (!push(k, raw[k])) return null;
        }
    }
    return map;
}

// ✅ T104: ставка НДС (%) по договору первой привязанной позиции оплаты
// (или — для новой оплаты — по договору первой из указанных позиций)
async function ndsRateFor(db, oplId, pozIds) {
    let row = null;
    if (oplId) {
        row = await db.get(`
            SELECT d.hdc FROM oplata_poz opz
            JOIN gryz_poz gp ON gp.id = opz.id_gryz_poz
            LEFT JOIN plan_perevozok pp ON pp.id = gp.id_plana
            LEFT JOIN dogovor d ON TRIM(COALESCE(d.nom_dogovor, '')) = TRIM(COALESCE(pp.dog_osnov, ''))
            WHERE opz.id_oplata_rabot = ? AND d.hdc IS NOT NULL AND TRIM(CAST(d.hdc AS TEXT)) != ''
            ORDER BY opz.id LIMIT 1`, [oplId]);
    }
    if (!row && Array.isArray(pozIds) && pozIds.length) {
        const ph = pozIds.map(() => '?').join(',');
        row = await db.get(`
            SELECT d.hdc FROM gryz_poz gp
            LEFT JOIN plan_perevozok pp ON pp.id = gp.id_plana
            LEFT JOIN dogovor d ON TRIM(COALESCE(d.nom_dogovor, '')) = TRIM(COALESCE(pp.dog_osnov, ''))
            WHERE gp.id IN (${ph}) AND d.hdc IS NOT NULL AND TRIM(CAST(d.hdc AS TEXT)) != ''
            ORDER BY gp.id LIMIT 1`, pozIds);
    }
    const rate = row ? parseFloat(String(row.hdc).replace(',', '.')) : NaN;
    return Number.isFinite(rate) ? rate : null;
}

// ✅ T105: лимит распределения платежки = сумма документа БЕЗ НДС
// (сравнение «Распределено X из Y» ведётся по сумме без НДС; НДС и
// итого с НДС — расчётные величины по ставке договора: показываются
// рядом, но в лимит не входят)
function oplLimit(summaKoplate) {
    return round2(parseFloat(summaKoplate) || 0);
}

module.exports = (db, wsManager) => ({

    // ====================================================================
    // GET /api/oplata/operatsii?firma=&data=&tip=&zakdog=&zakpto=&nomshag=
    // Транспортные операции для выбора (фирма / дата отправки / тип / этап)
    // ====================================================================
    async GET_OPERATSII(req, res, url) {
        try {
            const q = url.searchParams;
            const firma = (q.get('firma') || '').trim();
            const data  = (q.get('data')  || '').trim();
            const tip   = (q.get('tip')   || '').trim();

            // ✅ T103: «№ этапа» и «Тип перевозки» операции — по шагам заявок её
            // партий (gryz_poz → plan_perevozok.id_shag → shagi_marshruta →
            // transport_types), как в «Текущем плане перевозок» страницы
            // «План перевозок»; transport_tip/napravlenie/nomer_reisa больше
            // не отдаём. Тип перевозки фильтруется по nazvanie_operatsii шага.
            // ✅ T104: zak_dog_list — заказы к договору позиций операции
            // (для select-фильтра «№ зак. дог.» на клиенте).
            let sql = `
                SELECT t.id, t.id_firma, f.naimenovanie AS firma_name,
                       t.otgruzka_data, t.gruz_name, t.status,
                       (SELECT COUNT(*) FROM gryz_poz gp WHERE gp.id_transporta = t.id) AS poz_count,
                       (SELECT COUNT(DISTINCT gp.id_oplata_rabot) FROM gryz_poz gp
                         WHERE gp.id_transporta = t.id AND gp.id_oplata_rabot IS NOT NULL) AS opl_count,
                       (SELECT GROUP_CONCAT(DISTINCT sm.nom_shag) FROM gryz_poz g2
                         JOIN plan_perevozok pp2 ON pp2.id = g2.id_plana
                         JOIN shagi_marshruta sm ON sm.id_shag = pp2.id_shag
                         WHERE g2.id_transporta = t.id) AS nom_shag,
                       (SELECT GROUP_CONCAT(DISTINCT tp.nazvanie_operatsii) FROM gryz_poz g3
                         JOIN plan_perevozok pp3 ON pp3.id = g3.id_plana
                         JOIN shagi_marshruta sm3 ON sm3.id_shag = pp3.id_shag
                         JOIN transport_types tp ON tp.id_tipa = sm3.id_tipa_perevozki
                         WHERE g3.id_transporta = t.id) AS tip_perevozki,
                       (SELECT GROUP_CONCAT(DISTINCT zd.nomer_zakaza) FROM gryz_poz g4
                         JOIN plan_perevozok pz4 ON pz4.id = g4.id_plana
                         JOIN plan pl4 ON pl4.id = pz4.id_plana
                         JOIN poz_zakaz_dogovora pzd ON pzd.id_plana = pl4.id
                         JOIN zakaz_po_dogovoru zd ON zd.id = pzd.id_zakaza_po_dogovoru
                         WHERE g4.id_transporta = t.id) AS zak_dog_list
                FROM transport_oper t
                LEFT JOIN firmy f ON f.id_firmy = t.id_firma
                WHERE 1 = 1`;
            const params = [];
            if (firma) { sql += ' AND t.id_firma = ?';        params.push(firma); }
            if (data)  { sql += " AND t.otgruzka_data LIKE ?"; params.push(data + '%'); }
            if (tip)   { sql += ` AND EXISTS (
                             SELECT 1 FROM gryz_poz gt
                             JOIN plan_perevozok pt ON pt.id = gt.id_plana
                             JOIN shagi_marshruta st ON st.id_shag = pt.id_shag
                             JOIN transport_types tt ON tt.id_tipa = st.id_tipa_perevozki
                             WHERE gt.id_transporta = t.id AND tt.nazvanie_operatsii = ?)`;
                        params.push(tip); }
            // ✅ T103: фильтр «№ зак. дог.» — по номеру заказа к договору любой
            // позиции плана, чья партия едет в операции (частичное совпадение)
            const zakdog = (q.get('zakdog') || '').trim();
            if (zakdog) { sql += ` AND EXISTS (
                             SELECT 1 FROM gryz_poz gz
                             JOIN plan_perevozok pz ON pz.id = gz.id_plana
                             JOIN plan pl ON pl.id = pz.id_plana
                             JOIN poz_zakaz_dogovora pzd ON pzd.id_plana = pl.id
                             JOIN zakaz_po_dogovoru zd ON zd.id = pzd.id_zakaza_po_dogovoru
                             WHERE gz.id_transporta = t.id
                               AND COALESCE(zd.nomer_zakaza, '') GLOB ?)`;
                        params.push(cyrGlobPattern(zakdog)); }
            // ✅ T103: фильтр «№ зак. ПТО» — plan.zak_pto позиций операции
            const zakpto = (q.get('zakpto') || '').trim();
            if (zakpto) { sql += ` AND EXISTS (
                             SELECT 1 FROM gryz_poz gz2
                             JOIN plan_perevozok pz2 ON pz2.id = gz2.id_plana
                             JOIN plan pl2 ON pl2.id = pz2.id_plana
                             WHERE gz2.id_transporta = t.id
                               AND COALESCE(pl2.zak_pto, '') GLOB ?)`;
                        params.push(cyrGlobPattern(zakpto)); }
            // ✅ T104: фильтр «№ эт.» — этап шага маршрута партий операции
            // (аванс → № эт. = 1 — автофильтр на клиенте)
            const nomshag = (q.get('nomshag') || '').trim();
            if (nomshag) { sql += ` AND EXISTS (
                             SELECT 1 FROM gryz_poz gn
                             JOIN plan_perevozok pn ON pn.id = gn.id_plana
                             JOIN shagi_marshruta sn ON sn.id_shag = pn.id_shag
                             WHERE gn.id_transporta = t.id AND CAST(sn.nom_shag AS TEXT) = ?)`;
                        params.push(nomshag); }
            sql += ' ORDER BY t.otgruzka_data DESC, f.naimenovanie';

            const rows = await db.all(sql, params);
            send(res, 200, rows);
        } catch (e) {
            console.error('[oplataRabotRoutes.GET_OPERATSII]', e);
            send(res, 500, { error: e.message });
        }
    },

    // ====================================================================
    // GET /api/oplata/pozicii?operId=
    // Грузовые позиции транспортной операции — для идентификации оператору:
    // № чертежа, наименование оснастки, количество в грузовой позиции;
    // плюс договор (dog_osnov → dogovor) для НДС и % аванса (✅ T105).
    // ✅ T104: oplacheno — сумма ВСЕХ платежек позиции (oplata_poz.summa),
    //          opl_akty — список актов/УПД всех платежек позиции.
    // ====================================================================
    async GET_POZICII(req, res, url) {
        try {
            const operId = (url.searchParams.get('operId') || '').trim();
            if (!operId) return send(res, 400, { error: 'Не указана транспортная операция (operId)' });

            // ✅ T103: колонки «план производства» + стоимость/оплата:
            //   n_zaprosa / zak_po_dog — те же субзапросы, что в plan.list
            //   (syntheticTables.js); kolvo_zak = план позиции (plan_god_kolvo);
            //   cena_kp = kp.cena_postavshika лучшего КП (plan.id_kp);
            //   ✅ T104: oplacheno = SUM(oplata_poz.summa) — все платежки позиции
            const rows = await db.all(`
                SELECT gp.id, gp.kolvo_no_br, gp.kolvo_yes_br, gp.id_oplata_rabot,
                       o.nomer_chertezha, o.naimenovanie,
                       (COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0)) AS kolvo,
                       pp.dog_osnov, d.id_dogovor, d.nom_dogovor, d.hdc, d.predoplata_pr,
                       p.plan_god_kolvo AS kolvo_zak,
                       kp.cena_postavshika AS cena_kp,
                       (SELECT zk.n_zaprosa FROM kp kq
                         INNER JOIN zapros_kp zk ON zk.id = kq.id_zaprosa_kp
                         WHERE kq.id_plana = p.id AND COALESCE(zk.n_zaprosa, '') != ''
                         ORDER BY kq.rowid LIMIT 1) AS n_zaprosa,
                       (SELECT CASE WHEN COALESCE(z.nomer_zakaza, '') = '' THEN ''
                              ELSE z.nomer_zakaza ||
                               CASE WHEN COALESCE(z.data_zakaza, '') != ''
                                 THEN ' от ' || substr(z.data_zakaza, 9, 2) || '.' ||
                                      substr(z.data_zakaza, 6, 2) || '.' ||
                                      substr(z.data_zakaza, 1, 4)
                                 ELSE '' END END
                         FROM poz_zakaz_dogovora pz
                         INNER JOIN zakaz_po_dogovoru z ON z.id = pz.id_zakaza_po_dogovoru
                         WHERE pz.id_plana = p.id
                         ORDER BY pz.rowid DESC LIMIT 1) AS zak_po_dog,
                       (SELECT COALESCE(SUM(opz.summa), 0) FROM oplata_poz opz
                         WHERE opz.id_gryz_poz = gp.id) AS oplacheno,
                       (SELECT GROUP_CONCAT(or2.nomer_akta_upd, '; ') FROM oplata_poz opz2
                         JOIN oplata_rabot or2 ON or2.id = opz2.id_oplata_rabot
                         WHERE opz2.id_gryz_poz = gp.id) AS opl_akty
                FROM gryz_poz gp
                LEFT JOIN plan_perevozok pp ON pp.id = gp.id_plana
                LEFT JOIN plan p            ON p.id = pp.id_plana
                LEFT JOIN osnastka o        ON o.id = p.id_osnastka
                LEFT JOIN kp                ON kp.id = p.id_kp
                LEFT JOIN dogovor d         ON TRIM(COALESCE(d.nom_dogovor, '')) = TRIM(COALESCE(pp.dog_osnov, ''))
                WHERE gp.id_transporta = ?
                ORDER BY o.nomer_chertezha, gp.id`, [operId]);

            // dogovor.nom_dogovor не уникален в БД — возможны дубли строки позиции
            // при совпадающих номерах договора у разных фирм: оставляем первую
            const seen = new Set();
            const out = [];
            for (const r of rows) {
                if (seen.has(r.id)) continue;
                seen.add(r.id);
                out.push(r);
            }
            // ✅ T103: стоимость планового количества, ₽ = кол-во по заказу × цена КП
            for (const r of out) {
                const k = parseFloat(String(r.kolvo_zak ?? '').replace(',', '.'));
                const c = parseFloat(String(r.cena_kp ?? '').replace(',', '.'));
                r.stoim_plan = (Number.isFinite(k) && Number.isFinite(c)) ? round2(k * c) : null;
            }
            send(res, 200, out);
        } catch (e) {
            console.error('[oplataRabotRoutes.GET_POZICII]', e);
            send(res, 500, { error: e.message });
        }
    },

    // ====================================================================
    // GET /api/oplata/zapisi?operId=
    // Оплаты, привязанные к грузовым позициям выбранной операции.
    // НДС и «с НДС» вычисляются на лету: ставка — из договора первой
    // привязанной позиции (dog_osnov → dogovor.hdc), в БД не хранится.
    // ✅ T104: список через oplata_poz; raspred — распределённая по
    //          позициям сумма (может быть меньше суммы документа).
    // ====================================================================
    async GET_ZAPISI(req, res, url) {
        try {
            const operId = (url.searchParams.get('operId') || '').trim();
            if (!operId) return send(res, 400, { error: 'Не указана транспортная операция (operId)' });

            const rows = await db.all(`
                SELECT op.id, op.tip_oplaty, op.nomer_akta_upd,
                       op.data_predostavleniya_dok, op.nomer_schet_faktura,
                       op.summa_k_oplate, op.primechanie, op.created_at,
                       op.ssylka_doc, op.ssylka_scan_reestra, op.data_vneseniya_1s,
                       op.email_otpravki, op.data_email_otpravki,
                       (SELECT COUNT(DISTINCT opz.id_gryz_poz) FROM oplata_poz opz
                         WHERE opz.id_oplata_rabot = op.id) AS poz_count,
                       (SELECT COALESCE(SUM(opz.summa), 0) FROM oplata_poz opz
                         WHERE opz.id_oplata_rabot = op.id) AS raspred
                FROM oplata_rabot op
                WHERE EXISTS (
                    SELECT 1 FROM oplata_poz opz2
                    JOIN gryz_poz gp ON gp.id = opz2.id_gryz_poz
                    WHERE opz2.id_oplata_rabot = op.id AND gp.id_transporta = ?)
                ORDER BY op.created_at DESC, op.id`, [operId]);

            for (const r of rows) {
                const d = await db.get(`
                    SELECT d.hdc, d.nom_dogovor
                    FROM oplata_poz opz
                    JOIN gryz_poz gp ON gp.id = opz.id_gryz_poz
                    LEFT JOIN plan_perevozok pp ON pp.id = gp.id_plana
                    LEFT JOIN dogovor d ON TRIM(COALESCE(d.nom_dogovor, '')) = TRIM(COALESCE(pp.dog_osnov, ''))
                    WHERE opz.id_oplata_rabot = ? AND d.hdc IS NOT NULL AND TRIM(CAST(d.hdc AS TEXT)) != ''
                    ORDER BY opz.id LIMIT 1`, [r.id]);
                const rate = d ? parseFloat(String(d.hdc).replace(',', '.')) : NaN;
                const s = parseFloat(r.summa_k_oplate) || 0;
                r.nds_rate = Number.isFinite(rate) ? rate : null;
                r.nds_nom_dogovor = d ? (d.nom_dogovor || '') : '';
                r.summa_nds   = r.nds_rate != null ? round2(s * r.nds_rate / 100) : null;
                r.summa_s_nds = r.nds_rate != null ? round2(s + s * r.nds_rate / 100) : null;
                r.limit_rasp = oplLimit(s); // ✅ T105: лимит распределения (сумма документа без НДС)
                // ✅ T106: НЕ распределено — остаток платежки, который ещё можно
                // распределить по позициям (оператору видно, сколько осталось)
                r.ne_rasp = round2(r.limit_rasp - (parseFloat(r.raspred) || 0));
            }
            send(res, 200, rows);
        } catch (e) {
            console.error('[oplataRabotRoutes.GET_ZAPISI]', e);
            send(res, 500, { error: e.message });
        }
    },

    // ====================================================================
    // GET /api/oplata/raspredelenie?oplId=          (✅ T104)
    // Распределение оплаты по грузовым позициям: [{id_gryz_poz, summa}]
    // ====================================================================
    async GET_RASPRED(req, res, url) {
        try {
            const oplId = (url.searchParams.get('oplId') || '').trim();
            if (!oplId) return send(res, 400, { error: 'Не указана оплата (oplId)' });
            const rows = await db.all(
                `SELECT id_gryz_poz, summa FROM oplata_poz WHERE id_oplata_rabot = ? ORDER BY id`,
                [oplId]);
            send(res, 200, rows);
        } catch (e) {
            console.error('[oplataRabotRoutes.GET_RASPRED]', e);
            send(res, 500, { error: e.message });
        }
    },

    // ====================================================================
    // POST /api/oplata/zapisi
    // Создать оплату и распределить сумму по выбранным грузовым позициям
    // { id_oper, pozIds: [...], pozSum: [{id, summa}] | {id: summa},
    //   tip_oplaty, nomer_akta_upd, data_predostavleniya_dok,
    //   nomer_schet_faktura, summa_k_oplate, primechanie }
    // ✅ T104: сумма документа распределяется ЧАСТЯМИ по позициям;
    //          ✅ T105: Σ распределений ≤ сумма документа БЕЗ НДС.
    // ====================================================================
    async POST_ZAPIS(req, res) {
        try {
            const d = await parseBody(req);
            if (!d.id_oper) return send(res, 400, { error: 'Не выбрана транспортная операция' });
            const err = validateFields(d);
            if (err) return send(res, 400, { error: err });

            const sums = parsePozSum(d.pozSum);
            if (!sums || sums.size === 0) {
                return send(res, 400, { error: 'Отметьте грузовые позиции и укажите суммы распределения — оплата должна быть привязана хотя бы к одной позиции' });
            }
            const pozIds = Array.from(sums.keys());
            const ph = pozIds.map(() => '?').join(',');
            // позиции должны принадлежать выбранной операции
            const ok = await db.all(
                `SELECT id FROM gryz_poz WHERE id_transporta = ? AND id IN (${ph})`,
                [d.id_oper, ...pozIds]);
            if (ok.length !== pozIds.length) {
                return send(res, 400, { error: 'Некоторые позиции не относятся к выбранной транспортной операции' });
            }

            // ✅ T105: лимит — сумма документа БЕЗ НДС (НДС — расчётный)
            const summaDoc = parseFloat(d.summa_k_oplate) || 0;
            const limit = oplLimit(summaDoc);
            const total = round2(Array.from(sums.values()).reduce((a, b) => a + b, 0));
            if (total > limit + 0.011) {
                return send(res, 400, { error: `Сумма распределения по позициям (${total.toFixed(2)} ₽) превышает сумму документа (${limit.toFixed(2)} ₽)` });
            }

            const id = generateId('OR');
            await db.run(
                `INSERT INTO oplata_rabot
                 (id, tip_oplaty, nomer_akta_upd, data_predostavleniya_dok, nomer_schet_faktura, summa_k_oplate, primechanie)
                 VALUES (?,?,?,?,?,?,?)`,
                [
                    id,
                    d.tip_oplaty,
                    d.nomer_akta_upd || '',
                    d.data_predostavleniya_dok || '',
                    d.nomer_schet_faktura || '',
                    summaDoc,
                    d.primechanie || ''
                ]);
            for (const [pid, s] of sums) {
                await db.run(
                    `INSERT INTO oplata_poz (id, id_oplata_rabot, id_gryz_poz, summa) VALUES (?,?,?,?)`,
                    [generateId('OPZ'), id, pid, s]);
            }
            // совместимость (T102): первая оплата позиции в gryz_poz.id_oplata_rabot
            await db.run(
                `UPDATE gryz_poz SET id_oplata_rabot = ?
                 WHERE id IN (${ph}) AND id_oplata_rabot IS NULL`, [id, ...pozIds]);

            wsManager.notifyDataChange('oplata_rabot', 'add', id);
            wsManager.notifyDataChange('gryz_poz', 'update', pozIds.join(','));
            send(res, 201, { id });
        } catch (e) {
            console.error('[oplataRabotRoutes.POST_ZAPIS]', e);
            send(res, 400, { error: e.message });
        }
    },

    // ====================================================================
    // PUT /api/oplata/zapisi/:id — обновить поля оплаты
    // (привязка позиций и суммы меняются действием «привязать»)
    // ====================================================================
    async PUT_ZAPIS(req, res, url) {
        try {
            const id = req.url.split('/')[4]; // ✅ T102 fix3: /api/oplata/zapisi/:id
            const d = await parseBody(req);
            const err = validateFields(d);
            if (err) return send(res, 400, { error: err });

            const cur = await db.get('SELECT id FROM oplata_rabot WHERE id = ?', [id]);
            if (!cur) return send(res, 404, { error: 'Оплата не найдена' });

            // ✅ T105: при изменении суммы документа проверяем уже распределённое
            // (лимит — сумма документа БЕЗ НДС)
            const limit = oplLimit(d.summa_k_oplate);
            const agg = await db.get(
                `SELECT COALESCE(SUM(summa), 0) AS t FROM oplata_poz WHERE id_oplata_rabot = ?`, [id]);
            const total = round2(parseFloat(agg ? agg.t : 0));
            if (total > limit + 0.011) {
                return send(res, 400, { error: `Сумма документа (${limit.toFixed(2)} ₽ без НДС) меньше уже распределённой по позициям (${total.toFixed(2)} ₽) — сначала измените распределение` });
            }

            await db.run(
                `UPDATE oplata_rabot
                 SET tip_oplaty = ?, nomer_akta_upd = ?, data_predostavleniya_dok = ?,
                     nomer_schet_faktura = ?, summa_k_oplate = ?, primechanie = ?
                 WHERE id = ?`,
                [
                    d.tip_oplaty,
                    d.nomer_akta_upd || '',
                    d.data_predostavleniya_dok || '',
                    d.nomer_schet_faktura || '',
                    parseFloat(d.summa_k_oplate) || 0,
                    d.primechanie || '',
                    id
                ]);
            wsManager.notifyDataChange('oplata_rabot', 'update', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[oplataRabotRoutes.PUT_ZAPIS]', e);
            send(res, 400, { error: e.message });
        }
    },

    // ====================================================================
    // DELETE /api/oplata/zapisi/:id — удалить оплату, сняв привязку позиций
    // ====================================================================
    async DELETE_ZAPIS(req, res, url) {
        try {
            const id = req.url.split('/')[4]; // ✅ T102 fix3: /api/oplata/zapisi/:id
            const cur = await db.get('SELECT id FROM oplata_rabot WHERE id = ?', [id]);
            if (!cur) return send(res, 404, { error: 'Оплата не найдена' });

            await db.run('DELETE FROM oplata_poz WHERE id_oplata_rabot = ?', [id]);
            await db.run('DELETE FROM oplata_rabot WHERE id = ?', [id]);
            // совместимость: позиции, где эта оплата была «первой», — пересчёт
            await db.run(`UPDATE gryz_poz SET id_oplata_rabot =
                            (SELECT opz.id_oplata_rabot FROM oplata_poz opz
                              WHERE opz.id_gryz_poz = gryz_poz.id ORDER BY opz.id LIMIT 1)
                          WHERE id_oplata_rabot = ?`, [id]);

            wsManager.notifyDataChange('oplata_rabot', 'delete', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[oplataRabotRoutes.DELETE_ZAPIS]', e);
            send(res, 400, { error: e.message });
        }
    },

    // ====================================================================
    // POST /api/oplata/privyazat — привязать отмеченные позиции к оплате
    // и установить/обновить суммы распределения (UPSERT)
    // { id_oper, oplId, pozIds: [...], pozSum: [{id, summa}] | {id: summa} }
    // ====================================================================
    async POST_PRIVYAZAT(req, res) {
        try {
            const d = await parseBody(req);
            if (!d.oplId) return send(res, 400, { error: 'Не выбрана оплата для привязки' });
            const opl = await db.get('SELECT * FROM oplata_rabot WHERE id = ?', [d.oplId]);
            if (!opl) return send(res, 404, { error: 'Оплата не найдена' });

            const sums = parsePozSum(d.pozSum);
            if (!sums || sums.size === 0) {
                return send(res, 400, { error: 'Отметьте грузовые позиции и укажите суммы распределения' });
            }
            const pozIds = Array.from(sums.keys());
            const ph = pozIds.map(() => '?').join(',');
            const ok = await db.all(
                `SELECT id FROM gryz_poz WHERE id_transporta = ? AND id IN (${ph})`,
                [d.id_oper, ...pozIds]);
            if (ok.length !== pozIds.length) {
                return send(res, 400, { error: 'Некоторые позиции не относятся к выбранной транспортной операции' });
            }

            // ✅ T105: лимит документа БЕЗ НДС с учётом уже распределённого
            // по позициям ВНЕ текущего набора
            const limit = oplLimit(opl.summa_k_oplate);
            const aggAll = await db.get(
                `SELECT COALESCE(SUM(summa), 0) AS t FROM oplata_poz WHERE id_oplata_rabot = ?`, [d.oplId]);
            const aggSet = await db.get(
                `SELECT COALESCE(SUM(summa), 0) AS t FROM oplata_poz
                 WHERE id_oplata_rabot = ? AND id_gryz_poz IN (${ph})`, [d.oplId, ...pozIds]);
            const other = round2((aggAll ? aggAll.t : 0) - (aggSet ? aggSet.t : 0));
            const total = round2(other + Array.from(sums.values()).reduce((a, b) => a + b, 0));
            if (total > limit + 0.011) {
                return send(res, 400, { error: `Сумма распределения по документу (${total.toFixed(2)} ₽) превысит сумму платежки (${limit.toFixed(2)} ₽): по другим позициям уже распределено ${other.toFixed(2)} ₽` });
            }

            let cnt = 0;
            for (const [pid, s] of sums) {
                const ex = await db.get(
                    `SELECT id FROM oplata_poz WHERE id_oplata_rabot = ? AND id_gryz_poz = ?`,
                    [d.oplId, pid]);
                if (ex) {
                    await db.run(`UPDATE oplata_poz SET summa = ? WHERE id = ?`, [s, ex.id]);
                    cnt++;
                } else if (s > 0) {
                    // новая связь с нулевой суммой не создаётся — оператор
                    // осознанно оставил поле пустым/нулём
                    await db.run(
                        `INSERT INTO oplata_poz (id, id_oplata_rabot, id_gryz_poz, summa) VALUES (?,?,?,?)`,
                        [generateId('OPZ'), d.oplId, pid, s]);
                    cnt++;
                }
            }
            // совместимость (T102): первая оплата позиции
            await db.run(
                `UPDATE gryz_poz SET id_oplata_rabot = ?
                 WHERE id IN (${ph}) AND id_oplata_rabot IS NULL`, [d.oplId, ...pozIds]);

            wsManager.notifyDataChange('gryz_poz', 'update', pozIds.join(','));
            send(res, 200, { ok: true, count: cnt });
        } catch (e) {
            console.error('[oplataRabotRoutes.POST_PRIVYAZAT]', e);
            send(res, 400, { error: e.message });
        }
    },

    // ====================================================================
    // PUT /api/oplata/zapisi/:id/step — поля шагов работы с платежкой (✅ T106)
    // { patch: { ssylka_doc, ssylka_scan_reestra, data_vneseniya_1s,
    //            email_otpravki, data_email_otpravki } }
    // Шаг 1 «Прикрепить PDF документа» — ssylka_doc;
    // шаг 2 (аванс) — email_otpravki + data_email_otpravki;
    // шаг 2 (окончательный расчёт) — data_vneseniya_1s (занесение акта в 1С);
    // шаг 4 «Скан подписанного реестра» — ssylka_scan_reestra.
    // ====================================================================
    async PUT_STEP(req, res, url) {
        try {
            const id = req.url.split('/')[4]; // /api/oplata/zapisi/:id/step
            const d = await parseBody(req);
            const p = (d && d.patch) || {};
            const ALLOWED = ['ssylka_doc', 'ssylka_scan_reestra', 'data_vneseniya_1s',
                             'email_otpravki', 'data_email_otpravki'];
            const set = [];
            const params = [];
            for (const k of ALLOWED) {
                if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
                let v = p[k];
                if (v === null || v === undefined) v = '';
                v = String(v).trim();
                if ((k === 'ssylka_doc' || k === 'ssylka_scan_reestra') && v &&
                    !/^\/uploads\/oplata\//.test(v)) {
                    return send(res, 400, { error: 'Недопустимый путь файла: ' + v });
                }
                set.push(`${k} = ?`);
                params.push(v);
            }
            if (!set.length) return send(res, 400, { error: 'Нет полей для обновления' });
            const cur = await db.get('SELECT id FROM oplata_rabot WHERE id = ?', [id]);
            if (!cur) return send(res, 404, { error: 'Оплата не найдена' });
            params.push(id);
            await db.run(`UPDATE oplata_rabot SET ${set.join(', ')} WHERE id = ?`, params);
            wsManager.notifyDataChange('oplata_rabot', 'update', id);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[oplataRabotRoutes.PUT_STEP]', e);
            send(res, 400, { error: e.message });
        }
    },

    // ====================================================================
    // POST /api/oplata/upload-file — прикрепить PDF платежки/реестра (✅ T106)
    // Сырая загрузка (как /api/orders/upload-file): ?name=&kind=doc|reestr
    // Файлы: public/uploads/oplata/, только .pdf, лимит 25 МБ.
    // ====================================================================
    async POST_UPLOAD_FILE(req, res, url) {
        try {
            const name = url.searchParams.get('name') || 'file.pdf';
            const kind = url.searchParams.get('kind') === 'reestr' ? 'reestr' : 'doc';
            const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(-120) || 'file.pdf';
            if (!/\.pdf$/i.test(safe)) {
                return send(res, 400, { error: 'Прикрепить можно только файл PDF' });
            }
            const dir = path.join(__dirname, '..', '..', 'public', 'uploads', 'oplata');
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
            send(res, 200, { ok: true, path: '/uploads/oplata/' + encodeURIComponent(fname), name: safe });
        } catch (e) {
            console.error('[oplataRabotRoutes.POST_UPLOAD_FILE]', e);
            send(res, 400, { error: e.message });
        }
    },

    // ====================================================================
    // POST /api/oplata/send-email — шаг 2 (аванс): отправить PDF платежки
    // на почту, указанную оператором в поле «Email» шага 2  { oplId, email }
    // ====================================================================
    async POST_SEND_EMAIL(req, res) {
        try {
            const d = await parseBody(req);
            if (!d.oplId) return send(res, 400, { error: 'Не выбрана оплата' });
            const opl = await db.get('SELECT * FROM oplata_rabot WHERE id = ?', [d.oplId]);
            if (!opl) return send(res, 404, { error: 'Оплата не найдена' });
            if (!opl.ssylka_doc || !String(opl.ssylka_doc).trim()) {
                return send(res, 400, { error: 'Сначала прикрепите PDF платёжного документа (шаг 1)' });
            }
            const { list, invalid } = normalizeAddressList(d.email || '');
            if (invalid.length) return send(res, 400, { error: 'Некорректный адрес: ' + invalid.join(', ') });
            if (!list.length) return send(res, 400, { error: 'Укажите адрес получателя в поле «Email»' });

            const docName = decodeURIComponent(String(opl.ssylka_doc).split('/').pop() || '');
            const docPath = path.join(__dirname, '..', '..', 'public', 'uploads', 'oplata', docName);
            if (!fs.existsSync(docPath)) {
                return send(res, 400, { error: 'Файл документа не найден на сервере: ' + docName });
            }
            const dokNum = [opl.nomer_akta_upd ? ('№ ' + opl.nomer_akta_upd) : '',
                            opl.nomer_schet_faktura ? ('счёт-фактура № ' + opl.nomer_schet_faktura) : '']
                           .filter(Boolean).join(', ');
            const subject = 'Оплата работ — платёжный документ' + (dokNum ? ' ' + dokNum : '');
            const body = [
                'Уважаемые коллеги!',
                '',
                'Направляем во вложении платёжный документ' +
                    (dokNum ? ' (' + dokNum + ')' : '') +
                    ' по предоплате (авансу) за изготовление оснастки.',
                '',
                ...SIGNATURE.split('\n')
            ].join('\n');
            await sendEmail({ to: list.join(','), subject, body, attachments: [docPath] });

            const now = new Date();
            const p2 = n => String(n).padStart(2, '0');
            const dt = `${p2(now.getDate())}.${p2(now.getMonth() + 1)}.${now.getFullYear()} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
            await db.run('UPDATE oplata_rabot SET email_otpravki = ?, data_email_otpravki = ? WHERE id = ?',
                [list.join(';'), dt, d.oplId]);
            wsManager.notifyDataChange('oplata_rabot', 'update', d.oplId);
            send(res, 200, { ok: true, date: dt, email: list.join(';') });
        } catch (e) {
            console.error('[oplataRabotRoutes.POST_SEND_EMAIL]', e);
            send(res, 500, { error: e.message });
        }
    },

    // ====================================================================
    // POST /api/oplata/otvyazat — снять привязку отмеченных позиций
    // { id_oper, pozIds: [...], oplId }   (✅ T104: oplId — привязка
    // снимается для УКАЗАННОЙ платежки; связи других платежек позиции
    // сохраняются)
    // ====================================================================
    async POST_OTVYAZAT(req, res) {
        try {
            const d = await parseBody(req);
            if (!Array.isArray(d.pozIds) || d.pozIds.length === 0) {
                return send(res, 400, { error: 'Отметьте грузовые позиции' });
            }
            if (!d.oplId) {
                return send(res, 400, { error: 'Не выбрана оплата — снимите привязку в контексте конкретной платежки' });
            }
            const ph = d.pozIds.map(() => '?').join(',');
            await db.run(
                `DELETE FROM oplata_poz
                 WHERE id_oplata_rabot = ? AND id_gryz_poz IN (${ph})`,
                [d.oplId, ...d.pozIds]);
            // совместимость: пересчёт «первой» оплаты позиций
            await db.run(`UPDATE gryz_poz SET id_oplata_rabot =
                            (SELECT opz.id_oplata_rabot FROM oplata_poz opz
                              WHERE opz.id_gryz_poz = gryz_poz.id ORDER BY opz.id LIMIT 1)
                          WHERE id IN (${ph}) AND id_oplata_rabot = ?`, [...d.pozIds, d.oplId]);
            wsManager.notifyDataChange('gryz_poz', 'update', d.pozIds.join(','));
            send(res, 200, { ok: true, count: d.pozIds.length });
        } catch (e) {
            console.error('[oplataRabotRoutes.POST_OTVYAZAT]', e);
            send(res, 400, { error: e.message });
        }
    }
});
