// ============================================================
// src/routes/reportRoutes.js
// ОТЧЁТЫ: кнопка «Плоская таблица» (блок «Отчеты» главной страницы)
//   GET /api/reports/flat-table-filters — годы плана + фирмы для фильтров
//   GET /api/reports/flat-table         — выборка + Excel + HTML-предпросмотр
//
// Структура отчёта (согласовано с заказчиком):
//   1 строка = 1 событие (рейс × позиция плана из gryz_poz);
//   УХОД (отправка)    = шаг №1 маршрута (сейчас тип OUT_BL «Отправка заготовки»);
//   ПРИХОД             = ПОСЛЕДНИЙ шаг маршрута (сейчас тип IN_GOOD «Получение
//                        готовой продукции»);
//   промежуточные шаги (полуфабрикаты IN_PF/OUT_PF, ТО IN_TO/OUT_TO,
//   доработка брака OUT_REW) в плоскую таблицу НЕ попадают;
//   количество пишется строго в ОДНОЙ из двух колонок (отправка XOR приход) —
//   контроль двойного учёта: Σ(отправки) = Σ(приходы) = план по завершении;
//   позиция плана без событий → одна строка с пустыми событийными колонками;
//   Трудоёмкости и стоимости — в расчёте НА 1 ДЕТАЛЬ (шт.):
//     • Трудоёмкость ПТО = osnastka.trudoemkost_pto, н/ч на 1 деталь;
//     • Трудоёмкость фирмы = kp.trudoemkost_postavshika, н/ч на 1 деталь;
//     • Стоимость ПТО = трудоёмкость ПТО × plan.cena_pto (ставка ₽/нч) —
//       ₽ за 1 деталь (вычисляемая);
//     • Стоимость фирмы = kp.cena_postavshika — цена фирмы из КП
//       за 1 деталь без НДС;
//   приход отражается по количеству БЕЗ брака (gryz_poz.kolvo_no_br);
//   УПД привязан 1:1 к приходу; авансовый платёж (не у всех фирм) относится
//   к ОТПРАВЛЕННЫМ деталям — строка отправки берёт запись с tip_oplaty='avans',
//   строка прихода — tip_oplaty='okonchatelny_raschet';
//   «Кол-во по УПД» ВСЕГДА равно количеству ПРИХОДА готовой продукции
//   (УПД закрывает приход): в строке прихода — кол-во этого прихода,
//   в строке отправки (аванс) — кол-во прихода позиции (пусто, пока прихода
//   нет); без УПД колонка остаётся пустой (t60).
// ============================================================
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { send } = require('../utils');
const { displayDate } = require('./helpers/dateHelpers');
const { generatePreviewHTML } = require('../excelService');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'public', 'Отчеты');

// ---------- вспомогательные преобразователи ----------
function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

// 'YYYY-MM-DD…' → 'DD.MM.YYYY' БЕЗ сдвига часового пояса (регэксп, не new Date)
function dt(v) {
    if (v === null || v === undefined || v === '') return '';
    const s = String(v).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    return s; // дата уже в другом формате — отдаём как есть
}

// Классификация события маршрута: 'send' | 'recv' | null (промежуточное)
function classifyEvent(ev) {
    const maxn = Number(ev.maxn) || 1;
    const nom = Number(ev.nom_shag) || 1;
    if (maxn > 1) {
        if (nom === 1) return 'send';        // первый шаг  = уход
        if (nom === maxn) return 'recv';     // последний шаг = приход
        return null;                          // промежуточное движение
    }
    // маршрут из одного шага — классифицируем по типу перевозки
    const tip = String(ev.id_tipa_perevozki || '').toUpperCase();
    return tip.startsWith('IN') ? 'recv' : 'send';
}

// Выбор записи оплаты для строки события (аванс — у отправок, окончательный
// расчёт — у приходов; иначе любая запись с номером УПД/акта)
function pickOplata(list, kind) {
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0];
    const want = kind === 'send' ? 'avans' : 'okonchatelny_raschet';
    return list.find(o => String(o.tip_oplaty || '') === want) ||
           list.find(o => o.nomer_akta_upd) ||
           list[0];
}

// Пустые событийные колонки (позиция плана без движения)
const EMPTY_EV = {
    data_otpravki: '', kolvo_otpravki: null,
    data_prihoda: '',  kolvo_prihoda: null,
    upd_nomer: '', upd_data: '', upd_summa: null, upd_kolvo: null
};

module.exports = (db, wsManager) => ({

    // ====================================================================
    // GET /api/reports/flat-table-filters — значения для фильтров страницы
    // ====================================================================
    async GET_FLAT_TABLE_FILTERS(req, res) {
        try {
            const gody = (await db.all(
                'SELECT DISTINCT god FROM plan ORDER BY CAST(god AS INTEGER)'
            )).map(r => r.god);

            // Фирмы-поставщики, встречающиеся среди позиций плана (через выбранное КП)
            const firmy = await db.all(`
                SELECT DISTINCT f.id_firmy, f.naimenovanie
                FROM plan p
                JOIN kp    ON kp.id = p.id_kp
                JOIN firmy f ON f.id_firmy = kp.id_firma
                ORDER BY f.naimenovanie`);

            send(res, 200, { gody, firmy });
        } catch (e) {
            console.error('[reportRoutes.GET_FLAT_TABLE_FILTERS] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ====================================================================
    // GET /api/reports/flat-table?god=&id_firma=
    // Формирование «Плоской таблицы»: выборка БД → Excel → HTML-предпросмотр
    // ====================================================================
    async GET_FLAT_TABLE(req, res, url) {
        try {
            const god = (url.searchParams.get('god') || '').trim();
            const idFirma = (url.searchParams.get('id_firma') || '').trim();

            // ---------- 1. Позиции плана: статические колонки 1–13 ----------
            let posSql = `
                SELECT p.id AS plan_id, p.god, p.plan_god_kolvo, p.cena_pto, p.zak_pto,
                       o.nomer_chertezha, o.naimenovanie, o.trudoemkost_pto,
                       kp.id_firma, f.naimenovanie AS firma_name,
                       kp.trudoemkost_postavshika, kp.cena_postavshika,
                       d.nom_dogovor, zk.n_zaprosa
                FROM plan p
                LEFT JOIN osnastka o   ON o.id  = p.id_osnastka
                LEFT JOIN kp           ON kp.id = p.id_kp
                LEFT JOIN firmy f      ON f.id_firmy = kp.id_firma
                LEFT JOIN dogovor d    ON d.id_dogovor = kp.id_dogovor
                LEFT JOIN zapros_kp zk ON zk.id = COALESCE(kp.id_zaprosa_kp, p.zapros_kp_id)
                WHERE 1 = 1`;
            const posParams = [];
            if (god)     { posSql += ' AND TRIM(p.god) = ?'; posParams.push(god); }
            if (idFirma) { posSql += ' AND kp.id_firma = ?'; posParams.push(idFirma); }
            posSql += ' ORDER BY CAST(p.god AS INTEGER), f.naimenovanie, o.nomer_chertezha, p.id';
            const positions = await db.all(posSql, posParams);

            // «Заказ к договору» — отдельной картой (защита от дублей строк
            // при аномальном повторении позиции в заказах)
            const zdRows = await db.all(`
                SELECT pzd.id_plana, MIN(zd.nomer_zakaza) AS nomer_zakaza
                FROM poz_zakaz_dogovora pzd
                JOIN zakaz_po_dogovoru zd ON zd.id = pzd.id_zakaza_po_dogovoru
                GROUP BY pzd.id_plana`);
            const zdMap = new Map(zdRows.map(r => [r.id_plana, r.nomer_zakaza || '']));

            // ---------- 2. События: отправки/приходы ----------
            let evSql = `
                SELECT pp.id_plana, gp.id AS gp_id, gp.kolvo_no_br, gp.kolvo_yes_br,
                       sm.nom_shag, sm.id_tipa_perevozki, mx.maxn,
                       t.napravlenie, t.otgruzka_data, t.pribytie_data, t.nomer_reisa
                FROM gryz_poz gp
                JOIN plan_perevozok  pp ON pp.id = gp.id_plana
                JOIN shagi_marshruta sm ON sm.id_shag = pp.id_shag
                JOIN transport_oper  t  ON t.id = gp.id_transporta
                JOIN plan p             ON p.id = pp.id_plana
                LEFT JOIN kp            ON kp.id = p.id_kp
                JOIN (SELECT id_det, MAX(nom_shag) AS maxn
                      FROM shagi_marshruta GROUP BY id_det) mx ON mx.id_det = sm.id_det
                WHERE 1 = 1`;
            const evParams = [];
            if (god)     { evSql += ' AND TRIM(p.god) = ?'; evParams.push(god); }
            if (idFirma) { evSql += ' AND kp.id_firma = ?'; evParams.push(idFirma); }
            evSql += ' ORDER BY pp.id_plana';
            const events = await db.all(evSql, evParams);

            // ---------- 3. Оплаты (УПД/акты) ----------
            // ✅ T104: связь М:М — oplata_poz (позиция в нескольких платежках;
            // summa_k_oplate = часть суммы платежки, отнесённая позиции)
            const oplRows = await db.all(`
                SELECT opz.id_gryz_poz AS id_gryz_poz, op.tip_oplaty, op.nomer_akta_upd,
                       op.data_sogl_akta, opz.summa AS summa_k_oplate
                FROM oplata_poz opz
                JOIN oplata_rabot op ON op.id = opz.id_oplata_rabot`);
            const oplMap = new Map();
            for (const o of oplRows) {
                if (!oplMap.has(o.id_gryz_poz)) oplMap.set(o.id_gryz_poz, []);
                oplMap.get(o.id_gryz_poz).push(o);
            }

            // события по позициям (промежуточные шаги отбрасываются)
            const evByPlan = new Map();
            for (const ev of events) {
                const kind = classifyEvent(ev);
                if (!kind) continue;
                if (!evByPlan.has(ev.id_plana)) evByPlan.set(ev.id_plana, []);
                evByPlan.get(ev.id_plana).push({ ...ev, kind });
            }

            // сортировка событий внутри позиции: по дате события, отправка раньше прихода
            const evDate = ev => (ev.kind === 'send' ? dt(ev.otgruzka_data) : dt(ev.pribytie_data));
            for (const list of evByPlan.values()) {
                list.sort((a, b) => {
                    const da = evDate(a), dbb = evDate(b);
                    if (da !== dbb) return da < dbb ? -1 : 1;
                    if (a.kind !== b.kind) return a.kind === 'send' ? -1 : 1;
                    return String(a.gp_id) < String(b.gp_id) ? -1 : 1;
                });
            }

            // ---------- 4. Сборка строк отчёта ----------
            const rows = [];
            for (const p of positions) {
                const trudPto  = num(p.trudoemkost_pto);
                const cenaPto  = num(p.cena_pto);
                const stoimPto = (trudPto !== null && cenaPto !== null) ? round2(trudPto * cenaPto) : null;

                const base = {
                    god: p.god || '',
                    firma: p.firma_name || '',
                    nomer_chertezha: p.nomer_chertezha || '',
                    naimenovanie: p.naimenovanie || '',
                    plan_kolvo: num(p.plan_god_kolvo),
                    trud_pto: trudPto,
                    trud_firma: num(p.trudoemkost_postavshika),
                    stoim_pto: stoimPto,
                    stoim_firma: num(p.cena_postavshika),
                    zak_pto: p.zak_pto || '',
                    nom_dogovor: p.nom_dogovor || '',
                    zakaz_dog: zdMap.get(p.plan_id) || '',
                    n_zaprosa: p.n_zaprosa || ''
                };

                const evList = evByPlan.get(p.plan_id) || [];
                if (!evList.length) {
                    // позиция без событий — одна строка с пустыми событийными колонками
                    rows.push({ ...base, ...EMPTY_EV });
                    continue;
                }

                // Кол-во ПРИХОДА позиции (первый приход по дате) — источник для
                // «Кол-во по УПД» в строке отправки: УПД/аванс закрывает ПРИХОД
                // готовой продукции, а не отправку (баг t60)
                const recvList = evList.filter(e => e.kind === 'recv');
                const prihodKolvo = recvList.length ? num(recvList[0].kolvo_no_br) : null;

                for (const ev of evList) {
                    const opl = pickOplata(oplMap.get(ev.gp_id), ev.kind);
                    const kolvo = num(ev.kolvo_no_br);
                    const isSend = ev.kind === 'send';
                    rows.push({
                        ...base,
                        data_otpravki:  isSend ? dt(ev.otgruzka_data)  : '',
                        kolvo_otpravki: isSend ? kolvo : null,
                        data_prihoda:   !isSend ? dt(ev.pribytie_data) : '',
                        kolvo_prihoda:  !isSend ? kolvo : null,
                        upd_nomer: opl ? (opl.nomer_akta_upd || '') : '',
                        upd_data:  opl ? dt(opl.data_sogl_akta) : '',
                        upd_summa: opl ? num(opl.summa_k_oplate) : null,
                        // Кол-во по УПД: в строке прихода — кол-во этого прихода,
                        // в строке отправки (аванс) — кол-во прихода позиции
                        // (пусто, пока прихода нет); без УПД колонка пустая
                        upd_kolvo: opl ? (isSend ? prihodKolvo : kolvo) : null
                    });
                }
            }

            // ---------- 5. Excel ----------
            const wb = new ExcelJS.Workbook();
            wb.creator = 'Система управления производством';
            wb.created = new Date();
            const ws = wb.addWorksheet('Плоская таблица', {
                views: [{ state: 'frozen', ySplit: 1 }]
            });

            // Шапка: у трудоёмкостей/стоимостей уточнено «что это за штуки» —
            // все четыре показателя считаются НА 1 ДЕТАЛЬ (t60);
            // «Кол-во по УПД» явно приравнено к кол-ву прихода готовой продукции
            const HEADERS = [
                'Год плана', 'Фирма', '№ чертежа', 'Наименование', 'Кол-во по плану',
                'Трудоёмкость ПТО, н/ч\n(на 1 деталь)', 'Трудоёмкость фирмы, н/ч\n(на 1 деталь)',
                'Стоимость ПТО, ₽\n(на 1 деталь = трудоёмкость × ставка)', 'Стоимость фирмы, ₽\n(на 1 деталь, без НДС, из КП)',
                'Заказ ПТО', '№ договора', 'Заказ к договору', '№ запроса КП',
                'Дата отправки', 'Кол-во отправки',
                'Дата прихода готовой продукции', 'Кол-во прихода готовой продукции',
                '№ УПД/акта на оплату', 'Дата УПД/АКТА', 'Сумма по УПД/АКТУ, ₽', 'Кол-во по УПД\n(= кол-ву прихода)'
            ];
            const COLS = HEADERS.length; // 21

            const thin = { style: 'thin', color: { argb: 'FFB0B0B0' } };
            const border = { top: thin, left: thin, bottom: thin, right: thin };

            const hRow = ws.getRow(1);
            hRow.values = HEADERS;
            hRow.height = 48;
            hRow.eachCell(c => {
                c.font = { bold: true, size: 10 };
                c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
                c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                c.border = border;
            });
            ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLS } };

            const WIDTHS = [9, 24, 17, 32, 11, 12, 12, 12, 12, 18, 11, 14, 10,
                            12, 11, 14, 14, 17, 12, 14, 10];
            WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

            const NUM_FMT_QTY   = '#,##0.##';   // количества
            const NUM_FMT_HOURS = '0.###';      // трудоёмкости
            const NUM_FMT_MONEY = '#,##0.00';   // стоимости/суммы
            const COL_QTY  = [5, 15, 17, 21];
            const COL_HRS  = [6, 7];
            const COL_MONEY = [8, 9, 20];

            rows.forEach((r, idx) => {
                const row = ws.getRow(idx + 2);
                row.values = [
                    r.god, r.firma, r.nomer_chertezha, r.naimenovanie, r.plan_kolvo,
                    r.trud_pto, r.trud_firma, r.stoim_pto, r.stoim_firma,
                    r.zak_pto, r.nom_dogovor, r.zakaz_dog, r.n_zaprosa,
                    r.data_otpravki, r.kolvo_otpravki,
                    r.data_prihoda, r.kolvo_prihoda,
                    r.upd_nomer, r.upd_data, r.upd_summa, r.upd_kolvo
                ];
                row.eachCell({ includeEmpty: false }, (c, col) => {
                    c.font = { size: 10 };
                    c.border = border;
                    if (COL_QTY.includes(col))   c.numFmt = NUM_FMT_QTY;
                    if (COL_HRS.includes(col))   c.numFmt = NUM_FMT_HOURS;
                    if (COL_MONEY.includes(col)) c.numFmt = NUM_FMT_MONEY;
                    if (col === 1) c.alignment = { horizontal: 'center' };
                });
            });

            if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
            const parts = [];
            if (god) parts.push(`${god} год`);
            parts.push(`от ${displayDate()}`);
            const fileName = `Плоская таблица (${parts.join(', ')}).xlsx`;
            const filePath = path.join(OUTPUT_DIR, fileName);
            await wb.xlsx.writeFile(filePath);

            const preview = await generatePreviewHTML(filePath);

            send(res, 200, {
                path: '/Отчеты/' + encodeURIComponent(fileName),
                fileName,
                rowCount: rows.length,
                filters: { god, id_firma: idFirma },
                preview
            });
        } catch (e) {
            console.error('[reportRoutes.GET_FLAT_TABLE] Error:', e.message);
            console.error(e.stack);
            send(res, 500, { error: e.message });
        }
    }
});
