// ============================================================
// public/js/common/date-helpers.js
// Единые функции форматирования дат для всего клиента
// ============================================================

/**
 * Дата в формате YYYY-MM-DD (для сохранения в БД)
 * @param {Date|string|number} [date] — дата, по умолчанию — сейчас
 * @returns {string} "2026-08-10"
 */
export function sqlDate(date) {
    const d = date ? new Date(date) : new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Дата и время в формате YYYY-MM-DD HH:MM:SS (для сохранения в БД)
 * @param {Date|string|number} [date] — дата, по умолчанию — сейчас
 * @returns {string} "2026-08-10 14:30:00"
 */
export function sqlDateTime(date) {
    const d = date ? new Date(date) : new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/**
 * Дата для отображения людям: DD.MM.YYYY
 * @param {Date|string|number} [date]
 * @returns {string} "10.08.2026"
 */
export function displayDate(date) {
    if (!date) return '';
    // Если уже YYYY-MM-DD — конвертируем для отображения
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const [y, m, d] = date.split('-');
        return `${d}.${m}.${y}`;
    }
    const d = new Date(date);
    if (isNaN(d)) return date; // не смогли распарсить — возвращаем как есть
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

/**
 * Дата и время для отображения людям: DD.MM.YYYY HH:MM
 */
export function displayDateTime(date) {
    if (!date) return '';
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(date)) {
        const [datePart, timePart] = date.split(/[ T]/);
        const [y, m, d] = datePart.split('-');
        return `${d}.${m}.${y} ${timePart.substring(0, 5)}`;
    }
    const d = new Date(date);
    if (isNaN(d)) return date;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

/**
 * Нормализация даты из ЛЮБОГО формата в YYYY-MM-DD.
 * Используется перед отправкой на сервер для полей type="text",
 * которые могли получить дату в формате DD.MM.YYYY с сервера.
 *
 * @param {string} value — строка из input
 * @returns {string} YYYY-MM-DD или '' если пусто/невалидно
 */
export function normalizeToSqlDate(value) {
    if (!value || value === 'не отправлялось' || value === 'не согласовано') return '';
    const v = value.trim();
    // Уже YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    // DD.MM.YYYY
    const m1 = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
    // YYYY-MM-DD HH:MM:SS → берём только дату
    const m2 = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m2) return m2[1];
    // DD.MM.YYYY HH:MM
    const m3 = v.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (m3) return `${m3[3]}-${m3[2]}-${m3[1]}`;
    // ISO 8601
    const m4 = v.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (m4) return m4[1];
    console.warn(`[normalizeToSqlDate] Неизвестный формат даты: "${value}"`);
    return '';
}

/**
 * Нормализация даты из ЛЮБОГО формата в YYYY-MM-DD HH:MM:SS.
 * @param {string} value
 * @returns {string}
 */
export function normalizeToSqlDateTime(value) {
    if (!value || value === 'не отправлялось' || value === 'не согласовано') return '';
    const v = value.trim();
    // Уже YYYY-MM-DD HH:MM:SS
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return v;
    // YYYY-MM-DD HH:MM (без секунд)
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) return v + ':00';
    // YYYY-MM-DD → полночь
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + ' 00:00:00';
    // DD.MM.YYYY HH:MM
    const m1 = v.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
    if (m1) return `${m1[3]}-${m1[2]}-${m1[1]} ${m1[4]}:${m1[5]}:00`;
    // DD.MM.YYYY
    const m2 = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m2) return `${m2[3]}-${m2[2]}-${m2[1]} 00:00:00`;
    // ISO 8601 → YYYY-MM-DD HH:MM:SS
    const m3 = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
    if (m3) return `${m3[1]} ${m3[2]}`;
    console.warn(`[normalizeToSqlDateTime] Неизвестный формат даты: "${value}"`);
    return '';
}