/**
 * excelMonthCols.js
 *
 * Подключаемый модуль для управления видимостью колонок месяцев в Excel.
 *
 * Используется в exportZakazToExcel и exportZaprosKP для скрытия колонок
 * месяцев, в которых ВСЕ строки данных содержат нули или пустые значения.
 *
 * API:
 *   const mc = require('./excelMonthCols')(ws);
 *
 *   mc.collectMonthData(rowsMonthData, visibleMonths)
 *     — возвращает массив monthData для каждой строки (для записи в ячейки)
 *
 *   mc.getVisibleMonths(rowsMonthData)
 *     — возвращает массив индексов месяцев, в которых есть хотя бы одно
 *       ненулевое значение
 *
 *   mc.writeMonthValues(row, monthColStart, monthData, visibleMonths)
 *     — записывает значения месяцев в строку: в видимых — число, в скрытых — null
 *
 *   mc.hideEmptyColumns(monthColStart, monthCount, visibleMonths)
 *     — скрывает колонки месяцев, не входящих в visibleMonths
 *
 *   mc.applyVisibility(rowsMonthData, monthColStart, monthCount, startRow)
 *     — ПОЛНЫЙ ЦИКЛ: вычисляет видимые месяцы, возвращает их
 *       (запись значений и скрытие колонок делается отдельно — см. usage)
 *
 * Пример использования:
 *
 *   const mc = require('./excelMonthCols')(ws);
 *
 *   // 1. Собираем данные по месяцам для каждой строки
 *   const rowsMonthData = positions.map(pos => {
 *       const monthData = new Array(MONTH_COUNT).fill(0);
 *       pos.grafiks.forEach(g => {
 *           const m = parseInt(g.etap_nomer);
 *           if (m >= 1 && m <= MONTH_COUNT) {
 *               monthData[m - 1] += parseFloat(String(g.plan_kolvo).replace(',', '.')) || 0;
 *           }
 *       });
 *       return monthData;
 *   });
 *
 *   // 2. Вычисляем видимые месяцы
 *   const visibleMonths = mc.getVisibleMonths(rowsMonthData);
 *
 *   // 3. Записываем значения (null для скрытых)
 *   positions.forEach((pos, idx) => {
 *       const row = FIRST_DATA_ROW + idx;
 *       mc.writeMonthValues(row, MONTH_COL_START, rowsMonthData[idx], visibleMonths);
 *   });
 *
 *   // 4. Скрываем пустые колонки
 *   mc.hideEmptyColumns(MONTH_COL_START, MONTH_COUNT, visibleMonths);
 */

'use strict';

/**
 * Создаёт экземпляр утилит для конкретного worksheet
 * @param {import('exceljs').Worksheet} ws
 */
function createMonthColsUtils(ws) {
    if (!ws) throw new Error('createMonthColsUtils: ws обязателен');

    /**
     * Возвращает массив индексов месяцев, в которых есть хотя бы одно
     * ненулевое значение во ВСЕХ строках данных.
     *
     * @param {Array<Array<number>>} rowsMonthData — массив массивов значений по месяцам
     * @returns {number[]} — массив индексов видимых месяцев (0..MONTH_COUNT-1)
     */
    function getVisibleMonths(rowsMonthData) {
        const visibleMonths = [];
        if (!Array.isArray(rowsMonthData) || rowsMonthData.length === 0) {
            return visibleMonths;
        }
        const monthCount = rowsMonthData[0].length;
        for (let m = 0; m < monthCount; m++) {
            const hasValue = rowsMonthData.some(md => {
                if (md == null) return false;
                const v = parseFloat(md[m]) || 0;
                return v > 0;
            });
            if (hasValue) visibleMonths.push(m);
        }
        return visibleMonths;
    }

    /**
     * Записывает значения месяцев в строку.
     * В видимых месяцах — число (в т.ч. 0), в скрытых — null.
     *
     * @param {number} row — номер строки
     * @param {number} monthColStart — первая колонка месяцев
     * @param {Array<number>} monthData — массив значений по месяцам
     * @param {number[]} visibleMonths — массив индексов видимых месяцев
     * @param {Object} [opts] — доп. опции
     * @param {string} [opts.numFmt='#,##0'] — числовой формат
     * @param {Object} [opts.alignment] — выравнивание (по умолчанию center/middle)
     */
    function writeMonthValues(row, monthColStart, monthData, visibleMonths, opts = {}) {
        const numFmt = opts.numFmt || '#,##0';
        const alignment = opts.alignment || { horizontal: 'center', vertical: 'middle' };

        const monthCount = monthData.length;
        const visibleSet = new Set(visibleMonths);

        for (let m = 0; m < monthCount; m++) {
            const cell = ws.getCell(row, monthColStart + m);
            cell.value = visibleSet.has(m) ? monthData[m] : null;
            cell.numFmt = numFmt;
            cell.alignment = alignment;
        }
    }

    /**
     * Скрывает колонки месяцев, не входящих в visibleMonths.
     *
     * @param {number} monthColStart — первая колонка месяцев
     * @param {number} monthCount — количество месяцев
     * @param {number[]} visibleMonths — массив индексов видимых месяцев
     */
    function hideEmptyColumns(monthColStart, monthCount, visibleMonths) {
        const visibleSet = new Set(visibleMonths);
        for (let m = 0; m < monthCount; m++) {
            ws.getColumn(monthColStart + m).hidden = !visibleSet.has(m);
        }
    }

    /**
     * Восстанавливает видимость всех колонок месяцев (отменяет скрытие).
     * Полезно, если шаблон мог сохранить флаг hidden от предыдущих запусков.
     *
     * @param {number} monthColStart
     * @param {number} monthCount
     */
    function showAllColumns(monthColStart, monthCount) {
        for (let m = 0; m < monthCount; m++) {
            ws.getColumn(monthColStart + m).hidden = false;
        }
    }

    /**
     * Полный цикл: вычисляет видимые месяцы и скрывает пустые колонки.
     * Запись значений в ячейки нужно делать отдельно (через writeMonthValues),
     * т.к. формат записи зависит от контекста (с доп. колонками, без них и т.д.).
     *
     * @param {Array<Array<number>>} rowsMonthData
     * @param {number} monthColStart
     * @param {number} monthCount
     * @returns {number[]} visibleMonths — массив индексов видимых месяцев
     */
    function applyVisibility(rowsMonthData, monthColStart, monthCount) {
        const visibleMonths = getVisibleMonths(rowsMonthData);
        hideEmptyColumns(monthColStart, monthCount, visibleMonths);
        return visibleMonths;
    }

    return {
        getVisibleMonths,
        writeMonthValues,
        hideEmptyColumns,
        showAllColumns,
        applyVisibility
    };
}

module.exports = createMonthColsUtils;
module.exports.default = createMonthColsUtils;
