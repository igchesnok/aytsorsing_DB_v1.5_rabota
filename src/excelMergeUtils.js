/**
 * excelMergeUtils.js
 *
 * Подключаемый модуль для работы с объединениями ячеек exceljs.
 *
 * Решает проблему "Cannot merge already merged cells", которая возникает
 * из-за того, что exceljs хранит merges в двух структурах:
 *   - ws.model.merges  — публичный массив строк (пишется в XLSX)
 *   - ws._merges       — приватный кэш для проверки пересечений
 *
 * После spliceRows эти структуры рассинхронизируются: в ws._merges остаётся
 * "призрак", который unmergeCells не умеет удалять, и последующий
 * mergeCells падает с "already merged", хотя ячейки визуально разделены.
 *
 * API:
 *   const mu = require('./excelMergeUtils')(ws);
 *
 *   mu.clearMergesInRange(topRow, bottomRow, leftCol, rightCol)
 *     — вычищает все merges, пересекающие диапазон, из обеих структур
 *
 *   mu.forceMergeCells(top, left, bottom, right)
 *     — mergeCells с жёстким fallback: при ошибке вычищает призрак и пишет
 *       merge напрямую в обе структуры
 *
 *   mu.getTemplateMerges(rowNum)
 *     — возвращает массив { left, right } горизонтальных объединений в строке
 *
 *   mu.applyTemplateMergesToRange(templateMerges, startRow, endRow, lastCol)
 *     — применяет объединения шаблона ко всем строкам диапазона
 *
 *   mu.prepareForSplice(templateRowStart, templateRowEnd, lastCol)
 *     — снимок templateMerges + clearMergesInRange (вызывать ДО spliceRows)
 */

'use strict';

/**
 * Создаёт экземпляр утилит для конкретного worksheet
 * @param {import('exceljs').Worksheet} ws
 */
function createMergeUtils(ws) {
    if (!ws) throw new Error('createMergeUtils: ws обязателен');

    // ================================================================
    // ПАРСЕРЫ АДРЕСОВ
    // ================================================================

    /** "B16" -> { col: 2, row: 16 } */
    function parseAddress(addr) {
        const m = String(addr).match(/([A-Z]+)(\d+)/);
        if (!m) return null;
        let col = 0;
        for (let i = 0; i < m[1].length; i++) {
            col = col * 26 + (m[1].charCodeAt(i) - 64);
        }
        return { col, row: parseInt(m[2], 10) };
    }

    /** "B16:C16" -> { top: 16, bottom: 16, left: 2, right: 3 } */
    function parseRangeStr(rangeStr) {
        if (typeof rangeStr !== 'string') return null;
        const parts = rangeStr.split(':');
        if (parts.length < 2) return null;
        const s = parseAddress(parts[0]);
        const e = parseAddress(parts[1]);
        if (!s || !e) return null;
        return { top: s.row, bottom: e.row, left: s.col, right: e.col };
    }

    /** Координаты -> "B16:C16" */
    function toRangeStr(top, left, bottom, right) {
        return `${ws.getCell(top, left).address}:${ws.getCell(bottom, right).address}`;
    }

    /** Универсальное извлечение bounds (строка или объект с top/bottom) */
    function getMergeBounds(m) {
        if (typeof m === 'string') return parseRangeStr(m);
        if (m && typeof m === 'object') {
            if (m.top !== undefined && m.bottom !== undefined) {
                return { top: m.top, bottom: m.bottom, left: m.left, right: m.right };
            }
            if (m.model && m.model.top !== undefined) {
                return {
                    top: m.model.top, bottom: m.model.bottom,
                    left: m.model.left, right: m.model.right
                };
            }
        }
        return null;
    }

    // ================================================================
    // ОЧИСТКА MERGES
    // ================================================================

    /**
     * ЖЁСТКАЯ очистка merges в диапазоне [topRow..bottomRow, leftCol..rightCol]
     * из обеих структур exceljs. Убивает любые «призраки».
     */
    function clearMergesInRange(topRow, bottomRow, leftCol, rightCol) {
        // Чистим ws._merges (приватный кэш)
        if (ws._merges && typeof ws._merges === 'object') {
            const keysToDelete = [];
            Object.keys(ws._merges).forEach(topLeftAddr => {
                const m = ws._merges[topLeftAddr];
                const b = getMergeBounds(m) || parseRangeStr(topLeftAddr);
                if (!b) return;
                const intersects =
                    b.top <= bottomRow && b.bottom >= topRow &&
                    b.left <= rightCol && b.right >= leftCol;
                if (intersects) keysToDelete.push(topLeftAddr);
            });
            keysToDelete.forEach(k => delete ws._merges[k]);
        }

        // Чистим ws.model.merges (публичный массив)
        if (Array.isArray(ws.model.merges)) {
            ws.model.merges = ws.model.merges.filter(m => {
                const b = getMergeBounds(m);
                if (!b) return true;
                const intersects =
                    b.top <= bottomRow && b.bottom >= topRow &&
                    b.left <= rightCol && b.right >= leftCol;
                return !intersects;
            });
        }
    }

    // ================================================================
    // ЖЁСТКОЕ ОБЪЕДИНЕНИЕ
    // ================================================================

    /**
     * ЖЁСТКОЕ объединение ячеек. При ошибке вычищает призрак и пишет напрямую.
     * @returns {boolean} true если успешно
     */
    function forceMergeCells(topRow, leftCol, bottomRow, rightCol) {
        // Способ 1: официальный API (4 числовых аргумента — самый надёжный)
        try {
            ws.mergeCells(topRow, leftCol, bottomRow, rightCol);
            return true;
        } catch (e) {
            if (!String(e.message).includes('already merged')) {
                // Другая ошибка — пробуем range-строкой
                try {
                    ws.mergeCells(toRangeStr(topRow, leftCol, bottomRow, rightCol));
                    return true;
                } catch (e2) {
                    console.warn(`mergeCells failed (${e.message}, ${e2.message}) — fallback to direct write`);
                }
            }
        }

        // Способ 2: жёсткая очистка и повторная попытка
        clearMergesInRange(topRow, bottomRow, leftCol, rightCol);
        try {
            ws.mergeCells(topRow, leftCol, bottomRow, rightCol);
            return true;
        } catch (e) {
            console.warn(`Прямая запись merge: ${toRangeStr(topRow, leftCol, bottomRow, rightCol)}`);
        }

        // Способ 3: прямая запись в обе структуры
        const topLeftAddr = ws.getCell(topRow, leftCol).address;
        const bottomRightAddr = ws.getCell(bottomRow, rightCol).address;
        const rangeStr = `${topLeftAddr}:${bottomRightAddr}`;

        if (!ws._merges || typeof ws._merges !== 'object') ws._merges = {};
        ws._merges[topLeftAddr] = {
            tl: { row: topRow, col: leftCol },
            br: { row: bottomRow, col: rightCol },
            model: {
                top: topRow, left: leftCol, bottom: bottomRow, right: rightCol,
                topLeft: topLeftAddr,
                bottomRight: bottomRightAddr
            },
            range: rangeStr
        };

        if (!Array.isArray(ws.model.merges)) ws.model.merges = [];
        const exists = ws.model.merges.some(r => typeof r === 'string' && r === rangeStr);
        if (!exists) ws.model.merges.push(rangeStr);

        return true;
    }

    // ================================================================
    // ШАБЛОННЫЕ MERGES
    // ================================================================

    /**
     * Возвращает горизонтальные объединения конкретной строки (template row).
     * @param {number} rowNum — номер строки-шаблона
     * @returns {Array<{left: number, right: number}>}
     */
    function getTemplateMerges(rowNum) {
        const rawMerges = JSON.parse(JSON.stringify(ws.model.merges || []));
        const result = [];
        rawMerges.forEach(m => {
            const b = getMergeBounds(m);
            if (!b) return;
            if (b.top === rowNum && b.bottom === rowNum && b.left !== b.right) {
                result.push({ left: b.left, right: b.right });
            }
        });
        return result;
    }

    /**
     * Применяет templateMerges ко всем строкам диапазона [startRow..endRow].
     * @param {Array<{left: number, right: number}>} templateMerges
     * @param {number} startRow
     * @param {number} endRow
     * @param {number} [lastCol=Infinity] — ограничение правой колонки
     */
    function applyTemplateMergesToRange(templateMerges, startRow, endRow, lastCol = Infinity) {
        for (let r = startRow; r <= endRow; r++) {
            for (const m of templateMerges) {
                const right = Math.min(m.right, lastCol);
                if (right > m.left) {
                    forceMergeCells(r, m.left, r, right);
                }
            }
        }
    }

    /**
     * Подготовка к spliceRows: снимок templateMerges + clearMergesInRange.
     * Вызывать ДО spliceRows.
     *
     * @param {number} templateRowStart — первая строка шаблона
     * @param {number} templateRowEnd   — последняя строка шаблона
     * @param {number} lastCol          — последняя колонка (например 32)
     * @returns {{ templateMerges: Array<{left,right}>, templateRow: number }}
     */
    function prepareForSplice(templateRowStart, templateRowEnd, lastCol) {
        const templateMerges = getTemplateMerges(templateRowStart);
        clearMergesInRange(templateRowStart, templateRowEnd, 1, lastCol);
        return { templateMerges, templateRow: templateRowStart };
    }

    /**
     * Полный цикл: подготовка → spliceRows → применение merges.
     * Внутри spliceFn вы получаете доступ к templateMerges.
     *
     * @param {Object} opts
     * @param {number} opts.templateRowStart
     * @param {number} opts.templateRowEnd
     * @param {number} opts.dataEndRow
     * @param {number} opts.lastCol
     * @param {Function} opts.spliceFn — функция, выполняющая spliceRows и копирование стилей
     *        сигнатура: ({ templateMerges, templateRow }) => void
     */
    function withTemplateRows({ templateRowStart, templateRowEnd, dataEndRow, lastCol, spliceFn }) {
        // T22b: ДЕТЕРМИНИРОВАННАЯ работа с объединениями ячеек.
        // Прежняя логика снимала merges только из ws._merges/ws.model.merges,
        // НЕ разъединяя сами ячейки (MergeValue), а писатель exceljs строит
        // <mergeCell> из ЯЧЕЕК (групп по master). Рассинхрон давал пересекающиеся
        // диапазоны: Excel «восстанавливал» файл, удаляя объединения, а
        // generatePreviewHTML падал с «Cannot merge already merged cells».
        // Теперь: полный снимок -> снятие ВСЕХ объединений (и ячеек, и кэшей) ->
        // вставка строк (без MergeValue внутренний ремердж exceljs молчит) ->
        // детерминированное восстановление с защитой от пересечений.

        const rowsAdded = Math.max(0, dataEndRow - templateRowEnd);

        // 1. Полный снимок всех merges (_merges — источник истины после чтения)
        const snapshot = [];
        const seen = new Set();
        const collect = (list) => {
            (list || []).forEach(m => {
                const b = getMergeBounds(m);
                if (!b) return;
                const key = b.top + ':' + b.left + ':' + b.bottom + ':' + b.right;
                if (seen.has(key)) return;
                seen.add(key);
                snapshot.push({ top: b.top, left: b.left, bottom: b.bottom, right: b.right });
            });
        };
        if (ws._merges && typeof ws._merges === 'object') {
            collect(Object.keys(ws._merges).map(k => ws._merges[k]));
        }
        if (!snapshot.length && Array.isArray(ws.model.merges)) collect(ws.model.merges);

        // горизонтальные merges строки-шаблона — для копирования значений в spliceFn
        const templateMerges = snapshot
            .filter(b => b.top === templateRowStart && b.bottom === templateRowStart && b.left !== b.right)
            .map(b => ({ left: b.left, right: b.right }));

        // 2. Снять ВСЕ объединения (unMergeCells вычищает MergeValue в ячейках)
        snapshot.forEach(b => {
            try { ws.unMergeCells(b.top, b.left, b.bottom, b.right); } catch (e) { /* призрак */ }
        });
        if (ws._merges && typeof ws._merges === 'object') {
            Object.keys(ws._merges).forEach(k => { delete ws._merges[k]; });
        }

        // 3. Вставка строк: MergeValue нет — внутренний ремердж exceljs не вмешивается
        if (typeof spliceFn === 'function') {
            spliceFn({ templateMerges, templateRow: templateRowStart });
        }

        // 4. Восстановление с защитой от пересечений (гарантия валидного файла)
        const applied = [];
        const intersectsApplied = b => applied.some(a =>
            a.top <= b.bottom && b.top <= a.bottom && a.left <= b.right && b.left <= a.right);

        const applySafe = (top, left, bottom, right, tag) => {
            if (!(bottom >= top && top >= 1 && left >= 1)) return;
            const b = { top, left, bottom, right: Math.min(right, lastCol) };
            // T23: ширина 1 — это валидное ВЕРТИКАЛЬНОЕ объединение (A12:A14,
            // D12:D14... шапки заказа; A3:A5...F3:F5 шапки заявки КП).
            // Отбрасываем только перевёрнутый диапазон и одиночную ячейку.
            if (b.right < b.left) return;
            if (b.right === b.left && b.bottom === b.top) return;
            if (intersectsApplied(b)) {
                console.warn('[excelMergeUtils] merge ' + b.top + ',' + b.left + ':' +
                    b.bottom + ',' + b.right + ' (' + tag + ') пересекает восстановленное — пропущен');
                return;
            }
            try {
                ws.mergeCells(b.top, b.left, b.bottom, b.right);
                applied.push(b);
            } catch (e) {
                clearMergesInRange(b.top, b.bottom, b.left, b.right);
                try {
                    ws.mergeCells(b.top, b.left, b.bottom, b.right);
                    applied.push(b);
                } catch (e2) {
                    console.warn('[excelMergeUtils] mergeCells failed: ' + e2.message + ' (' + tag + ')');
                }
            }
        };

        // (а) выше зоны данных — без изменений
        snapshot.forEach(b => {
            if (b.bottom < templateRowStart) applySafe(b.top, b.left, b.bottom, b.right, 'above');
        });
        // (б) шаблонные горизонтальные — в каждую строку данных
        templateMerges.forEach(m => {
            for (let r = templateRowStart; r <= dataEndRow; r++) {
                applySafe(r, m.left, r, m.right, 'data');
            }
        });
        // (в) ниже зоны данных — со сдвигом вниз на число добавленных строк
        snapshot.forEach(b => {
            if (b.top > templateRowEnd) {
                applySafe(b.top + rowsAdded, b.left, b.bottom + rowsAdded, b.right, 'below');
            }
        });
        // (г) пересекающие зону шаблона неоднострочные — восстановить невозможно
        snapshot.forEach(b => {
            const isTplRow = b.top === templateRowStart && b.bottom === templateRowStart;
            if (b.bottom >= templateRowStart && b.top <= templateRowEnd && !isTplRow) {
                console.warn('[excelMergeUtils] merge ' + b.top + ',' + b.left + ':' +
                    b.bottom + ',' + b.right + ' пересекает строки шаблона — не восстановлен');
            }
        });
    }

    return {
        // парсеры (на случай если понадобятся внешне)
        parseAddress,
        parseRangeStr,
        toRangeStr,
        getMergeBounds,

        // основные методы
        clearMergesInRange,
        forceMergeCells,
        getTemplateMerges,
        applyTemplateMergesToRange,
        prepareForSplice,
        withTemplateRows
    };
}

module.exports = createMergeUtils;
module.exports.default = createMergeUtils;
