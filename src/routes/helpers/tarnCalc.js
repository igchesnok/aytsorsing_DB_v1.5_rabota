// ============================================================
// ✅ T57: helpers/tarnCalc.js — ДВИЖОК РАСЧЁТА ТАРНЫХ МЕСТ
// по ТРЁМ типам груза (модальный диалог редактора операций).
//
// ТИПЫ ГРУЗА (в каждой грузовой позиции gryz_poz.tip_gruza):
//   listy     — «В листах»: раскрой листа ВСТЫК (LIST_PRIPUSK_MM = 0),
//               групповой раскрой по одинаковым листам (Д×Ш×Т+марка):
//               сетка лучшей ориентации + ПОВЁРНУТЫЙ добор той же детали
//               в свободные полосы + умная декомпозиция остатка —
//               T56-f, воспроизводит ручной раскрой цеха (42 листа на
//               данных пользователя). ТАРИРОВАНИЕ: листы РАЗНЫХ
//               типоразмеров штабелируются друг на друга — ОДНО тарное
//               место «Пачки листов» с МАКСИМАЛЬНЫМИ длиной и шириной
//               из всех типоразмеров; высота стопки ограничена лимитом.
//   prutki    — «В прутках»: резка прутка (припуск 5 мм), сечение связки
//               считается по Ø прутка (prutok_diametr). Тарное место —
//               «Связки прутков» (штабелируемость да).
//   zagotovki — «Отдельные заготовки» на деревянной таре: габарит тары/
//               поддона задаёт ПОЛЬЗОВАТЕЛЬ (tara_dlina/shirina/vysota),
//               укладка внутри тары — РУЧНОЙ параметр позиции (ukladka):
//                 sloy     — один слой (крупные прямоугольные, по
//                            максимальной подошве, для устойчивости);
//                 piramida — пирамидкой (круглые болванки: нижний ряд
//                            floor(Дтары/Ø), каждый ряд на 1 уже, до 3 рядов);
//                 stoyma   — стоймя/«снарядами» (мелкие детали в спец.
//                            ящиках, счёт по минимальной подошве Ø×Ø).
//               Деревянная тара СНАРУЖИ НЕ штабелируется, и КАЖДЫЙ
//               типоразмер тары — ОТДЕЛЬНОЕ тарное место с отдельной
//               строкой в СЗ на транспорт.
//
// ✅ T57-e: ОБРЕЗКИ = 0 ЛИСТОВ (правило нулей УДАЛЕНО по указанию
//   пользователя): если деталь получается из обрезков — по позиции
//   пишется 0 листов, никаких «приписанных» листов-источников.
//   Листы НЕ «перекладываются» между позициями: позиция, открывшая
//   листы, сохраняет их в своём счёте (как в ручном раскрое цеха).
//
// ✅ ВЕС: вес тарного места = Σ ves_zag × кол-во ДЕТАЛЕЙ по позициям
//   (вес груза, как считал старый алгоритм ~6.6 т на данных пользователя),
//   а НЕ вес целых листов/прутков (7.3 т — двойной счёт обрезков).
//   Если ves_zag не задан — вес детали оценивается по габаритам × плотность.
//
// ✅ РУЧНОЕ «Кол-во заготовок»: движок принимает kolvo_zagotovok как
//   ручное перекрытие ТОЛЬКО с флагом p.kolvo_manual === 1 (клиент ставит
//   его, когда пользователь сам отредактировал ячейку в модальном окне).
//   Значения, записанные прошлым авто-расчётом (kolvo_manual нет),
//   игнорируются — повторный авто-расчёт НЕ раздувает количество
//   (баг «47 листов»).
//
// ✅ Правило «больше N деталей → ящик» ОТМЕНЕНО — режим укладки задаёт
//   пользователь, ничего не «переключается» автоматически.
// ============================================================
'use strict';

const LIST_PRIPUSK_MM = 0;     // T56-f: припуск на рез (0 = ВСТЫК, как в ручном раскрое цеха)
const PRUTOK_PRIPUSK_MM = 5;   // припуск на рез при резке прутка
const STEEL_DENSITY_KG_MM3 = 7.85e-6;   // fallback плотности (сталь 7850 кг/м3)
const LIST_STACK_LIMIT_MM = 1000;       // лимит высоты стопки листов на тарном месте
const PRUTOK_BUNDLE_SIDE_MM = 300;      // сторона сечения связки прутков
const PIRAMIDA_MAX_ROWS = 3;            // пирамидка: максимум рядов

const safeNum = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return isNaN(n) ? 0 : n;
};
const round3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;

// Укладка: код -> подпись
const UKLADKA_LABEL = { sloy: 'один слой', piramida: 'пирамидкой', stoyma: 'стоймя' };
// Тип места -> бейдж/название
const TIP_LABEL = { listy: 'Пачки листов', prutki: 'Связки прутков', zagotovki: 'Деревянная тара' };

// ============================================================
// ВЕС ОДНОЙ ДЕТАЛИ (кг): ves_zag оснастки; fallback — габариты детали
// × плотность стали (лист: Д×Ш×Т; пруток: Ø² π/4 × длина)
// ============================================================
function partWeightOf(p) {
  const vz = safeNum(p.ves_zag);
  if (vz > 0) return vz;
  const DL = safeNum(p.dlina), DW = safeNum(p.shirina);
  let TH = safeNum(p.vysota);
  if (!(TH > 0)) TH = safeNum(p.list_tolshina);
  if (DL > 0 && DW > 0 && TH > 0) return DL * DW * TH * STEEL_DENSITY_KG_MM3;
  const DIA = safeNum(p.prutok_diametr);
  if (DIA > 0) {
    const L = safeNum(p.dlina) || safeNum(p.prutok_dlina);
    if (L > 0) return Math.PI * (DIA / 2) * (DIA / 2) * L * STEEL_DENSITY_KG_MM3;
  }
  return 0;
}

// ============================================================
// ОДНА ЛИСТОВАЯ ПОЗИЦИЯ (проверка помещаемости; ВСТЫК, припуск 0)
// null — параметры листа не заданы; { err } — деталь не помещается;
// иначе { perSheet, sheets, SL, SW, ST, manual }
// ============================================================
function sheetCalcFor(p, qty) {
  const SL = safeNum(p.list_dlina), SW = safeNum(p.list_shirina), ST = safeNum(p.list_tolshina);
  const DL = safeNum(p.dlina), DW = safeNum(p.shirina);
  if (!(SL > 0 && SW > 0 && ST > 0 && DL > 0 && DW > 0)) return null;
  const pa = DL + LIST_PRIPUSK_MM, pb = DW + LIST_PRIPUSK_MM;
  const nA = Math.floor(SL / pa) * Math.floor(SW / pb);   // ориентация 1
  const nB = Math.floor(SL / pb) * Math.floor(SW / pa);   // ориентация 2
  const perSheet = Math.max(nA, nB);
  if (perSheet <= 0) {
    return { err: `${p.nomer_chertezha || 'Позиция'}: заготовка ${pa}×${pb} мм не помещается на лист ${SL}×${SW} мм — посчитана штучной` };
  }
  // Ручное «Кол-во заготовок» — ТОЛЬКО по явному флагу kolvo_manual
  // (записи прошлых авто-расчётов колво_manual не имеют и НЕ блокируют пересчёт)
  const manualSheets = p.kolvo_manual === 1 ? Math.round(safeNum(p.kolvo_zagotovok)) : 0;
  const sheets = manualSheets > 0 ? manualSheets : Math.ceil(qty / perSheet);
  return { perSheet, sheets, SL, SW, ST, manual: manualSheets > 0 };
}

// ============================================================
// ОДНА ПРУТКОВАЯ ПОЗИЦИЯ (резка, припуск 5 мм; сечение по Ø)
// null — параметры прутка не заданы; { err } — не помещается;
// иначе { perBar, bars, bundles, BL, DIA, wt, manual }
// wt — вес ДЕТАЛЕЙ позиции (не целых прутков)
// ============================================================
function barCalcFor(p, qty) {
  const BL = safeNum(p.prutok_dlina), DIA = safeNum(p.prutok_diametr);
  const DL = safeNum(p.dlina);
  if (!(BL > 0 && DIA > 0 && DL > 0)) return null;
  const perBar = Math.floor(BL / (DL + PRUTOK_PRIPUSK_MM));
  if (perBar <= 0) {
    return { err: `${p.nomer_chertezha || 'Позиция'}: деталь ${DL} мм не помещается в пруток ${BL} мм (с припуском ${PRUTOK_PRIPUSK_MM} мм)` };
  }
  const manualBars = p.kolvo_manual === 1 ? Math.round(safeNum(p.kolvo_zagotovok)) : 0;
  const bars = manualBars > 0 ? manualBars : Math.ceil(qty / perBar);
  // Сечение связки: круги Ø в квадратной сетке со стороной 300 мм
  const perBundle = Math.max(1, Math.floor(PRUTOK_BUNDLE_SIDE_MM / DIA) ** 2);
  const bundles = Math.max(1, Math.ceil(bars / perBundle));
  const wt = partWeightOf(p) * qty;   // вес деталей позиции
  return { perBar, bars, bundles, BL, DIA, wt, manual: manualBars > 0 };
}

// ============================================================
// ВМЕСТИМОСТЬ ОДНОЙ ДЕРЕВЯННОЙ ТАРЫ (укладка — РУЧНОЙ параметр)
// { per, warn } — per = деталей в одной таре (0 = негабарит: 1 шт = 1 тара)
// ============================================================
function ukladkaCapacity(p) {
  const TL = safeNum(p.tara_dlina), TW = safeNum(p.tara_shirina), TH = safeNum(p.tara_vysota);
  const DL = safeNum(p.dlina), DW = safeNum(p.shirina), DH = safeNum(p.vysota);
  const warn = [];
  let per = 0;
  if (!(TL > 0 && TW > 0 && TH > 0)) return { per: 0, warn: ['не задан габарит тары'] };
  const mode = String(p.ukladka || '').trim();

  if (mode === 'sloy') {
    // ОДИН СЛОЙ: по максимальной подошве (2 ориентации), для устойчивости
    if (DL > 0 && DW > 0) {
      per = Math.max(Math.floor(TL / DL) * Math.floor(TW / DW), Math.floor(TL / DW) * Math.floor(TW / DL));
      if (DH > 0 && DH > TH) warn.push(`высота заготовки ${DH} мм больше высоты тары ${TH} мм`);
    }
  } else if (mode === 'piramida') {
    // ПИРАМИДКОЙ: круглые болванки — нижний ряд floor(Дтары/Ø),
    // каждый следующий ряд на 1 уже, рядов до 3 (высота ограничивает)
    const dia = Math.max(DL, DW, DH);
    if (dia > 0) {
      const bottom = Math.floor(TL / dia);
      if (bottom > 0) {
        let rows = Math.min(PIRAMIDA_MAX_ROWS, Math.floor(TH / dia), bottom);
        if (rows < 1) rows = 1;
        per = rows * bottom - (rows * (rows - 1)) / 2;   // 6+5+4 = 15 и т.п.
      }
    }
  } else if (mode === 'stoyma') {
    // СТОЙМЯ («снарядами»): мелкие детали в спец. ящике —
    // счёт по минимальной подошве Ø×Ø, высота ограничивает
    const dia = Math.max(DL, DW, DH);
    if (dia > 0) {
      per = Math.floor(TL / dia) * Math.floor(TW / dia);
      if (DH > 0 && DH > TH) warn.push(`высота заготовки ${DH} мм больше высоты тары ${TH} мм — деталь не встанет стоймя`);
    }
  }
  if (per <= 0) {
    warn.push(`деталь не помещается в тару ${TL}×${TW}×${TH} мм (укладка: ${UKLADKA_LABEL[mode] || mode || 'не задана'}) — считается 1 деталь = 1 тара`);
    per = 0;   // негабарит: каждая деталь — отдельная тара
  }
  return { per, warn };
}

// ============================================================
// T56-f: РАСКРОЙ ОСТАТКА прямоугольника после размещения сетки.
//   обычный вариант — остаток ряда / полоса ниже / правая полоса;
//   для НЕДОЗАПОЛНЕННОЙ ОДНОЙ строки (f=0, r>0) альтернатива — правый
//   блок ВО ВСЮ высоту (в цеху: 2 плиты + 8 пластин в полосе 1132 мм).
//   Берём вариант, где крупнее наибольший свободный прямоугольник.
// ============================================================
function cutRemainder(rc, cw, ch, place) {
  const cols = Math.floor(rc.w / cw);
  if (cols <= 0) return [{ w: rc.w, h: rc.h }];
  const f = Math.floor(place / cols), r = place % cols;
  const usedRows = r > 0 ? f + 1 : f;
  const d1 = [];
  if (r > 0) d1.push({ w: (cols - r) * cw, h: ch });
  const belowH = rc.h - usedRows * ch;
  if (belowH > 0) d1.push({ w: cols * cw, h: belowH });
  const rightW = rc.w - cols * cw;
  if (rightW > 0) d1.push({ w: rightW, h: rc.h });
  if (!(f === 0 && r > 0)) return d1;
  const d2 = [];
  if (rc.w - r * cw > 0) d2.push({ w: rc.w - r * cw, h: rc.h });
  if (rc.h - ch > 0) d2.push({ w: r * cw, h: rc.h - ch });
  const maxA = (arr) => arr.reduce((m, q) => Math.max(m, q.w * q.h), 0);
  return maxA(d2) > maxA(d1) ? d2 : d1;
}

// T56-f: жадное заполнение свободных прямоугольников деталью
// (pa×pb, обе ориентации, лучший прямоугольник по вместимости).
// sheets: [{ free: [...] }]; onlySi >= 0 — только один лист.
function fillFree(sheets, pa, pb, want, onlySi) {
  let placed = 0, rem = want;
  while (rem > 0) {
    let best = null;
    for (let si = 0; si < sheets.length; si++) {
      if (onlySi >= 0 && si !== onlySi) continue;
      for (let ri = 0; ri < sheets[si].free.length; ri++) {
        const rc = sheets[si].free[ri];
        for (const [cw, ch] of [[pa, pb], [pb, pa]]) {
          const fit = Math.floor(rc.w / cw) * Math.floor(rc.h / ch);
          if (fit > 0 && (!best || fit > best.fit)) best = { si, ri, cw, ch, fit };
        }
      }
    }
    if (!best) break;
    const place = Math.min(rem, best.fit);
    const rc = sheets[best.si].free[best.ri];
    const nr = cutRemainder(rc, best.cw, best.ch, place);
    sheets[best.si].free.splice(best.ri, 1);
    for (const q of nr) if (q.w > 0 && q.h > 0) sheets[best.si].free.push(q);
    rem -= place; placed += place;
  }
  return placed;
}

// T56-f: план ОДНОГО нового листа: равномерная сетка в ориентации
// A или B, затем добор ПОВЁРНУТЫХ деталей той же позиции в свободные
// полосы (90 сеткой + 4 повёрнутых = 94 на листе).
function bestSheetPlan(SL, SW, pa, pb, want) {
  let bestPlan = null;
  for (const [cw, ch] of [[pa, pb], [pb, pa]]) {
    const cols = Math.floor(SL / cw), rows = Math.floor(SW / ch);
    const gridCap = cols * rows;
    if (gridCap <= 0) continue;
    const place = Math.min(want, gridCap);
    const free = cutRemainder({ w: SL, h: SW }, cw, ch, place);
    const virt = [{ free: free.map(q => ({ w: q.w, h: q.h })) }];
    const fill = fillFree(virt, pa, pb, want - place, 0);
    const score = place + fill;
    const maxRect = virt[0].free.reduce((m, q) => Math.max(m, q.w * q.h), 0);
    if (!bestPlan || score > bestPlan.score ||
        (score === bestPlan.score && maxRect > bestPlan.maxRect)) {
      bestPlan = { score, maxRect, free: virt[0].free };
    }
  }
  if (!bestPlan) bestPlan = { score: 0, maxRect: 0, free: [{ w: SL, h: SW }] };
  return { placed: bestPlan.score, free: bestPlan.free };
}

// T56-f: вместимость ПОЛНОГО листа (сетка + повёрнутый добор) —
// честная база для «На листе» и экономии.
function sheetCapOf(SL, SW, pa, pb) {
  let cap = 0;
  for (const [cw, ch] of [[pa, pb], [pb, pa]]) {
    const cols = Math.floor(SL / cw), rows = Math.floor(SW / ch);
    if (cols * rows <= 0) continue;
    const free = cutRemainder({ w: SL, h: SW }, cw, ch, cols * rows);
    const virt = [{ free: free.map(q => ({ w: q.w, h: q.h })) }];
    cap = Math.max(cap, cols * rows + fillFree(virt, pa, pb, Number.MAX_SAFE_INTEGER, 0));
  }
  return cap;
}

// ============================================================
// ГРУППОВОЙ РАСКРОЙ ЛИСТОВ по группам одинаковых листов (Д×Ш×Т+марка)
// + ✅ T57-e (листов позиции = СОБСТВЕННЫЕ новые листы; позиция,
//    резавшаяся целиком из обрезков, получает 0 листов — правило нулей
//    удалено по указанию пользователя)
// items: [{ key, p, qty, sc }] (auto), manualItems — ручные листы
// Возвращает { any, groups, perPoz: Map(key->sheets), maxSL, maxSW, totalH, brutto, warnings }
//   brutto здесь — вес ДЕТАЛЕЙ (partWeightOf × qty)
// ============================================================
function nestSheetGroups(autoItems, manualItems, warnings) {
  const groupsMap = new Map();
  const effMarkaOf = (p) =>
    String(p.marka_materiala || '').trim() || String(p.marka_materiala_osn || '').trim();
  for (const it of [...autoItems, ...manualItems]) {
    const gkey = `${it.sc.SL}x${it.sc.SW}x${it.sc.ST}|${effMarkaOf(it.p).toUpperCase()}`;
    if (!groupsMap.has(gkey)) {
      groupsMap.set(gkey, {
        SL: it.sc.SL, SW: it.sc.SW, ST: it.sc.ST,
        marka: effMarkaOf(it.p), auto: [], manual: []
      });
    }
    const g = groupsMap.get(gkey);
    (it.sc.manual ? g.manual : g.auto).push(it);
  }

  const perPoz = new Map();     // key -> листов позиции (для М-15 и kolvo_zagotovok)
  const bump = (key, d) => perPoz.set(key, (perPoz.get(key) || 0) + d);
  // инициализация: ручные сразу (как заданы), авторасчётные — при вскрытии листов
  for (const it of autoItems) perPoz.set(it.key, 0);
  for (const it of manualItems) bump(it.key, it.sc.sheets);

  const groups = [];
  let sheets = 0, totalH = 0, brutto = 0, maxSL = 0, maxSW = 0, naive = 0;
  for (const g of groupsMap.values()) {
    const sorted = [...g.auto].sort((a, b) =>
      (safeNum(b.p.dlina) * safeNum(b.p.shirina)) - (safeNum(a.p.dlina) * safeNum(a.p.shirina)));
    // Разрезанные листы группы: { free: [{w,h}] }
    const cutSheets = [];
    const rowInfo = new Map();  // item -> { vObrezki, opened, cap }
    for (const it of sorted) {
      const DL = safeNum(it.p.dlina), DW = safeNum(it.p.shirina);
      const pa = DL + LIST_PRIPUSK_MM, pb = DW + LIST_PRIPUSK_MM;
      let remaining = it.qty;
      // 1) добор в обрезки уже разрезанных листов группы (T56-f fillFree)
      const vObrezki = fillFree(cutSheets, pa, pb, remaining, -1);
      remaining -= vObrezki;
      // 2) новые листы: сетка лучшей ориентации + повёрнутый добор
      let opened = 0;
      while (remaining > 0) {
        const plan = bestSheetPlan(g.SL, g.SW, pa, pb, remaining);
        if (plan.placed <= 0) break; // страховка (sheetCalcFor уже отсёк такие)
        cutSheets.push({ free: plan.free });
        remaining -= plan.placed;
        opened += 1;
      }
      // ✅ ПРАВИЛО НУЛЕЙ: листов позиции = СОБСТВЕННЫЕ новые листы.
      //    Листы не перекладываются: кто открыл — у того и остались.
      bump(it.key, opened);
      rowInfo.set(it, { vObrezki, opened });
    }
    // ✅ T57-e: правило нулей УДАЛЕНО — позиция, целиком вырезанная из
    // обрезков, честно получает 0 листов (никакой лист-источник не
    // приписывается, предупреждение не выдаётся).
    const manSheets = g.manual.reduce((s, it) => s + it.sc.sheets, 0);
    const gSheets = cutSheets.length + manSheets;
    // честная вместимость полного листа для каждой детали (сетка + добор)
    const capOf = (it) => {
      const DL = safeNum(it.p.dlina), DW = safeNum(it.p.shirina);
      return Math.max(1, sheetCapOf(g.SL, g.SW, DL + LIST_PRIPUSK_MM, DW + LIST_PRIPUSK_MM));
    };
    const gNaive = g.auto.reduce((s, it) => s + Math.ceil(it.qty / capOf(it)), 0);
    const rows = [];
    for (const it of sorted) {
      const info = rowInfo.get(it) || { vObrezki: 0, opened: 0 };
      rows.push({
        nomer_chertezha: it.p.nomer_chertezha || '', qty: it.qty, tip: 'лист',
        sheet: `${it.sc.SL}×${it.sc.SW}×${it.sc.ST}`, per_sheet: capOf(it),
        v_obrezki: info.vObrezki, lists_novyh: info.opened,
        lists_poz: perPoz.get(it.key) || 0, marka: g.marka
      });
    }
    for (const it of g.manual) {
      rows.push({
        nomer_chertezha: it.p.nomer_chertezha || '', qty: it.qty, tip: 'лист',
        sheet: `${it.sc.SL}×${it.sc.SW}×${it.sc.ST}`, sheets: it.sc.sheets,
        zagotovok_manual: true, manual_sheets: it.sc.sheets,
        lists_poz: it.sc.sheets, marka: g.marka
      });
    }
    // ✅ ВЕС: вес ДЕТАЛЕЙ группы (ves_zag × кол-во; fallback — габариты × сталь)
    const gWt = [...g.auto, ...g.manual].reduce((s, it) => s + partWeightOf(it.p) * it.qty, 0);
    groups.push({
      sheet: `${g.SL}×${g.SW}×${g.ST}`, marka: g.marka,
      sheets: gSheets, saved: Math.max(0, gNaive - cutSheets.length),
      ves: r2(gWt), rows
    });
    sheets += gSheets;
    naive += gNaive + manSheets;
    brutto += gWt;
    maxSL = Math.max(maxSL, g.SL); maxSW = Math.max(maxSW, g.SW);
    // высота стопки группы: листов × толщина
    totalH += g.ST * gSheets;
  }
  return {
    any: groupsMap.size > 0, groups, perPoz, sheets,
    totalH, brutto, maxSL, maxSW,
    saved: Math.max(0, naive - sheets)
  };
}

// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ: расчёт тарных мест перевозки по типам груза
// positions — строки GET_POZ / pending (с tip_gruza и параметрами типа)
// Возвращает { groups, pozResults, errors, warnings, summary, totals }
//   groups     — группы тарных мест (строки СЗ):
//                { tip, name, dlina_m, shirina_m, vysota_m, shtabil,
//                  kolvo, ves_kg, ukladka, pozcii:[key] }
//   pozResults — по позиции: { key, tip_gruza, kolvo_zagotovok, detail }
//   errors     — валидация параметров: [{ key, field, message }]
// ============================================================
function calcTarnMesta(positions) {
  const errors = [];
  const warnings = [];
  const pozResults = [];
  const groups = [];

  // --- Разбор позиций по типам (пустой тип — автоопределение по параметрам)
  const listy = [], prutki = [], zagotovki = [];
  for (const p of positions) {
    const qty = Math.round(safeNum(p.kolvo_no_br) + safeNum(p.kolvo_yes_br));
    let tip = String(p.tip_gruza || '').trim();
    if (!['listy', 'prutki', 'zagotovki'].includes(tip)) {
      // автоопределение: лист -> пруток -> отдельная заготовка (совместимость)
      if (safeNum(p.list_dlina) > 0 && safeNum(p.list_shirina) > 0 && safeNum(p.list_tolshina) > 0) tip = 'listy';
      else if (safeNum(p.prutok_dlina) > 0) tip = 'prutki';
      else tip = 'zagotovki';
    }
    const key = String(p.id || p.plan_perevozok_id || p.id_plana || ('idx' + pozResults.length));
    const rec = { key, p, qty, tip };
    pozResults.push({ key, tip_gruza: tip, kolvo_zagotovok: 0, qty, detail: null });
    if (qty <= 0) continue;   // пустая позиция — в расчёт не идёт (0 запрещён, но и груза нет)

    // --- Валидация обязательных параметров по типу
    if (tip === 'listy') {
      if (!(safeNum(p.list_dlina) > 0)) errors.push({ key, field: 'list_dlina', message: 'не задана длина листа' });
      if (!(safeNum(p.list_shirina) > 0)) errors.push({ key, field: 'list_shirina', message: 'не задана ширина листа' });
      if (!(safeNum(p.list_tolshina) > 0)) errors.push({ key, field: 'list_tolshina', message: 'не задана толщина листа' });
      if (!(safeNum(p.dlina) > 0) || !(safeNum(p.shirina) > 0)) errors.push({ key, field: 'dlina', message: 'не заданы размеры заготовки (оснастка)' });
      listy.push(rec);
    } else if (tip === 'prutki') {
      if (!(safeNum(p.prutok_dlina) > 0)) errors.push({ key, field: 'prutok_dlina', message: 'не задана длина прутка' });
      if (!(safeNum(p.prutok_diametr) > 0)) errors.push({ key, field: 'prutok_diametr', message: 'не задан диаметр прутка (сечение связки)' });
      if (!(safeNum(p.dlina) > 0)) errors.push({ key, field: 'dlina', message: 'не задана длина детали (оснастка)' });
      prutki.push(rec);
    } else {
      if (!(safeNum(p.tara_dlina) > 0)) errors.push({ key, field: 'tara_dlina', message: 'не задана длина тары/поддона' });
      if (!(safeNum(p.tara_shirina) > 0)) errors.push({ key, field: 'tara_shirina', message: 'не задана ширина тары/поддона' });
      if (!(safeNum(p.tara_vysota) > 0)) errors.push({ key, field: 'tara_vysota', message: 'не задана высота тары/поддона' });
      if (!String(p.ukladka || '').trim()) errors.push({ key, field: 'ukladka', message: 'не задана укладка в таре (ручной параметр)' });
      if (!(safeNum(p.dlina) > 0) || !(safeNum(p.shirina) > 0)) errors.push({ key, field: 'dlina', message: 'не заданы размеры заготовки (оснастка)' });
      zagotovki.push(rec);
    }
  }

  const pozKey = (rec) => rec.key;
  const findResult = (key) => pozResults.find(x => x.key === key);

  // ============================================================
  // ЛИСТЫ: групповой раскрой + ОДНО тарное место «Пачки листов»
  // (листы разных типоразмеров штабелируются: габарит = макс Д×Ш)
  // ============================================================
  const sheetAuto = [], sheetManual = [];
  for (const rec of listy) {
    const sc = sheetCalcFor(rec.p, rec.qty);
    if (sc && !sc.err) {
      rec.sc = sc;
      (sc.manual ? sheetManual : sheetAuto).push({ key: pozKey(rec), p: rec.p, qty: rec.qty, sc });
    } else if (sc && sc.err) {
      errors.push({ key: pozKey(rec), field: 'list_dlina', message: sc.err });
    }
  }
  let agg = null;
  if (sheetAuto.length + sheetManual.length > 0) {
    agg = nestSheetGroups(sheetAuto, sheetManual, warnings);
    // кол-во заготовок позиции = листов позиции (правило нулей внутри)
    for (const rec of listy) {
      const sheets = agg.perPoz.get(pozKey(rec));
      if (sheets != null) {
        const res = findResult(pozKey(rec));
        if (res) { res.kolvo_zagotovok = sheets; res.detail = { tip: 'лист', sheets, per_sheet: rec.sc ? rec.sc.perSheet : null }; }
      }
    }
    if (agg.any) {
      const stackH = agg.totalH;
      const kolvo = Math.max(1, Math.ceil(stackH / LIST_STACK_LIMIT_MM));
      groups.push({
        tip: 'listy', name: TIP_LABEL.listy,
        dlina_m: round3(agg.maxSL / 1000), shirina_m: round3(agg.maxSW / 1000),
        vysota_m: round3(Math.min(stackH, LIST_STACK_LIMIT_MM) / 1000),
        shtabil: 'да', kolvo, ves_kg: r2(agg.brutto), ukladka: '',
        // только фактически рассчитанные позиции (с параметрами листа)
        pozcii: [...new Set([...sheetAuto, ...sheetManual].map(it => it.key))],
        detail: { lists: agg.sheets, saved: agg.saved, groups: agg.groups, stackH: round3(stackH) }
      });
    }
  }

  // ============================================================
  // ПРУТКИ: связки по Ø — одно тарное место «Связки прутков»
  // (штабелируемость да; габарит = макс длина × сечение связки)
  // ============================================================
  let barCnt = 0, barWt = 0, maxBL = 0, maxSide = 0, bundlesTotal = 0;
  for (const rec of prutki) {
    const bc = barCalcFor(rec.p, rec.qty);
    if (bc && !bc.err) {
      rec.bc = bc;
      barCnt += bc.bars; barWt += bc.wt; bundlesTotal += bc.bundles;
      maxBL = Math.max(maxBL, bc.BL);
      maxSide = Math.max(maxSide, Math.min(PRUTOK_BUNDLE_SIDE_MM, Math.ceil(Math.sqrt(bc.bars)) * bc.DIA));
      const res = findResult(pozKey(rec));
      if (res) { res.kolvo_zagotovok = bc.bars; res.detail = { tip: 'пруток', bars: bc.bars, per_bar: bc.perBar, bundles: bc.bundles, ves: r2(bc.wt) }; }
    } else if (bc && bc.err) {
      errors.push({ key: pozKey(rec), field: 'prutok_dlina', message: bc.err });
    }
  }
  if (barCnt > 0) {
    groups.push({
      tip: 'prutki', name: TIP_LABEL.prutki,
      dlina_m: round3(maxBL / 1000), shirina_m: round3(maxSide / 1000), vysota_m: round3(maxSide / 1000),
      shtabil: 'да', kolvo: bundlesTotal, ves_kg: r2(barWt), ukladka: '',
      pozcii: prutki.filter(r => r.bc && !r.bc.err).map(pozKey),
      detail: { prutkov: barCnt, svyazok: bundlesTotal }
    });
  }

  // ============================================================
  // ОТДЕЛЬНЫЕ ЗАГОТОВКИ: деревянная тара, КАЖДЫЙ типоразмер тары —
  // ОТДЕЛЬНОЕ тарное место (не штабелируется, отдельная строка в СЗ)
  // ============================================================
  const taraGroups = new Map();   // key = Д×Ш×В тары
  for (const rec of zagotovki) {
    const cap = ukladkaCapacity(rec.p);
    cap.warn.forEach(w => warnings.push(`${rec.p.nomer_chertezha || 'Позиция'}: ${w}`));
    const pallets = cap.per > 0 ? Math.ceil(rec.qty / cap.per) : rec.qty;
    const res = findResult(pozKey(rec));
    if (res) {
      res.kolvo_zagotovok = rec.qty;   // штучные: кол-во заготовок = кол-во деталей
      res.detail = { tip: 'заготовка', pallets, per_pallet: cap.per, ukladka: rec.p.ukladka || '' };
    }
    const TL = safeNum(rec.p.tara_dlina), TW = safeNum(rec.p.tara_shirina), TH = safeNum(rec.p.tara_vysota);
    const gkey = `${TL}x${TW}x${TH}`;
    if (!taraGroups.has(gkey)) {
      taraGroups.set(gkey, {
        tip: 'zagotovki', name: TIP_LABEL.zagotovki,
        dlina_m: round3(TL / 1000), shirina_m: round3(TW / 1000), vysota_m: round3(TH / 1000),
        shtabil: 'нет', kolvo: 0, ves_kg: 0,
        ukladka: String(rec.p.ukladka || ''), pozcii: [], ukladki: new Set()
      });
    }
    const g = taraGroups.get(gkey);
    g.kolvo += pallets;
    g.ves_kg += partWeightOf(rec.p) * rec.qty;   // вес деталей (нетто, вес тары не задаётся)
    g.pozcii.push(pozKey(rec));
    if (rec.p.ukladka) g.ukladki.add(String(rec.p.ukladka));
  }
  for (const g of taraGroups.values()) {
    if (g.ukladki.size > 0) {
      g.ukladka = [...g.ukladki].join(', ');
      const labels = [...g.ukladki].map(u => UKLADKA_LABEL[u] || u);
      g.name = `${TIP_LABEL.zagotovki} (${labels.join(' / ')})`;
    }
    g.ves_kg = r2(g.ves_kg);
    delete g.ukladki;
    groups.push(g);
  }

  // --- Итоги
  const totals = {
    mest: groups.reduce((s, g) => s + (parseFloat(g.kolvo) || 0), 0),
    ves: r2(groups.reduce((s, g) => s + (parseFloat(g.ves_kg) || 0), 0)),
    tipov: groups.length,
    shtabil: groups.some(g => String(g.shtabil) === 'да') ? 'да' : 'нет'
  };
  const parts = [];
  for (const g of groups) {
    parts.push(`${g.name}: ${g.kolvo} мест` +
      (g.detail && g.detail.lists ? ` (листов ${g.detail.lists}` + (g.detail.saved ? `, экономия ${g.detail.saved}` : '') + ')' : '') +
      (g.detail && g.detail.prutkov ? ` (прутков ${g.detail.prutkov})` : ''));
  }
  const summary = (parts.length ? parts.join(', ') : 'Нет рассчитанных тарных мест') +
    ` — итого мест: ${totals.mest}, вес: ${totals.ves} кг`;

  return { groups, pozResults, errors, warnings, summary, totals };
}

// ============================================================
// ✅ T57-e: ДОЗАПОЛНЕНИЕ ГРУПП ТАРНЫХ МЕСТ ПО СОСТАВУ ПОЗИЦИЙ
// (для строки СЗ «на каждый тип тарного места»): группа, собранная
// вручную с пустыми габаритом/весом, получает:
//   габарит = МАКС габаритов мест позиций (лист Д×Ш; пруток Д×сечение связки;
//             тара Д×Ш×В, иначе габарит детали), м;
//   вес     = Σ (вес детали × кол-во) по позициям места, кг.
// Заполненные пользователем значения НЕ перетираются.
// pozRows — строки gryz_poz (+ plan/osnastka) операции.
// ============================================================
function fillTarnGroups(tmArr, pozRows) {
  const mm = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return isNaN(n) ? 0 : n;
  };
  const mMet = (v) => { const x = mm(v); return x > 0 ? Math.round(x) / 1000 : 0; };
  const wOf = (r) => {
    const vz = mm(r.ves_zag);
    if (vz > 0) return vz;
    const L = mm(r.dlina), W = mm(r.shirina);
    let T = mm(r.vysota);
    if (!(T > 0)) T = mm(r.list_tolshina);
    if (L > 0 && W > 0 && T > 0) return L * W * T * STEEL_DENSITY_KG_MM3;
    const D = mm(r.prutok_diametr);
    if (D > 0) {
      const PL = mm(r.dlina) || mm(r.prutok_dlina);
      if (PL > 0) return Math.PI * (D / 2) * (D / 2) * PL * STEEL_DENSITY_KG_MM3;
    }
    return 0;
  };
  // ✅ T57-e-2: габариты позиции в месте — по ТИПУ МЕСТА (gtip), не по типу
  // позиции: листовые позиции, вручную помещённые в «Деревянную тару»,
  // вносят габарит ДЕТАЛИ (содержимого ящика), а не листа 6000×1500.
  const dimsOf = (r, gtip) => {
    const tip = String(gtip || r.tip_gruza || '').trim();
    if (tip === 'listy') return { l: mMet(r.list_dlina), w: mMet(r.list_shirina), h: 0 };
    if (tip === 'prutki') {
      // ✅ T64 (баг 2): сечение связки — от количества прутков позиции
      // («Кол-во заготовок» = прутки; пусто — авто ceil(qty/perBar));
      // как в движке авто-расчёта: сторона квадрата ceil(sqrt(N)) × Ø,
      // но не более 300 мм (раньше был Ø одиночного прутка)
      const DIA = mm(r.prutok_diametr);
      let side = 0;
      if (DIA > 0) {
        let N = Math.round(mm(r.kolvo_zagotovok));
        if (!(N > 0)) {
          const BL = mm(r.prutok_dlina), DL = mm(r.dlina);
          const qty = Math.round(mm(r.kolvo_no_br) + mm(r.kolvo_yes_br));
          if (BL > 0 && DL > 0) {
            const perBar = Math.floor(BL / (DL + PRUTOK_PRIPUSK_MM));
            if (perBar > 0) N = Math.ceil(qty / perBar);
          }
        }
        side = Math.min(PRUTOK_BUNDLE_SIDE_MM, Math.ceil(Math.sqrt(Math.max(N, 1))) * DIA);
      }
      return { l: mMet(r.prutok_dlina), w: side / 1000, h: side / 1000 };
    }
    const tl = mMet(r.tara_dlina), tw = mMet(r.tara_shirina), th = mMet(r.tara_vysota);
    if (tl > 0 && tw > 0 && th > 0) return { l: tl, w: tw, h: th };
    return { l: mMet(r.dlina), w: mMet(r.shirina), h: mMet(r.vysota) };
  };
  const byKey = new Map((pozRows || []).map(r => [String(r.id), r]));
  let obemTot = 0;
  (tmArr || []).forEach((g) => {
    if (!g || typeof g !== 'object') return;
    const pozs = (Array.isArray(g.pozcii) ? g.pozcii : [])
      .map(k => byKey.get(String(k))).filter(Boolean);
    if (pozs.length) {
      let ves = 0, L = 0, W = 0, H = 0;
      pozs.forEach((r) => {
        ves += wOf(r) * Math.round(mm(r.kolvo_no_br) + mm(r.kolvo_yes_br));
        const d = dimsOf(r, g.tip);
        L = Math.max(L, d.l); W = Math.max(W, d.w); H = Math.max(H, d.h);
      });
      if (!mm(g.dlina_m) && L > 0) g.dlina_m = Math.round(L * 1000) / 1000;
      if (!mm(g.shirina_m) && W > 0) g.shirina_m = Math.round(W * 1000) / 1000;
      if (!mm(g.vysota_m) && H > 0) g.vysota_m = Math.round(H * 1000) / 1000;
      if (!mm(g.ves_kg) && ves > 0) g.ves_kg = Math.round(ves * 100) / 100;
    }
    obemTot += mm(g.dlina_m) * mm(g.shirina_m) * mm(g.vysota_m) * mm(g.kolvo);
  });
  return Math.round(obemTot * 100) / 100;   // общий объём груза, м3
}

// ============================================================
// ✅ T57-f: РАСКЛАДКА ТИПОВ ТАРНЫХ МЕСТ ПО СТРОКАМ СЗ «Заявка на отгрузку»
// «Просто следующая строка»: ПЕРВЫЙ тип — строка 6 (обновления DataArray2:
// 34=кол-во AI, 35/36/37=длина/ширина/высота AJ/AK/AL, 39=штабелируемость AN,
// 40=вес AO), каждый СЛЕДУЮЩИЙ тип — следующая строка 7, 8, 9… (т.к. в
// шаблоне строки 7..32). Возвращает { a2Updates, tarnRows }.
// Объём строки считает формула шаблона AM — сюда НЕ входит.
// ============================================================
function szRows(tmArr, oper, toRuNumber, a1, a2) {
  const a2Updates = {};
  const tarnRows = [];
  // ✅ T58-2.1: КОЛОНКИ С ОДИНАКОВЫМИ ДАННЫМИ ДУБЛИРУЮТСЯ В СТРОКИ 7+.
  // Одинаковые для всех строк тарных мест значения: B..Z (DataArray1 —
  // заказчик/грузоотправитель/адреса/контакты), AH (класс опасности),
  // AP..BD (даты/время отгрузки и прибытия, № рейса, транспорт, способ
  // загрузки, темрежим, оформление ТН, комментарий, плательщик,
  // описание груза, кто с ЭДО, причина/виновник срочности).
  // Своя у каждой строки: AG (наименование груза = тип места), AI..AL
  // (кол-во/габарит), AM (формула объёма — не трогаем), AN (штабел.),
  // AO (вес); BE («Требуется заказ транспорта?») — «+» в каждой строке.
  const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const sharedCells = {};
  if (a1) {
    for (let i = 1; i <= 25; i++) {           // B..Z
      if (a1[i] === undefined) continue;
      sharedCells[colLetter(i + 1)] = a1[i];
    }
  }
  if (a2) {
    if (a2[33] !== undefined) sharedCells.AH = a2[33];   // класс опасности
    for (let i = 41; i <= 55; i++) {          // AP..BD
      if (a2[i] === undefined) continue;
      sharedCells[colLetter(i + 1)] = a2[i];
    }
  }
  (Array.isArray(tmArr) ? tmArr : []).slice(0, 27).forEach((g, i) => {
    if (!g || typeof g !== 'object') return;
    if (i === 0) {
      // ПЕРВЫЙ тип — строка 6 через DataArray2 (VBA 1:1)
      // ✅ T58-2.3: наименование груза (AG6) — ЧЁТКОЕ НАЗВАНИЕ тарного
      // места («Пачки листов»/«Связки прутков»/«Деревянная тара»),
      // а не старое «Заготовки в листах: ШВЕЛЛЕР (заготовка в листах)…»
      if (String(g.name || '').trim()) a2Updates[32] = String(g.name);
      a2Updates[34] = toRuNumber(g.kolvo);      // AI6 — кол-во мест
      a2Updates[35] = toRuNumber(g.dlina_m);    // AJ6 — длина, м
      a2Updates[36] = toRuNumber(g.shirina_m);  // AK6 — ширина, м
      a2Updates[37] = toRuNumber(g.vysota_m);   // AL6 — высота, м
      a2Updates[39] = String(g.shtabil || '');  // AN6 — штабелируемость
      a2Updates[40] = toRuNumber(g.ves_kg);     // AO6 — вес, кг
    } else {
      // последующие типы — строки 7, 8, 9…
      tarnRows.push({ row: 6 + i, cells: Object.assign({}, sharedCells, {
        AG: String(g.name || ''),               // наименование груза = тип места
        AH: String((oper && oper.opasnost_class) || ''), // класс опасности
        AI: toRuNumber(g.kolvo),                // кол-во мест
        AJ: toRuNumber(g.dlina_m),              // длина, м
        AK: toRuNumber(g.shirina_m),            // ширина, м
        AL: toRuNumber(g.vysota_m),             // высота, м
        AN: String(g.shtabil || ''),            // штабелируемость
        AO: toRuNumber(g.ves_kg),               // вес, кг
        BE: '+'                                 // ✅ T58-2.2: «Требуется заказ транспорта?» — «+» в каждой строке
      }) });
    }
  });
  return { a2Updates, tarnRows };
}

module.exports = {
  calcTarnMesta, sheetCalcFor, barCalcFor, ukladkaCapacity, nestSheetGroups, partWeightOf,
  fillTarnGroups, szRows,
  LIST_PRIPUSK_MM, PRUTOK_PRIPUSK_MM, LIST_STACK_LIMIT_MM, PRUTOK_BUNDLE_SIDE_MM, UKLADKA_LABEL
};
