// common/clipboard-import.js
// Универсальный импорт из буфера обмена с дедупликацией.
// Версия: 3.0 — поддерживает async preprocessRow и async onDuplicate.
// Версия: 3.1 — ✅ lookupFields: текст из ячейки -> ID записи справочника
//                    (например, «А123БВ» -> id_osnastka, «03 — Заготовительный» -> cex_zatrat);
//               ✅ dateFields: «01.02.2026» -> «2026-02-01» (формат input[type=date]);
//               ✅ requiredFields стал опциональным (по умолчанию []);
//               ✅ расширены ключи распознавания строки-заголовка (год, марка, деталь...);
//               ✅ обязательные lookup-поля помечаются «*» в подсказке формата.
// Версия: 3.1.1 — ✅ диагностика: маркер версии в консоли при загрузке модуля
//                    (защита от ситуации «на сервере остался старый файл»);
//                    ✅ понятная ошибка, если справочник загрузился ПУСТЫМ;
//                    ✅ при ненайденном значении в консоль выводятся размер
//                    справочника и примеры значений (что реально загрузилось).
// Версия: 3.1.2 — ✅ сводка конфига импорта в консоли при запуске (видно, дошли
//                    ли lookupFields от app-файла — защита от старого app-файла);
//                    ✅ отказ сервера: номер строки + причина + точный payload
//                    в консоли; итоговый тост считает ошибки сервера.
import { api, toast } from './utils.js';
import { batchManager } from './batch-update.js';

// ✅ 3.1.1 Маркер версии: откройте консоль DevTools (F12) — если этой строки нет,
// браузер использует ЗАКАЧИРОВАННУЮ старую версию файла (Ctrl+F5 / очистка кэша)
console.info('[clipboard-import] v3.1.2 loaded — lookupFields + dateFields доступны');

// ============================================================
// ЭКРАНИРОВАНИЕ HTML
// ============================================================
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

// ============================================================
// ✅ 3.1 СПРАВОЧНИКИ ДЛЯ LOOKUP-ПОЛЕЙ (текст -> ID)
// ============================================================

// Нормализация для сопоставления: trim, lower, ё->е, пробелы схлопнуть
function normRef(v) {
    return String(v ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}
// Ключ без пробелов вообще («а 123 бв» == «а123бв»)
function normRefKey(v) {
    return normRef(v).replace(/\s+/g, '');
}

// Варианты запроса из ячейки: вся ячейка + части по тире С ПРОБЕЛАМИ,
// чтобы не разрезать чертежи вида «210-01-4600»
function refQueryVariants(raw) {
    const s = String(raw ?? '').trim();
    const out = new Set([s]);
    const em = s.split(/\s+[—–]\s+/);
    if (em.length > 1) em.forEach(p => out.add(p.trim()));
    const hy = s.split(/\s+-\s+/);
    if (hy.length > 1) hy.forEach(p => out.add(p.trim()));
    return [...out].filter(Boolean);
}

// Все «узнаваемые» строки одной записи справочника:
// id (valueKey), значения matchFields, составная «a — b», результат displayFormat
function refRowCandidates(row, opts) {
    const cands = [];
    const valueKey = opts.valueKey || 'id';
    if (row[valueKey] != null) cands.push(String(row[valueKey]));
    (opts.matchFields || []).forEach(f => {
        if (row[f] != null && String(row[f]).trim() !== '') cands.push(String(row[f]));
    });
    if ((opts.matchFields || []).length > 1) {
        const comp = (opts.matchFields || [])
            .map(f => String(row[f] ?? '').trim())
            .filter(Boolean)
            .join(' — ');
        if (comp) cands.push(comp);
    }
    if (typeof opts.displayFormat === 'function') {
        try {
            const d = opts.displayFormat(row);
            if (d != null) cands.push(String(d));
        } catch (e) { /* displayFormat не обязан работать на каждой строке */ }
    }
    return cands;
}

// Строки справочника по URL (кэш на один вызов importFromClipboard).
// Ошибка загрузки тоже кэшируется — чтобы не дёргать API на каждой строке.
function loadRefRows(url, cache) {
    if (!cache.has(url)) {
        cache.set(url, api('GET', url).then(rows => {
            if (rows && rows.error) throw new Error(rows.error);
            if (!Array.isArray(rows)) throw new Error('ожидался массив, пришло: ' + typeof rows);
            return rows;
        }));
    }
    return cache.get(url);
}

// Карта сопоставления для конкретного lookup-поля (кэш на вызов)
async function loadRefMap(field, opts, refRowsCache, refMapsCache) {
    if (refMapsCache.has(field)) return refMapsCache.get(field);
    const rows = await loadRefRows(opts.url, refRowsCache);
    // ✅ 3.1.1 пустой справочник — отдельная диагностируемая ситуация
    // (например, API вернул [] из-за фильтра/прав доступа)
    if (rows.length === 0) {
        throw new Error('справочник пуст (0 записей) — проверьте таблицу/фильтры ' + opts.url);
    }
    const byNorm = new Map(), byKey = new Map();
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        for (const c of refRowCandidates(row, opts)) {
            const n = normRef(c), k = normRefKey(c);
            if (n && !byNorm.has(n)) byNorm.set(n, row);
            if (k && !byKey.has(k)) byKey.set(k, row);
        }
    }
    const map = { byNorm, byKey, rowCount: rows.length };
    refMapsCache.set(field, map);
    return map;
}

// Поиск записи справочника по вставленному тексту (или null)
function matchRefRow(raw, refMap) {
    for (const v of refQueryVariants(raw)) {
        const row = refMap.byNorm.get(normRef(v)) || refMap.byKey.get(normRefKey(v));
        if (row) return row;
    }
    return null;
}

// ✅ 3.1.1 Примеры значений справочника для диагностики в консоли:
// при ненайденном совпадении видно, ЧТО реально загрузилось из API
function refMapSamples(refMap, opts, n = 5) {
    const seen = new Set();
    for (const row of refMap.byNorm.values()) {
        for (const f of (opts.matchFields || [])) {
            const v = String(row?.[f] ?? '').trim();
            if (v) seen.add(v);
        }
        if (seen.size >= n) break;
    }
    return [...seen].slice(0, n).join(' | ');
}

// ============================================================
// БЛОК-ПОДСКАЗКА: ожидаемый порядок колонок для вставки.
// ============================================================
function buildFormatHint(config = {}) {
    const keys   = config.fields || [];
    const labels = config.columnHints || keys;
    if (!labels || labels.length === 0) return '';

    const required = new Set(config.requiredFields || []);
    // ✅ 3.1 обязательные lookup-поля тоже помечаем звёздочкой
    Object.entries(config.lookupFields || {}).forEach(([field, opts]) => {
        if (opts && opts.required) required.add(field);
    });
    const items = labels.map((label, i) => {
        const key = keys[i] || label;
        const req = required.has(key) ? ' <b style="color:#cf222e;">*</b>' : '';
        return `<li style="margin:0 0 2px 0;"><b>${i + 1}.</b> ${escapeHtml(label)}${req}</li>`;
    }).join('');

    const example = labels.join(' | ');

    return `
        <div style="margin:0 0 10px; padding:8px 10px; background:#f6f8fa;
                    border:1px solid #d0d7de; border-radius:4px;
                    font-size:12px; color:#1f2328;">
            <div style="font-weight:600; margin-bottom:4px;">
                Ожидаемый порядок колонок (как в Excel, через TAB):
            </div>
            <ol style="margin:0 0 6px 20px; padding:0;">${items}</ol>
            <div style="color:#57606a;">
                Пример строки:
                <code style="background:#fff; padding:1px 4px; border:1px solid #d0d7de;
                             border-radius:3px;">${escapeHtml(example)}</code>
            </div>
            <div style="color:#57606a; margin-top:4px; font-size:11px;">
                <b style="color:#cf222e;">*</b> — обязательное поле.
                Разделитель: TAB (копирование из Excel), «;» или «,».
                Строка-заголовок пропускается автоматически.
            </div>
        </div>
    `;
}

// ============================================================
// МОДАЛКА ДЛЯ ВСТАВКИ
// ============================================================
function fallbackPaste(config = {}, prefillText = '') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top:0; left:0; width:100%; height:100%;
            background: rgba(0,0,0,0.5); z-index: 9999;
            display: flex; align-items: center; justify-content: center;
        `;
        const modal = document.createElement('div');
        modal.style.cssText = `
            background: white; padding: 20px; border-radius: 8px;
            max-width: 640px; width: 92%; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        `;

        const hint = buildFormatHint(config);
        const labels = config.columnHints || config.fields || [];
        const placeholder = labels.length
            ? labels.join('\t')
            : 'Вставьте сюда скопированные строки...';

        modal.innerHTML = `
            <h3 style="margin-top:0;">Вставьте данные из буфера обмена</h3>
            ${hint}
            <textarea id="pasteArea"
                style="width:100%; height:200px; font-family:monospace; padding:8px;
                       border:1px solid #ccc; border-radius:4px;"
                placeholder="${escapeHtml(placeholder)}"></textarea>
            <div style="margin-top:12px; display:flex; gap:10px; justify-content:flex-end;">
                <button id="pasteCancel" style="padding:6px 18px; border:1px solid #ccc; background:#f5f5f5; border-radius:4px; cursor:pointer;">Отмена</button>
                <button id="pasteOk" style="padding:6px 18px; background:#007bff; color:white; border:none; border-radius:4px; cursor:pointer;">Вставить</button>
            </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const textarea  = modal.querySelector('#pasteArea');
        const okBtn     = modal.querySelector('#pasteOk');
        const cancelBtn = modal.querySelector('#pasteCancel');

        if (prefillText) {
            textarea.value = prefillText;
        }

        const cleanup = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        };
        const handleOk     = () => { cleanup(); resolve(textarea.value); };
        const handleCancel = () => { cleanup(); resolve(null); };

        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', escHandler);
                handleCancel();
            }
        });
        textarea.focus();
    });
}

/**
 * Универсальный импорт из буфера обмена с дедупликацией.
 *
 * ✅ Версия 3.0: preprocessRow и onDuplicate поддерживают async.
 * ✅ Версия 3.1: lookupFields (текст -> ID справочника) и dateFields.
 *
 * @param {Object} config
 * @param {string} config.tableName
 * @param {string} config.apiUrl
 * @param {string[]} config.fields
 * @param {string[]} [config.requiredFields] — по умолчанию [] (ничего не блокируем на клиенте)
 * @param {string[]} [config.booleanFields]
 * @param {string[]} [config.numericFields]
 * @param {string[]} [config.dateFields] — ✅ 3.1: «01.02.2026» -> «2026-02-01»
 * @param {string[]} [config.columnHints]
 * @param {Function} config.getData
 * @param {Function} config.load
 * @param {Function} config.clearForm
 * @param {Function} config.updateButtons
 * @param {string} [config.delimiter]
 * @param {string[]} [config.booleanTrueValues]
 * @param {string[]} [config.booleanFalseValues]
 *
 * ✅ 3.1 lookupFields — преобразование текста в ID справочника, выполняется
 *     ДО preprocessRow и проверки requiredFields (они видят уже готовые ID):
 *     lookupFields: {
 *         id_osnastka: {
 *             url: '/api/osnastka',            // GET-список записей справочника
 *             valueKey: 'id',                  // поле записи -> значение для obj (по умолчанию 'id')
 *             matchFields: ['nomer_chertezha'],// по каким полям сопоставлять текст
 *             displayFormat: (row) => ...,     // опц.: узнаваемая строка целиком («чертёж — наименование»)
 *             label: 'Деталь (оснастка)',      // опц.: человекочитаемое имя для сообщений
 *             required: true,                  // не найдено -> строка пропускается с причиной;
 *                                              // false -> поле очищается, строка импортируется
 *             autofill: { peredel: 'peredel' } // опц.: дозаполнить пустые поля obj
 *                                              // из найденной записи справочника
 *         }
 *     }
 *     Сопоставление устойчиво к регистру, «ё/е», пробелам и тире:
 *     «а 123 бв» найдёт «А123БВ», «210-01-4600 — Стойка» найдёт чертёж 210-01-4600.
 *
 * @param {Function} [config.preprocessRow] — может быть async: (obj, cols) => obj | null | Promise<obj|null>
 * @param {Function} [config.isDuplicate] — ✅ () => false отключает дедупликацию:
 *                          каждая строка создаёт новую запись (для таблиц, где
 *                          дубликаты допустимы по природе данных, напр. план)
 * @param {Function} [config.onDuplicate]   — async (existingRow, newObj) => void
 */
export async function importFromClipboard(config) {
    let prefillText = '';

    if (navigator.clipboard && navigator.clipboard.readText) {
        try {
            prefillText = await navigator.clipboard.readText() || '';
        } catch (e) {
            console.warn('Clipboard API readText failed, will show modal:', e);
        }
    }

    const rawText = await fallbackPaste(config, prefillText);
    if (rawText === null) {
        toast('Операция отменена', 'info');
        return;
    }

    // ✅ 3.1.2 Сводка конфига в консоль: мгновенно видно, дошел ли importConfig
    // (lookupFields!) от app-файла до механизма. «lookupFields: НЕТ (!)» означает,
    // что app-файл старый (или simple-crud-app передаёт конфиг не целиком)
    console.info('[clipboard-import] конфиг импорта: полей: ' + (config.fields || []).length +
        '; lookupFields: ' + (config.lookupFields ? Object.keys(config.lookupFields).join(', ') : 'НЕТ (!)') +
        '; isDuplicate: ' + (typeof config.isDuplicate === 'function' ? 'задан' : 'по умолчанию'));

    // ✅ Хук предварительной подготовки (async) — например, загрузка справочников
    if (typeof config.beforeParse === 'function') {
        try {
            await config.beforeParse(config);
        } catch (e) {
            console.warn('[clipboard-import] beforeParse failed:', e);
        }
    }

    try {
        const text = rawText;
        if (!text.trim()) {
            toast('Буфер обмена пуст', 'warning');
            return;
        }

        const rows = text.split('\n').filter(line => line.trim() !== '');
        if (rows.length === 0) {
            toast('Нет данных для вставки', 'warning');
            return;
        }

        let delimiter = config.delimiter || '\t';
        if (!rows[0].includes(delimiter)) {
            if (rows[0].includes(';')) delimiter = ';';
            else if (rows[0].includes(',')) delimiter = ',';
        }

        const parsed = rows.map(line => line.split(delimiter).map(s => s.trim()));

        let startIndex = 0;
        const firstRow = parsed[0];
        if (firstRow.length >= 2) {
            const firstVal = firstRow[0].toLowerCase();
            // ✅ 3.1 добавлены: год, марка, деталь, чертеж (для плана и др. страниц)
            const headerKeywords = ['цех', 'передел', 'название', 'фио', 'fio', 'email', 'телефон', 'тип', 'оснастка', 'начальник', 'чертеж', 'чертежа', 'наименование', 'код', 'содержание', '№', 'год', 'марка', 'деталь'];
            if (headerKeywords.some(kw => firstVal.includes(kw))) {
                startIndex = 1;
            }
        }

        let existingData = config.getData();
        if (!existingData || existingData.length === 0) {
            await config.load();
            existingData = config.getData() || [];
        }

        const boolFields = config.booleanFields || [];
        const numFields = config.numericFields || [];
        const dateFields = config.dateFields || [];   // ✅ 3.1
        const trueValues = config.booleanTrueValues || ['1', 'true', 'да', 'yes', 'истина'];
        const falseValues = config.booleanFalseValues || ['0', 'false', 'нет', 'no', 'ложь'];

        // ✅ 3.1 кэши справочников для lookupFields (живут один вызов импорта)
        const refRowsCache = new Map();
        const refMapsCache = new Map();

        // Сначала парсим все строки в «сырые» объекты (без preprocessRow)
        const rawObjs = [];
        const skipped = [];
        let updatedCount = 0;

        for (let i = startIndex; i < parsed.length; i++) {
            const cols = parsed[i];
            if (cols.length === 0) continue;

            const obj = {};
            config.fields.forEach((field, idx) => {
                let value = (idx < cols.length) ? cols[idx] : '';

                if (boolFields.includes(field)) {
                    const lower = value.toLowerCase().trim();
                    if (trueValues.includes(lower)) {
                        value = 1;
                    } else if (falseValues.includes(lower)) {
                        value = 0;
                    } else {
                        const num = Number(value);
                        if (!isNaN(num)) {
                            value = num ? 1 : 0;
                        } else {
                            value = 0;
                        }
                    }
                }

                if (numFields.includes(field)) {
                    const normalized = value.toString().replace(',', '.').replace(/\s/g, '');
                    const num = parseFloat(normalized);
                    value = isNaN(num) ? 0 : num;
                }

                // ✅ 3.1 даты: «01.02.2026» -> «2026-02-01» (формат input[type=date]);
                // нераспознанная дата сохраняется как есть с предупреждением в консоль
                if (dateFields.includes(field) && value) {
                    const s = String(value).trim();
                    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);              // 2026-02-01 (+возможно время)
                    if (m) {
                        value = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
                    } else if ((m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/))) {  // 01.02.2026 | 01/02/2026
                        value = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
                    } else {
                        console.warn(`[clipboard-import] поле ${field}: дата «${s}» не распознана, сохранена как есть`);
                    }
                }

                obj[field] = value;
            });

            rawObjs.push({ obj, cols, lineNo: i + 1 });
        }

        // ✅ Применяем preprocessRow (с поддержкой async)
        const toAdd = [];
        const requiredFields = config.requiredFields || [];   // ✅ 3.1 защита от undefined
        for (const { obj, cols, lineNo } of rawObjs) {
            // ✅ 3.1 lookupFields: текст из ячейки -> ID записи справочника.
            // Выполняется ДО preprocessRow и requiredFields — они видят готовые ID.
            if (config.lookupFields) {
                let rowSkipped = false;
                for (const [field, opts] of Object.entries(config.lookupFields)) {
                    if (!opts || !opts.url) continue;
                    const raw = String(obj[field] ?? '').trim();

                    if (!raw) {
                        if (opts.required) {
                            skipped.push(`Строка ${lineNo}: не заполнено поле «${opts.label || field}»`);
                            rowSkipped = true;
                        }
                        continue;
                    }

                    let refMap = null;
                    try {
                        refMap = await loadRefMap(field, opts, refRowsCache, refMapsCache);
                    } catch (e) {
                        skipped.push(`Строка ${lineNo}: справочник «${opts.label || field}» (${opts.url}) недоступен: ${e.message}`);
                        rowSkipped = true;
                        break;
                    }

                    const refRow = matchRefRow(raw, refMap);
                    if (refRow) {
                        obj[field] = refRow[opts.valueKey || 'id'];
                        // Автозаполнение зависимых полей из найденной записи
                        // (например, передел из цеха — как dataProps комбобокса формы);
                        // явно вставленные значения не перезатираем
                        if (opts.autofill) {
                            for (const [target, src] of Object.entries(opts.autofill)) {
                                if (!String(obj[target] ?? '').trim()) obj[target] = refRow[src] ?? '';
                            }
                        }
                    } else {
                        // ✅ 3.1.1 развёрнутая диагностика: сразу отличаем «нет такой
                        // записи» от «справочник не загрузился / загрузился частично»
                        const samples = refMapSamples(refMap, opts);
                        console.warn(
                            `[clipboard-import] Строка ${lineNo}: «${opts.label || field}»: «${raw}» не найдено в ${opts.url} ` +
                            `(записей: ${refMap.rowCount ?? refMap.byNorm.size})${samples ? '; примеры: ' + samples : ''}`
                        );
                        if (opts.required) {
                            skipped.push(`Строка ${lineNo}: «${opts.label || field}» не найдено в справочнике: «${raw}»`);
                            rowSkipped = true;
                        } else {
                            // Не найдено, но поле необязательное: очищаем, чтобы текст
                            // не ушёл в FK-поле, и импортируем строку дальше
                            obj[field] = '';
                        }
                    }
                }
                if (rowSkipped) continue;
            }

            let finalObj = obj;
            if (typeof config.preprocessRow === 'function') {
                try {
                    const result = await config.preprocessRow(obj, cols);
                    if (result === null) {
                        skipped.push(`Строка ${lineNo}: пропущена preprocessRow`);
                        continue;
                    }
                    if (result && typeof result === 'object') {
                        Object.assign(obj, result);
                    }
                } catch (e) {
                    skipped.push(`Строка ${lineNo}: ошибка preprocessRow: ${e.message}`);
                    continue;
                }
            }

            const missing = requiredFields.filter(f => !obj[f]);
            if (missing.length > 0) {
                skipped.push(`Строка ${lineNo}: отсутствуют обязательные поля: ${missing.join(', ')}`);
                continue;
            }

            const existingRow = existingData.find(row => {
                if (typeof config.isDuplicate === 'function') {
                    return config.isDuplicate(row, obj);
                }
                return config.fields.every(field =>
                    String(row[field]).trim().toLowerCase() === String(obj[field]).trim().toLowerCase()
                );
            });

            if (existingRow) {
                if (typeof config.onDuplicate === 'function') {
                    try {
                        await config.onDuplicate(existingRow, obj);
                        updatedCount++;
                        Object.assign(existingRow, obj);
                    } catch (e) {
                        skipped.push(`Строка ${lineNo} (${obj[config.fields[0]] || '???'}): ${e.message}`);
                    }
                } else {
                    skipped.push(`Строка ${lineNo}: дубликат`);
                }
                continue;
            }

            toAdd.push({ obj, lineNo });
        }

        // Пакетная вставка новых записей
        let addedCount = 0;
        let serverErrors = 0;
        if (toAdd.length > 0) {
            await batchManager.withBatch(config.tableName, async () => {
                for (const { obj, lineNo } of toAdd) {
                    const r = await api('POST', config.apiUrl, obj);
                    if (r.error) {
                        serverErrors++;
                        // ✅ 3.1.2 полная диагностика отказа сервера: номер строки,
                        // причина и точный payload — без этого «почему 400» не видно
                        console.warn(`[clipboard-import] Сервер отклонил строку ${lineNo}: ${r.error}; payload:`, obj);
                        toast(`Строка ${lineNo}: ${r.error}`, 'error');
                    } else {
                        addedCount++;
                    }
                }
            });
        }

        await config.load();
        config.clearForm();
        config.updateButtons();

        const msg = `Добавлено: ${addedCount}, обновлено: ${updatedCount}, пропущено: ${skipped.length}` +
            (serverErrors ? `, ошибок сервера: ${serverErrors}` : '');

        if (toAdd.length === 0 && updatedCount === 0) {
            if (skipped.length > 0) {
                toast(msg + ` (подробности в консоли)`, 'info');
                console.warn('Пропущенные строки:', skipped);
            } else {
                toast('Нет новых записей для добавления', 'info');
            }
            return;
        }

        if (skipped.length > 0 || serverErrors > 0) {
            // ✅ 3.1.2 если сервер отклонил ВСЁ — это не «success», а warning
            toast(msg + ` (подробности в консоли)`,
                (serverErrors > 0 && addedCount === 0 && updatedCount === 0) ? 'warning' : 'info');
            if (skipped.length > 0) console.warn('Пропущенные строки:', skipped);
        } else {
            toast(msg, 'success');
        }
    } catch (err) {
        console.error(err);
        toast('Ошибка обработки данных: ' + err.message, 'error');
    }
}
