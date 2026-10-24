// ============================================================
// src/routes/helpers/queryBuilder.js
// Единый построитель SQL-запросов с авто-выводом зависимостей
// ============================================================

// ✅ Кир→Лат: варианты букв-двойников (кириллица/латиница) для GLOB-классов
const { charVariants } = require('./homoglyphs');

// ✅ НОВОЕ: регистронезависимый поиск по кириллице.
// LIKE в SQLite сравнивает регистр ТОЛЬКО для ASCII: '%Шток%' не находил
// 'шток', из-за чего фильтр «Наименование» казался неработающим.
// Встроенный LOWER() — тоже ASCII-only, а пользовательские функции
// (UDF) node-sqlite3 не поддерживает. Вложенные REPLACE() падают с
// «parser stack overflow» (33 уровня). Решение — GLOB с классами
// символов: текст пользователя разворачивается в JS-паттерн
// 'Шток' -> '*[шШ][тТ][оО][кК]*', SQL-стороне достаётся простой
// 'col GLOB ?' без вложенности. Класс [хХ] матчит любой из регистров,
// цифры/знаки — литералы, '*' и '?' экранируются классом.
// ✅ Кир→Лат: в классы добавлены латинские двойники — «швеллер» даёт
// '*[шШ][вВbB][еЕeEёЁ][лЛ][лЛ][еЕeEёЁ][рРpP]*' и находит «ШBEЛЛЕР»,
// где B, E, P набраны латиницей. withHomoglyphs=false — строгий режим (hg=0).
function cyrGlobPattern(userQuery, withHomoglyphs = true) {
  let pattern = '*';
  for (const ch of String(userQuery)) {
    if (ch === '*' || ch === '?') { pattern += '[' + ch + ']'; continue; }  // экранируем wildcards GLOB
    if (ch === '[') { pattern += '[[]'; continue; }                         // '[' -> класс из '['
    const variants = charVariants(ch, withHomoglyphs);                      // регистры + двойники
    if (variants.length === 1) pattern += variants[0];                      // цифры/знаки — литералы
    else pattern += '[' + variants.join('') + ']';                          // буква: класс вариантов
  }
  return pattern + '*';
}

/**
 * Хелпер для создания JOIN
 */
function join(table, on, alias, type = 'LEFT') {
  return { table, on, alias: alias || table, type };
}

/**
 * Хелпер для поля с алиасом
 */
function field(table, fieldName, as) {
  const expr = `${table}.${fieldName}`;
  return as ? `${expr} AS ${as}` : expr;
}
/**
 * Подзапрос — мини-spec с автоматическим извлечением зависимостей
 * @param {string} from - основная таблица подзапроса
 * @param {string} [alias] - алиас
 * @param {string|string[]} fields - поля SELECT
 * @param {Array} [joins] - JOIN'ы подзапроса
 * @param {string} [where] - WHERE подзапроса
 * @param {string} [groupBy] - GROUP BY подзапроса (✅ НОВОЕ)
 */
function subquery(from, alias, fields, joins, where, groupBy) {
  return {
    _type: 'subquery',
    from,
    alias: alias || from,
    fields: fields || '*',
    joins: joins || [],
    where: where || '',
    groupBy: groupBy || '', // ✅ НОВОЕ
    getDependencies() {
      const deps = new Set([this.from]);
      for (const j of this.joins) {
        if (j.table && typeof j.table === 'string' && !j.table.trim().startsWith('(')) {
          deps.add(j.table);
        }
      }
      return deps;
    },
    toSQL() {
      let sql = 'SELECT ';
      if (Array.isArray(this.fields)) {
        sql += this.fields.join(', ');
      } else {
        sql += this.fields;
      }
      sql += ` FROM ${this.from}`;
      if (this.alias && this.alias !== this.from) sql += ` ${this.alias}`;
      for (const j of this.joins) {
        sql += ` ${j.type || 'LEFT'} JOIN ${j.table} ${j.alias || j.table} ON ${j.on}`;
      }
      if (this.where) sql += ` WHERE ${this.where}`;
      if (this.groupBy) sql += ` GROUP BY ${this.groupBy}`; // ✅ НОВОЕ
      return sql;
    }
  };
}

/**
 * EXISTS (подзапрос)
 */
function exists(sub) {
  return {
    _type: 'exists',
    subquery: sub,
    toSQL() { return `EXISTS (${this.subquery.toSQL()})`; },
    getDependencies() { return this.subquery.getDependencies(); }
  };
}

/**
 * NOT EXISTS (подзапрос)
 */
function notExists(sub) {
  return {
    _type: 'not_exists',
    subquery: sub,
    toSQL() { return `NOT EXISTS (${this.subquery.toSQL()})`; },
    getDependencies() { return this.subquery.getDependencies(); }
  };
}

/**
 * field NOT IN (подзапрос)
 */
function notInSubquery(fieldExpr, sub) {
  return {
    _type: 'not_in_subquery',
    field: fieldExpr,
    subquery: sub,
    toSQL() { return `${this.field} NOT IN (${this.subquery.toSQL()})`; },
    getDependencies() { return this.subquery.getDependencies(); }
  };
}

/**
 * field IN (подзапрос)
 */
function inSubquery(fieldExpr, sub) {
  return {
    _type: 'in_subquery',
    field: fieldExpr,
    subquery: sub,
    toSQL() { return `${this.field} IN (${this.subquery.toSQL()})`; },
    getDependencies() { return this.subquery.getDependencies(); }
  };
}

/**
 * Простое условие (строка) — для обратной совместимости
 */
function raw(sql) {
  return {
    _type: 'raw',
    sql,
    toSQL() { return this.sql; },
    getDependencies() { return new Set(); }
  };
}

/**
 * Собрать массив условий в WHERE-строку
 * @param {Array} conditions - массив Condition-объектов или строк
 * @param {string} [connector=' AND '] - соединитель
 * @returns {{ sql: string, dependencies: Set<string> }}
 */
function buildConditions(conditions, connector = ' AND ') {
  const parts = [];
  const dependencies = new Set();
  for (const cond of conditions) {
    if (!cond) continue;
    if (typeof cond === 'string') {
      // Обратная совместимость — сырая строка
      parts.push(cond);
    } else if (cond._type && cond.toSQL) {
      parts.push(cond.toSQL());
      if (cond.getDependencies) {
        cond.getDependencies().forEach(d => dependencies.add(d));
      }
    }
  }
  return {
    sql: parts.join(connector),
    dependencies
  };
}
/**
 * Построить SQL-запрос и извлечь зависимости
 * @param {Object} spec
 * @param {string} spec.from - основная таблица
 * @param {string} [spec.alias] - алиас основной таблицы
 * @param {Array} [spec.joins] - массив JOIN'ов
 * @param {string[]|string} [spec.fields] - поля SELECT
 * @param {string} [spec.where] - условие WHERE
 * @param {Array} [spec.params] - параметры
 * @param {string} [spec.orderBy] - ORDER BY
 * @returns {{ sql: string, params: any[], dependencies: Set<string> }}
 */
function buildQuery(spec) {
  const dependencies = new Set();
  if (spec.from) dependencies.add(spec.from);
  
  let sql = 'SELECT ';
  if (spec.fields) {
    sql += Array.isArray(spec.fields) ? spec.fields.join(', ') : spec.fields;
  } else {
    const alias = spec.alias || spec.from;
    sql += `${alias}.*`;
  }
  
  if (spec.from) {
    sql += ` FROM ${spec.from}`;
    if (spec.alias) sql += ` ${spec.alias}`;
  }
  
  if (spec.joins && spec.joins.length > 0) {
    for (const j of spec.joins) {
      const joinType = j.type || 'LEFT';
      
      // ✅ НОВОЕ: Поддержка объектов subquery() в JOIN
      if (typeof j.table === 'object' && j.table !== null && typeof j.table.toSQL === 'function') {
        const alias = j.alias || j.table.alias || 'sub';
        sql += ` ${joinType} JOIN (${j.table.toSQL()}) ${alias} ON ${j.on}`;
        // Автоматически извлекаем зависимости из подзапроса (gryz_poz)
        if (typeof j.table.getDependencies === 'function') {
          j.table.getDependencies().forEach(d => dependencies.add(d));
        }
      } else {
        // Старое поведение для строк (названия таблиц или сырой SQL)
        const alias = j.alias || j.table;
        sql += ` ${joinType} JOIN ${j.table} ${alias} ON ${j.on}`;
        dependencies.add(j.table);
      }
    }
  }
  
  if (spec.where) {
    if (typeof spec.where === 'string') {
      sql += ` WHERE ${spec.where}`;
    } else if (spec.where._type) {
      sql += ` WHERE ${spec.where.toSQL()}`;
      if (spec.where.getDependencies) {
        spec.where.getDependencies().forEach(d => dependencies.add(d));
      }
    }
  }
  
  if (spec.orderBy) sql += ` ORDER BY ${spec.orderBy}`;
  
  return { sql, params: spec.params || [], dependencies };
}


module.exports = {
  buildQuery, buildConditions,
  join, field,
  subquery, exists, notExists, notInSubquery, inSubquery, raw,
  cyrGlobPattern
};