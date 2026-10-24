// ============================================================
// src/routes/helpers/dateHelpers.js
// Единые функции форматирования дат для всего сервера
// ============================================================

/**
 * Дата в формате YYYY-MM-DD (для полей типа DATE)
 */
function sqlDate(date) {
    const d = date ? new Date(date) : new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Дата и время в формате YYYY-MM-DD HH:MM:SS (для полей типа DATETIME)
 */
function sqlDateTime(date) {
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
 */
function displayDate(date) {
    const d = date ? new Date(date) : new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

/**
 * Дата и время для отображения людям: DD.MM.YYYY HH:MM
 */
function displayDateTime(date) {
    const d = date ? new Date(date) : new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

/**
 * Нормализация: любая строка → YYYY-MM-DD
 */
function normalizeToSqlDate(value) {
    if (!value) return '';
    const v = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const m1 = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
    const m2 = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m2) return m2[1];
    const m3 = v.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (m3) return `${m3[3]}-${m3[2]}-${m3[1]}`;
    const m4 = v.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (m4) return m4[1];
    return '';
}

/**
 * Нормализация: любая строка → YYYY-MM-DD HH:MM:SS
 */
function normalizeToSqlDateTime(value) {
    if (!value) return '';
    const v = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return v;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) return v + ':00';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + ' 00:00:00';
    const m1 = v.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
    if (m1) return `${m1[3]}-${m1[2]}-${m1[1]} ${m1[4]}:${m1[5]}:00`;
    const m2 = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m2) return `${m2[3]}-${m2[2]}-${m2[1]} 00:00:00`;
    const m3 = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
    if (m3) return `${m3[1]} ${m3[2]}`;
    return '';
}

module.exports = {
    sqlDate, sqlDateTime,
    displayDate, displayDateTime,
    normalizeToSqlDate, normalizeToSqlDateTime
};