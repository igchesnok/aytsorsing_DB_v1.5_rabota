// ============================================================
// src/routes/helpers/homoglyphs.js
// ✅ ОБЩИЙ ХЕЛПЕР ГОМОГЛИФОВ (кириллица <-> латиница)
// ============================================================
// Проблема: данные в БД часто набраны «смешанным алфавитом» —
// «ШBEЛЛЕР» (B, E, P — латиница), «BЫTAЛKИBATEЛЬ», «CTOЙKA»,
// «MATPИЦA» и т.п. Поиск чистой кириллицей такие строки не находил.
//
// Решение: буквы-двойники считаются одним и тем же символом:
//   А=A, В=B, С=C, Е=E, Н=H, К=K, М=M, О=O, Р=P, Т=T, Х=X, У=Y
//   (+ ё=е — стандартная русская нормализация поиска).
//
// Использование:
//   * queryBuilder.cyrGlobPattern — строит GLOB-классы '[вВbB]' для SQL;
//   * grafikRoutes / transportOperRoutes — matches() для JS-фильтров.
//
// Клиентская копия (ESM): public/js/common/homoglyph-helper.js —
// ПРИ ИЗМЕНЕНИИ КАРТЫ ПРАВИТЬ ОБА ФАЙЛА.
// ============================================================
'use strict';

// Пары [кириллица, латиница] — визуальные двойники
const PAIRS = [
  ['а', 'a'], ['в', 'b'], ['с', 'c'], ['е', 'e'], ['н', 'h'], ['к', 'k'],
  ['м', 'm'], ['о', 'o'], ['р', 'p'], ['т', 't'], ['х', 'x'], ['у', 'y'],
];

const CYR2LAT = {};   // кириллица -> латиница (для toLatin/normalize)
const HOMOGLYPH = {}; // двунаправленная карта двойников (для charVariants)
for (const [cyr, lat] of PAIRS) {
  CYR2LAT[cyr] = lat;
  CYR2LAT[cyr.toUpperCase()] = lat.toUpperCase();
  HOMOGLYPH[cyr] = lat;
  HOMOGLYPH[cyr.toUpperCase()] = lat.toUpperCase();
  HOMOGLYPH[lat] = cyr;
  HOMOGLYPH[lat.toUpperCase()] = cyr.toUpperCase();
}

// ё/Ё -> e/E: русская нормализация. Отображаем сразу в ЛАТИНСКИЙ канон
// (как и остальные кириллические двойники), иначе normalize('ёлка') давал
// бы кириллическую 'е' и не совпадал с normalize('елка').
CYR2LAT['ё'] = 'e';
CYR2LAT['Ё'] = 'E';
// Двойники для GLOB-классов: запрос с 'ё' находит 'е' в данных и наоборот
HOMOGLYPH['ё'] = 'е';
HOMOGLYPH['Ё'] = 'Е';
const EXTRA_VARIANTS = {
  'е': ['ё', 'Ё'], 'Е': ['ё', 'Ё'],
  'ё': ['е', 'Е', 'e', 'E'], 'Ё': ['е', 'Е', 'e', 'E'],
};

// Заменить кириллические буквы-двойники на латиницу
// («ШBEЛЛЕР»-режим из постановки задачи: А->A, В->B, Р->P, ...)
function toLatin(str) {
  return String(str ?? '').replace(/./gu, (ch) => CYR2LAT[ch] || ch);
}

// Каноническая форма для сравнения: lower + ё->е + кириллица->латиница.
// Символы без латинских двойников (ш, л, Щ, Д, Ч...) остаются кириллицей —
// они и в данных, и в запросе записаны одним и тем же юникод-символом,
// поэтому в нормализации не нуждаются.
function normalize(str) {
  return toLatin(String(str ?? '').toLowerCase());
}

// JS-сравнение «содержит» с учётом гомоглифов.
// Обе стороны нормализуются, поэтому работает в ОБЕ стороны:
// кириллический запрос находит латиницу в данных и наоборот.
function matches(haystack, needle) {
  const n = normalize(needle);
  if (!n) return true;
  return normalize(haystack).includes(n);
}

// Все варианты символа для GLOB-класса: сам символ, оба регистра
// и буквы-двойники. withHomoglyphs=false — строгий режим
// (только регистры исходной буквы; включается параметром hg=0).
// Возвращает массив из 1+ элементов без '*?[' — безопасно для класса GLOB.
function charVariants(ch, withHomoglyphs = true) {
  const set = new Set([ch, ch.toLowerCase(), ch.toUpperCase()]);
  if (withHomoglyphs) {
    for (const c of [ch.toLowerCase(), ch.toUpperCase()]) {
      const h = HOMOGLYPH[c];
      if (h) {
        set.add(h);
        set.add(h.toLowerCase());
        set.add(h.toUpperCase());
      }
      for (const extra of (EXTRA_VARIANTS[c] || [])) set.add(extra);
    }
  }
  return [...set];
}

module.exports = { PAIRS, CYR2LAT, HOMOGLYPH, toLatin, normalize, matches, charVariants };
