// ============================================================
// СЕРВИС РАБОТЫ С EXCEL (исправленный)
// ============================================================
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { displayDate } = require('./routes/helpers/dateHelpers'); 
const createMergeUtils = require('./excelMergeUtils');
const createMonthColsUtils = require('./excelMonthCols');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'Заявки');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });


/**
 * Экспорт заказа в Excel
 * @param {Object} params
 * @param {Object} params.zakaz - запись из zakaz_po_dogovoru
 * @param {Object} params.dogovor - запись из dogovor
 * @param {Object} params.firma - запись из firmy
 * @param {Array} params.positions - массив позиций заказа (с JOIN-полями)
 * @param {number} params.baseYear - базовый год (например, 2026)
 * @param {string} [params.vidRabotName] - вид работ по договору (строка 16, T22b)
 */
async function exportZakazToExcel({ zakaz, dogovor, firma, positions, baseYear, vidRabotName }) {
    const templatePath = path.join(TEMPLATES_DIR, 'шаблон заказа.xlsx');
    if (!fs.existsSync(templatePath)) {
        throw new Error(`Шаблон не найден: ${templatePath}`);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    const ws = workbook.worksheets[0];
    if (!ws) throw new Error('В шаблоне нет листов');

    // ============================================================
    // КОНСТАНТЫ ШАБЛОНА
    // ============================================================
    const FIRST_DATA_ROW = 17; // T22: шаблон обновлён — позиции с 17-й строки
    const TEMPLATE_ROWS = 1;
    const COL_NPP = 1, COL_NOMER = 2, COL_NAIM = 4, COL_ED_IZM = 5;
    const COL_CENA = 6, COL_KOLVO = 7, COL_SUMMA = 8;
    const LAST_DATA_COL = COL_SUMMA;
    const MONTH_COL_START = 9;
    const MONTH_COUNT = 24;
    const LAST_COL = MONTH_COL_START + MONTH_COUNT - 1; // 32

    // Подключаем утилиты
    const mu = createMergeUtils(ws);
    const mc = createMonthColsUtils(ws);

    // ============================================================
    // 1. ЗАПОЛНЕНИЕ ШАПКИ
    // ============================================================
    ws.getCell(2, 3).value = zakaz.nomer_zakaza || '';
    ws.getCell(4, 3).value = `${dogovor.nom_dogovor || ''} от ${displayDate(dogovor.data_dogovor || '')}`;
    ws.getCell(6, 3).value = firma.naimenovanie || '';
    ws.getCell(8, 3).value = 'АО «АВТОВАЗ»';
    // T22/T22b: строка 16 — «Вид работ» — значение ИЗ БАЗЫ
    // (договор -> справочник «Вид работ», sprav_uslov.soderzhanie).
    // При пустом значении остаётся текст шаблона.
    if (vidRabotName) ws.getCell(16, 1).value = vidRabotName;
    ws.getCell(10, 3).value = displayDate(zakaz.data_zakaza || '');

    // ============================================================
    // 2. ДОБАВЛЕНИЕ СТРОК (через модуль merges)
    // ============================================================
    const rowsToAdd = Math.max(0, positions.length - TEMPLATE_ROWS);
    const dataEndRow = FIRST_DATA_ROW + Math.max(positions.length, TEMPLATE_ROWS) - 1;

    mu.withTemplateRows({
        templateRowStart: FIRST_DATA_ROW,
        templateRowEnd: FIRST_DATA_ROW + TEMPLATE_ROWS - 1,
        dataEndRow: dataEndRow,
        lastCol: LAST_COL,
        spliceFn: ({ templateMerges, templateRow }) => {
            if (rowsToAdd <= 0) return;

            const insertAfterRow = FIRST_DATA_ROW + TEMPLATE_ROWS - 1;
            for (let i = 0; i < rowsToAdd; i++) {
                const currentNewRowNum = insertAfterRow + 1 + i;
                ws.spliceRows(currentNewRowNum, 0, []);

                const newRow = ws.getRow(currentNewRowNum);
                const srcRow = ws.getRow(templateRow);
                if (srcRow.height) newRow.height = srcRow.height;

                for (let col = 1; col <= LAST_COL; col++) {
                    const srcCell = srcRow.getCell(col);
                    const newCell = newRow.getCell(col);

                    if (srcCell.value !== undefined && srcCell.value !== null) {
                        const isPartOfMerge = templateMerges.some(m =>
                            col >= m.left && col <= m.right && col !== m.left
                        );
                        if (!isPartOfMerge) newCell.value = srcCell.value;
                    }

                    if (srcCell.style) newCell.style = JSON.parse(JSON.stringify(srcCell.style));
                    if (srcCell.numFmt) newCell.numFmt = srcCell.numFmt;
                    if (srcCell.alignment) newCell.alignment = { ...srcCell.alignment };
                    if (srcCell.font) newCell.font = { ...srcCell.font };
                    if (srcCell.fill) newCell.fill = { ...srcCell.fill };
                    if (srcCell.border) newCell.border = JSON.parse(JSON.stringify(srcCell.border));
                }
            }
        }
    });

    // ============================================================
    // 3. ЗАПОЛНЕНИЕ ДАННЫХ ПО ПОЗИЦИЯМ
    // ============================================================
    let totalSumma = 0;
    const rowsMonthData = []; // собираем месяцы для каждой строки

    for (let idx = 0; idx < positions.length; idx++) {
        const pos = positions[idx];
        const row = FIRST_DATA_ROW + idx;

        const grafiks = Array.isArray(pos.grafiks) ? pos.grafiks : [];
        const monthData = new Array(MONTH_COUNT).fill(0);
        grafiks.forEach(g => {
            const m = parseInt(g.etap_nomer);
            if (m >= 1 && m <= MONTH_COUNT) {
                monthData[m - 1] += parseFloat(String(g.plan_kolvo).replace(',', '.')) || 0;
            }
        });
        rowsMonthData.push(monthData);

        const kolvo = parseFloat(String(pos.plan_god_kolvo).replace(',', '.')) || 0;
        const cena = parseFloat(String(pos.cena_postavshika).replace(',', '.')) || 0;
        const summa = kolvo * cena;
        totalSumma += summa;

        ws.getCell(row, COL_NPP).value = idx + 1;
        ws.getCell(row, COL_NOMER).value = `${pos.nomer_chertezha || ''} / ${pos.zak_pto || ''}`;;
        ws.getCell(row, COL_NOMER).numFmt = '@';
        ws.getCell(row, COL_NAIM).value = pos.osn_naimenovanie || '';
        ws.getCell(row, COL_NAIM).alignment = { wrapText: true, vertical: 'middle' };
        ws.getCell(row, COL_ED_IZM).value = 'шт.';
        ws.getCell(row, COL_ED_IZM).alignment = { horizontal: 'center', vertical: 'middle' };
        ws.getCell(row, COL_CENA).value = cena;
        ws.getCell(row, COL_CENA).numFmt = '#,##0.00';
        ws.getCell(row, COL_CENA).alignment = { horizontal: 'right', vertical: 'middle' };
        ws.getCell(row, COL_KOLVO).value = kolvo;
        ws.getCell(row, COL_KOLVO).numFmt = '#,##0';
        ws.getCell(row, COL_KOLVO).alignment = { horizontal: 'center', vertical: 'middle' };
        ws.getCell(row, COL_SUMMA).value = summa;
        ws.getCell(row, COL_SUMMA).numFmt = '#,##0.00';
        ws.getCell(row, COL_SUMMA).alignment = { horizontal: 'right', vertical: 'middle' };
    }

    // ============================================================
    // 3-Б. ВИДИМЫЕ МЕСЯЦЫ + ЗАПИСЬ ЗНАЧЕНИЙ + СКРЫТИЕ ПУСТЫХ КОЛОНОК
    // ============================================================
    // Используем модуль excelMonthCols — та же логика, что и в exportZaprosKP:
    // если во ВСЕХ строках данных значение месяца = 0 или null, колонка
    // скрывается. В видимых колонках пишем значение (в т.ч. 0), в скрытых — null.
    const visibleMonths = mc.getVisibleMonths(rowsMonthData);
    positions.forEach((pos, idx) => {
        const row = FIRST_DATA_ROW + idx;
        mc.writeMonthValues(row, MONTH_COL_START, rowsMonthData[idx], visibleMonths, {
            numFmt: '#,##0',
            alignment: { horizontal: 'center', vertical: 'middle' }
        });
    });
    mc.hideEmptyColumns(MONTH_COL_START, MONTH_COUNT, visibleMonths);

    // ============================================================
    // 4. ИТОГОВЫЕ СТРОКИ
    // ============================================================
    const totalRow = FIRST_DATA_ROW + positions.length;
    const hdcStr = String(dogovor.hdc || '20').replace('%', '').replace(',', '.').trim();
    const ndsRate = (parseFloat(hdcStr) || 20) / 100;
    const ndsSumma = totalSumma * ndsRate;
    const totalWithNds = totalSumma + ndsSumma;

    ws.getCell(totalRow, LAST_DATA_COL).value = totalSumma;
    ws.getCell(totalRow, LAST_DATA_COL).numFmt = '#,##0.00';
    ws.getCell(totalRow, LAST_DATA_COL).font = { bold: true };

    const ndsRow = totalRow + 1;
    ws.getCell(ndsRow, 2).value = parseFloat(hdcStr);
    ws.getCell(ndsRow, 3).value = '%';
    ws.getCell(ndsRow, LAST_DATA_COL).value = ndsSumma;
    ws.getCell(ndsRow, LAST_DATA_COL).numFmt = '#,##0.00';
    ws.getCell(ndsRow, LAST_DATA_COL).font = { bold: true };

    const totalWithNdsRow = ndsRow + 1;
    ws.getCell(totalWithNdsRow, 1).value = 'Всего с НДС:';
    ws.getCell(totalWithNdsRow, 1).font = { bold: true };
    ws.getCell(totalWithNdsRow, LAST_DATA_COL).value = totalWithNds;
    ws.getCell(totalWithNdsRow, LAST_DATA_COL).numFmt = '#,##0.00';
    ws.getCell(totalWithNdsRow, LAST_DATA_COL).font = { bold: true };

    // ============================================================
    // 5. ПОДВАЛ
    // ============================================================
    const signNameRow = totalWithNdsRow + 6;
    ws.getCell(signNameRow, 1).value = firma.naimenovanie || '';
    ws.getCell(signNameRow, 1).font = { bold: true };
    ws.getCell(signNameRow, 7).value = 'АО «АВТОВАЗ»';
    ws.getCell(signNameRow, 7).font = { bold: true };

    // ============================================================
    // 6. СОХРАНЕНИЕ
    // ============================================================
    const yearFolder = path.join(OUTPUT_DIR, String(baseYear));
    if (!fs.existsSync(yearFolder)) fs.mkdirSync(yearFolder, { recursive: true });

    const firmFolder = sanitizeFolderName(firma.naimenovanie);
    const firmPath = path.join(yearFolder, firmFolder);
    if (!fs.existsSync(firmPath)) fs.mkdirSync(firmPath, { recursive: true });

    const fileName = `Заказ № ${zakaz.nomer_zakaza}.xlsx`;
    const fullPath = path.join(firmPath, fileName);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);

    await workbook.xlsx.writeFile(fullPath);

    return {
        path: fullPath,
        // T22: файл сохраняется в public/Заявки/... — URL должен совпадать
        // (было /Заказы/... -> статика отдавала 404 Not Found)
        relativePath: `/Заявки/${baseYear}/${encodeURIComponent(firmFolder)}/${encodeURIComponent(fileName)}`,
        fileName
    };
}




function sanitizeFolderName(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Unknown';
}



// ============================================================
// ЭКСПОРТ ЗАПРОСА КП (без правок подвала и без "выдуманных" количеств)
// ============================================================
async function exportZaprosKP({ planIds, zaprosKPNumber, baseYear, zaprosDate }) {
    const templatePath = path.join(TEMPLATES_DIR, 'шаблон заявки.xlsx');
    if (!fs.existsSync(templatePath)) throw new Error(`Шаблон не найден: ${templatePath}`);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    const ws = workbook.worksheets[0];
    if (!ws) throw new Error('В шаблоне нет листов');

    const FIRST_DATA_ROW = 6;
    const MONTH_COL_START = 7;
    const MONTH_COUNT = 24;
    const LAST_COL = MONTH_COL_START + MONTH_COUNT - 1; // 30
    const TEMPLATE_ROWS = 2;

    // Подключаем утилиты
    const mu = createMergeUtils(ws);
    const mc = createMonthColsUtils(ws);

    const Database = require('./Database');
    const db = new Database('firmy.db');
    await db.connect();
    try {
        const plans = [];
        for (const planId of planIds) {
            const plan = await db.get('SELECT * FROM plan WHERE id = ?', [planId]);
            if (!plan) continue;
            const osn = await db.get('SELECT * FROM osnastka WHERE id = ?', [plan.id_osnastka]);
            const grafiks = await db.all('SELECT * FROM grafik WHERE id_plana = ?', [planId]);
            plans.push({ plan, osn, grafiks });
        }
        if (plans.length === 0) throw new Error('Нет данных для экспорта');

        // === ШАПКА ===
        ws.getCell(1, 1).value = `ЗАПРОС КП № ${zaprosKPNumber} от ${displayDate(zaprosDate)}`;
        ws.getCell(4, 7).value = baseYear;
        ws.getCell(4, 19).value = baseYear + 1;

        // === ДОБАВЛЕНИЕ СТРОК + ОБЪЕДИНЕНИЯ (через модуль) ===
        const rowsToAdd = Math.max(0, plans.length - TEMPLATE_ROWS);
        const dataEndRow = FIRST_DATA_ROW + Math.max(plans.length, TEMPLATE_ROWS) - 1;

        mu.withTemplateRows({
            templateRowStart: FIRST_DATA_ROW,
            templateRowEnd: FIRST_DATA_ROW + TEMPLATE_ROWS - 1,
            dataEndRow: dataEndRow,
            lastCol: LAST_COL,
            spliceFn: ({ templateMerges, templateRow }) => {
                if (rowsToAdd <= 0) return;

                const insertAfterRow = FIRST_DATA_ROW + TEMPLATE_ROWS - 1;
                for (let i = 0; i < rowsToAdd; i++) {
                    const currentNewRowNum = insertAfterRow + 1 + i;
                    ws.spliceRows(currentNewRowNum, 0, []);

                    const newRow = ws.getRow(currentNewRowNum);
                    const srcRow = ws.getRow(templateRow);
                    if (srcRow.height) newRow.height = srcRow.height;

                    for (let col = 1; col <= LAST_COL; col++) {
                        const srcCell = srcRow.getCell(col);
                        const newCell = newRow.getCell(col);

                        if (srcCell.value !== undefined && srcCell.value !== null) {
                            const isPartOfMerge = templateMerges.some(m =>
                                col >= m.left && col <= m.right && col !== m.left
                            );
                            if (!isPartOfMerge) newCell.value = srcCell.value;
                        }

                        if (srcCell.style) newCell.style = JSON.parse(JSON.stringify(srcCell.style));
                        if (srcCell.border) newCell.border = JSON.parse(JSON.stringify(srcCell.border));
                        if (srcCell.numFmt) newCell.numFmt = srcCell.numFmt;
                        if (srcCell.alignment) newCell.alignment = { ...srcCell.alignment };
                        if (srcCell.font) newCell.font = { ...srcCell.font };
                        if (srcCell.fill) newCell.fill = { ...srcCell.fill };
                    }
                }
            }
        });

        // === ЗАПОЛНЕНИЕ ДАННЫХ ===
        const rowsMonthData = [];
        plans.forEach((item, idx) => {
            const row = FIRST_DATA_ROW + idx;
            const { plan, osn, grafiks } = item;
            ws.getCell(row, 1).value = idx + 1;
            ws.getCell(row, 2).value = osn?.nomer_chertezha || '';
            ws.getCell(row, 2).numFmt = '@';
            ws.getCell(row, 3).value = osn?.naimenovanie || '';
            ws.getCell(row, 4).value = `${osn?.dlina || ''}x${osn?.shirina || ''}x${osn?.vysota || ''}`;
            // t65: колонка «Марка/вес» — марка материала из таблицы оснастки перед весом
            const markaMat65 = String(osn?.marka_materiala ?? '').trim();
            const vesRaw65 = osn?.ves_det;
            const vesNum65 = vesRaw65 ? parseFloat(String(vesRaw65).replace(',', '.')) : NaN;
            const vesDet65 = !isNaN(vesNum65)
                ? String(vesNum65).replace('.', ',')
                : (vesRaw65 ? String(vesRaw65).trim().replace('.', ',') : '');
            ws.getCell(row, 5).value = [markaMat65, vesDet65].filter(Boolean).join(' / ');
            ws.getCell(row, 5).numFmt = '@';
            ws.getCell(row, 6).value = parseFloat(String(plan.plan_god_kolvo).replace(',', '.')) || 0;

            const monthData = new Array(MONTH_COUNT).fill(0);
            grafiks.forEach(g => {
                const m = parseInt(g.etap_nomer);
                if (m >= 1 && m <= MONTH_COUNT) {
                    monthData[m - 1] += parseFloat(String(g.plan_kolvo).replace(',', '.')) || 0;
                }
            });
            rowsMonthData.push(monthData);
        });

        // === ВИДИМЫЕ МЕСЯЦЫ + ЗАПИСЬ ЗНАЧЕНИЙ + СКРЫТИЕ ПУСТЫХ КОЛОНОК ===
        // Используем модуль excelMonthCols — единая логика для обеих функций.
        const visibleMonths = mc.getVisibleMonths(rowsMonthData);
        plans.forEach((item, idx) => {
            const row = FIRST_DATA_ROW + idx;
            mc.writeMonthValues(row, MONTH_COL_START, rowsMonthData[idx], visibleMonths, {
                numFmt: '#,##0',
                alignment: { horizontal: 'center', vertical: 'middle' }
            });
        });
        mc.hideEmptyColumns(MONTH_COL_START, MONTH_COUNT, visibleMonths);

        // ✅ ПОДВАЛ НЕ ТРОГАЕМ — остаётся как в шаблоне
        // ✅ РАМКИ НЕ РИСУЕМ — остаются как в шаблоне

        // === СОХРАНЕНИЕ ===
        const yearFolder = path.join(OUTPUT_DIR, String(baseYear));
        if (!fs.existsSync(yearFolder)) fs.mkdirSync(yearFolder, { recursive: true });
        const fileName = `Заявка № ${zaprosKPNumber}.xlsx`;
        const fullPath = path.join(yearFolder, fileName);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        await workbook.xlsx.writeFile(fullPath);
        return { path: fullPath, relativePath: `/Заявки/${baseYear}/${fileName}`, fileName };
    } finally {
        await db.close();
    }
}

/**
* Создание обменной формы (ОБНОВЛЁННАЯ ВЕРСИЯ с детализацией по видам работ)
*
* Логика:
* - Для каждой детали создаётся N строк (по числу видов работ из vidy_rabot_dogovor)
* - Колонка 1 (наименование детали) объединяется на N строк
* - Формулы в колонках 10, 11, 12 — в ПЕРВОЙ строке объединения (Excel показывает только её)
* - Колонки 4-7 заполняются только в первой строке, остальные — пустые (объединены)
* ✅ ИСПРАВЛЕНО: фильтр по id_firma в SQL-запросах договора и НДС
*/
async function createEquipmentTable({ equipmentList, tableName, zaprosId, firmaName, id_firma }) {
    if (!id_firma) {
        throw new Error('[createEquipmentTable] Не передан id_firma — невозможно построить форму для конкретной фирмы');
    }

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('обменная форма');

    const Database = require('./Database');
    const db = new Database('firmy.db');
    await db.connect();

    try {
        const zapros = await db.get('SELECT n_zaprosa, data_form FROM zapros_kp WHERE id = ?', [zaprosId]);
        const zaprosDisplay = zapros ? `${zapros.n_zaprosa} от ${displayDate(zapros.data_form)}` : '';

        let dogovorInfo = 'ХХХХХХХ от ДД.ММ.ГГГГ';
        let hdcValue = 22;

        if (zaprosId) {
            // ✅ ИСПРАВЛЕНИЕ: фильтр по id_firma
            const kpDogovor = await db.get(
                'SELECT k.id_dogovor FROM kp k ' +
                'WHERE k.id_zaprosa_kp = ? AND k.id_firma = ? ' +
                'AND k.id_dogovor IS NOT NULL AND k.id_dogovor != \'\' ' +
                'LIMIT 1',
                [zaprosId, id_firma]
            );

            if (kpDogovor && kpDogovor.id_dogovor) {
                const dogovor = await db.get(
                    'SELECT nom_dogovor, data_dogovor, hdc FROM dogovor WHERE id_dogovor = ?',
                    [kpDogovor.id_dogovor]
                );
                if (dogovor) {
                    dogovorInfo = `${dogovor.nom_dogovor || 'ХХХХХХХ'} от ${displayDate(dogovor.data_dogovor) || 'ДД.ММ.ГГГГ'}`;
                    if (dogovor.hdc) {
                        const hdcStr = String(dogovor.hdc).replace('%', '').replace(',', '.').trim();
                        const parsed = parseFloat(hdcStr);
                        if (!isNaN(parsed)) hdcValue = parsed;
                    }
                }
            } else {
                console.warn(`[createEquipmentTable] Для фирмы ${id_firma} в запросе ${zaprosId} не найден договор (НДС = ${hdcValue} по умолчанию)`);
            }
        }

        const hdcPercent = hdcValue;
        const hdcRate = hdcPercent / 100;

        // === ШАПКА (без изменений) ===
        ws.mergeCells('A1:L1');
        const titleCell = ws.getCell('A1');
        titleCell.value = tableName;
        titleCell.font = { bold: true, size: 16 };
        titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
        titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F0F9' } };
        ws.getRow(1).height = 30;

        ws.mergeCells('A2:L2');
        const infoCell = ws.getCell('A2');
        const zaprosInfo = zaprosDisplay ? `на запрос АВТОВАЗ №${zaprosDisplay}` : '';
        const firmaInfo = firmaName || '';
        infoCell.value = `Приложение расчета к  ТКП: ${firmaInfo} ${zaprosInfo} к договору № ${dogovorInfo}`.trim();
        infoCell.font = { bold: true, size: 12 };
        infoCell.alignment = { horizontal: 'left', vertical: 'middle' };
        ws.getRow(2).height = 25;

        // === ЗАГОЛОВКИ (без изменений) ===
        const headers = [
            'Номенклатурный номер\nнаименование детали',
            'Наименование\nработ (согласно договора)',
            'Кол-во\nпо заявке,\nшт',
            'Тип изготовления',
            'Срок\nизготовления в\nнеделях (с\nмомента поставки)',
            'Возможности\nизготовления,\nшт',
            'Трудоемкость\nна операцию,\nн/ч',
            'Стоимость \n1 н/ч без НДС \n(согласно\nдоговора), руб.',
            'Цена\nоперации, руб',
            'Трудоемкость\nна деталь,\nн/ч',
            'Цена за единицу\nбез НДС,\nруб.',
            'Стоимость\nработ без НДС,\nруб.'
        ];
        const headerRow = ws.getRow(3);
        headers.forEach((h, i) => {
            const cell = headerRow.getCell(i + 1);
            cell.value = h;
            cell.font = { bold: true, size: 10 };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8C8C8' } };
            cell.border = {
                top: { style: 'thin' }, left: { style: 'thin' },
                bottom: { style: 'thin' }, right: { style: 'thin' }
            };
        });
        headerRow.height = 80;

        ws.getColumn(1).width = 25;  ws.getColumn(2).width = 25;
        ws.getColumn(3).width = 10;  ws.getColumn(4).width = 25;
        ws.getColumn(5).width = 15;  ws.getColumn(6).width = 15;
        ws.getColumn(7).width = 15;  ws.getColumn(8).width = 15;
        ws.getColumn(9).width = 15;  ws.getColumn(10).width = 15;
        ws.getColumn(11).width = 15; ws.getColumn(12).width = 15;
        ws.getColumn(1).numFmt = '@';
        ws.getColumn(2).numFmt = '@';

        // === ДАННЫЕ ПО ДЕТАЛЯМ ===
        let currentRow = 4;
        for (const equip of equipmentList) {
            const plan = await db.get(
                'SELECT p.*, o.nomer_chertezha, o.naimenovanie as osn_name ' +
                'FROM plan p LEFT JOIN osnastka o ON p.id_osnastka = o.id ' +
                'WHERE p.id = ?',
                [equip.id_plana || equip.id]
            );
            if (!plan) continue;

            // ✅ КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: фильтр по id_firma
            const kpRecord = await db.get(
                'SELECT id_dogovor FROM kp ' +
                'WHERE id_plana = ? AND id_zaprosa_kp = ? AND id_firma = ?',
                [plan.id, zaprosId, id_firma]
            );

            if (!kpRecord || !kpRecord.id_dogovor) {
                console.warn(`[createEquipmentTable] Нет договора для детали ${plan.id} и фирмы ${id_firma} — пропускаем`);
                continue;
            }

            const workTypes = await db.all(
                'SELECT naimenovanie, stoimost FROM vidy_rabot_dogovor WHERE id_dogovor = ? ORDER BY naimenovanie',
                [kpRecord.id_dogovor]
            );
            if (workTypes.length === 0) {
                console.warn(`[createEquipmentTable] Нет видов работ для договора ${kpRecord.id_dogovor}`);
                continue;
            }

            const detailName = `${plan.nomer_chertezha || ''} -- ${plan.osn_name || ''}`.trim();
            const startRow = currentRow;
            const endRow = currentRow + workTypes.length - 1;

            for (let workIndex = 0; workIndex < workTypes.length; workIndex++) {
                const work = workTypes[workIndex];
                const rowNum = currentRow + workIndex;
                const row = ws.getRow(rowNum);

                if (workIndex === 0) {
                    const cell1 = row.getCell(1);
                    cell1.value = detailName;
                    cell1.alignment = { wrapText: true, vertical: 'middle' };
                    cell1.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    if (workTypes.length > 1) ws.mergeCells(`A${rowNum}:A${endRow}`);
                }

                const cell2 = row.getCell(2);
                cell2.value = work.naimenovanie;
                cell2.alignment = { wrapText: true, vertical: 'middle' };
                cell2.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

                if (workIndex === 0) {
                    const cell3 = row.getCell(3);
                    cell3.value = parseFloat(String(plan.plan_god_kolvo).replace(',', '.')) || 0;
                    cell3.alignment = { horizontal: 'center', vertical: 'middle' };
                    cell3.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    if (workTypes.length > 1) ws.mergeCells(`C${rowNum}:C${endRow}`);
                }
                if (workIndex === 0) {
                    const cell4 = row.getCell(4);
                    cell4.value = equip.tip_izgotovleniya || plan.tip_izgotovleniya || '';
                    cell4.alignment = { wrapText: true, vertical: 'middle' };
                    cell4.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    if (workTypes.length > 1) ws.mergeCells(`D${rowNum}:D${endRow}`);
                }
                if (workIndex === 0) {
                    const cell5 = row.getCell(5);
                    cell5.value = equip.srok_vipolneniya || plan.srok_vipolneniya || '';
                    cell5.alignment = { horizontal: 'center', vertical: 'middle' };
                    cell5.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    if (workTypes.length > 1) ws.mergeCells(`E${rowNum}:E${endRow}`);
                }
                if (workIndex === 0) {
                    const cell6 = row.getCell(6);
                    cell6.value = equip.moshchnost_kolvo || plan.moshchnost_kolvo || 0;
                    cell6.alignment = { horizontal: 'center', vertical: 'middle' };
                    cell6.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    if (workTypes.length > 1) ws.mergeCells(`F${rowNum}:F${endRow}`);
                }

                const cell7 = row.getCell(7);
                cell7.value = equip.trudoemkost || equip.trudoemkost_postavshika || 0;
                cell7.alignment = { horizontal: 'center', vertical: 'middle' };
                cell7.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

                const cell8 = row.getCell(8);
                cell8.value = work.stoimost || 0;
                cell8.numFmt = '#,##0.00';
                cell8.alignment = { horizontal: 'right', vertical: 'middle' };
                cell8.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

                const cell9 = row.getCell(9);
                cell9.value = { formula: `G${rowNum}*H${rowNum}` };
                cell9.numFmt = '#,##0.00';
                cell9.alignment = { horizontal: 'right', vertical: 'middle' };
                cell9.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

                if (workIndex === 0) {
                    const cell10 = row.getCell(10);
                    cell10.value = { formula: `SUM(G${startRow}:G${endRow})` };
                    cell10.numFmt = '#,##0.0';
                    cell10.alignment = { horizontal: 'center', vertical: 'middle' };
                    cell10.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    if (workTypes.length > 1) ws.mergeCells(`J${rowNum}:J${endRow}`);

                    const cell11 = row.getCell(11);
                    cell11.value = { formula: `SUM(I${startRow}:I${endRow})` };
                    cell11.numFmt = '#,##0.00';
                    cell11.alignment = { horizontal: 'right', vertical: 'middle' };
                    cell11.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    if (workTypes.length > 1) ws.mergeCells(`K${rowNum}:K${endRow}`);

                    const cell12 = row.getCell(12);
                    cell12.value = { formula: `K${startRow}*F${startRow}` };
                    cell12.numFmt = '#,##0.00';
                    cell12.alignment = { horizontal: 'right', vertical: 'middle' };
                    cell12.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    if (workTypes.length > 1) ws.mergeCells(`L${rowNum}:L${endRow}`);
                }
                row.height = 30;
            }
            currentRow += workTypes.length;
        }

        // === ИТОГИ (без изменений) ===
        const lastDataRow = currentRow;
        const fullBorder = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

        ws.mergeCells(`A${lastDataRow}:K${lastDataRow}`);
        for (let c = 1; c <= 11; c++) ws.getCell(lastDataRow, c).border = fullBorder;
        ws.getCell(lastDataRow, 12).border = fullBorder;

        const totalCell = ws.getCell(`A${lastDataRow}`);
        totalCell.value = 'Итого без НДС';
        totalCell.font = { bold: true };
        totalCell.alignment = { horizontal: 'right', vertical: 'middle' };

        const totalValueCell = ws.getCell(`L${lastDataRow}`);
        totalValueCell.value = { formula: `SUM(L4:L${lastDataRow - 1})` };
        totalValueCell.numFmt = '#,##0.00';
        totalValueCell.font = { bold: true };
        totalValueCell.alignment = { horizontal: 'right', vertical: 'middle' };
        ws.getRow(lastDataRow).height = 25;

        const vatRow = lastDataRow + 1;
        ws.mergeCells(`A${vatRow}:J${vatRow}`);
        for (let c = 1; c <= 10; c++) ws.getCell(vatRow, c).border = fullBorder;
        ws.getCell(vatRow, 11).border = fullBorder;
        ws.getCell(vatRow, 12).border = fullBorder;

        ws.getCell(`A${vatRow}`).value = 'НДС';
        ws.getCell(`A${vatRow}`).font = { bold: true };
        ws.getCell(`A${vatRow}`).alignment = { horizontal: 'right', vertical: 'middle' };
        ws.getCell(`K${vatRow}`).value = `${hdcPercent}%`;
        ws.getCell(`K${vatRow}`).font = { bold: true };
        ws.getCell(`K${vatRow}`).alignment = { horizontal: 'center', vertical: 'middle' };
        ws.getCell(`L${vatRow}`).value = { formula: `L${lastDataRow}*${hdcRate}` };
        ws.getCell(`L${vatRow}`).numFmt = '#,##0.00';
        ws.getCell(`L${vatRow}`).font = { bold: true };
        ws.getCell(`L${vatRow}`).alignment = { horizontal: 'right', vertical: 'middle' };
        ws.getRow(vatRow).height = 25;

        const totalWithVatRow = vatRow + 1;
        ws.mergeCells(`A${totalWithVatRow}:K${totalWithVatRow}`);
        for (let c = 1; c <= 11; c++) ws.getCell(totalWithVatRow, c).border = fullBorder;
        ws.getCell(totalWithVatRow, 12).border = fullBorder;

        ws.getCell(`A${totalWithVatRow}`).value = 'Всего с НДС';
        ws.getCell(`A${totalWithVatRow}`).font = { bold: true };
        ws.getCell(`A${totalWithVatRow}`).alignment = { horizontal: 'right', vertical: 'middle' };
        ws.getCell(`L${totalWithVatRow}`).value = { formula: `L${lastDataRow}+L${vatRow}` };
        ws.getCell(`L${totalWithVatRow}`).numFmt = '#,##0.00';
        ws.getCell(`L${totalWithVatRow}`).font = { bold: true };
        ws.getCell(`L${totalWithVatRow}`).alignment = { horizontal: 'right', vertical: 'middle' };
        ws.getRow(totalWithVatRow).height = 25;

        const footerRow = totalWithVatRow + 3;
        ws.mergeCells(`A${footerRow}:L${footerRow}`);
        ws.getCell(`A${footerRow}`).value = `Условия оплаты строго согласно договора № ${dogovorInfo}`;
        ws.getCell(`A${footerRow}`).alignment = { horizontal: 'left', vertical: 'middle' };
        ws.getCell(`A${footerRow}`).font = { italic: true };
        ws.getRow(footerRow).height = 25;

        // === БЛОК ПОДПИСЕЙ ===
        const signatureRow1 = footerRow + 2;
        const signatureRow2 = footerRow + 3;
    
        // Строка с подписями
        // Строка "тип"
        ws.mergeCells(`A${signatureRow1}:C${signatureRow1}`);
        const typeCell = ws.getCell(`A${signatureRow1}`);
       
        typeCell.alignment = { horizontal: 'left', vertical: 'bottom' };
      
        ws.getRow(signatureRow1).height = 80;
        // (Должность)
        ws.mergeCells(`A${signatureRow2}:D${signatureRow2}`);
        const positionCell = ws.getCell(`A${signatureRow2}`);
        positionCell.value = '(Должность)';
        positionCell.alignment = { horizontal: 'center', vertical: 'top' };
        positionCell.border = {
            top: { style: 'thin' },
            left: { style: 'none' },
            bottom: { style: 'none' },
            right: { style: 'none' }
        };
        
        // (подпись)
        ws.mergeCells(`E${signatureRow2}:H${signatureRow2}`);
        const signCell = ws.getCell(`E${signatureRow2}`);
        signCell.value = '(подпись)';
        signCell.alignment = { horizontal: 'center', vertical: 'top' };
        
        
        // (ФИО)
        ws.mergeCells(`I${signatureRow2}:L${signatureRow2}`);
        const fioCell = ws.getCell(`I${signatureRow2}`);
        fioCell.value = '(ФИО)';
        fioCell.alignment = { horizontal: 'center', vertical: 'top' };
        fioCell.border = {
            top: { style: 'thin' },
            left: { style: 'none' },
            bottom: { style: 'none' },
            right: { style: 'none' }
        };
        
        ws.getRow(signatureRow2).height = 20;

        // === ЗАЩИТА (без изменений) ===
        const lastRow = totalWithVatRow;
        ws.eachRow({ includeEmpty: true }, (row) => {
            row.eachCell({ includeEmpty: true }, (cell) => { cell.protection = { locked: false }; });
        });
        for (let r = 1; r <= 3; r++) ws.getRow(r).eachCell((cell) => { cell.protection = { locked: true }; });
        for (let r = 4; r <= lastRow; r++) {
            [1, 2, 3, 8, 9, 10, 11, 12].forEach(c => { ws.getCell(r, c).protection = { locked: true }; });
        }
        for (let c = 1; c <= 12; c++) {
            ws.getCell(lastDataRow, c).protection = { locked: true };
            ws.getCell(vatRow, c).protection = { locked: true };
            ws.getCell(totalWithVatRow, c).protection = { locked: true };
        }
        ws.protect('', {
            selectLockedCells: true, selectUnlockedCells: true,
            formatCells: true, formatColumns: true, formatRows: true,
            insertRows: true, insertColumns: true,
            deleteRows: true, deleteColumns: true,
            sort: true, autoFilter: true, pivotTables: true
        });

        // === ВАЛИДАЦИЯ (без изменений) ===
        if (equipmentList.length > 0) {
            for (let r = 4; r < lastDataRow; r++) {
                ws.getCell(`D${r}`).dataValidation = {
                    type: 'list', allowBlank: true,
                    formulae: ['"ПОЛНЫЙ ЦИКЛ (ТО + МЕХ. ОБРАБОТКА),ПОЛНАЯ МЕХ ОБРАБОТКА БЕЗ ТО,ЧАСТИЧНАЯ МЕХ ОБРАБОТКА С ТО,ЧАСТИЧНАЯ МЕХ ОБРАБОТКА БЕЗ ТО"'],
                    showErrorMessage: true, errorTitle: 'Ошибка', error: 'Выберите значение из списка'
                };
                ws.getCell(`E${r}`).dataValidation = { type: 'whole', operator: 'greaterThan', formulae: [0], showErrorMessage: true, errorTitle: 'Ошибка', error: 'Значение должно быть положительным целым числом' };
                ws.getCell(`F${r}`).dataValidation = { type: 'whole', operator: 'greaterThan', formulae: [0], showErrorMessage: true, errorTitle: 'Ошибка', error: 'Значение должно быть положительным целым числом' };
            }
        }

        // ✅ ИСПРАВЛЕНИЕ: сохраняем в подпапку фирмы, чтобы не перезаписывалось
        const yearFolder = path.join(OUTPUT_DIR, String(new Date().getFullYear()));
        if (!fs.existsSync(yearFolder)) fs.mkdirSync(yearFolder, { recursive: true });

        const firmFolder = sanitizeFolderName(firmaName || `firma_${id_firma}`);
        const firmPath = path.join(yearFolder, firmFolder);
        if (!fs.existsSync(firmPath)) fs.mkdirSync(firmPath, { recursive: true });

        const outputFileName = `${tableName}.xlsx`;
        const fullPath = path.join(firmPath, outputFileName);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        await workbook.xlsx.writeFile(fullPath);

        return {
            path: fullPath,
            relativePath: `/Заявки/${new Date().getFullYear()}/${firmFolder}/${outputFileName}`,
            fileName: outputFileName
        };
    } finally {
        await db.close();
    }
}


module.exports = {
  exportZaprosKP,
  createEquipmentTable,
  exportZakazToExcel,
  getNextZayavkaNumber,
  generatePreviewHTML,
  OUTPUT_DIR,
  TEMPLATES_DIR
};

function getNextZayavkaNumber() {
    const now = new Date();
    const year = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${year}-${mm}${dd}`;
}

// ============================================================
// ПРЕВЬЮ: ЛИСТ EXCEL → HTML «КАК ЕСТЬ» (без деления на шапку/данные)
// Значение объединённой области выводится ТОЛЬКО в master-ячейке,
// подчинённые ячейки пропускаются; rowspan/colspan — по ВИДИМЫМ.
// ============================================================
function _pvEsc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
function _pvColToNum(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
}
// ✅ НОВОЕ: обратное преобразование — номер колонки → буквы (1 → A, 27 → AA).
// Используется для корректного topLeftCell в frozen-panes.
function _colLetter(n) {
    let s = '';
    while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}
function _pvParseRange(str) {
    const m = String(str).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) return null;
    return { top: +m[2], left: _pvColToNum(m[1]), bottom: +m[4], right: _pvColToNum(m[3]) };
}
function _pvGetMerges(ws) {
    const out = [];
    let raw = [];
    try {
        if (ws.model && ws.model.merges) {
            raw = Array.isArray(ws.model.merges) ? ws.model.merges : Object.values(ws.model.merges);
        } else if (ws._merges) {
            raw = Object.values(ws._merges);
        }
    } catch (e) { raw = []; }
    for (const m of raw) {
        if (typeof m === 'string') { const p = _pvParseRange(m); if (p) out.push(p); }
        else if (m && m.top !== undefined) out.push({ top: m.top, left: m.left, bottom: m.bottom, right: m.right });
    }
    return out;
}

function _pvBorderSide(side) {
    if (!side || !side.style) return null;
    const w = { thin: 1, hair: 1, medium: 2, thick: 3 }[side.style] || 1;
    const st = { dotted: 'dotted', dashed: 'dashed', dashDot: 'dashed', dashDotDot: 'dashed' }[side.style] || 'solid';
    let rgb = '0,0,0';
    if (side.color && side.color.argb) {
        const a = String(side.color.argb).padStart(8, '0');
        rgb = `${parseInt(a.substr(2, 2), 16)},${parseInt(a.substr(4, 2), 16)},${parseInt(a.substr(6, 2), 16)}`;
    }
    return `${w}px solid rgb(${rgb})`;
}

function _pvText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
        if (v.master) return _pvText(v.master.value !== undefined ? v.master.value : v.master); // merged-proxy
        if (v.richText) return v.richText.map(t => t.text).join('');
        if (v.text) return String(v.text);                 // hyperlink
        if (v.result !== undefined) return _pvText(v.result); // formula
        return '';
    }
    if (v instanceof Date) {
        const dd = String(v.getDate()).padStart(2, '0');
        const mm = String(v.getMonth() + 1).padStart(2, '0');
        return `${dd}.${mm}.${v.getFullYear()}`;
    }
    if (typeof v === 'number') {
        return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
    }
    return String(v);
}

async function generatePreviewHTML(xlsxFilePath, opts = {}) {
  // ✅ T59: generatePreviewHTML(xlsxFilePath | Buffer, opts)
  //   - xlsxFilePath может быть Buffer (wb.xlsx.load) — предпросмотр СЗ
  //     строится из буфера szExcel.buildPreviewBuffer (снят кэш формул
  //     шаблона) без временного файла;
  //   - opts.sheet — имя листа (у «Заявка NEW!» он ВТОРОЙ: worksheets[0] —
  //     служебная «Таблица»; умолчание, как прежде, — первый лист).
  try {
    const wb = new ExcelJS.Workbook();
    if (Buffer.isBuffer(xlsxFilePath)) await wb.xlsx.load(xlsxFilePath);
    else {
      if (!fs.existsSync(xlsxFilePath)) {
        return `<p style='color:#999;padding:20px;'>Файл не найден: ${_pvEsc(path.basename(String(xlsxFilePath)))}</p>`;
      }
      await wb.xlsx.readFile(xlsxFilePath);
    }
    let ws = wb.worksheets[0];
    if (opts.sheet) {
      const target = wb.worksheets.find(w =>
        String(w.name || '').trim().toLowerCase() === String(opts.sheet).trim().toLowerCase());
      if (target) ws = target;
    }
    if (!ws) return '<p style="color:#999;padding:20px;">Лист не найден</p>';

        const lastRow = ws.rowCount || 1;
        let lastCol = ws.columnCount || 1;

        const merges = _pvGetMerges(ws);
        const masterAt = new Map();
        const covered = new Set();
        for (const m of merges) {
            masterAt.set(`${m.top}:${m.left}`, m);
            for (let r = m.top; r <= m.bottom; r++)
                for (let c = m.left; c <= m.right; c++)
                    if (!(r === m.top && c === m.left)) covered.add(`${r}:${c}`);
            if (m.right > lastCol) lastCol = m.right;
        }

        const colHidden = [], rowHidden = [];
        for (let c = 1; c <= lastCol; c++) colHidden[c] = !!(ws.getColumn(c) && ws.getColumn(c).hidden);
        for (let r = 1; r <= lastRow; r++) rowHidden[r] = !!(ws.getRow(r) && ws.getRow(r).hidden);
        const visCols = (l, rt) => { let n = 0; for (let c = l; c <= rt; c++) if (!colHidden[c]) n++; return n; };
        const visRows = (t, b) => { let n = 0; for (let r = t; r <= b; r++) if (!rowHidden[r]) n++; return n; };

        // значение master-ячейки; если пусто — ищем в любой ячейке диапазона
        const cellText = (r, c, m) => {
            let t = _pvText(ws.getCell(r, c).value);
            if (t === '' && m) {
                outer:
                for (let rr = m.top; rr <= m.bottom; rr++) {
                    for (let cc = m.left; cc <= m.right; cc++) {
                        t = _pvText(ws.getCell(rr, cc).value);
                        if (t !== '') break outer;
                    }
                }
            }
            return t;
        };

        let html = `<!DOCTYPE html><html><head><meta charset='UTF-8'><style>table{border-collapse:collapse;font-family:Calibri;font-size:11pt;}td{border:none;padding:2px;vertical-align:middle;}</style></head><body><table>`;

        for (let r = 1; r <= lastRow; r++) {
            if (rowHidden[r]) continue;
            const row = ws.getRow(r);
            html += row.height ? `<tr style='height:${Math.round(row.height * 4 / 3)}px'>` : '<tr>';

            for (let c = 1; c <= lastCol; c++) {
                const key = `${r}:${c}`;
                if (covered.has(key)) continue;          // значение уже выведено в master

                const m = masterAt.get(key);
                // ✅ скрытую колонку пропускаем ТОЛЬКО для обычных ячеек;
                //    master объединения рендерим, если хотя бы одна колонка диапазона видима
                if (!m && colHidden[c]) continue;

                let attrs = '';
                let text = '';
                if (m) {
                    const cs = visCols(m.left, m.right);
                    const rs = visRows(m.top, m.bottom);
                    if (cs <= 0 || rs <= 0) continue;    // объединение целиком в скрытой зоне
                    if (rs > 1) attrs += ` rowspan='${rs}'`;
                    if (cs > 1) attrs += ` colspan='${cs}'`;
                    text = cellText(r, c, m);
                } else {
                    text = _pvText(ws.getCell(r, c).value);
                }

                const cell = ws.getCell(r, c);
                const st = [];
                const b = cell.border || (cell.style && cell.style.border);
                if (b) {
                    const t1 = _pvBorderSide(b.top);    if (t1) st.push(`border-top:${t1}`);
                    const t2 = _pvBorderSide(b.right);  if (t2) st.push(`border-right:${t2}`);
                    const t3 = _pvBorderSide(b.bottom); if (t3) st.push(`border-bottom:${t3}`);
                    const t4 = _pvBorderSide(b.left);   if (t4) st.push(`border-left:${t4}`);
                }
                const font = cell.font || {};
                if (font.bold) st.push('font-weight:bold');
                const al = cell.alignment || {};
                if (al.horizontal) st.push(`text-align:${al.horizontal}`);
                if (al.wrapText) st.push('white-space:pre-wrap;word-wrap:break-word');
                else st.push('white-space:nowrap');

                html += `<td${attrs} style='${st.join(';')};'>${_pvEsc(text)}</td>`;
            }
            html += '</tr>\n';
        }
        html += '</table></body></html>';
        return html;
    } catch (e) {
        console.error('[generatePreviewHTML] Error:', e.message);
        return `<p style='color:red;padding:20px;'>Ошибка превью: ${_pvEsc(e.message)}</p>`;
    }
}




// ============================================================
// ✅ НОВОЕ: ЭКСПОРТ СВОДНОЙ ТАБЛИЦЫ КП (Выбор поставщика)
// ============================================================
// Файл: public/Заявки/{baseYear}/Выбор поставщика заявка№{n_zaprosa}.xlsx
//
// Структура листа:
//   Строка 1     — заголовок «Выбор поставщика заявка № N от DATE» (merged)
//   Строка 2     — пустая
//   Строка 3     — группы колонок (merged): Деталь | Фирма 1 | ... | Лучшее ТКП
//   Строка 4     — подзаголовки колонок
//   Строки 5+    — данные (по одной строке на деталь)
//   Подвал 1     — подвал колонок: SUM в best_stoim_partii и best_econom
//   Подвал 2     — подвал групп: для фирм — soderzhanie из sprav_uslov,
//                  для Деталь/Лучшее ТКП — пусто
//
// Расчётные колонки (живые Excel-формулы):
//   • В фирмах: cena_nch = IFERROR(cost/trud,""),
//               stoim_partii = cost*mosh
//   • В Лучшее ТКПе: best_econom = cost_pto − best_stoim_partii
//                  (cost_pto уже = труд*цена*план — стоимость партии ПТО)
//   • В подвале:    SUM(cost_pto), SUM(best_stoim_partii) и SUM(best_econom)
//   Колонка best_stoim_partii в Лучшее ТКПе — значение (т.к. зависит от
//   выбранного «лучшего КП», что является бизнес-логикой offers.js).
//
// Входные данные (от клиента):
//   {
//     zaprosNumber: '2026-0101',
//     zaprosDate:    '2026-01-15',
//     baseYear:      2026,
//     baseCols:      [{key,label,width}, ...],            // 5 шт
//     firmColsTpl:   [{suffix,label,width}, ...],         // 7 шт (FIRM_COLUMNS)
//     firmsList:     [{id_firmy, naimenovanie}, ...],
//     resultCols:    [{key,label,width}, ...],            // 4 шт:
//                       best_firma, best_stoim_partii, best_econom,
//                       best_primechanie_kp (Обоснование выбора — текст комментария ЛКП)
//     rows:          [{...}, ...],                        // массив строк
//     footerInfo:    { "<firmaId>": { soderzhanie, nom_dogovor, data_dogovor }, ... },
//                    // для подвала групп фирм. Формируется как
//                    // 'Договор №N от D: soderzhanie'.
//     bestEconomKey: 'best_econom'                        // ключ колонки для суммы
//   }
// ============================================================
async function exportSummaryTableKP({
    zaprosNumber, zaprosDate, baseYear,
    baseCols, firmColsTpl, firmsList, resultCols,
    rows, footerInfo, bestEconomKey = 'best_econom'
}) {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('[exportSummaryTableKP] Нет данных для экспорта');
    }
    if (!Array.isArray(firmsList) || firmsList.length === 0) {
        throw new Error('[exportSummaryTableKP] Нет фирм для экспорта');
    }
    if (!Array.isArray(baseCols) || !Array.isArray(firmColsTpl) || !Array.isArray(resultCols)) {
        throw new Error('[exportSummaryTableKP] Некорректная конфигурация колонок');
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'АО «АВТОВАЗ» — Offers module';
    workbook.created = new Date();

    // ============================================================
    // 1. ПОДГОТОВКА СТРУКТУРЫ КОЛОНОК (до создания worksheet —
    //    нужны baseCols.length для frozen xSplit и topLeftCell)
    // ============================================================
    // Полный список колонок: base + (для каждой фирмы × firmColsTpl) + result
    const allCols = [];
    // base
    baseCols.forEach(c => allCols.push({ ...c, group: 'Деталь', groupClass: 'base' }));
    // firms
    firmsList.forEach((firma, fIdx) => {
        firmColsTpl.forEach(fc => {
            allCols.push({
                key: `f_${fIdx}_${fc.suffix}`,
                label: fc.label,
                width: fc.width,
                group: firma.naimenovanie,
                groupClass: 'firm',
                firmaId: firma.id_firmy,
                suffix: fc.suffix
            });
        });
    });
    // result
    resultCols.forEach(c => allCols.push({ ...c, group: 'Лучшее ТКП', groupClass: 'result' }));

    const LAST_COL = allCols.length;
    const HEADER_TITLE_ROW = 1;
    const HEADER_BLANK_ROW = 2;
    const HEADER_GROUP_ROW = 3;
    const HEADER_SUB_ROW   = 4;
    const FIRST_DATA_ROW   = 5;

    // ✅ ИСПРАВЛЕНО: topLeftCell frozen-pane должен указывать на ячейку
    // ПОСЛЕ разделения. При xSplit=N, ySplit=M topLeftCell должен быть
    // на колонке (N+1) и строке (M+1). Иначе Excel при открытии ругается
    // на /xl/worksheets/sheet1.xml и восстанавливает view.
    const FROZEN_XSPLIT = baseCols.length;
    const FROZEN_YSPLIT = 4;
    const topLeftCol = FROZEN_XSPLIT + 1;    // 6 → 'F'
    const topLeftRowNum = FROZEN_YSPLIT + 1; // 5
    const topLeftCell = _colLetter(topLeftCol) + topLeftRowNum;  // "F5"

    const ws = workbook.addWorksheet('Сводная КП', {
        views: [{
            state: 'frozen',
            ySplit: FROZEN_YSPLIT,
            xSplit: FROZEN_XSPLIT,
            topLeftCell: topLeftCell
        }]
    });

    // Устанавливаем ширины колонок
    allCols.forEach((c, idx) => {
        ws.getColumn(idx + 1).width = Math.max(8, Math.round((c.width || 80) / 7));
    });

    // ✅ НОВОЕ: Excel Outline (grouping) для колонок фирм.
    //   Кнопки [+/−] появляются ВВЕРХУ листа (summaryBelow: false) —
    //   при клике на '−' группа схлопывается, на '+' — разворачивается.
    //   Группируем все колонки фирмы КРОМЕ последней (stoim_partii) —
    //   аналогично UI сводной таблицы (collapsibleGroups + keepLastN=1).
    //   Изначально все группы свёрнуты (hidden=true).
    ws.properties.outlineProperties = {
        summaryBelow: false,   // кнопки [1][2] сверху, а не снизу
        summaryRight: false
    };
    allCols.forEach((c, idx) => {
        // Группируем только колонки фирм (groupClass='firm')
        if (c.groupClass !== 'firm') return;
        // Пропускаем ПОСЛЕДНЮЮ колонку группы (stoim_partii) — оставляем видимой
        //   Для этого найдём диапазон текущей группы
        const groupStart = allCols.findIndex((cc, ii) =>
            ii <= idx && cc.group === c.group && cc.groupClass === 'firm');
        // Найдём конец группы (последний idx с тем же group)
        let groupEnd = idx;
        for (let j = idx + 1; j < allCols.length; j++) {
            if (allCols[j].group === c.group && allCols[j].groupClass === 'firm') {
                groupEnd = j;
            } else {
                break;
            }
        }
        // Если это последняя колонка группы — НЕ группируем (оставляем видимой)
        if (idx === groupEnd) return;
        // Устанавливаем outline level + скрываем (collapsed=true по умолчанию)
        const colNum = idx + 1;
        ws.getColumn(colNum).outlineLevel = 1;
        ws.getColumn(colNum).hidden = true;
    });

    // ============================================================
    // 2. СТИЛИ
    // ============================================================
    const thinBorder = {
        top:    { style: 'thin' },
        left:   { style: 'thin' },
        bottom: { style: 'thin' },
        right:  { style: 'thin' }
    };
    const headerFillBase   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F3FF' } };
    const headerFillFirm   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } };
    const headerFillResult = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6FFED' } };
    const headerFillTitle  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD0D7DE' } };
    const footerFillFirm   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } };
    // ✅ НОВОЕ: заливка для подсветки выбранного ЛКП
    //   Светло-зелёный, чуть насыщеннее чем headerFillResult,
    //   чтобы выделяться на фоне обычных ячеек.
    const highlightBestFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } };

    function groupFill(groupClass) {
        if (groupClass === 'base')   return headerFillBase;
        if (groupClass === 'firm')   return headerFillFirm;
        if (groupClass === 'result') return headerFillResult;
        return null;
    }

    // ============================================================
    // 3. ЗАГОЛОВОК (строка 1)
    // ============================================================
    const titleText = `Выбор поставщика заявка № ${zaprosNumber || ''}` +
                      (zaprosDate ? ` от ${displayDate(zaprosDate)}` : '');
    ws.getCell(HEADER_TITLE_ROW, 1).value = titleText;
    ws.getCell(HEADER_TITLE_ROW, 1).font = { bold: true, size: 14 };
    ws.getCell(HEADER_TITLE_ROW, 1).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getCell(HEADER_TITLE_ROW, 1).fill = headerFillTitle;
    ws.mergeCells(HEADER_TITLE_ROW, 1, HEADER_TITLE_ROW, LAST_COL);
    ws.getRow(HEADER_TITLE_ROW).height = 24;

    // Строка 2 — пустая (визуальный отступ)
    ws.getRow(HEADER_BLANK_ROW).height = 6;

    // ============================================================
    // 4. ГРУППЫ КОЛОНОК (строка 3) — merged
    // ============================================================
    // Идём по allCols и объединяем подряд идущие колонки с одним group
    let groupStart = 0;
    for (let i = 1; i <= allCols.length; i++) {
        const cur = i < allCols.length ? allCols[i].group : null;
        const prev = allCols[i - 1].group;
        if (cur !== prev) {
            // Закрываем группу [groupStart+1 .. i]
            const from = groupStart + 1;
            const to = i;
            const g = allCols[groupStart].group;
            const gc = allCols[groupStart].groupClass;
            const cell = ws.getCell(HEADER_GROUP_ROW, from);
            cell.value = g;
            cell.font = { bold: true, size: 11 };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = thinBorder;
            const fill = groupFill(gc);
            if (fill) cell.fill = fill;
            if (to > from) ws.mergeCells(HEADER_GROUP_ROW, from, HEADER_GROUP_ROW, to);
            // Заполняем border для всех колонок группы
            for (let c = from + 1; c <= to; c++) {
                ws.getCell(HEADER_GROUP_ROW, c).border = thinBorder;
                if (fill) ws.getCell(HEADER_GROUP_ROW, c).fill = fill;
            }
            groupStart = i;
        }
    }
    // ✅ ИЗМЕНЕНО: высота строки с группами фирм зависит от схлопывания.
    //   Если есть хотя бы одна свёрнутая группа (hidden=true) — 2 строки × 16 = 32px
    //   (т.к. в свёрнутой группе видна только 'Стоим. партии', название
    //   фирмы + кнопка [+/−] переносятся на 2 строки из-за узкой ширины)
    //   Если все развёрнуты — 1 строка × 16 + 6px отступ = 22px
    let hasCollapsedGroup = false;
    allCols.forEach((c, idx) => {
        if (c.groupClass !== 'firm') return;
        if (ws.getColumn(idx + 1).hidden) {
            hasCollapsedGroup = true;
        }
    });
    ws.getRow(HEADER_GROUP_ROW).height = hasCollapsedGroup ? 32 : 22;

    // ============================================================
    // 5. ПОДЗАГОЛОВКИ КОЛОНОК (строка 4)
    // ============================================================
    allCols.forEach((c, idx) => {
        const col = idx + 1;
        const cell = ws.getCell(HEADER_SUB_ROW, col);
        cell.value = c.label;
        cell.font = { bold: true, size: 10 };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = thinBorder;
        const fill = groupFill(c.groupClass);
        if (fill) cell.fill = fill;
    });
    ws.getRow(HEADER_SUB_ROW).height = 28;

    // ============================================================
    // 6. ДАННЫЕ (строки 5+)
    // ============================================================
    // ✅ НОВОЕ: для расчётных колонок 'cena_nch' и 'stoim_partii' (в фирмах)
    // пишем Excel-формулы со ссылками на ячейки той же строки.
    // Для каждой фирмы колонки идут в порядке FIRM_COLUMNS:
    //   trud | cost | cena_nch | mosh | stoim_partii | srok | tip
    // Значит внутри фирмы:
    //   • trud         — колонка 0 (относительно начала группы)
    //   • cost         — колонка 1
    //   • mosh         — колонка 3
    //   • cena_nch     — колонка 2 (формула: =IFERROR(cost/trud,""))
    //   • stoim_partii — колонка 4 (формула: =cost*mosh)
    // Чтобы построить ссылки — для каждой расчётной колонки сохраняем
    // номера колонок её операндов (абсолютные, 1-based).
    //
    // ✅ ИЗМЕНЕНО (rev 3): для колонки 'best_econom' в группе «Лучшее ТКП»
    //   формула: =cost_pto - best_stoim_partii
    //   (cost_pto теперь хранит стоимость партии ПТО = trud_pto*cena_pto*plan_god_kolvo).
    //   Колонку 'best_stoim_partii' оставляем значением (т.к. она зависит
    // от выбранного «лучшего КП», а это уже бизнес-логика, не формула).
    // ============================================================

    // Строим карту: для каждой расчётной колонки — ссылки на trud/cost/mosh
    // той же фирмы. Ключ — номер колонки (1-based) расчётной, значение —
    // { trudCol, costCol, moshCol } (буквы колонок).
    const formulaMap = new Map(); // colNum -> { cenaNch | stoimPartii, ... }
    {
        // Индексы суффиксов внутри FIRM_COLUMNS (должны совпадать с offers.js)
        const trudIdx     = firmColsTpl.findIndex(fc => fc.suffix === 'trud');
        const costIdx     = firmColsTpl.findIndex(fc => fc.suffix === 'cost');
        const moshIdx     = firmColsTpl.findIndex(fc => fc.suffix === 'mosh');
        const cenaNchIdx  = firmColsTpl.findIndex(fc => fc.suffix === 'cena_nch');
        const stoimPIdx   = firmColsTpl.findIndex(fc => fc.suffix === 'stoim_partii');

        if (trudIdx >= 0 && costIdx >= 0 && moshIdx >= 0) {
            // Для каждой фирмы вычисляем абсолютные номера колонок её операндов
            // и сохраняем ссылки для расчётных колонок (если они есть).
            firmsList.forEach((firma, fIdx) => {
                const groupStartCol = baseCols.length + fIdx * firmColsTpl.length; // 0-based
                const trudColNum     = groupStartCol + trudIdx + 1;
                const costColNum     = groupStartCol + costIdx + 1;
                const moshColNum     = groupStartCol + moshIdx + 1;

                if (cenaNchIdx >= 0) {
                    const cenaNchColNum = groupStartCol + cenaNchIdx + 1;
                    formulaMap.set(cenaNchColNum, {
                        cenaNch: true,
                        trudCol: _colLetter(trudColNum),
                        costCol: _colLetter(costColNum)
                    });
                }
                if (stoimPIdx >= 0) {
                    const stoimPColNum = groupStartCol + stoimPIdx + 1;
                    formulaMap.set(stoimPColNum, {
                        stoimPartii: true,
                        costCol: _colLetter(costColNum),
                        moshCol: _colLetter(moshColNum)
                    });
                }
            });
        }
    }

    // ✅ ИЗМЕНЕНО: для колонки best_econom — формула =cost_pto − best_stoim_partii
    //   (cost_pto теперь уже = труд*цена*план, без умножения на plan_god_kolvo)
    // Найдём абсолютные номера колонок cost_pto и best_stoim_partii.
    let bestEconomFormulaInfo = null;
    {
        const costPtoIdx     = allCols.findIndex(c => c.key === 'cost_pto');
        const planKolvoIdx   = allCols.findIndex(c => c.key === 'plan_god_kolvo');
        const bestStoimPIdx  = allCols.findIndex(c => c.key === 'best_stoim_partii');
        const bestEconomIdx  = allCols.findIndex(c => c.key === bestEconomKey);

        if (costPtoIdx >= 0 && planKolvoIdx >= 0 && bestStoimPIdx >= 0 && bestEconomIdx >= 0) {
            bestEconomFormulaInfo = {
                economColNum:   bestEconomIdx + 1,
                costPtoCol:     _colLetter(costPtoIdx + 1),
                planKolvoCol:   _colLetter(planKolvoIdx + 1),
                bestStoimPCol:  _colLetter(bestStoimPIdx + 1)
            };
        }
    }

    // ✅ НОВОЕ: карта для подсветки выбранного ЛКП
    //   firmaName → { groupHeaderCol (номер колонки начала группы),
    //                 stoimPartiiCol (номер колонки stoim_partii фирмы) }
    //   Используется в цикле ниже для заливки ячеек выбранной фирмы.
    const firmColMap = new Map();
    firmsList.forEach((firma, fIdx) => {
        // Группа фирм в allCols начинается с baseCols.length + fIdx * firmColsTpl.length
        const groupStartCol = baseCols.length + fIdx * firmColsTpl.length + 1;  // 1-based
        // stoim_partii — последняя колонка в группе
        const stoimPartiiIdx = firmColsTpl.findIndex(fc => fc.suffix === 'stoim_partii');
        const stoimPartiiCol = stoimPartiiIdx >= 0
            ? groupStartCol + stoimPartiiIdx
            : groupStartCol + firmColsTpl.length - 1;
        firmColMap.set(firma.naimenovanie, { groupHeaderCol: groupStartCol, stoimPartiiCol });
    });

    // ✅ НОВОЕ: множество фирм, чьи ячейки в группе Лучшее ТКП нужно подсветить
    //   (заполняется в цикле ниже, после которого обходим header для заливки названий)
    const highlightedFirmNames = new Set();

    rows.forEach((row, rIdx) => {
        const rowNum = FIRST_DATA_ROW + rIdx;
        allCols.forEach((c, cIdx) => {
            const col = cIdx + 1;
            const cell = ws.getCell(rowNum, col);
            let v = row[c.key];

            // ✅ НОВОЕ: расчётные колонки фирм — Excel-формулы со ссылками
            // на ячейки той же строки (trud/cost/mosh этой же фирмы).
            const fInfo = formulaMap.get(col);
            if (fInfo && fInfo.cenaNch) {
                // ✅ ИЗМЕНЕНО: 'нет предложения' → 'нет ТКП'
                cell.value = {
                    formula: `IFERROR(${fInfo.costCol}${rowNum}/${fInfo.trudCol}${rowNum},"нет ТКП")`
                };
                cell.numFmt = '#,##0.00';
                cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
                cell.border = thinBorder;
                cell.font = { size: 10 };
                return; // переходим к следующей колонке
            }
            if (fInfo && fInfo.stoimPartii) {
                // ✅ ИЗМЕНЕНО: 'нет предложения' → 'нет ТКП'
                cell.value = {
                    formula: `IFERROR(${fInfo.costCol}${rowNum}*${fInfo.moshCol}${rowNum},"нет ТКП")`
                };
                cell.numFmt = '#,##0.00';
                cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
                cell.border = thinBorder;
                cell.font = { size: 10 };
                return;
            }

            // ✅ ИЗМЕНЕНО: best_econom — формула =cost_pto − best_stoim_partii
            //   (cost_pto теперь = труд*цена*план — стоимость партии ПТО)
            // Если best_stoim_partii пустой (нет предл.) — пишем текст "нет предл."
            if (bestEconomFormulaInfo && c.key === bestEconomKey &&
                bestEconomFormulaInfo.economColNum === col) {
                const bestStoimPVal = row['best_stoim_partii'];
                const hasStoimPartii = bestStoimPVal !== '' &&
                                       bestStoimPVal != null &&
                                       !isNaN(Number(String(bestStoimPVal).replace(',', '.')));
                if (hasStoimPartii) {
                    // ✅ ИЗМЕНЕНО: формула = best_stoim_partii - cost_pto
                    //   (поменяли местами операнды — теперь положительное значение
                    //    означает, что выбранное КП выгоднее ПТО)
                    cell.value = {
                        formula: `${bestEconomFormulaInfo.bestStoimPCol}${rowNum}-${bestEconomFormulaInfo.costPtoCol}${rowNum}`
                    };
                    cell.numFmt = '#,##0.00';
                    cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
                    cell.border = thinBorder;
                    // ✅ НОВОЕ: если значение > 0 (КП выгоднее ПТО) — красный жирный
                    //   Проверяем по row['best_stoim_partii'] и row['cost_pto']:
                    //   если best_stoim_partii > cost_pto → значение будет > 0
                    const economVal = hasStoimPartii
                        ? (Number(String(row['best_stoim_partii']).replace(',', '.')) -
                           Number(String(row['cost_pto']).replace(',', '.')))
                        : 0;
                    cell.font = (economVal > 0)
                        ? { size: 10, bold: true, color: { argb: 'FFCC0000' } }
                        : { size: 10 };
                    return;
                } else {
                    // Нет стоимости партии — пишем текст 'нет предл.'
                    // ✅ ИЗМЕНЕНО: было 'нет предл.', оставлено для совместимости
                    //   с клиентским UI (там тоже 'нет предл.')
                    cell.value = 'нет предл.';
                    cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
                    cell.border = thinBorder;
                    cell.font = { size: 10 };
                    return;
                }
            }

            // Обычные числовые колонки — приводим к числу
            const numericSuffixes = ['trud', 'cost', 'mosh'];  // ✅ убран 'econom', добавлены через формулу
            // ✅ НОВОЕ: добавлена cena_pto (числовая колонка)
            const numericBaseKeys  = ['plan_god_kolvo', 'trud_pto', 'cena_pto', 'cost_pto'];
            // ✅ НОВОЕ: best_stoim_partii — тоже числовая (значение, не формула)
            const numericResultKeys = ['best_stoim_partii'];
            let isNumeric = false;
            if (numericBaseKeys.includes(c.key)) isNumeric = true;
            if (c.suffix && numericSuffixes.includes(c.suffix)) isNumeric = true;
            if (numericResultKeys.includes(c.key)) isNumeric = true;
            if (c.key === bestEconomKey) isNumeric = true;

            if (isNumeric && v !== '' && v != null && !isNaN(Number(String(v).replace(',', '.')))) {
                v = Number(String(v).replace(',', '.'));
                cell.numFmt = '#,##0.00';
                cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
            } else if (c.key === 'best_econom') {
                // может быть "нет предл." — оставляем как текст
                cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
                // ✅ НОВОЕ: если это число > 0 — красный жирный шрифт
                //   (значение было вычислено на клиенте как bestStoimPartii - costPartiiPto)
                const vNum = (typeof v === 'string') ? Number(v.replace(',', '.')) : Number(v);
                if (!isNaN(vNum) && vNum > 0) {
                    cell.font = { size: 10, bold: true, color: { argb: 'FFCC0000' } };
                }
            } else if (c.key === 'best_primechanie_kp') {
                // ✅ ИЗМЕНЕНО: колонка «Обоснование выбора» — центрирование
                //   по вертикали (vertical: 'middle' вместо 'top'), чтобы текст
                //   выравнивался по центру ячейки при увеличенной высоте строки.
                cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
            } else {
                cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
            }
            cell.value = (v === undefined || v === null) ? '' : v;
            cell.border = thinBorder;
            cell.font = { size: 10 };
        });
        // ✅ ИЗМЕНЕНО: расчёт высоты строки с учётом:
        //   • Колонка 'best_firma' (Выбранное КП) ВСЕГДА содержит 3 строки
        //     (формат 'FirmaName (TipIzgotovleniya)' переносится на 3 строки)
        //     → минимальная высота = 3 строки × 16px = 48px
        //   • Колонка 'best_primechanie_kp' (Обоснование выбора) — при длинном
        //     комментарии увеличивает высоту (множитель 16px на строку)
        const comment = row['best_primechanie_kp'] || '';
        // ~25 символов на одну строку в колонке шириной 200px
        const commentLines = comment ? Math.ceil(comment.length / 40) : 0;
        // best_firma всегда 3 строки (минимум) + комментарий если есть
        const bestFirmaLines = 3;
        const totalLines = Math.max(bestFirmaLines, commentLines);
        ws.getRow(rowNum).height = Math.max(18, totalLines * 16);

        // ✅ НОВОЕ: заливка ячеек группы Лучшее ТКП светло-зелёным
        allCols.forEach((c, cIdx) => {
            if (c.groupClass === 'result') {
                const resultCell = ws.getCell(rowNum, cIdx + 1);
                resultCell.fill = highlightBestFill;
            }
        });

        // ✅ НОВОЕ: подсветка ячейки stoim_partii выбранной фирмы в группе фирм
        //   Парсим best_firma (формат: 'FirmaName (TipIzgotovleniya)')
        //   и заливаем ячейку (rowNum × stoimPartiiCol) той же фирмой
        const bestFirmaText = row['best_firma'] || '';
        if (bestFirmaText && bestFirmaText !== 'Не выбрано') {
            // Извлекаем название фирмы до первой скобки
            const match = bestFirmaText.match(/^(.+?)\s*\(/);
            const firmaName = match ? match[1].trim() : bestFirmaText.trim();
            const firmInfo = firmColMap.get(firmaName);
            if (firmInfo) {
                const cellToHighlight = ws.getCell(rowNum, firmInfo.stoimPartiiCol);
                cellToHighlight.fill = highlightBestFill;
                // Запоминаем фирму для заливки её заголовка ниже
                highlightedFirmNames.add(firmaName);
            }
        }
    });

    // ✅ НОВОЕ: заливка header-cell (HEADER_GROUP_ROW) для фирм, у которых есть выбранное ЛКП
    //   Это делает заголовок фирмы с зелёным фоном — сразу видно, какие фирмы выбраны
    if (highlightedFirmNames.size > 0) {
        allCols.forEach((c, cIdx) => {
            if (c.groupClass !== 'firm') return;
            if (highlightedFirmNames.has(c.group)) {
                const headerCell = ws.getCell(HEADER_GROUP_ROW, cIdx + 1);
                headerCell.fill = highlightBestFill;
            }
        });
    }

    // ============================================================
    // 7. ПОДВАЛ КОЛОНОК — строка сразу после данных
    //    Сумма в best_stoim_partii и best_econom (через формулу SUM).
    //    Остальные колонки пустые.
    // ============================================================
    const footerColRow = FIRST_DATA_ROW + rows.length;
    const firstDataRowNum = FIRST_DATA_ROW;
    const lastDataRowNum  = FIRST_DATA_ROW + rows.length - 1;

    allCols.forEach((c, cIdx) => {
        const col = cIdx + 1;
        const cell = ws.getCell(footerColRow, col);
        cell.border = thinBorder;
        cell.font = { bold: true, size: 10 };

        // ✅ НОВОЕ: первая колонка (nomer_chertezha) — текст 'ИТОГО:'
        if (c.key === 'nomer_chertezha') {
            cell.value = 'ИТОГО:';
            cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
            cell.font = { bold: true, size: 10 };
        } else if (c.key === 'cost_pto') {
            // ✅ НОВОЕ: сумма стоимости партии ПТО через формулу Excel
            const colLetter = _colLetter(col);
            cell.value = {
                formula: `IF(SUM(${colLetter}${firstDataRowNum}:${colLetter}${lastDataRowNum})=0,"нет ТКП",SUM(${colLetter}${firstDataRowNum}:${colLetter}${lastDataRowNum}))`
            };
            cell.numFmt = '#,##0.00';
            cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
            cell.font = { bold: true, color: { argb: 'FF0A5C26' }, size: 10 };
        } else if (c.key === 'best_stoim_partii') {
            // ✅ НОВОЕ: сумма стоим. партии через формулу Excel
            const colLetter = _colLetter(col);
            cell.value = {
                formula: `IF(SUM(${colLetter}${firstDataRowNum}:${colLetter}${lastDataRowNum})=0,"нет ТКП",SUM(${colLetter}${firstDataRowNum}:${colLetter}${lastDataRowNum}))`
            };
            cell.numFmt = '#,##0.00';
            cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
            cell.font = { bold: true, color: { argb: 'FF0A5C26' }, size: 10 };
        } else if (c.key === bestEconomKey) {
            // ✅ ИЗМЕНЕНО: сумма экономии через формулу Excel (раньше было значение).
            // Формула посчитает сумму по диапазону ячеек колонки — включая
            // текстовые "нет предл." (SUM их игнорирует).
            const colLetter = _colLetter(col);
            cell.value = {
                formula: `IF(SUM(${colLetter}${firstDataRowNum}:${colLetter}${lastDataRowNum})=0,"нет ТКП",SUM(${colLetter}${firstDataRowNum}:${colLetter}${lastDataRowNum}))`
            };
            cell.numFmt = '#,##0.00';
            cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
            cell.font = { bold: true, color: { argb: 'FF0A5C26' }, size: 10 };
        } else if (c.suffix === 'stoim_partii' && c.firmaId != null) {
            // ✅ НОВОЕ: сумма стоим. партии для каждой фирмы (SUM формула)
            const colLetter = _colLetter(col);
            cell.value = {
                formula: `IF(SUM(${colLetter}${firstDataRowNum}:${colLetter}${lastDataRowNum})=0,"нет ТКП",SUM(${colLetter}${firstDataRowNum}:${colLetter}${lastDataRowNum}))`
            };
            cell.numFmt = '#,##0.00';
            cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
            cell.font = { bold: true, color: { argb: 'FF0A5C26' }, size: 10 };
        } else {
            cell.value = '';
        }
    });
    ws.getRow(footerColRow).height = 22;

    // ============================================================
    // 8. ПОДВАЛ ГРУПП — строка под подвалом колонок
    //    Для фирм — soderzhanie, для Деталь/Лучшее ТКП — пусто.
    //    Каждая группа merged по тем же колонкам, что в заголовке.
    // ============================================================
    const footerGroupRow = footerColRow + 1;

    groupStart = 0;
    for (let i = 1; i <= allCols.length; i++) {
        const cur = i < allCols.length ? allCols[i].group : null;
        const prev = allCols[i - 1].group;
        if (cur !== prev) {
            const from = groupStart + 1;
            const to = i;
            const gc = allCols[groupStart].groupClass;
            const firmaId = allCols[groupStart].firmaId;

            const cell = ws.getCell(footerGroupRow, from);
            let text = '';
            if (gc === 'base') {
                // ✅ НОВОЕ: для группы 'Деталь' — поясняющий заголовок подвала
                text = 'Условия оплаты по договору';
            } else if (gc === 'firm' && firmaId != null) {
                // ✅ ИЗМЕНЕНО: footerInfo теперь содержит объекты с метаданными договора
                //   { soderzhanie, nom_dogovor, data_dogovor }
                //   Формируем текст: 'Договор №N от D: soderzhanie'
                const info = (footerInfo && footerInfo[String(firmaId)]) || null;
                if (info && typeof info === 'object') {
                    const parts = [];
                    if (info.nom_dogovor) parts.push(`Договор №${info.nom_dogovor}`);
                    // ✅ ИЗМЕНЕНО: дату пропускаем через displayDate
                    //   для единого формата отображения (ДД.ММ.ГГГГ)
                    if (info.data_dogovor) parts.push(`от ${displayDate(info.data_dogovor)}`);
                    if (parts.length > 0 && info.soderzhanie) parts.push(':');
                    if (info.soderzhanie) parts.push(info.soderzhanie);
                    text = parts.join(' ') || '— условие предоплаты не задано —';
                } else if (typeof info === 'string') {
                    // Обратная совместимость: если footerInfo — строка
                    text = info;
                } else {
                    text = '— условие предоплаты не задано —';
                }
            }
            // Для gc === 'result' — text остаётся пустым
            cell.value = text;
            cell.font = { bold: true, size: 10, italic: !!text };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = thinBorder;
            if (gc === 'firm') cell.fill = footerFillFirm;
            else {
                const f = groupFill(gc);
                if (f) cell.fill = f;
            }
            if (to > from) ws.mergeCells(footerGroupRow, from, footerGroupRow, to);
            for (let c = from + 1; c <= to; c++) {
                ws.getCell(footerGroupRow, c).border = thinBorder;
                if (gc === 'firm') ws.getCell(footerGroupRow, c).fill = footerFillFirm;
                else {
                    const f = groupFill(gc);
                    if (f) ws.getCell(footerGroupRow, c).fill = f;
                }
            }
            groupStart = i;
        }
    }
    // ✅ ИЗМЕНЕНО: подвал групп с условиями договора содержит
    //   длинный текст 'Договор №N от D: условия предоплаты'.
    //   Перенос текста занимает ~7 строк × 16px = 112px
    ws.getRow(footerGroupRow).height = 7 * 16;

    // ============================================================
    // ✅ НОВОЕ: 8.5. ЛЕГЕНДА — последняя строка таблицы
    //   В колонке 1 — заливка highlightBestFill (как у лучших ЛКП)
    //   В колонках 2..LAST_COL — текст 'отмечены лучшие предложения фирм'
    // ============================================================
    const legendRow = footerGroupRow + 1;
    const legendCell1 = ws.getCell(legendRow, 1);
    legendCell1.fill = highlightBestFill;
    legendCell1.border = thinBorder;
    // Подпись легенды во второй колонке + merge до последней
    if (LAST_COL > 1) {
        const legendTextCell = ws.getCell(legendRow, 2);
        legendTextCell.value = 'отмечены лучшие предложения фирм';
        legendTextCell.font = { bold: true, size: 11, italic: true };
        legendTextCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        legendTextCell.border = thinBorder;
        if (LAST_COL > 2) {
            ws.mergeCells(legendRow, 2, legendRow, LAST_COL);
        }
        // Заливка остальных ячеек строки легенды (кроме 1) — без цвета
        for (let c = 2; c <= LAST_COL; c++) {
            const c2 = ws.getCell(legendRow, c);
            c2.border = thinBorder;
        }
    }
    ws.getRow(legendRow).height = 22;

    // ============================================================
    // 9. АВТО-ФИЛЬТР
    // ============================================================
    // ✅ ИСПРАВЛЕНО: авто-фильтр был причиной восстановления файла в Excel —
    // он начинался с row=HEADER_SUB_ROW (4), но в строке 3 выше есть merged
    // cells (группы колонок). Excel иногда ругается, когда autoFilter
    // пересекается с merges. Убираем авто-фильтр — он не критичен для
    // сводной таблицы КП (пользователь может включить его сам в Excel).
    // Если понадобится — можно вернуть, ограничив диапазон ТОЛЬКО данными:
    //   ws.autoFilter = {
    //     from: { row: HEADER_SUB_ROW, column: 1 },
    //     to:   { row: FIRST_DATA_ROW + rows.length - 1, column: LAST_COL }
    //   };

    // ============================================================
    // 10. СОХРАНЕНИЕ
    // ============================================================
    const yearFolder = path.join(OUTPUT_DIR, String(baseYear || new Date().getFullYear()));
    if (!fs.existsSync(yearFolder)) fs.mkdirSync(yearFolder, { recursive: true });

    const safeNum = String(zaprosNumber || 'without_number')
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim();
    const fileName = `Выбор поставщика заявка№${safeNum}.xlsx`;
    const fullPath = path.join(yearFolder, fileName);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);

    await workbook.xlsx.writeFile(fullPath);

    return {
        path: fullPath,
        relativePath: `/Заявки/${baseYear}/${encodeURIComponent(fileName)}`,
        fileName
    };
}




module.exports = {
    exportZaprosKP,
    createEquipmentTable,
    exportZakazToExcel,
    exportSummaryTableKP,
    getNextZayavkaNumber,
    generatePreviewHTML,
    OUTPUT_DIR,
    TEMPLATES_DIR
};