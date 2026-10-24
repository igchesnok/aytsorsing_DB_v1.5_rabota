// ============================================================
// src/routes/helpers/fkHelpers.js
// Общие хелперы для работы с Foreign Key и валидации данных
// Подключаются ко всем роутам, работающим с БД
// ============================================================

/**
 * Роут
 * ______________________________________________________________________________________
 *  Какие хелперы использовать
 *  transportOperRoutes.js      normalizeFk, validateFk, validateFkArray, safeNum, safeStr
 *  planRoutes.js               validateFk (для id_osnastka, id_kp, cex_zatrat), safeNum
 *  zaprosKpRoutes.js           validateFkArray (для позиций плана), safeStr
 *  dogovorRoutes.js            validateFk (для id_firmy), safeNum, safeStr
 *  kontRoutes.js               validateFk (для id_firmy), safeBool
 *  adresRoutes.js              validateFk (для id_firmy), safeStr
 *  planPerevozokRoutes.js      validateFk (для id_plana, id_tipa_perevozki, id_shag), safeNum
 *  osnastkaRoutes.js           safeNum, safeBool
 *  cexRoutes.js                safeStr
 * _____________________________________________________________
 * Нормализует FK-поле: пустая строка → null
 * SQLite требует null (а не '') для опциональных внешних ключей
 *
 * @param {string|undefined|null} value - значение из запроса
 * @returns {string|null} - нормализованное значение
 *
 * @example
 * normalizeFk('')           // → null
 * normalizeFk('  ')         // → null
 * normalizeFk('F_123')      // → 'F_123'
 * normalizeFk(undefined)    // → null
 */
function normalizeFk(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed !== '' ? trimmed : null;
}

/**
 * Пре-валидация одного FK: проверяет существование записи в справочнике
 *
 * @param {Database} db - объект базы данных
 * @param {string} table - имя таблицы справочника
 * @param {string} pkColumn - имя первичного ключа
 * @param {string|null} fkValue - значение FK (null пропускается)
 * @param {string} fieldName - имя поля для сообщения об ошибке
 * @returns {Promise<{ok: boolean, error?: string}>}
 *
 * @example
 * const check = await validateFk(db, 'firmy', 'id_firmy', d.id_firma, 'Фирма');
 * if (!check.ok) return send(res, 400, { error: check.error });
 */
async function validateFk(db, table, pkColumn, fkValue, fieldName) {
    if (fkValue === null || fkValue === undefined) {
        return { ok: true };  // null допустим (опциональный FK)
    }

    try {
        const row = await db.get(
            `SELECT ${pkColumn} FROM ${table} WHERE ${pkColumn} = ?`,
            [fkValue]
        );

        if (!row) {
            return {
                ok: false,
                error: `${fieldName} "${fkValue}" не найдено в справочнике ${table}`
            };
        }

        return { ok: true };
    } catch (e) {
        return {
            ok: false,
            error: `Ошибка проверки ${fieldName}: ${e.message}`
        };
    }
}

/**
 * Пре-валидация массива FK (например, id_plana в позициях)
 *
 * @param {Database} db
 * @param {string} table - имя таблицы
 * @param {string} pkColumn - имя PK
 * @param {string[]} fkValues - массив значений FK
 * @param {string} fieldName - имя поля для сообщения
 * @returns {Promise<{ok: boolean, error?: string, missing?: string[]}>}
 *
 * @example
 * const planIds = d.positions.map(p => p.id_plana);
 * const check = await validateFkArray(db, 'plan', 'id', planIds, 'Позиции плана');
 * if (!check.ok) return send(res, 400, { error: check.error });
 */
async function validateFkArray(db, table, pkColumn, fkValues, fieldName) {
    if (!fkValues || fkValues.length === 0) {
        return { ok: true };
    }

    try {
        // Убираем дубликаты и пустые значения
        const uniqueIds = [...new Set(fkValues.filter(id => id))];
        if (uniqueIds.length === 0) return { ok: true };

        const placeholders = uniqueIds.map(() => '?').join(',');
        const existing = await db.all(
            `SELECT ${pkColumn} FROM ${table} WHERE ${pkColumn} IN (${placeholders})`,
            uniqueIds
        );

        const existingSet = new Set(existing.map(r => r[pkColumn]));
        const missing = uniqueIds.filter(id => !existingSet.has(id));

        if (missing.length > 0) {
            return {
                ok: false,
                error: `${fieldName} не найдены: ${missing.join(', ')}`,
                missing
            };
        }

        return { ok: true };
    } catch (e) {
        return {
            ok: false,
            error: `Ошибка проверки ${fieldName}: ${e.message}`
        };
    }
}

/**
 * Безопасное преобразование значения в число
 *
 * @param {any} value - значение
 * @param {number} defaultValue - значение по умолчанию (0)
 * @returns {number}
 *
 * @example
 * safeNum('123.45')    // → 123.45
 * safeNum('123,45')    // → 123.45 (запятая → точка)
 * safeNum('')          // → 0
 * safeNum(null, -1)    // → -1
 */
function safeNum(value, defaultValue = 0) {
    if (value === null || value === undefined || value === '') {
        return defaultValue;
    }
    const str = String(value).replace(',', '.').trim();
    const num = parseFloat(str);
    return isNaN(num) ? defaultValue : num;
}

/**
 * Безопасное преобразование значения в булево
 *
 * @param {any} value
 * @returns {number} 1 или 0 (для SQLite INTEGER)
 *
 * @example
 * safeBool(true)       // → 1
 * safeBool('1')        // → 1
 * safeBool('да')       // → 1
 * safeBool(false)      // → 0
 * safeBool('')         // → 0
 */
function safeBool(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value ? 1 : 0;
    const str = String(value).toLowerCase().trim();
    const trueValues = ['1', 'true', 'да', 'yes', 'истина', 'on'];
    return trueValues.includes(str) ? 1 : 0;
}

/**
 * Безопасная обрезка строки (trim + защита от undefined)
 *
 * @param {any} value
 * @returns {string}
 */
function safeStr(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

module.exports = {
    normalizeFk,
    validateFk,
    validateFkArray,
    safeNum,
    safeBool,
    safeStr
};