// ============================================================
// public/js/modules/offers-matrix.js
// ✅ T74: «МАТРИЦА ВЫБОРА ПОСТАВЩИКА» — визуализация сводной КП
// ============================================================
// Назначение:
//   С одной картинки показать результат сравнения фирм по запросу КП:
//   • строки  — позиции (детали ПТО) запроса;
//   • колонки — ТОЛЬКО фирмы, у которых есть хотя бы одно КП с ценой
//     (фирмы без предложений в графике не отображаются);
//   • ячейка  — стоимость партии (Стоим × Кол-во) на зелёно-красной
//     шкале по строке (зелёный — дешевле) + трудоёмкость ед. (н/ч) +
//     тип производства (сокращённо);
//   • ★ в строке — ячейка с МИНИМАЛЬНОЙ стоимостью (критерий согласован
//     с логикой «лучшее предложение по цене»);
//   • строка ИТОГО — сумма по позициям с КП + мини-бары + покрытие
//     «N из M поз.»; ★ ИТОГО — минимум среди фирм с МАКСИМАЛЬНЫМ
//     покрытием (фирмы с неполным покрытием не участвуют в выборе
//     лучшего ИТОГО, их бар — нейтральный);
//   • слева справочная колонка «Целевая ПТО» (расчёт заказчика:
//     труд-ть × целевая цена н/ч × план кол-во) для оценки отклонения;
//   • наведение на ячейку — тултип с полными параметрами КП
//     (цена н/ч, кол-во, срок, отклонение от целевой, обоснование);
//   • клик по ячейке — карточка КП (модальное окно) с кнопкой
//     «Выбрать фирму в фильтре» (переиспользует #fltFirma change);
//   • клик по ячейке ИТОГО фирмы — выбрать фирму в фильтре.
//
// Архитектура:
//   • Модуль самодостаточный: стили, тултип и модалку создаёт сам
//     (offers.html содержит только контейнер #matrixWrap/#choiceMatrix).
//   • Данные — те же, что у сводной таблицы (Offers._allKP), вызов из
//     Offers._rebuildSummaryTable → renderChoiceMatrix(allKP).
//     Никаких дополнительных запросов к серверу.
//   • Без внешних библиотек — чистый HTML/CSS.
//   • Экспорт: renderChoiceMatrix(allKP), clearChoiceMatrix().
//
// ✅ T75: вторая визуализация — SCATTER «Трудоёмкость vs Стоимость»
//   (SVG, без библиотек; рендерится из renderChoiceMatrix в
//   #scatterWrap/#kpScatter): точка = фирма с ценами, X — суммарная
//   трудоёмкость партий (н/ч), Y — суммарная стоимость партий (₽);
//   ◆ Цель — целевые параметры; пунктиры — уровни цели; диагональ из
//   начала координат — средняя цена н/ч = целевой; контурная точка —
//   фирма с неполным покрытием позиций (суммы несопоставимы, как и у
//   ★ ИТОГО); клик по точке — выбрать фирму в фильтре.
//
// ✅ T76: улучшения по обратной связи:
//   • scatter переключается КЛИКОМ ПО СТРОКЕ матрицы (позиция) и по
//     строке ИТОГО (итоги по всем позициям); дубль — селект режима;
//   • чекбокс «не допускается разбивать партию»: когда снят, на
//     диаграмме появляется СБОРНАЯ точка (Σ лучших цен и Σ лучших
//     трудоёмкостей по позициям от разных фирм);
//   • матрица + scatter живут в контейнере принятия решения
//     (#decisionBlock, сворачивание как у фильтров) с горизонтальным
//     ресайзером #decisionResizer над сводной таблицей.
//
// ✅ T78 (ревизия по обратной связи):
//   • строки матрицы ОБЪЕДИНЕНЫ по № чертежа: синтетически разделённые
//     позиции плана (разделение по мощности) — одна строка с суммой
//     плановых количеств; КП-копии фирм не задваиваются;
//   • нумерация позиций + чекбоксы «показать на диаграмме» (номер — в
//     символе точки, итоговые точки — без номера);
//   • колонка «Лучшее предложение»: партии фирм-победительниц по
//     ПЛАНОВОМУ кол-ву; при требовании запроса «не допускается разбивать
//     партию» (zapros_kp.komplekt) — предложение фирмы-победителя на всю
//     партию (и стоимость, и трудоёмкость);
//   • ИТОГО по фирмам — только при «комплекте» и предложениях по всем
//     позициям; итоги «Целевая ПТО» и «Лучшего предложения» — только по
//     позициям с предложениями;
//   • диаграмма интерактивная (масштаб/сдвиг), цель и лучшее предложение
//     без номера, отмеченные позиции — с номером в символе.
// ============================================================

// Сокращения типа производства (полный текст — в тултипе/карточке)
function tipAbbr(tip) {
  if (!tip) return '';
  const t = String(tip).toUpperCase();
  if (t.includes('ПОЛНЫЙ ЦИКЛ')) return 'ПЦ';
  if (t.includes('ПОЛНАЯ МЕХ')) return 'ПМ б/ТО';
  if (t.includes('ЧАСТИЧНАЯ') && t.includes('С ТО')) return 'ЧМ с ТО';
  if (t.includes('ЧАСТИЧНАЯ')) return 'ЧМ б/ТО';
  const s = String(tip);
  return s.length > 14 ? s.slice(0, 13) + '…' : s;
}

// Числа из БД могут прийти строками ('142.68', '176008,5')
function num(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

const fmtInt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rub = (n) => fmtInt.format(Math.round(n)) + ' ₽';

// Зелёно-красная шкала заливки ячейки (t: 0 = лучший/зелёный, 1 = худший/красный)
function heatColor(t) {
  const h = Math.round(140 * (1 - t));      // 140 (зелёный) → 0 (красный), через жёлтый
  const l = 93 - Math.round(9 * t);         // светлый фон — тёмный текст читается
  return `hsl(${h}, 62%, ${l}%)`;
}
// Насыщенный цвет для мини-баров строки ИТОГО
function heatBarColor(t) {
  const h = Math.round(140 * (1 - t));
  return `hsl(${h}, 55%, 45%)`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null && text !== '') e.textContent = text;
  return e;
}

// ============================================================
// СОСТОЯНИЕ МОДУЛЯ
// ============================================================
const _cellData = new Map();   // key → payload (тултип/карточка)
let _tooltip = null;           // единственный div тултипа
let _modal = null;             // { overlay, title, sub, body, btnFirma, btnClose }
let _modalFirmaId = null;      // фирма для кнопки «Выбрать фирму в фильтре»
let _stylesInjected = false;

// ============================================================
// СТИЛИ — инжектятся один раз (offers.html патчить не нужно)
// ============================================================
const MATRIX_CSS = `
#matrixWrap { margin: 8px 0 10px; }
#matrixWrap .kp-mx-container { max-height: 46vh; overflow: auto; border: 1px solid #c3ccd6; border-radius: 6px; background: #fff; }
#matrixWrap .kp-mx-legend { font-size: 10.5px; color: #5b6773; margin-top: 4px; line-height: 1.4; }
#matrixWrap .kp-mx-legend .lg { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; margin: 0 3px 0 8px; }
.kp-mx { border-collapse: separate; border-spacing: 0; width: max-content; font-size: 11px; }
.kp-mx th, .kp-mx td { box-sizing: border-box; padding: 4px 6px; border-right: 1px solid #dfe5ec; border-bottom: 1px solid #dfe5ec; vertical-align: middle; }
.kp-mx thead th { position: sticky; top: 0; z-index: 3; background: #e8eef5; border-bottom: 2px solid #b9c4d0; text-align: center; }
.kp-mx thead th.kp-mx-pos { left: 44px; z-index: 5; text-align: left; }
.kp-mx .kp-mx-pos { position: sticky; left: 44px; z-index: 2; background: #f3f6fa; min-width: 168px; max-width: 218px; }
.kp-mx-chn { font-weight: 700; font-size: 12px; color: #1a2733; white-space: nowrap; }
.kp-mx-naim { font-size: 10px; color: #5b6773; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 206px; }
.kp-mx-kolvo { font-size: 9.5px; color: #8a94a0; }
.kp-mx-h .kp-mx-firm { font-weight: 700; font-size: 10.5px; color: #1a2733; max-width: 112px; margin: 0 auto; line-height: 1.15; }
.kp-mx-h .kp-mx-cap { font-size: 9px; color: #8a94a0; font-weight: 400; }
.kp-mx-cell { text-align: center; min-width: 98px; }
.kp-mx-cell[data-mx-key] { cursor: pointer; }
.kp-mx-cell[data-mx-key]:hover { outline: 2px solid #4a7db5; outline-offset: -2px; }
.kp-mx-cell.tgt { background: #eef2f7; }
.kp-mx-val { font-weight: 700; font-size: 12px; color: #1a2733; white-space: nowrap; font-variant-numeric: tabular-nums; }
.kp-mx-val.muted { color: #9aa2ad; }
.kp-mx-sub { font-size: 9.5px; color: #46535f; white-space: nowrap; }
.kp-mx-cell.best { background: #2e9e44 !important; outline: 2px solid #1b7a35; outline-offset: -2px; }
.kp-mx-cell.best .kp-mx-val { color: #fff; }
.kp-mx-cell.best .kp-mx-sub { color: #e2f6e5; }
.kp-mx-cell.best .kp-mx-val::before { content: '\\2605 '; }
.kp-mx-nocell { text-align: center; color: #b7bfc9; background: repeating-linear-gradient(45deg, #fafbfc, #fafbfc 6px, #f1f3f6 6px, #f1f3f6 12px); }
.kp-mx-total th, .kp-mx-total td { border-top: 2px solid #b9c4d0; position: sticky; bottom: 0; z-index: 3; background: #e8eef5; }
.kp-mx-total th.kp-mx-pos { z-index: 5; }
.kp-mx-total-title { font-weight: 700; font-size: 12px; color: #1a2733; }
.kp-mx-total .best-total .kp-mx-val { color: #1b7a35; }
.kp-mx-total .best-total .kp-mx-val::before { content: '\\2605 '; }
.kp-mx-bar { height: 5px; background: #dde4ec; border-radius: 3px; margin-top: 3px; overflow: hidden; }
.kp-mx-bar > span { display: block; height: 100%; border-radius: 3px; min-width: 2px; }
.kp-mx-tooltip { position: fixed; z-index: 3000; background: #fff; border: 1px solid #9aa7b5; border-radius: 8px; box-shadow: 0 6px 24px rgba(15,30,50,.25); padding: 8px 11px; font-size: 11.5px; max-width: 360px; pointer-events: none; color: #1a2733; display: none; }
.kp-mx-tooltip .tt-title { font-weight: 700; font-size: 12.5px; margin-bottom: 3px; }
.kp-mx-tooltip .tt-sub { color: #5b6773; margin-bottom: 4px; }
.kp-mx-tooltip .tt-row { display: flex; justify-content: space-between; gap: 14px; margin: 2px 0; }
.kp-mx-tooltip .tt-k { color: #5b6773; white-space: nowrap; }
.kp-mx-tooltip .tt-v { font-weight: 600; text-align: right; }
.kp-mx-tooltip .tt-v.up { color: #c62828; }
.kp-mx-tooltip .tt-v.down { color: #1b7a35; }
.kp-mx-tooltip .tt-best { margin-top: 4px; color: #1b7a35; font-weight: 700; }
.kp-mx-tooltip .tt-note { margin-top: 4px; color: #8a6d1a; font-style: italic; }
.kp-mx-overlay { position: fixed; inset: 0; background: rgba(20,30,40,.45); display: flex; align-items: center; justify-content: center; z-index: 1500; }
.kp-mx-overlay.hidden { display: none; }
.kp-mx-window { background: #fff; border-radius: 8px; padding: 14px 18px; width: 540px; max-width: 95vw; max-height: 88vh; overflow: auto; box-shadow: 0 8px 30px rgba(0,0,0,.28); }
.kp-mx-window h3 { margin: 0 0 2px; font-size: 15px; color: #1a2733; }
.kp-mx-window .kp-mx-sub-title { margin: 0 0 10px; color: #5b6773; font-size: 12.5px; }
.kp-mx-window .kp-mx-fs { border: 1px solid #c8d0d8; border-radius: 6px; margin: 0 0 10px; padding: 6px 10px 8px; }
.kp-mx-window .kp-mx-fs legend { font-size: 11px; color: #66717d; padding: 0 4px; }
.kp-mx-window .kp-mx-frow { display: flex; justify-content: space-between; gap: 16px; margin: 4px 0; font-size: 12.5px; }
.kp-mx-window .kp-mx-frow .k { color: #5b6773; white-space: nowrap; }
.kp-mx-window .kp-mx-frow .v { font-weight: 600; text-align: right; }
.kp-mx-window .kp-mx-frow .v.up { color: #c62828; }
.kp-mx-window .kp-mx-frow .v.down { color: #1b7a35; }
.kp-mx-window .kp-mx-osnov { font-style: italic; color: #46535f; background: #f6f8fa; border-radius: 4px; padding: 6px 8px; font-size: 12px; }
.kp-mx-window .kp-mx-badge-best { display: inline-block; background: #2e9e44; color: #fff; border-radius: 4px; padding: 1px 8px; font-size: 11px; font-weight: 700; margin-left: 6px; }
.kp-mx-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }

/* ✅ T75: scatter «Трудоёмкость vs Стоимость» */
#scatterWrap { margin: 8px 0 10px; }
.kp-sc-container { border: 1px solid #c3ccd6; border-radius: 6px; background: #fff; padding: 4px 2px 0; }
.kp-sc-container svg { display: block; }
.kp-sc-grid { stroke: #eef2f7; stroke-width: 1; }
.kp-sc-zero { stroke: #dbe3ec; stroke-width: 1.2; }
.kp-sc-axis { stroke: #9aa7b5; stroke-width: 1; }
.kp-sc-tick { font-size: 10px; fill: #7a8794; }
.kp-sc-axis-title { font-size: 11px; fill: #46535f; font-weight: 600; }
.kp-sc-guide { stroke: #b9c4d0; stroke-width: 1.2; stroke-dasharray: 5 4; }
.kp-sc-hint { font-size: 10px; fill: #8a94a0; font-style: italic; }
.kp-sc-lbl { font-size: 10.5px; font-weight: 600; fill: #1a2733; paint-order: stroke; stroke: rgba(255,255,255,.88); stroke-width: 3px; pointer-events: none; }
.kp-sc-pt { cursor: pointer; }
.kp-sc-pt:hover .pt-body { stroke-width: 2.6px; }

/* ✅ T76: клик по строке матрицы — режим диаграммы; активная строка */
.kp-mx tr[data-mx-row] { cursor: pointer; }
.kp-mx tr[data-mx-row].kp-mx-row-act > td,
.kp-mx tr[data-mx-row].kp-mx-row-act > th { box-shadow: inset 3px 0 0 var(--primary); }
/* ✅ T76: панель управления scatter (режим + чекбокс партии) */
#kpScatterCtrls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
#kpScatterMode { max-width: 300px; font-size: 11.5px; padding: 1px 4px; }
#lblNoSplit { white-space: nowrap; font-size: 11.5px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
/* ✅ T78: нумерация позиций + чекбокс «показать на диаграмме» */
.kp-mx th.kp-mx-numcol, .kp-mx td.kp-mx-numcol { position: sticky; left: 0; z-index: 4; background: #f3f6fa; text-align: center; min-width: 44px; width: 44px; padding: 4px 2px; }
.kp-mx thead th.kp-mx-numcol { z-index: 6; background: #e8eef5; }
.kp-mx-total td.kp-mx-numcol { z-index: 5; }
.kp-mx-numlbl { display: inline-flex; align-items: center; gap: 3px; font-weight: 700; font-size: 11px; color: #1a2733; cursor: pointer; user-select: none; }
/* ✅ T78: колонка «Лучшее предложение» */
.kp-mx-cell.bestoffer { background: #e9f5ec; }
.kp-mx-cell.bestoffer .kp-mx-val { color: #1b7a35; }
/* ✅ T78: диаграмма — масштаб/сдвиг */
#kpScatter { cursor: grab; }
#kpScatter.panning { cursor: grabbing; }
.kp-sc-pt-num { font-size: 9px; font-weight: 700; fill: #fff; pointer-events: none; }
/* ✅ T80: бейджи значений линий на перекрестиях (в концах у осей) */
.kp-sc-gval { font-size: 9px; font-weight: 700; fill: #fff; pointer-events: none; }
.kp-sc-gval.d { fill: #46535f; }
.kp-sc-gvalr { stroke: #b9c4d0; stroke-width: 1; }
/* ✅ T80: перекрестие при наведении на предложение */
.kp-sc-hline { stroke-width: 1.3; stroke-dasharray: 4 3; }
/* ✅ T80: слой наведения — только визуализация: не перехватывает
   клики/наведение (иначе линия подсветки закрывает круги) */
#scHoverLayer { pointer-events: none; }
/* ✅ T80: легенда — цвет названия фирмы = цвет метки фирмы */

/* ✅ T81: подсветка ячейки матрицы при синхронизации наведения
   «матрица ↔ диаграмма» (наведение на предложение в матрице подсвечивает
   точку на графике и наоборот — рамка цвета акцента) */
.kp-mx td.kp-mx-sync-hl, .kp-mx th.kp-mx-sync-hl { box-shadow: inset 0 0 0 2px var(--primary); }
/* ✅ T81: полноэкранный режим диаграммы — поверх страницы, но ПОД
   карточкой КП (z 1500) и тултипом (z 3000) */
#scatterWrap.sc-fs { position: fixed; left: 0; right: 0; top: 0; bottom: 0; z-index: 1200; background: #fff; padding: 10px 16px; margin: 0; overflow: auto; }
`;


function injectStyles() {
  if (_stylesInjected) return;
  if (!document.getElementById('kpMatrixStyles')) {
    const st = document.createElement('style');
    st.id = 'kpMatrixStyles';
    st.textContent = MATRIX_CSS;
    document.head.appendChild(st);
  }
  _stylesInjected = true;
}

// ============================================================
// ТУЛТИП
// ============================================================
function ensureTooltip() {
  if (_tooltip) return _tooltip;
  _tooltip = el('div', 'kp-mx-tooltip');
  _tooltip.id = 'kpMatrixTooltip';
  document.body.appendChild(_tooltip);
  return _tooltip;
}

function ttRow(k, v, vCls) {
  const row = el('div', 'tt-row');
  row.appendChild(el('span', 'tt-k', k));
  const vv = el('span', 'tt-v' + (vCls ? ' ' + vCls : ''), v);
  row.appendChild(vv);
  return row;
}

function showTip(payload) {
  const tip = ensureTooltip();
  tip.innerHTML = '';
  if (payload.type === 'kp') {
    tip.appendChild(el('div', 'tt-title', (payload.num ? '№ ' + payload.num + ' · ' : '') + payload.firma)); // ✅ T79
    tip.appendChild(el('div', 'tt-sub', payload.detal + (payload.tip ? ' · ' + payload.tip : '')));
    if (payload.priced) {
      tip.appendChild(ttRow('Стоимость партии:', rub(payload.stoimPartii)));
      tip.appendChild(ttRow('Стоимость ед.:', rub(payload.stoimEd)));
      tip.appendChild(ttRow('Трудоёмкость ед.:', fmt2.format(payload.trud) + ' н/ч'));
      tip.appendChild(ttRow('Цена н/ч:', rub(payload.cenaNch)));
      tip.appendChild(ttRow('Кол-во:', fmtInt.format(payload.kolvo) + ' шт. (план: ' + fmtInt.format(payload.planKolvo) + ')'));
      // ✅ T79: точка на диаграмме считается по плановому кол-ву
      if (payload.chCost != null) tip.appendChild(ttRow('Партия по план. кол-ву:', rub(payload.chCost) + ' · ' + fmt2.format(payload.chLabor || 0) + ' н/ч'));
      if (payload.srok) tip.appendChild(ttRow('Срок:', payload.srok));
      if (payload.targetPartii > 0) {
        const cls = payload.otkl > 0 ? 'up' : (payload.otkl < 0 ? 'down' : '');
        const sign = payload.otkl > 0 ? '+' : '';
        tip.appendChild(ttRow('Отклонение от целевой:',
          sign + fmtInt.format(Math.round(payload.otkl)) + ' ₽ (' + sign + fmt2.format(payload.otklPct) + '%)', cls));
      }
      if (payload.primechanie) tip.appendChild(ttRow('Обоснование:', payload.primechanie));
      if (payload.isBest) tip.appendChild(el('div', 'tt-best', '★ минимальная цена по позиции'));
    } else {
      tip.appendChild(el('div', 'tt-note', 'КП есть, но стоимость не рассчитана (нет цены или кол-ва)'));
      if (payload.trud > 0) tip.appendChild(ttRow('Трудоёмкость ед.:', fmt2.format(payload.trud) + ' н/ч'));
      if (payload.srok) tip.appendChild(ttRow('Срок:', payload.srok));
      if (payload.primechanie) tip.appendChild(ttRow('Обоснование:', payload.primechanie));
    }
  } else if (payload.type === 'kpGroup') {
    // ✅ T82: совпавшие предложения — один маркер, номера внутри
    tip.appendChild(el('div', 'tt-title', 'Совпавшие предложения: ' + payload.items.length));
    tip.appendChild(el('div', 'tt-sub',
      'Одинаковые стоимость и трудоёмкость партии — маркеры наложились, номера позиций внутри маркера'));
    payload.items.forEach((it) => {
      tip.appendChild(el('div', 'tt-note',
        '№ ' + it.num + ' · ' + it.firma + ' — ' + rub(it.cost) + ' · ' + fmt2.format(it.labor) + ' н/ч'
        + (it.isBest ? ' · ★' : '')));
    });
    if (payload.openFirma) tip.appendChild(el('div', 'tt-note',
      'Клик — карточка КП «' + payload.openFirma + '» (№ ' + payload.openNum + ')'));
  } else if (payload.type === 'targetGroup') {
    // ✅ T82: совпавшие целевые ромбы — один маркер, номера внутри
    tip.appendChild(el('div', 'tt-title', 'Целевые стоимости ПТО — точки совпали'));
    tip.appendChild(el('div', 'tt-sub',
      'Одинаковые цель и плановое кол-во — маркеры наложились, номера позиций внутри маркера'));
    payload.items.forEach((it) => {
      tip.appendChild(el('div', 'tt-note',
        '№ ' + it.num + ' · ' + it.detal + ' — ' + rub(it.targetPartii) + ' · ' + fmt2.format(it.trudPto) + ' н/ч'));
    });
  } else if (payload.type === 'target') {
    tip.appendChild(el('div', 'tt-title', 'Целевая стоимость ПТО (расчёт заказчика)'));
    tip.appendChild(el('div', 'tt-sub', payload.detal));
    tip.appendChild(ttRow('Стоимость партии:', rub(payload.targetPartii)));
    tip.appendChild(ttRow('Трудоёмкость ед.:', fmt2.format(payload.trudPto) + ' н/ч'));
    tip.appendChild(ttRow('Цена н/ч целевая:', rub(payload.cenaPto)));
    tip.appendChild(ttRow('Кол-во:', fmtInt.format(payload.planKolvo) + ' шт.'));
    if (payload.noOffer) tip.appendChild(el('div', 'tt-note', 'Предложений по позиции нет — в итогах и на диаграмме не учитывается'));
  } else if (payload.type === 'total') {
    // ✅ T78: итог фирмы — только «комплект» + полное покрытие, по план. кол-ву
    tip.appendChild(el('div', 'tt-title', 'ИТОГО: ' + payload.firma));
    tip.appendChild(ttRow('Сумма партий (план. кол-во):', rub(payload.sum)));
    tip.appendChild(ttRow('Трудоёмкость партий:', fmt2.format(payload.labor || 0) + ' н/ч'));
    tip.appendChild(ttRow('Покрытие:', payload.n + ' из ' + payload.m + ' поз.'));
    tip.appendChild(el('div', 'tt-note',
      'Требование «не допускается разбивать партию»: вся партия — у одной фирмы. Клик — выбрать фирму в фильтре'));
  } else if (payload.type === 'bestTotal') {
    // ✅ T78: итог колонки «Лучшее предложение»
    tip.appendChild(el('div', 'tt-title', 'ИТОГО «Лучшее предложение»'));
    tip.appendChild(el('div', 'tt-sub', payload.batchFirm
      ? 'Предложение фирмы-победителя на всю партию: ' + payload.batchFirm
      : 'Лучшая комбинация по позициям (партия разбита между фирмами)'));
    tip.appendChild(ttRow('Стоимость партии:', rub(payload.cost)));
    tip.appendChild(ttRow('Трудоёмкость партии:', fmt2.format(payload.labor) + ' н/ч'));
    if (!payload.noSplit) {
      tip.appendChild(el('div', 'tt-note',
        'Отметьте в запросе «не допускается разбивать партию», чтобы партия заказывалась у одной фирмы'));
    }
  } else if (payload.type === 'scatterPos') {
    // ✅ T78: точка позиции (номер — в символе) / ячейка «Лучшее предложение»
    tip.appendChild(el('div', 'tt-title', '№ ' + payload.num + ' — ' + (payload.nomer || '—')));
    if (payload.naim) tip.appendChild(el('div', 'tt-sub', payload.naim));
    tip.appendChild(ttRow('Стоимость партии:', rub(payload.cost)));
    tip.appendChild(ttRow('Трудоёмкость партии:', fmt2.format(payload.labor) + ' н/ч'));
    tip.appendChild(ttRow('Плановое кол-во:', fmtInt.format(payload.planQty) + ' шт.'));
    (payload.parts || []).forEach((pt) => {
      tip.appendChild(el('div', 'tt-note',
        pt.firma + ' — ' + fmtInt.format(pt.serve) + ' шт. × ' + fmtInt.format(pt.price) + ' ₽ (' + fmt2.format(pt.labor * pt.serve) + ' н/ч)'));
    });
    if (payload.batchFirm) tip.appendChild(el('div', 'tt-best', 'Фирма — победитель по всей партии (комплект)'));
    if (payload.remainder > 0) tip.appendChild(el('div', 'tt-note',
      'Мощности фирм не хватает на ' + fmtInt.format(payload.remainder) + ' шт. — остаток без предложения'));
  } else if (payload.type === 'scatterBest') {
    // ✅ T78: точка «Лучшее предложение» на диаграмме
    tip.appendChild(el('div', 'tt-title', 'Лучшее предложение — итоги по партии'));
    tip.appendChild(el('div', 'tt-sub', payload.batchFirm
      ? 'Предложение одной фирмы (требование «не допускается разбивать партию»): ' + payload.batchFirm
      : 'Лучшая комбинация по позициям (партия разбита между фирмами)'));
    tip.appendChild(ttRow('Стоимость партии:', rub(payload.cost)));
    tip.appendChild(ttRow('Трудоёмкость партии:', fmt2.format(payload.labor) + ' н/ч'));
    (payload.parts || []).slice(0, 12).forEach((pt) => {
      tip.appendChild(el('div', 'tt-note',
        '№ ' + pt.num + ' ' + (pt.nomer || '—') + ': ' + (pt.batchFirm
          ? pt.batchFirm
          : (pt.parts || []).map((w) => w.firma + ' — ' + fmtInt.format(w.serve) + ' шт.').join(' + '))));
    });
  } else if (payload.type === 'scatter') {
    // ✅ T75/T76: точка scatter — итоги по фирме или КП по позиции
    tip.appendChild(el('div', 'tt-title', payload.firma));
    if (payload.mode === 'position') {
      // ✅ T76: режим позиции
      tip.appendChild(el('div', 'tt-sub', payload.detal || 'Позиция'));
      tip.appendChild(ttRow('Стоимость партии:', rub(payload.sum)));
      tip.appendChild(ttRow('Трудоёмкость партии:', fmt2.format(payload.trudX) + ' н/ч'));
      if (payload.trudEd > 0) tip.appendChild(ttRow('Трудоёмкость ед.:', fmt2.format(payload.trudEd) + ' н/ч'));
      if (payload.cenaNch > 0) tip.appendChild(ttRow('Цена н/ч:', rub(payload.cenaNch)));
      tip.appendChild(ttRow('Кол-во:', fmtInt.format(payload.kolvo) + ' шт. (план: ' + fmtInt.format(payload.planKolvo || 0) + ')'));
      if (payload.targetYT > 0) {
        const cls = payload.otkl > 0 ? 'up' : (payload.otkl < 0 ? 'down' : '');
        const sign = payload.otkl > 0 ? '+' : '';
        tip.appendChild(ttRow('Отклонение от целевой:',
          sign + fmtInt.format(Math.round(payload.otkl)) + ' ₽ (' + sign + fmt2.format(payload.otklPct) + '%)', cls));
      }
      tip.appendChild(el('div', 'tt-note', 'Клик — выбрать фирму в фильтре'));
    } else {
      tip.appendChild(el('div', 'tt-sub', 'Все позиции с ценами (агрегат)'));
      tip.appendChild(ttRow('Стоимость партий:', rub(payload.sum)));
      tip.appendChild(ttRow('Трудоёмкость партий:', fmt2.format(payload.trudX) + ' н/ч'));
      if (payload.trudX > 0) {
        tip.appendChild(ttRow('Средняя цена н/ч:', rub(payload.avgCena)));
      }
      tip.appendChild(ttRow('Покрытие:', payload.n + ' из ' + payload.m + ' поз.'));
      if (payload.targetYT > 0) {
        const cls = payload.otkl > 0 ? 'up' : (payload.otkl < 0 ? 'down' : '');
        const sign = payload.otkl > 0 ? '+' : '';
        tip.appendChild(ttRow('Отклонение от целевой:',
          sign + fmtInt.format(Math.round(payload.otkl)) + ' ₽ (' + sign + fmt2.format(payload.otklPct) + '%)', cls));
      }
      if (payload.n < payload.maxN) {
        tip.appendChild(el('div', 'tt-note',
          'Фирма предложила цену не по всем позициям — точка показана контуром; в выборе лучшего ИТОГО (★) не участвует'));
      }
      tip.appendChild(el('div', 'tt-note', 'Клик — выбрать фирму в фильтре'));
    }
  } else if (payload.type === 'scatterSynth') {
    // ✅ T76: сборная точка — лучшие по позициям от разных фирм
    tip.appendChild(el('div', 'tt-title', 'Сборная точка — лучшие по позициям'));
    tip.appendChild(el('div', 'tt-sub', 'Цена и трудоёмкость — от разных фирм (партия разбита)'));
    tip.appendChild(ttRow('Стоимость сборной:', rub(payload.sum)));
    tip.appendChild(ttRow('Трудоёмкость сборной:', fmt2.format(payload.trudX) + ' н/ч'));
    if (payload.trudX > 0) {
      tip.appendChild(ttRow('Средняя цена н/ч:', rub(payload.sum / payload.trudX)));
    }
    (payload.parts || []).slice(0, 12).forEach((pt) => {
      tip.appendChild(el('div', 'tt-note',
        pt.nomer + ': ' + (pt.yF === pt.xF ? pt.yF : 'цена — ' + pt.yF + ', труд-ть — ' + pt.xF)));
    });
    tip.appendChild(el('div', 'tt-note',
      'Не является предложением одной фирмы; чекбокс «не допускается разбивать партию» снят'));
  } else if (payload.type === 'scatterTarget') {
    // ✅ T75: ромб «Цель»
    tip.appendChild(el('div', 'tt-title', 'Целевая точка (расчёт заказчика)'));
    tip.appendChild(ttRow('Трудоёмкость партий:', fmt2.format(payload.targetXT) + ' н/ч'));
    tip.appendChild(ttRow('Стоимость:', rub(payload.targetYT)));
    if (payload.excluded > 0) tip.appendChild(el('div', 'tt-note',
      'Позиции без предложений исключены: ' + payload.excluded));
    if (payload.targetXT > 0) {
      tip.appendChild(ttRow('Цена н/ч целевая:', rub(payload.targetYT / payload.targetXT)));
    }
  } else if (payload.type === 'totalTarget') {
    tip.appendChild(el('div', 'tt-title', 'ИТОГО целевая стоимость ПТО'));
    tip.appendChild(ttRow('Сумма по всем позициям:', rub(payload.sum)));
  }
  tip.style.display = 'block';
}

function hideTip() {
  if (_tooltip) _tooltip.style.display = 'none';
}

function moveTip(ev) {
  if (!_tooltip || _tooltip.style.display !== 'block') return;
  const pad = 14;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  const w = _tooltip.offsetWidth;
  const h = _tooltip.offsetHeight;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = Math.max(8, ev.clientY - h - pad);
  _tooltip.style.left = x + 'px';
  _tooltip.style.top = y + 'px';
}

// ============================================================
// МОДАЛЬНАЯ КАРТОЧКА КП
// ============================================================
function ensureModal() {
  if (_modal) return _modal;
  const overlay = el('div', 'kp-mx-overlay hidden');
  overlay.id = 'kpMatrixModal';
  const win = el('div', 'kp-mx-window');
  const title = el('h3', '', 'КП');
  const sub = el('p', 'kp-mx-sub-title', '');
  const body = el('div', '', '');
  const actions = el('div', 'kp-mx-actions');
  const btnFirma = el('button', 'btn btn-sm btn-primary', '🏢 Выбрать фирму в фильтре');
  const btnClose = el('button', 'btn btn-sm', 'Закрыть');
  actions.appendChild(btnFirma);
  actions.appendChild(btnClose);
  win.appendChild(title);
  win.appendChild(sub);
  win.appendChild(body);
  win.appendChild(actions);
  overlay.appendChild(win);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeModal(); });
  btnClose.addEventListener('click', closeModal);
  btnFirma.addEventListener('click', () => {
    if (_modalFirmaId != null) selectFirma(_modalFirmaId);
    closeModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
  });

  _modal = { overlay, title, sub, body, btnFirma };
  return _modal;
}

function openModal(p) {
  const m = ensureModal();
  _modalFirmaId = p.firmaId;
  m.title.textContent = 'КП: ' + p.firma;
  // бейдж «лучший» добавим в подзаголовок
  m.sub.innerHTML = '';
  m.sub.appendChild(document.createTextNode(p.detal));
  if (p.isBest) m.sub.appendChild(el('span', 'kp-mx-badge-best', '★ минимальная цена'));
  m.body.innerHTML = '';

  const fsCommon = el('fieldset', 'kp-mx-fs');
  fsCommon.appendChild(el('legend', '', 'Параметры предложения'));
  const addRow = (fs, k, v, vCls) => {
    const r = el('div', 'kp-mx-frow');
    r.appendChild(el('span', 'k', k));
    r.appendChild(el('span', 'v' + (vCls ? ' ' + vCls : ''), v));
    fs.appendChild(r);
  };
  addRow(fsCommon, 'Тип изготовления:', p.tip || '—');
  if (p.priced) {
    addRow(fsCommon, 'Стоимость партии (без НДС):', rub(p.stoimPartii));
    addRow(fsCommon, 'Стоимость ед.:', rub(p.stoimEd));
    addRow(fsCommon, 'Трудоёмкость ед.:', fmt2.format(p.trud) + ' н/ч');
    addRow(fsCommon, 'Цена н/ч:', rub(p.cenaNch));
    addRow(fsCommon, 'Кол-во:', fmtInt.format(p.kolvo) + ' шт. (план: ' + fmtInt.format(p.planKolvo) + ')');
  } else {
    addRow(fsCommon, 'Стоимость:', 'не рассчитана (нет цены или кол-ва)');
    if (p.trud > 0) addRow(fsCommon, 'Трудоёмкость ед.:', fmt2.format(p.trud) + ' н/ч');
  }
  addRow(fsCommon, 'Срок выполнения:', p.srok || '—');
  if (p.targetPartii > 0 && p.priced) {
    const sign = p.otkl > 0 ? '+' : '';
    addRow(fsCommon, 'Отклонение от целевой:',
      sign + fmtInt.format(Math.round(p.otkl)) + ' ₽ (' + sign + fmt2.format(p.otklPct) + '%)',
      p.otkl > 0 ? 'up' : (p.otkl < 0 ? 'down' : ''));
    addRow(fsCommon, 'Целевая стоимость партии:', rub(p.targetPartii));
  }
  m.body.appendChild(fsCommon);

  if (p.dogovor || p.primechanie) {
    const fs2 = el('fieldset', 'kp-mx-fs');
    fs2.appendChild(el('legend', '', 'Договор и обоснование'));
    if (p.dogovor) addRow(fs2, 'Договор:', p.dogovor);
    if (p.primechanie) {
      const o = el('div', 'kp-mx-osnov', p.primechanie);
      fs2.appendChild(o);
    }
    m.body.appendChild(fs2);
  }
  m.overlay.classList.remove('hidden');
}

function closeModal() {
  if (_modal) _modal.overlay.classList.add('hidden');
}

// Выбрать фирму в фильтре #fltFirma (переиспользуем существующий change-обработчик
// offers.js: загрузка деталей, центрирование группы колонок сводной и т.д.)
function selectFirma(firmaId) {
  const sel = document.getElementById('fltFirma');
  if (!sel) return;
  const v = String(firmaId);
  if (!Array.from(sel.options).some((o) => o.value === v)) return;
  sel.value = v;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

// ============================================================
// ПОСТРОЕНИЕ МАТРИЦЫ
// ============================================================
// ============================================================
// ПОСТРОЕНИЕ МАТРИЦЫ
// ============================================================
// ✅ T78 (ревизия по обратной связи):
//   • строки — позиции, ОБЪЕДИНЕННЫЕ по № чертежа: синтетически
//     разделённые позиции плана (разделение по мощности) показываются
//     одной строкой, плановое кол-во суммируется;
//   • КП одной фирмы на разделённых позициях (создано копированием)
//     НЕ задваивается: по чертежу берётся одно предложение фирмы —
//     лучшая цена за 1 деталь, при равенстве — меньшая трудоёмкость;
//     мощность фирмы — максимальная заявленная;
//   • нумерация позиций + чекбокс «показать на диаграмме»: номер
//     позиции выводится в символе точки на диаграмме, итоговые точки —
//     без номера;
//   • новая колонка «Лучшее предложение»: стоимость и трудоёмкость
//     партии позиции по фирмам-победительницам (разделение по мощности:
//     лучшая фирма — на свою мощность, остаток — следующей лучшей);
//     при требовании «не допускается разбивать партию» (поле запроса
//     zapros_kp.komplekt) — предложение фирмы с лучшим предложением
//     на ВСЮ партию;
//   • ИТОГО по фирмам — только при требовании «не допускается разбивать
//     партию» И предложениях по ВСЕМ позициям; суммы считаются по
//     ПЛАНОВОМУ кол-ву позиции (мощность фирмы может быть завышена —
//     сравниваем по плану);
//   • итоги «Целевая ПТО» и «Лучшее предложение» — только по позициям,
//     у которых есть хотя бы одно предложение (без предложений —
//     исключаются из итогов и диаграммы).
// ============================================================
export function renderChoiceMatrix(allKP) {
  injectStyles();
  ensureDecisionContainer(); // ✅ T76
  const wrap = document.getElementById('matrixWrap');
  const cont = document.getElementById('choiceMatrix');
  if (!wrap || !cont) return;
  hideTip();
  _cellData.clear();
  cont.innerHTML = '';
  // ✅ T75: сброс scatter (перестроится ниже; при раннем выходе — скрыт)
  _scatterState = null;
  const scWrap0 = document.getElementById('scatterWrap');
  const scCont0 = document.getElementById('kpScatter');
  if (scCont0) scCont0.innerHTML = '';
  if (scWrap0) scWrap0.style.display = 'none';

  // Нет данных — прячем блок целиком (как согласовано: пустых графиков нет)
  if (!Array.isArray(allKP) || allKP.length === 0) {
    wrap.style.display = 'none';
    hideDecision(); // ✅ T76
    return;
  }

  // ✅ T78: требование «не допускается разбивать партию» — чекбокс
  // страницы; состояние поля zapros_kp.komplekt (сохраняется на сервере)
  const noSplit = scNoSplitChecked();

  // 1. Группировка КП по позициям плана (id_plana)
  const byPlan = new Map();
  allKP.forEach((kp) => {
    if (!kp.id_plana) return;
    if (!byPlan.has(kp.id_plana)) {
      byPlan.set(kp.id_plana, { plan: kp, firms: new Map() });
    }
    if (kp.id_firma) byPlan.get(kp.id_plana).firms.set(kp.id_firma, kp);
  });
  if (byPlan.size === 0) { wrap.style.display = 'none'; hideDecision(); return; } // ✅ T76

  // 2. ✅ T78: объединение позиций плана с одинаковым № чертежа.
  //   Разделённая по мощности позиция живёт в плане несколькими записями
  //   (корень + дочерние) — на экране это ОДНА позиция с суммарным
  //   плановым кол-вом.
  const rowMap = new Map();
  byPlan.forEach((g) => {
    const plan = g.plan;
    const nomer = plan.nomer_chertezha || '';
    if (!rowMap.has(nomer)) {
      rowMap.set(nomer, {
        key: nomer,
        nomer,
        naim: plan.osn_naimenovanie || '',
        planQty: 0,
        nPlans: 0,
        trudPto: num(plan.trudoemkost_pto),
        cenaPto: num(plan.cena_pto),
        firms: new Map(), // firmaId → предложение фирмы по чертежу (без копий)
      });
    }
    const R = rowMap.get(nomer);
    R.planQty += num(plan.plan_god_kolvo);
    R.nPlans += 1;
    if (!R.trudPto) R.trudPto = num(plan.trudoemkost_pto);
    if (!R.cenaPto) R.cenaPto = num(plan.cena_pto);
    if (!R.naim && plan.osn_naimenovanie) R.naim = plan.osn_naimenovanie;
    g.firms.forEach((kp, firmaId) => {
      const stoimEd = num(kp.cena_postavshika);
      const trud = num(kp.trudoemkost_postavshika);
      const kolvo = num(kp.moshchnost_kolvo);
      const priced = stoimEd > 0 && kolvo > 0;
      const name = kp.firma_nazvanie || firmaId;
      const prev = R.firms.get(firmaId);
      if (!prev) {
        R.firms.set(firmaId, {
          name, stoimEd, trud, kolvo, priced,
          srok: kp.srok_vipolneniya || '',
          tip: kp.tip_izgotovleniya || '',
          primechanie: kp.primechanie_kp || '',
          dogovor: kp.nom_dogovor
            ? ('№' + kp.nom_dogovor + (kp.data_dogovor ? ' от ' + kp.data_dogovor : ''))
            : '',
        });
      } else if (priced) {
        // ✅ T78: копия КП (создана разбиением по мощности) не задваивается:
        // предложение фирмы по чертежу — лучшая цена за 1 деталь, при
        // равенстве — меньшая трудоёмкость; мощность — максимальная
        if (!prev.priced || stoimEd < prev.stoimEd || (stoimEd === prev.stoimEd && trud < prev.trud)) {
          prev.stoimEd = stoimEd;
          prev.trud = trud;
          prev.priced = true;
          prev.srok = kp.srok_vipolneniya || prev.srok;
          prev.tip = kp.tip_izgotovleniya || prev.tip;
          prev.primechanie = kp.primechanie_kp || prev.primechanie;
        }
        prev.kolvo = Math.max(prev.kolvo, kolvo);
      }
    });
  });

  // 3. Порядок и нумерация позиций (✅ T78: № выводится и на диаграмме)
  const rows = Array.from(rowMap.values()).sort((a, b) => (a.nomer || '').localeCompare(b.nomer || ''));
  rows.forEach((R, i) => {
    R.num = i + 1;
    R.hasOffer = false;
    R.firms.forEach((f) => { if (f.priced) R.hasOffer = true; });
  });

  // 4. Колонки — фирмы в порядке появления КП, только с ценой хотя бы на
  //    одну позицию
  const firmOrder = new Map(); // id_firma → naimenovanie
  allKP.forEach((kp) => {
    if (kp.id_firma && !firmOrder.has(kp.id_firma)) {
      firmOrder.set(kp.id_firma, kp.firma_nazvanie || kp.id_firma);
    }
  });
  const firmHasPrice = new Set();
  rows.forEach((R) => {
    R.firms.forEach((f, id) => { if (f.priced) firmHasPrice.add(id); });
  });
  const firmCols = [];
  firmOrder.forEach((name, id) => {
    if (firmHasPrice.has(id)) firmCols.push({ id, name });
  });
  // Ни одной фирмы с ценами — показывать нечего
  if (firmCols.length === 0) { wrap.style.display = 'none'; hideDecision(); return; } // ✅ T76

  // ✅ T79: цвет фирмы на диаграмме — по порядку колонок (стабилен
  // в пределах запроса); номер позиции — внутри символа
  const firmColors = new Map();
  firmCols.forEach((F, i) => firmColors.set(F.id, SC_PALETTE[i % SC_PALETTE.length]));

  // 5. ✅ T78: победители по позиции и колонка «Лучшее предложение».
  //   Критерий лучшего — как на сервере (T77): цена за 1 деталь →
  //   меньшая трудоёмкость. Разделение по мощности (требование снято):
  //   лучшая фирма — на свою мощность, остаток планового кол-ва —
  //   следующей лучшей и т.д. Итог позиции может распределяться между
  //   НЕСКОЛЬКИМИ фирмами-победительницами.
  const bestCmp = (a, b) => (a.stoimEd - b.stoimEd) || (a.trud - b.trud);
  rows.forEach((R) => {
    R.winners = [];
    R.remainder = 0;
    const priced = firmCols.map((F) => R.firms.get(F.id)).filter((f) => f && f.priced);
    if (!priced.length || !(R.planQty > 0)) { R.best = null; return; }
    const sorted = [...priced].sort(bestCmp);
    if (noSplit) {
      const w = sorted[0];
      R.winners = [{ f: w, serve: R.planQty }];
    } else {
      let rem = R.planQty;
      for (const f of sorted) {
        if (rem <= 0) break;
        const serve = Math.min(f.kolvo, rem);
        if (serve > 0) { R.winners.push({ f, serve }); rem -= serve; }
      }
      R.remainder = rem;
    }
    R.best = {
      cost: R.winners.reduce((s, w) => s + w.serve * w.f.stoimEd, 0),
      labor: R.winners.reduce((s, w) => s + w.serve * w.f.trud, 0),
      batchFirm: '',
      parts: R.winners.map((w) => ({ firma: w.f.name, serve: w.serve, price: w.f.stoimEd, labor: w.f.trud })),
    };
  });

  // 6. ✅ T78: победитель на ВСЮ партию (требование «комплект») — фирма
  //   с предложениями по ВСЕМ позициям и минимальной суммарной
  //   стоимостью по плановым количествам (тай-брейк — трудоёмкость).
  let batchWinner = null;
  if (noSplit && rows.length > 0) {
    const full = firmCols.map((F) => {
      let cost = 0, labor = 0, ok = true;
      rows.forEach((R) => {
        const f = R.firms.get(F.id);
        if (f && f.priced) { cost += f.stoimEd * R.planQty; labor += f.trud * R.planQty; }
        else ok = false;
      });
      return { F, cost, labor, ok };
    }).filter((x) => x.ok);
    if (full.length) batchWinner = full.sort((a, b) => (a.cost - b.cost) || (a.labor - b.labor))[0];
  }
  // ✅ T78: колонка «Лучшее предложение» при требовании «комплект» —
  //   предложение фирмы-победителя на всю партию: и стоимость, и
  //   ТРУДОЁМКОСТЬ — её (не сборная из разных фирм)
  if (noSplit && batchWinner) {
    rows.forEach((R) => {
      if (!R.best) return;
      const f = R.firms.get(batchWinner.F.id);
      if (f && f.priced) {
        R.best = {
          cost: f.stoimEd * R.planQty,
          labor: f.trud * R.planQty,
          batchFirm: batchWinner.F.name,
          parts: [{ firma: f.name, serve: R.planQty, price: f.stoimEd, labor: f.trud }],
        };
      }
    });
  }

  // 7. ✅ T78: итоги — ТОЛЬКО по позициям, у которых есть хотя бы одно
  //   предложение (позиции без предложений исключаются целиком).
  //   Стоимость и трудоёмкость партии — по ПЛАНОВОМУ кол-ву.
  let targetCost = 0, targetLabor = 0, bestCost = 0, bestLabor = 0;
  let excludedRows = 0;
  rows.forEach((R) => {
    if (!R.hasOffer) { excludedRows += 1; return; }
    targetCost += R.trudPto * R.cenaPto * R.planQty;
    targetLabor += R.trudPto * R.planQty;
    if (R.best) { bestCost += R.best.cost; bestLabor += R.best.labor; }
  });

  // ✅ T78: ИТОГО по фирмам — только при требовании «не допускается
  //   разбивать партию» И предложениях по ВСЕМ позициям (фирма, у
  //   которой нет предложения хотя бы по одной позиции, итога не имеет)
  const totals = new Map();
  if (noSplit) {
    firmCols.forEach((F) => {
      let cost = 0, labor = 0, n = 0;
      rows.forEach((R) => {
        const f = R.firms.get(F.id);
        if (f && f.priced) { cost += f.stoimEd * R.planQty; labor += f.trud * R.planQty; n += 1; }
      });
      totals.set(F.id, { cost, labor, n, full: n === rows.length });
    });
  }
  let minFull = Infinity, maxFull = -Infinity;
  totals.forEach((T) => {
    if (T.full && T.cost > 0) {
      if (T.cost < minFull) minFull = T.cost;
      if (T.cost > maxFull) maxFull = T.cost;
    }
  });

  // ✅ T78: отмеченные позиции для диаграммы (по умолчанию — все с
  // предложениями); вычисляется ДО сборки таблицы — чекбоксы строк
  // рендерятся уже с этим состоянием
  _scChecked = new Set(rows.filter((R) => R.hasOffer && R.best && R.best.cost > 0).map((R) => R.key));

  // 8. Сборка таблицы
  const table = el('table', 'kp-mx');
  const thead = el('thead');
  const hr = el('tr');
  const thNum = el('th', 'kp-mx-numcol', '№');
  thNum.title = 'Чекбоксы — показать на диаграмме: строка — позицию (номер — в символе, круг — цвет фирмы), строка ИТОГО — итоги (Цель и Лучшее предложение)';
  hr.appendChild(thNum);
  const thPos = el('th', 'kp-mx-pos', 'Позиция');
  hr.appendChild(thPos);
  const thTgt = el('th', 'kp-mx-h');
  thTgt.appendChild(el('div', 'kp-mx-firm', 'Целевая ПТО'));
  thTgt.appendChild(el('div', 'kp-mx-cap', 'цена за деталь, ₽'));
  hr.appendChild(thTgt);
  const thBest = el('th', 'kp-mx-h');
  thBest.appendChild(el('div', 'kp-mx-firm', 'Лучшее предложение'));
  thBest.appendChild(el('div', 'kp-mx-cap', 'стоимость и трудоёмкость партии'));
  hr.appendChild(thBest);
  firmCols.forEach((F) => {
    const th = el('th', 'kp-mx-h');
    th.title = F.name;
    th.appendChild(el('div', 'kp-mx-firm', F.name));
    th.appendChild(el('div', 'kp-mx-cap', 'цена за деталь, ₽'));
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  rows.forEach((R) => {
    const tr = el('tr');

    // ✅ T78: № позиции + чекбокс «показать на диаграмме»
    const tdN = el('td', 'kp-mx-numcol');
    const lbl = el('label', 'kp-mx-numlbl');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.mxChk = R.key;
    cb.checked = _scChecked.has(R.key);
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(String(R.num)));
    tdN.appendChild(lbl);
    tr.appendChild(tdN);

    const th = el('th', 'kp-mx-pos');
    th.appendChild(el('div', 'kp-mx-chn', R.nomer || '—'));
    if (R.naim) th.appendChild(el('div', 'kp-mx-naim', R.naim));
    th.appendChild(el('div', 'kp-mx-kolvo',
      R.planQty > 0
        ? fmtInt.format(R.planQty) + ' шт.' + (R.nPlans > 1 ? ' · ' + R.nPlans + ' поз. плана' : '')
        : ''));
    tr.appendChild(th);

    // Целевая ПТО (справочно, вне зелёно-красной шкалы)
    const tdT = el('td', 'kp-mx-cell tgt');
    if (R.trudPto > 0 && R.cenaPto > 0) {
      const key = 't:' + R.key;
      tdT.dataset.mxKey = key;
      tdT.appendChild(el('div', 'kp-mx-val', fmtInt.format(R.trudPto * R.cenaPto)));
      tdT.appendChild(el('div', 'kp-mx-sub',
        fmt2.format(R.trudPto) + ' н/ч' + (R.cenaPto > 0 ? ' · ' + fmtInt.format(R.cenaPto) + ' ₽/н/ч' : '')));
      _cellData.set(key, {
        type: 'target',
        detal: (R.nomer || '') + (R.naim ? ' — ' + R.naim : ''),
        targetPartii: R.trudPto * R.cenaPto * R.planQty,
        trudPto: R.trudPto,
        cenaPto: R.cenaPto,
        planKolvo: R.planQty,
        noOffer: !R.hasOffer,
      });
    } else {
      tdT.appendChild(el('div', 'kp-mx-val muted', '—'));
    }
    tr.appendChild(tdT);

    // ✅ T78: «Лучшее предложение» — стоимость и трудоёмкость партии
    const tdB = el('td', 'kp-mx-cell bestoffer');
    if (R.best && R.best.cost > 0) {
      const key = 'b:' + R.key;
      tdB.dataset.mxKey = key;
      tdB.appendChild(el('div', 'kp-mx-val', fmtInt.format(R.best.cost)));
      // ✅ T83: название фирмы — при ЛЮБОМ состоянии галки «не допускается
      //   разбивать партию»: с требованием — фирма-победитель партии
      //   (batchFirm); без требования — фирмы-победители по мощности из
      //   parts (одна — имя, партия разбита — имена через « + »)
      const bfNames = R.best.batchFirm
        || (R.best.parts || []).map((p) => p.firma).join(' + ');
      tdB.appendChild(el('div', 'kp-mx-sub',
        fmt2.format(R.best.labor) + ' н/ч' + (bfNames ? ' · ' + bfNames : '')));
      _cellData.set(key, {
        type: 'scatterPos',
        num: R.num,
        nomer: R.nomer,
        naim: R.naim,
        planQty: R.planQty,
        cost: R.best.cost,
        labor: R.best.labor,
        parts: R.best.parts,
        batchFirm: R.best.batchFirm,
        remainder: R.remainder,
      });
    } else {
      tdB.appendChild(el('div', 'kp-mx-val muted', '—'));
    }
    tr.appendChild(tdB);

    // Ячейки фирм (шкала — цена за 1 деталь по строке; ✅ T78: победители)
    let mn = Infinity, mx = -Infinity;
    firmCols.forEach((F) => {
      const f = R.firms.get(F.id);
      if (f && f.priced) {
        if (f.stoimEd < mn) mn = f.stoimEd;
        if (f.stoimEd > mx) mx = f.stoimEd;
      }
    });
    firmCols.forEach((F) => {
      const f = R.firms.get(F.id);
      if (!f) {
        tr.appendChild(el('td', 'kp-mx-nocell', '—'));
        return;
      }
      const key = 'c:' + R.key + ':' + F.id;
      if (!f.priced) {
        _cellData.set(key, {
          type: 'kp',
          firma: F.name,
          firmaId: F.id,
          detal: (R.nomer || '') + (R.naim ? ' — ' + R.naim : ''),
          priced: false,
          trud: f.trud,
          srok: f.srok,
          tip: f.tip,
          primechanie: f.primechanie,
          dogovor: f.dogovor,
        });
        const td = el('td', 'kp-mx-cell');
        td.dataset.mxKey = key;
        td.appendChild(el('div', 'kp-mx-val muted', '—'));
        td.appendChild(el('div', 'kp-mx-sub', f.tip ? tipAbbr(f.tip) : ''));
        tr.appendChild(td);
        return;
      }
      const W = R.winners.find((w) => w.f === f) || null;
      const td = el('td', 'kp-mx-cell' + (W ? ' best' : ''));
      td.dataset.mxKey = key;
      if (!W && mx > mn) td.style.background = heatColor((f.stoimEd - mn) / (mx - mn));
      td.appendChild(el('div', 'kp-mx-val', fmtInt.format(f.stoimEd))); // цена за 1 деталь
      td.appendChild(el('div', 'kp-mx-sub',
        fmt2.format(f.trud) + ' н/ч' + (f.tip ? ' · ' + tipAbbr(f.tip) : '')
        + (W ? ' · ' + fmtInt.format(W.serve) + ' шт.' : '')));
      tr.appendChild(td);
      const costPlan = f.stoimEd * R.planQty;
      const targetBatch = R.trudPto * R.cenaPto * R.planQty;
      _cellData.set(key, {
        type: 'kp',
        firma: F.name,
        firmaId: F.id,
        detal: (R.nomer || '') + (R.naim ? ' — ' + R.naim : ''),
        priced: true,
        stoimPartii: f.stoimEd * f.kolvo,
        stoimEd: f.stoimEd,
        trud: f.trud,
        kolvo: f.kolvo,
        planKolvo: R.planQty,
        cenaNch: f.trud > 0 ? f.stoimEd / f.trud : 0,
        srok: f.srok,
        tip: f.tip,
        primechanie: f.primechanie,
        dogovor: f.dogovor,
        targetPartii: targetBatch,
        otkl: costPlan - targetBatch,
        otklPct: targetBatch > 0 ? ((costPlan - targetBatch) / targetBatch * 100) : 0,
        isBest: !!W,
        serve: W ? W.serve : 0,
      });
    });
    tbody.appendChild(tr);
  });

  // Строка ИТОГО (✅ T78: суммы по плановому кол-ву, только позиции
  // с предложениями; фирмы — при требовании «не разбивать» и полном покрытии)
  const tt = el('tr', 'kp-mx-total');
  // ✅ T79: чекбокс итогов — показать/скрыть итоговые точки на диаграмме
  const tdTN = el('td', 'kp-mx-numcol');
  tdTN.title = 'Чекбокс — итоги (Цель и Лучшее предложение) на диаграмме';
  const lblT = el('label', 'kp-mx-numlbl');
  const cbT = document.createElement('input');
  cbT.type = 'checkbox';
  cbT.dataset.mxChk = '__totals__';
  cbT.checked = _scTotals;
  lblT.appendChild(cbT);
  lblT.appendChild(document.createTextNode('\u03a3'));
  tdTN.appendChild(lblT);
  tt.appendChild(tdTN);
  const thc = el('th', 'kp-mx-pos');
  thc.appendChild(el('div', 'kp-mx-total-title', 'ИТОГО:'));
  thc.appendChild(el('div', 'kp-mx-kolvo', 'Σ партий по плановому кол-ву'));
  tt.appendChild(thc);

  const tdTT = el('td', 'kp-mx-cell tgt');
  if (targetCost > 0) {
    tdTT.dataset.mxKey = 'st';
    _cellData.set('st', { type: 'totalTarget', sum: targetCost, labor: targetLabor, excluded: excludedRows });
    tdTT.appendChild(el('div', 'kp-mx-val', fmtInt.format(targetCost)));
    tdTT.appendChild(el('div', 'kp-mx-sub',
      'целевая, ₽' + (excludedRows > 0 ? ' · без ' + excludedRows + ' поз. без КП' : '')));
  } else {
    tdTT.appendChild(el('div', 'kp-mx-val muted', '—'));
  }
  tt.appendChild(tdTT);

  const tdBB = el('td', 'kp-mx-cell bestoffer');
  if (bestCost > 0) {
    tdBB.dataset.mxKey = 'sb';
    _cellData.set('sb', {
      type: 'bestTotal',
      cost: bestCost,
      labor: bestLabor,
      batchFirm: batchWinner ? batchWinner.F.name : '',
      noSplit,
    });
    tdBB.appendChild(el('div', 'kp-mx-val', fmtInt.format(bestCost)));
    tdBB.appendChild(el('div', 'kp-mx-sub', fmt2.format(bestLabor) + ' н/ч'));
  } else {
    tdBB.appendChild(el('div', 'kp-mx-val muted', '—'));
  }
  tt.appendChild(tdBB);

  firmCols.forEach((F) => {
    const T = totals.get(F.id);
    const td = el('td', 'kp-mx-cell total-cell');
    if (T && T.full && T.cost > 0) {
      const key = 's:' + F.id;
      td.dataset.mxKey = key;
      _cellData.set(key, {
        type: 'total',
        firma: F.name,
        firmaId: F.id,
        sum: T.cost,
        labor: T.labor,
        n: T.n,
        m: rows.length,
      });
      td.appendChild(el('div', 'kp-mx-val', fmtInt.format(T.cost)));
      td.appendChild(el('div', 'kp-mx-sub', fmt2.format(T.labor) + ' н/ч · ' + T.n + ' из ' + rows.length + ' поз.'));
      const bar = el('div', 'kp-mx-bar');
      const fill = el('span');
      fill.style.width = (maxFull > 0 ? (T.cost / maxFull * 100) : 0) + '%';
      fill.style.background = (maxFull > minFull)
        ? heatBarColor((T.cost - minFull) / (maxFull - minFull))
        : heatBarColor(0);
      bar.appendChild(fill);
      td.appendChild(bar);
      if (batchWinner && batchWinner.F.id === F.id) td.classList.add('best-total');
    } else {
      td.title = noSplit
        ? 'Фирма предложила цену не по всем позициям — итог не показан'
        : 'Итоги по фирмам — только при требовании «не допускается разбивать партию»';
      td.appendChild(el('div', 'kp-mx-val muted', '—'));
    }
    tt.appendChild(td);
  });
  tbody.appendChild(tt);

  table.appendChild(tbody);
  cont.appendChild(table);

  // Легенда
  let legend = document.getElementById('kpMxLegend');
  if (!legend) {
    legend = el('div', 'kp-mx-legend');
    legend.id = 'kpMxLegend';
    wrap.appendChild(legend);
  }
  legend.innerHTML = '';
  const sw1 = el('span', 'lg'); sw1.style.background = heatColor(0);
  const sw2 = el('span', 'lg'); sw2.style.background = heatColor(0.55);
  const sw3 = el('span', 'lg'); sw3.style.background = heatColor(1);
  legend.appendChild(document.createTextNode('Заливка:'));
  legend.appendChild(sw1);
  legend.appendChild(document.createTextNode('дешевле'));
  legend.appendChild(sw2);
  legend.appendChild(document.createTextNode('середина'));
  legend.appendChild(sw3);
  legend.appendChild(document.createTextNode(
    'дороже (шкала цены за деталь по строке) · ★ — фирмы-победители (лучшее предложение распределяется по мощности) · '
    + 'позиции с одинаковым № чертежа объединены в одну строку, плановое кол-во суммируется · '
    + 'итоги — по плановому кол-ву, только позиции с предложениями · '
    + 'чекбоксы — на диаграмме: строка — предложения позиции (цвет — фирма, номер — в символе), ИТОГО — итоги · наведение — параметры КП, клик — карточка КП · наведение на предложение подсвечивает его точку на диаграмме'));

  wrap.style.display = 'block';
  showDecision(); // ✅ T76: контейнер принятия решения виден вместе с матрицей

  renderScatterT75({
    rows,
    targetXT: targetLabor,
    targetYT: targetCost,
    best: { cost: bestCost, labor: bestLabor },
    excluded: excludedRows,
    noSplit,
    batchWinnerId: batchWinner ? batchWinner.F.id : null, // ✅ T80: победитель на всю партию
    firmCols,     // ✅ T79: колонки фирм для точек предложений
    firmColors,   // ✅ T79: цвет фирмы на диаграмме
  });

  // 9. Интерактив (делегирование, переустанавливаем на каждый рендер —
  //    контейнер очищается, а слушатели висят на нём)
  cont.onmousemove = (ev) => {
    const cell = ev.target.closest ? ev.target.closest('[data-mx-key]') : null;
    if (!cell || !cont.contains(cell)) { hideTip(); scSetHover(null); return; } // ✅ T81
    const payload = _cellData.get(cell.dataset.mxKey);
    if (!payload) { hideTip(); scSetHover(null); return; }
    // ✅ T81: СИНХРОНИЗАЦИЯ «матрица → диаграмма»: наведение на ячейку
    // предложения подсвечивает точку этого КП на диаграмме — то же
    // перекрестие со значениями у осей и подсветкой промежутка до цели,
    // что и при наведении на саму точку. Точки нет на диаграмме (позиция
    // снята чекбоксом, отфильтрована «только лучшие» или вне видимого
    // домена) — перекрестие просто не рисуется.
    if (payload.type === 'kp' && payload.priced && cell.dataset.mxKey.slice(0, 2) === 'c:') {
      scSetHover('o:' + cell.dataset.mxKey.slice(2));
    } else if (cell.dataset.mxKey === 'st') {
      scSetHover('tgtS'); // ✅ T82: итоговая цель — то же перекрестие
    } else if (cell.dataset.mxKey === 'sb') {
      scSetHover('bestS'); // ✅ T82: итог «Лучшее предложение» — то же перекрестие
    } else {
      scSetHover(null);
    }
    showTip(payload);
    moveTip(ev);
  };
  cont.onmouseleave = () => { hideTip(); scSetHover(null); }; // ✅ T81
  cont.onchange = (ev) => {
    // ✅ T78: чекбокс строки — показать/убрать позицию на диаграмме
    const cb = ev.target && ev.target.closest ? ev.target.closest('input[data-mx-chk]') : null;
    if (!cb) return;
    const key = cb.dataset.mxChk;
    // ✅ T79: чекбокс строки ИТОГО — итоги (Цель/Лучшее предложение) на диаграмме
    if (key === '__totals__') {
      _scTotals = cb.checked;
      if (_scatterState) renderScatterT75(_scatterState);
      return;
    }
    if (cb.checked) _scChecked.add(key); else _scChecked.delete(key);
    if (_scatterState) renderScatterT75(_scatterState);
  };
  cont.onclick = (ev) => {
    // клик по ячейке фирмы — карточка КП, по ячейке ИТОГО — выбрать фирму
    // (✅ T78: синхронизация «клик по строке → диаграмма» заменена чекбоксами)
    const cell = ev.target.closest ? ev.target.closest('[data-mx-key]') : null;
    if (!cell || !cont.contains(cell)) return;
    const payload = _cellData.get(cell.dataset.mxKey);
    if (!payload) return;
    if (payload.type === 'kp') {
      hideTip();
      openModal(payload);
    } else if (payload.type === 'total') {
      hideTip();
      selectFirma(payload.firmaId);
    }
  };
}

// ============================================================
// ✅ T75/T78: ДИАГРАММА «СТОИМОСТЬ И ТРУДОЁМКОСТЬ ПАРТИИ» (SVG, без библиотек)
// ============================================================
// ✅ T78 (ревизия модели по обратной связи):
//   • координаты — стоимость партии (Y, ₽) и трудоёмкость партии (X, н/ч);
//     суммы считаются по ПЛАНОВОМУ кол-ву позиций (мощность фирмы может
//     быть завышена — для адекватного сравнения берём план);
//   • ◆ ЦЕЛЬ — итоги колонки «Целевая ПТО»: стоимость и трудоёмкость как
//     сумма по позициям; позиции с одинаковым № чертежа (синтетически
//     разделённые для передачи разным фирмам) на графике — ОДНА позиция;
//     позиции, по которым не было ни одного предложения, ИСКЛЮЧАЮТСЯ;
//   • ⭑ «ЛУЧШЕЕ ПРЕДЛОЖЕНИЕ» — итоги одноимённой колонки матрицы:
//     при требовании «не допускается разбивать партию» — стоимость и
//     трудоёмкость фирмы с лучшим предложением на всю партию, иначе —
//     лучшая комбинация по позициям (партия разбита между фирмами);
//   • позиции отмечаются ЧЕКБОКСАМИ в строках матрицы (синхронизация
//     кликом заменена); каждая отмеченная позиция — символ с НОМЕРОМ
//     позиции внутри; итоговые точки — без номера;
//   • диаграмма интерактивная: колесо — масштаб, перетаскивание — сдвиг,
//     двойной клик или кнопка «⟲ Сброс» — исходный вид.
// ============================================================

const SC_M = { t: 24, r: 26, b: 50, l: 76 };
const SC_H = 340;
const SC_PALETTE = ['#4a7db5', '#c0641a', '#2e9e44', '#8a4fb0', '#c62f68', '#00838f', '#7a8a1a', '#b0483a', '#5b6773', '#946b00'];
const SC_BEST_COLOR = '#1b7a35';
const SC_TGT_COLOR = '#46535f';
const SC_BETTER = '#7cbf2f';  // ✅ T80: салатовый — предложение дешевле цели
const SC_WORSE = '#e0559b';   // ✅ T80: розовый — предложение дороже цели
let _scatterState = null;
let _scResizeInstalled = false;
let _dcInstalled = false;     // ✅ T76: контейнер принятия решения — подключён
let _scChecked = new Set();   // ✅ T78: отмеченные позиции (ключ = № чертежа)
let _scTotals = true;         // ✅ T79: итоги на диаграмме — чекбокс строки ИТОГО
let _scDom = null;            // ✅ T79: видимый домен {x0,x1,y0,y1} — в единицах данных
let _scBase = null;           // ✅ T79: базовый домен (весь экран данных) — для сброса
let _scGeom = null;           // ✅ T79: геометрия последней отрисовки {pw,ph}
let _scPts = [];              // ✅ T79: точки отмеченных позиций (целевая + предложения)
let _scHasT = false;          // ✅ T79: итог «Цель» на диаграмме показан
let _scHasB = false;          // ✅ T79: итог «Лучшее предложение» показан
let _scPan = null;            // активное перетаскивание
let _scClickSwallow = false;  // клик сразу после перетаскивания — подавить
let _scDocInstalled = false;  // документы-обработчики перетаскивания
let _scRaf = 0;               // ✅ T79: отложенная перерисовка (requestAnimationFrame)
let _scBestOnly = false;      // ✅ T80: «только лучшие предложения» — чекбокс панели диаграммы
try { _scBestOnly = localStorage.getItem('offers_sc_bestonly') === '1'; } catch (e) { /* ignore */ }
let _scHoverKey = null;       // ✅ T80: ключ наведённого предложения (перекрестие переживает перерисовку)
let _scFs = false;            // ✅ T81: полноэкранный режим диаграммы
let _scO2G = new Map();       // ✅ T82: ключ 'o:...' → ключ группы совпавших точек

function scNS(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }

// «Красивый» шаг сетки: 1/2/5 × 10^k
function scNiceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
}
// Максимум оси, округлённый вверх до красивого шага
function scNiceMax(v) {
  if (!(v > 0)) return 1;
  const step = scNiceStep(v / 4.5);
  return Math.ceil(v / step) * step;
}
// Компактные подписи осей: 4 604 032 → «4,6 млн»
function scCompact(v) {
  if (v >= 1e6) return String(Math.round(v / 1e5) / 10).replace('.', ',') + ' млн';
  if (v >= 1e3) return String(Math.round(v / 100) / 10).replace('.', ',') + ' тыс.';
  return fmtInt.format(v);
}
// ✅ T79: подпись деления с учётом ТЕКУЩЕГО шага сетки — при глубоком
// масштабе шаг становится меньше 1 и подписи показывают дробную часть
function scTickText(v, step) {
  v = v + 0; // ✅ T79: -0 -> 0 (иначе Intl.format даёт «-0» на нулевом делении)
  const av = Math.abs(v);
  if (av >= 1e6 || (step >= 1 && av >= 1e3)) return scCompact(v);
  if (step >= 1) return fmtInt.format(Math.round(v));
  const dec = Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
  return v.toFixed(dec).replace('.', ',');
}

// ✅ T80: значение линии перекрестия — компактная подпись бейджа у оси
function scValText(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return String(Math.round(v / 1e4) / 100).replace('.', ',') + ' млн';
  if (a >= 1e4) return String(Math.round(v / 100) / 10).replace('.', ',') + ' тыс.';
  if (a >= 100 || Number.isInteger(v)) return fmtInt.format(Math.round(v));
  return String(Math.round(v * 10) / 10).replace('.', ',');
}
// ✅ T80: бейдж со значением линии перекрестия в конце линии (у оси)
function scValBadge(svg, x, y, text, fill, light) {
  const w = text.length * 5.6 + 8, h = 13;
  const r = scNS('rect');
  r.setAttribute('x', x - w / 2); r.setAttribute('y', y - h / 2);
  r.setAttribute('width', w); r.setAttribute('height', h);
  r.setAttribute('rx', 3);
  r.setAttribute('fill', fill);
  if (light) r.setAttribute('class', 'kp-sc-gvalr');
  svg.appendChild(r);
  const t = scNS('text');
  t.setAttribute('x', x); t.setAttribute('y', y + 3);
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('class', 'kp-sc-gval' + (light ? ' d' : ''));
  t.textContent = text;
  svg.appendChild(t);
}

function scLine(svg, x1, y1, x2, y2, cls) {
  const l = scNS('line');
  l.setAttribute('x1', x1); l.setAttribute('y1', y1);
  l.setAttribute('x2', x2); l.setAttribute('y2', y2);
  l.setAttribute('class', cls);
  svg.appendChild(l);
  return l;
}

function scText(svg, x, y, s, cls, anchor) {
  const t = scNS('text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  t.setAttribute('class', cls);
  if (anchor) t.setAttribute('text-anchor', anchor);
  t.textContent = s;
  svg.appendChild(t);
  return t;
}

// Пятиконечная звезда (точка «Лучшее предложение»)
function scStarPath(cx, cy, R) {
  const r = R * 0.45;
  let d = '';
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + k * Math.PI / 5;
    const rr = (k % 2 === 0) ? R : r;
    d += (k === 0 ? 'M ' : ' L ') + (cx + rr * Math.cos(a)).toFixed(1) + ' ' + (cy + rr * Math.sin(a)).toFixed(1);
  }
  return d + ' Z';
}

// ✅ T76: контейнер принятия решения — сворачивание как блок фильтров (t73)
function ensureDecisionContainer() {
  const db = document.getElementById('decisionBlock');
  if (!db) return;
  if (!_dcInstalled) {
    _dcInstalled = true;
    const btn = document.getElementById('btnDecisionToggle');
    const rz = document.getElementById('decisionResizer');
    if (btn) {
      btn.addEventListener('click', () => {
        const collapsed = db.classList.toggle('collapsed');
        btn.textContent = collapsed ? '▼' : '▲';
        btn.title = collapsed ? 'Развернуть блок принятия решения' : 'Свернуть блок принятия решения';
        // ✅ T76b: сброс px-высоты, оставленной штатным ресайзером, —
        // свёрнутый блок сжимается до полоски шапки
        db.style.height = ''; db.style.minHeight = ''; db.style.maxHeight = '';
        if (rz) rz.style.display = collapsed ? 'none' : '';
        try { localStorage.setItem('offers_decision_collapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
      });
    }
    let saved = null;
    try { saved = localStorage.getItem('offers_decision_collapsed'); } catch (e) { /* ignore */ }
    if (saved === '1') {
      db.classList.add('collapsed');
      if (btn) { btn.textContent = '▼'; btn.title = 'Развернуть блок принятия решения'; }
      if (rz) rz.style.display = 'none';
    }
  }
}

// ✅ T76: блок принятия решения виден/скрыт вместе с матрицей (пустых графиков нет)
function showDecision() {
  const db = document.getElementById('decisionBlock');
  if (db) db.style.display = '';
  const rz = document.getElementById('decisionResizer');
  if (rz) rz.style.display = (db && db.classList.contains('collapsed')) ? 'none' : '';
}
function hideDecision() {
  const db = document.getElementById('decisionBlock');
  if (db) db.style.display = 'none';
  const rz = document.getElementById('decisionResizer');
  if (rz) rz.style.display = 'none';
}

// ✅ T78: требование «не допускается разбивать партию» — чекбокс страницы;
// состояние хранится в запросе (zapros_kp.komplekt), страница его сохраняет
function scNoSplitChecked() {
  const chk = document.getElementById('chkNoSplitBatch');
  return chk ? !!chk.checked : true;
}

// ✅ T78: панель управления диаграммой — кнопка сброса вида + чекбокс
// «не допускается разбивать партию» (селект режима заменён чекбоксами
// в строках матрицы)
function ensureScatterCtrls() {
  const chk = document.getElementById('chkNoSplitBatch');
  if (chk && !chk.dataset.t78wired) {
    chk.dataset.t78wired = '1';
    chk.addEventListener('change', () => {
      // сохранение требования в запросе выполняет offers.js (POST /api/zapros-kp/komplekt)
      document.dispatchEvent(new CustomEvent('kp-nosplit-change', { detail: { checked: chk.checked } }));
    });
  }
  // ✅ T80: фильтр «только лучшие предложения» (состояние — в localStorage)
  const cbB = document.getElementById('chkBestOnly');
  if (cbB && !cbB.dataset.t80wired) {
    cbB.dataset.t80wired = '1';
    cbB.checked = _scBestOnly;
    cbB.addEventListener('change', () => {
      _scBestOnly = cbB.checked;
      try { localStorage.setItem('offers_sc_bestonly', cbB.checked ? '1' : '0'); } catch (e) { /* ignore */ }
      if (_scatterState) renderScatterT75(_scatterState);
    });
  }
  const rst = document.getElementById('btnScatterReset');
  if (rst && !rst.dataset.t78wired) {
    rst.dataset.t78wired = '1';
    rst.addEventListener('click', () => {
      // ✅ T79: сброс — вернуть базовый домен (весь экран данных) и перерисовать
      _scDom = null;
      if (_scatterState) renderScatterT75(_scatterState);
    });
  }
  // ✅ T81: полноэкранный режим — кнопка на панели + Esc (с приоритетом
  // закрытия карточки КП, если она открыта)
  const btnF = document.getElementById('btnScatterFull');
  if (btnF && !btnF.dataset.t81wired) {
    btnF.dataset.t81wired = '1';
    btnF.addEventListener('click', () => scToggleFs());
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !_scFs) return;
      const ov = document.getElementById('kpMatrixModal');
      if (ov && !ov.classList.contains('hidden')) return; // Esc закрывает карточку
      scToggleFs(false);
    });
  }
}

function ensureScatterResize() {
  if (_scResizeInstalled) return;
  _scResizeInstalled = true;
  let tm = null;
  window.addEventListener('resize', () => {
    if (!_scatterState) return;
    clearTimeout(tm);
    tm = setTimeout(() => { if (_scatterState) renderScatterT75(_scatterState); }, 200);
  });
}

// ✅ T79: удержание видимого домена в разумных пределах: глубина
// масштаба до ×800, панорама не дальше 0,2 базы за её пределы
function scClampDom() {
  const b = _scBase;
  if (!b || !_scDom) return;
  const minSx = Math.max(b.x1 / 800, 1e-9), minSy = Math.max(b.y1 / 800, 1e-9);
  let sx = _scDom.x1 - _scDom.x0, sy = _scDom.y1 - _scDom.y0;
  sx = Math.min(Math.max(sx, minSx), b.x1 * 8);
  sy = Math.min(Math.max(sy, minSy), b.y1 * 8);
  let cx = (_scDom.x0 + _scDom.x1) / 2, cy = (_scDom.y0 + _scDom.y1) / 2;
  cx = Math.min(Math.max(cx, -b.x1 * 0.2), b.x1 * 1.2);
  cy = Math.min(Math.max(cy, -b.y1 * 0.2), b.y1 * 1.2);
  _scDom.x0 = cx - sx / 2; _scDom.x1 = cx + sx / 2;
  _scDom.y0 = cy - sy / 2; _scDom.y1 = cy + sy / 2;
}

// ✅ T79: перерисовка не чаще кадра (панорама/колесо — плавно)
function scScheduleDraw() {
  if (_scRaf) return;
  _scRaf = requestAnimationFrame(() => { _scRaf = 0; scDraw(); });
}

// ✅ T79: перетаскивание — обработчики на document (курсор уходит с SVG):
// сдвиг ВИДИМОГО ДОМЕНА в единицах данных + полная перерисовка сцены
function scEnsureDocHandlers() {
  if (_scDocInstalled) return;
  _scDocInstalled = true;
  document.addEventListener('mousemove', (ev) => {
    if (!_scPan || !_scGeom || !_scDom) return;
    const dx = ev.clientX - _scPan.x;
    const dy = ev.clientY - _scPan.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) _scClickSwallow = true;
    _scPan.x = ev.clientX; _scPan.y = ev.clientY;
    const kx = (_scDom.x1 - _scDom.x0) / _scGeom.pw;
    const ky = (_scDom.y1 - _scDom.y0) / _scGeom.ph;
    _scDom.x0 -= dx * kx; _scDom.x1 -= dx * kx;
    _scDom.y0 += dy * ky; _scDom.y1 += dy * ky;
    scClampDom();
    scScheduleDraw();
  });
  document.addEventListener('mouseup', () => {
    if (!_scPan) return;
    _scPan = null;
    const c = document.getElementById('kpScatter');
    if (c) c.classList.remove('panning');
    setTimeout(() => { _scClickSwallow = false; }, 0);
  });
}

function renderScatterT75(state) {
  const wrap = document.getElementById('scatterWrap');
  const cont = document.getElementById('kpScatter');
  if (!wrap || !cont) return;
  const isNew = state !== _scatterState; // ✅ T79: новые данные — вид на весь экран данных
  if (isNew) _scHoverKey = null; // ✅ T80: перекрестие наведения не переносится на новые данные
  _scatterState = state;
  ensureScatterResize();
  ensureScatterCtrls();
  const cbBO = document.getElementById('chkBestOnly');
  if (cbBO && cbBO.checked !== _scBestOnly) cbBO.checked = _scBestOnly; // ✅ T80

  // ✅ T79: точки отмеченных позиций — целевая + ВСЕ предложения
  // (цвет — фирма); стоимость и трудоёмкость партии — по ПЛАНОВОМУ кол-ву
  const firmCols = state.firmCols || [];
  const firmColors = state.firmColors || new Map();
  const pts = [];
  // ✅ T80: «только лучшие предложения» — С УЧЁТОМ требования
  // «не допускается разбивать партию»: при «комплекте» и фирме-победителе
  // на всю партию — только ЕЁ предложение по позиции; без «комплекта» —
  // фирмы-победительницы лучшей комбинации (разделение по мощности)
  state.rows.forEach((R) => {
    if (!R.hasOffer || !_scChecked.has(R.key)) return;
    const offers = [];
    const winSet = new Set((R.winners || []).map((w) => w.f));
    firmCols.forEach((F) => {
      const f = R.firms.get(F.id);
      if (!(f && f.priced && (f.trud > 0 || f.stoimEd > 0))) return;
      if (_scBestOnly) {
        if (state.noSplit && state.batchWinnerId) {
          if (F.id !== state.batchWinnerId) return; // «комплект» — предложение фирмы-победителя
        } else if (!winSet.has(f)) {
          return; // победители лучшей комбинации (партия разбита по мощности)
        }
      }
      offers.push({
        F, f,
        color: firmColors.get(F.id) || '#5b6773',
        x: f.trud * R.planQty,    // трудоёмкость партии, н/ч
        y: f.stoimEd * R.planQty, // стоимость партии, ₽
        // ✅ T80: синтетическая обводка победителя — ТОЛЬКО в пути фильтра
        // «только лучшие» при «комплекте» (показана фирма-победитель на всю
        // партию); иначе обводка = ★ в матрице (победитель по позиции)
        W: (_scBestOnly && state.noSplit && state.batchWinnerId)
          ? { serve: R.planQty }
          : ((R.winners || []).find((w) => w.f === f) || null),
      });
    });
    const tgt = (R.trudPto > 0 && R.cenaPto > 0 && R.planQty > 0)
      ? { x: R.trudPto * R.planQty, y: R.trudPto * R.cenaPto * R.planQty }
      : null;
    if (offers.length || tgt) pts.push({ R, offers, tgt });
  });
  // ✅ T79: итоги (Цель / Лучшее предложение) — только при отмеченном
  // чекбоксе строки ИТОГО
  const hasTarget = _scTotals && (state.targetXT > 0 || state.targetYT > 0);
  const hasBest = _scTotals && state.best && state.best.cost > 0;
  _scPts = pts; _scHasT = hasTarget; _scHasB = hasBest;

  if (pts.length === 0 && !hasTarget && !hasBest) {
    wrap.style.display = 'none';
    _scDom = null;
    return;
  }
  wrap.style.display = 'block';

  // ✅ T79: база — все видимые данные; домен — текущий вид (или вся база)
  let xMax = 0, yMax = 0;
  pts.forEach((P) => {
    P.offers.forEach((O) => { if (O.x > xMax) xMax = O.x; if (O.y > yMax) yMax = O.y; });
    if (P.tgt) { if (P.tgt.x > xMax) xMax = P.tgt.x; if (P.tgt.y > yMax) yMax = P.tgt.y; }
  });
  if (hasTarget) { if (state.targetXT > xMax) xMax = state.targetXT; if (state.targetYT > yMax) yMax = state.targetYT; }
  if (hasBest) { if (state.best.labor > xMax) xMax = state.best.labor; if (state.best.cost > yMax) yMax = state.best.cost; }
  _scBase = { x0: 0, y0: 0, x1: scNiceMax(xMax > 0 ? xMax : 1), y1: scNiceMax(yMax > 0 ? yMax : 1) };
  if (isNew || !_scDom) _scDom = { x0: _scBase.x0, x1: _scBase.x1, y0: _scBase.y0, y1: _scBase.y1 };

  scEnsureDocHandlers();
  scDraw();

  // ✅ T79: заголовок
  const tt = document.getElementById('kpScatterTitleText');
  if (tt) {
    tt.textContent = 'Стоимость и трудоёмкость партии — цель, предложения по позициям и итоги';
  }

  // легенда: итоги + фирмы (цвет — фирма; номер в символе — № позиции)
  let lg = document.getElementById('kpScatterLegend');
  if (!lg) {
    lg = el('div', 'kp-mx-legend');
    lg.id = 'kpScatterLegend';
    wrap.appendChild(lg);
  }
  lg.innerHTML = '';
  if (_scHasT) {
    const chipT = el('span', 'lg');
    chipT.style.background = SC_TGT_COLOR;
    chipT.style.transform = 'rotate(45deg)';
    lg.appendChild(chipT);
    lg.appendChild(document.createTextNode('Цель (ПТО) — итоги'));
  }
  if (_scHasB) {
    const chipB = el('span', 'lg');
    chipB.style.borderRadius = '50%';
    chipB.style.background = SC_BEST_COLOR;
    lg.appendChild(chipB);
    lg.appendChild(document.createTextNode('Лучшее предложение — итоги'));
  }
  const seenF = new Map();
  pts.forEach((P) => P.offers.forEach((O) => {
    if (!seenF.has(O.F.id)) seenF.set(O.F.id, O.color);
  }));
  seenF.forEach((color, id) => {
    const F = firmCols.find((x) => x.id === id);
    const chip = el('span', 'lg');
    chip.style.borderRadius = '50%';
    chip.style.background = color;
    lg.appendChild(chip);
    // ✅ T80: цвет НАЗВАНИЯ фирмы = цвет метки фирмы
    const nm = el('span', 'lg-firm', F ? F.name : String(id));
    nm.style.color = color;
    lg.appendChild(nm);
  });
  lg.appendChild(document.createTextNode(
    ' · в символе — № позиции, тёмный ромб — целевая стоимость позиции (перекрестие со значениями у осей), тёмная обводка — фирма-победитель'
    + (_scBestOnly ? ' · показаны ТОЛЬКО лучшие предложения' : '')
    + ' · наведение на предложение — перекрестие: салатовая подсветка — дешевле цели, розовая — дороже'
    + ' · наведение на предложение в матрице подсвечивает его точку на диаграмме (синхронизация), и наоборот'
    + ' · совпавшие точки (одинаковые цена и трудоёмкость) — один маркер, номера позиций внутри через запятую'
    + ' · итоговые точки (Цель / Лучшее предложение) — то же перекрестие, ячейка ИТОГО подсвечивается в матрице'
    + ' · суммы по плановому кол-ву, только позиции с предложениями'
    + ' · колесо — масштаб (сетка детализируется), перетаскивание — сдвиг, двойной клик — сброс'
    + ' · итоги — чекбокс в строке ИТОГО, позиции — чекбоксы в строках матрицы'));
}

// ✅ T79: ПОЛНАЯ ПЕРЕРИСОВКА сцены по текущему видимому домену —
// вызывается при каждом изменении масштаба/сдвига: сетка и деления
// пересчитываются (чем крупнее масштаб — тем детальнее сетка), маркеры
// ставятся в новые экранные координаты с ПОСТОЯННЫМ размером, точки,
// перекрытые при мелком масштабе, расходятся и становятся видны
function scDraw() {
  const wrap = document.getElementById('scatterWrap');
  const cont = document.getElementById('kpScatter');
  const state = _scatterState;
  if (!wrap || !cont || !state || !_scDom || !_scBase) return;
  hideTip();
  cont.innerHTML = '';

  // ✅ T81: в полноэкранном режиме — вся ширина окна и увеличенная высота
  const W = Math.max(560, Math.min(_scFs ? 2600 : 1180, Math.round(cont.clientWidth || 940)));
  const H = _scFs ? Math.max(SC_H, Math.round((window.innerHeight || 800) - 130)) : SC_H;
  const pw = W - SC_M.l - SC_M.r;
  const ph = H - SC_M.t - SC_M.b;
  _scGeom = { pw, ph };
  const dom = _scDom;
  const sx = (v) => SC_M.l + (v - dom.x0) / (dom.x1 - dom.x0) * pw;
  const sy = (v) => SC_M.t + ph - (v - dom.y0) / (dom.y1 - dom.y0) * ph;
  const inX = (v) => v >= dom.x0 && v <= dom.x1;
  const inY = (v) => v >= dom.y0 && v <= dom.y1;

  const svg = scNS('svg');
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.style.touchAction = 'none';

  // сцена строится в ЭКРАННЫХ координатах — никаких scale-трансформаций
  const gRoot = scNS('g');

  // сетка + подписи делений (шаг пересчитывается по видимому домену)
  const stX = scNiceStep((dom.x1 - dom.x0) / 6);
  const i0x = Math.ceil(dom.x0 / stX - 1e-9), i1x = Math.floor(dom.x1 / stX + 1e-9);
  for (let i = i0x; i <= i1x; i++) {
    const v = i * stX;
    const x = sx(v);
    scLine(gRoot, x, SC_M.t, x, SC_M.t + ph, i === 0 ? 'kp-sc-zero' : 'kp-sc-grid');
    scText(gRoot, x, SC_M.t + ph + 16, scTickText(v, stX), 'kp-sc-tick', 'middle');
  }
  const stY = scNiceStep((dom.y1 - dom.y0) / 5);
  const i0y = Math.ceil(dom.y0 / stY - 1e-9), i1y = Math.floor(dom.y1 / stY + 1e-9);
  for (let i = i0y; i <= i1y; i++) {
    const v = i * stY;
    const y = sy(v);
    scLine(gRoot, SC_M.l, y, SC_M.l + pw, y, i === 0 ? 'kp-sc-zero' : 'kp-sc-grid');
    scText(gRoot, SC_M.l - 8, y + 3.5, scTickText(v, stY), 'kp-sc-tick', 'end');
  }

  // оси (рамка области построения — на месте при любом масштабе)
  scLine(gRoot, SC_M.l, SC_M.t + ph, SC_M.l + pw, SC_M.t + ph, 'kp-sc-axis');
  scLine(gRoot, SC_M.l, SC_M.t, SC_M.l, SC_M.t + ph, 'kp-sc-axis');
  scText(gRoot, SC_M.l + pw / 2, H - 8, 'Трудоёмкость партии, н/ч', 'kp-sc-axis-title', 'middle');
  const ty = scNS('text');
  ty.setAttribute('class', 'kp-sc-axis-title');
  ty.setAttribute('text-anchor', 'middle');
  ty.setAttribute('transform', 'translate(14 ' + (SC_M.t + ph / 2) + ') rotate(-90)');
  ty.textContent = 'Стоимость партии, ₽';
  gRoot.appendChild(ty);

  // подсказка: идеал — левый нижний угол
  scText(gRoot, SC_M.l + 10, SC_M.t + ph - 10, '← ниже и левее — выгоднее', 'kp-sc-hint');

  // ◆ ЦЕЛЬ (итоги): пунктирные уровни + диагональ «цена н/ч = целевая» + ромб
  if (_scHasT) {
    // ✅ T80: в концах линий перекрестия у осей — значения линий (бейджи)
    if (inX(state.targetXT)) {
      scLine(gRoot, sx(state.targetXT), SC_M.t, sx(state.targetXT), SC_M.t + ph, 'kp-sc-guide');
      scValBadge(gRoot, sx(state.targetXT), SC_M.t + ph + 16, scValText(state.targetXT), '#46535f');
    }
    if (inY(state.targetYT)) {
      scLine(gRoot, SC_M.l, sy(state.targetYT), SC_M.l + pw, sy(state.targetYT), 'kp-sc-guide');
      scValBadge(gRoot, SC_M.l - 26, sy(state.targetYT), scValText(state.targetYT), '#46535f');
    }
    if (state.targetXT > 0 && state.targetYT > 0) {
      const slope = state.targetYT / state.targetXT;
      const xa = Math.max(dom.x0, dom.y0 / slope);
      const xb = Math.min(dom.x1, dom.y1 / slope);
      if (xb > xa) scLine(gRoot, sx(xa), sy(slope * xa), sx(xb), sy(slope * xb), 'kp-sc-guide');
      if (inX(state.targetXT) && inY(state.targetYT)) {
        const cx = sx(state.targetXT), cy = sy(state.targetYT);
        const d = scNS('path');
        d.setAttribute('d', 'M ' + cx + ' ' + (cy - 8) + ' L ' + (cx + 8) + ' ' + cy + ' L ' + cx + ' ' + (cy + 8) + ' L ' + (cx - 8) + ' ' + cy + ' Z');
        d.setAttribute('fill', SC_TGT_COLOR);
        d.setAttribute('stroke', '#fff');
        d.setAttribute('stroke-width', '1.5');
        const gT = scNS('g');
        gT.dataset.scKey = 'tgtS';
        // ✅ T82: итоговый маркер — то же поведение, что у позиций:
        // перекрестие при наведении и синхронизация с ячейкой
        // «Целевая ПТО» строки ИТОГО (отрезка до цели нет — цель сама)
        gT.dataset.scX = String(state.targetXT);
        gT.dataset.scY = String(state.targetYT);
        gT.appendChild(d);
        gRoot.appendChild(gT);
        scText(gRoot, cx + 12, cy - 9, 'Цель', 'kp-sc-lbl');
        _cellData.set('tgtS', {
          type: 'scatterTarget',
          targetXT: state.targetXT,
          targetYT: state.targetYT,
          excluded: state.excluded || 0,
        });
      }
    }
  }

  // ✅ T79: отмеченные позиции — целевая (тёмный ромб) и ВСЕ предложения
  // (круг цвета фирмы); внутри символа — НОМЕР позиции; предложение-
  // победитель (★ в матрице) — тёмная обводка. Маркеры ПОСТОЯННОГО
  // размера при любом масштабе; вне видимого домена — не рисуются
  // ✅ T79: отмеченные позиции — целевая (тёмный ромб) и ВСЕ предложения
  // (круг цвета фирмы); внутри символа — НОМЕР позиции; предложение-
  // победитель (★ в матрице) — тёмная обводка. Маркеры ПОСТОЯННОГО
  // размера при любом масштабе; вне видимого домена — не рисуются.
  // ✅ T82: точки с одинаковыми координатами (одинаковые цена и
  // трудоёмкость партии) сливаются в ОДИН маркер с номерами позиций
  // через запятую — иначе последний маркер перекрывает остальные;
  // на крупном масштабе точки расходятся по пикселям и снова видны.
  const scTgts = [];
  _scPts.forEach((P) => {
    if (P.tgt && inX(P.tgt.x) && inY(P.tgt.y)) scTgts.push({ R: P.R, tgt: P.tgt });
  });
  // — целевые ромбы: группировка совпавших —
  const tGroups = new Map();
  scTgts.forEach((T) => {
    const cx = sx(T.tgt.x), cy = sy(T.tgt.y);
    const gk = Math.round(cx) + ':' + Math.round(cy);
    if (!tGroups.has(gk)) tGroups.set(gk, { cx, cy, items: [] });
    tGroups.get(gk).items.push(T);
  });
  tGroups.forEach((G) => {
    const single = G.items.length === 1;
    const it0 = G.items[0];
    const key = single
      ? ('t2:' + it0.R.key)
      : ('t2g@' + (Math.round(it0.tgt.x * 1e6) / 1e6) + ',' + (Math.round(it0.tgt.y * 1e6) / 1e6));
    const cx = G.cx, cy = G.cy;
    const nums = [];
    G.items.forEach((T) => { if (nums.indexOf(T.R.num) < 0) nums.push(T.R.num); });
    const label = single ? String(it0.R.num) : nums.join(',');
    const r = single ? 10 : Math.max(10, Math.min(22, 4 + label.length * 2.8));
    G.items.forEach((T) => {
      // ✅ T80: перекрестие целевой стоимости ПОЗИЦИИ — как у итоговой
      // цели: пунктиры к осям + значения линий в концах (светлые бейджи)
      scLine(gRoot, sx(T.tgt.x), SC_M.t, sx(T.tgt.x), SC_M.t + ph, 'kp-sc-guide');
      scValBadge(gRoot, sx(T.tgt.x), SC_M.t + ph + 16, scValText(T.tgt.x), '#f1f4f8', true);
      scLine(gRoot, SC_M.l, sy(T.tgt.y), SC_M.l + pw, sy(T.tgt.y), 'kp-sc-guide');
      scValBadge(gRoot, SC_M.l - 26, sy(T.tgt.y), scValText(T.tgt.y), '#f1f4f8', true);
    });
    const g = scNS('g');
    g.classList.add('kp-sc-pt');
    g.dataset.scKey = key;
    const d = scNS('path');
    d.setAttribute('d', 'M ' + cx + ' ' + (cy - r) + ' L ' + (cx + r) + ' ' + cy + ' L ' + cx + ' ' + (cy + r) + ' L ' + (cx - r) + ' ' + cy + ' Z');
    d.setAttribute('fill', SC_TGT_COLOR);
    d.setAttribute('stroke', '#fff');
    d.setAttribute('stroke-width', '1.5');
    g.appendChild(d);
    const t = scNS('text');
    t.setAttribute('x', cx); t.setAttribute('y', cy + 3);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'kp-sc-pt-num');
    t.textContent = label;
    g.appendChild(t);
    gRoot.appendChild(g);
    if (single) {
      _cellData.set(key, {
        type: 'target',
        num: it0.R.num,
        detal: (it0.R.nomer || '') + (it0.R.naim ? ' — ' + it0.R.naim : ''),
        targetPartii: it0.tgt.y,
        trudPto: it0.R.trudPto,
        cenaPto: it0.R.cenaPto,
        planKolvo: it0.R.planQty,
        noOffer: false,
      });
    } else {
      // ✅ T82: совпавшие цели — один ромб, в тултипе — все позиции
      _cellData.set(key, {
        type: 'targetGroup',
        items: G.items.map((T) => ({
          num: T.R.num,
          detal: (T.R.nomer || '') + (T.R.naim ? ' — ' + T.R.naim : ''),
          targetPartii: T.tgt.y,
          trudPto: T.R.trudPto,
          cenaPto: T.R.cenaPto,
          planQty: T.R.planQty,
        })),
        mxKeys: G.items.map((T) => 't:' + T.R.key),
      });
    }
  });
  // — предложения: группировка совпавших (экранный пиксель → точки) —
  const scGroups = new Map();
  _scPts.forEach((P) => {
    P.offers.forEach((O) => {
      if (!inX(O.x) || !inY(O.y)) return;
      const cx = sx(O.x), cy = sy(O.y);
      const gk = Math.round(cx) + ':' + Math.round(cy);
      if (!scGroups.has(gk)) scGroups.set(gk, { cx, cy, items: [] });
      scGroups.get(gk).items.push({ R: P.R, O, x: O.x, y: O.y, tgt: P.tgt });
    });
  });
  _scO2G.clear(); // ✅ T82: карта «предложение → группа» пересобирается
  scGroups.forEach((G) => {
    const single = G.items.length === 1;
    const it0 = G.items[0];
    const key = single
      ? ('o:' + it0.R.key + ':' + it0.O.F.id)
      : ('grp@' + (Math.round(it0.x * 1e6) / 1e6) + ',' + (Math.round(it0.y * 1e6) / 1e6));
    if (!single) {
      G.items.forEach((it) => { _scO2G.set('o:' + it.R.key + ':' + it.O.F.id, key); });
    }
    // данные тултипов/карточек — по-прежнему на каждое предложение
    G.items.forEach((it) => {
      const costPlan = it.y;
      const targetBatch = it.tgt ? it.tgt.y : 0;
      _cellData.set('o:' + it.R.key + ':' + it.O.F.id, {
        type: 'kp',
        firma: it.O.F.name,
        firmaId: it.O.F.id,
        num: it.R.num,
        detal: (it.R.nomer || '') + (it.R.naim ? ' — ' + it.R.naim : ''),
        priced: true,
        stoimPartii: it.O.f.stoimEd * it.O.f.kolvo,
        stoimEd: it.O.f.stoimEd,
        trud: it.O.f.trud,
        kolvo: it.O.f.kolvo,
        planKolvo: it.R.planQty,
        cenaNch: it.O.f.trud > 0 ? it.O.f.stoimEd / it.O.f.trud : 0,
        srok: it.O.f.srok,
        tip: it.O.f.tip,
        primechanie: it.O.f.primechanie,
        dogovor: it.O.f.dogovor,
        targetPartii: targetBatch,
        otkl: costPlan - targetBatch,
        otklPct: targetBatch > 0 ? ((costPlan - targetBatch) / targetBatch * 100) : 0,
        isBest: !!it.O.W,
        serve: it.O.W ? it.O.W.serve : 0,
        chCost: costPlan,
        chLabor: it.x,
      });
    });
    const g = scNS('g');
    g.classList.add('kp-sc-pt');
    g.dataset.scKey = key;
    // ✅ T80/T82: координаты точки и цели — для перекрестия при наведении
    g.dataset.scX = String(it0.x);
    g.dataset.scY = String(it0.y);
    if (!single) {
      // ✅ T82: у каждого члена группы — свой отрезок «цель → точка»
      const segs = [];
      const seenT = new Set();
      G.items.forEach((it) => {
        const tk = it.tgt ? (it.tgt.x + '|' + it.tgt.y) : '-';
        if (seenT.has(tk)) return;
        seenT.add(tk);
        segs.push(it.tgt
          ? { x: String(it.x), y: String(it.y), tx: String(it.tgt.x), ty: String(it.tgt.y) }
          : { x: String(it.x), y: String(it.y) });
      });
      g.dataset.scGroup = JSON.stringify(segs);
    } else if (it0.tgt) {
      g.dataset.scTx = String(it0.tgt.x);
      g.dataset.scTy = String(it0.tgt.y);
    }
    const cx = G.cx, cy = G.cy;
    const nums = [];
    const firms = [];
    const win = G.items.find((it) => it.O.W) || null;
    G.items.forEach((it) => {
      if (nums.indexOf(it.R.num) < 0) nums.push(it.R.num);
      if (!firms.some((ff) => ff.id === it.O.F.id)) firms.push({ id: it.O.F.id, color: it.O.color });
    });
    const label = single ? String(it0.R.num) : nums.join(',');
    const r = single ? 9 : Math.max(9, Math.min(24, 3 + label.length * 3.1));
    if (firms.length === 1) {
      const c = scNS('circle');
      c.classList.add('pt-body');
      c.setAttribute('cx', cx);
      c.setAttribute('cy', cy);
      c.setAttribute('r', String(r));
      c.setAttribute('fill', firms[0].color);
      c.setAttribute('stroke', win ? '#1a2733' : '#fff');
      c.setAttribute('stroke-width', win ? '2.4' : '1.5');
      g.appendChild(c);
    } else {
      // несколько фирм в одной точке — круг делится на сектора их цветов
      const n = firms.length;
      firms.forEach((ff, i) => {
        const a0 = -Math.PI / 2 + i * 2 * Math.PI / n;
        const a1 = a0 + 2 * Math.PI / n;
        const pth = scNS('path');
        pth.setAttribute('d', 'M ' + cx + ' ' + cy
          + ' L ' + (cx + r * Math.cos(a0)).toFixed(2) + ' ' + (cy + r * Math.sin(a0)).toFixed(2)
          + ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx + r * Math.cos(a1)).toFixed(2) + ' ' + (cy + r * Math.sin(a1)).toFixed(2) + ' Z');
        pth.setAttribute('fill', ff.color);
        pth.setAttribute('stroke', '#fff');
        pth.setAttribute('stroke-width', '1');
        g.appendChild(pth);
      });
      const ring = scNS('circle');
      ring.setAttribute('cx', cx);
      ring.setAttribute('cy', cy);
      ring.setAttribute('r', String(r));
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', win ? '#1a2733' : '#fff');
      ring.setAttribute('stroke-width', win ? '2.4' : '1.5');
      g.appendChild(ring);
    }
    const t = scNS('text');
    t.setAttribute('x', cx); t.setAttribute('y', cy + 3);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'kp-sc-pt-num');
    t.textContent = label;
    g.appendChild(t);
    gRoot.appendChild(g);
    if (!single) {
      const open = win || it0;
      _cellData.set(key, {
        type: 'kpGroup', // ✅ T82: совпавшие предложения — один маркер
        numLabel: label,
        items: G.items.map((it) => ({
          num: it.R.num,
          firma: it.O.F.name,
          cost: it.y,
          labor: it.x,
          isBest: !!it.O.W,
        })),
        mxKeys: G.items.map((it) => 'c:' + it.R.key + ':' + it.O.F.id),
        openKey: 'o:' + open.R.key + ':' + open.O.F.id,
        openFirma: open.O.F.name,
        openNum: open.R.num,
      });
    }
  });

  // ⭑ «ЛУЧШЕЕ ПРЕДЛОЖЕНИЕ» — итог одноимённой колонки матрицы
  if (_scHasB && inX(state.best.labor) && inY(state.best.cost)) {
    _cellData.set('bestS', {
      type: 'scatterBest',
      cost: state.best.cost,
      labor: state.best.labor,
      batchFirm: state.noSplit && state.best.batchFirm ? state.best.batchFirm : '',
      parts: state.rows
        .filter((R) => R.best && R.best.cost > 0)
        .map((R) => ({ num: R.num, nomer: R.nomer, parts: R.best.parts, batchFirm: R.best.batchFirm })),
    });
    const gB = scNS('g');
    gB.classList.add('kp-sc-pt');
    gB.dataset.scKey = 'bestS';
    // ✅ T82: итоговый маркер — то же поведение, что у позиций:
    // перекрестие с отрезком до целевой точки (салатовый — дешевле
    // цели, розовый — дороже) и синхронизация с ячейкой
    // «Лучшее предложение» строки ИТОГО
    gB.dataset.scX = String(state.best.labor);
    gB.dataset.scY = String(state.best.cost);
    if (state.targetXT > 0 && state.targetYT > 0) {
      gB.dataset.scTx = String(state.targetXT);
      gB.dataset.scTy = String(state.targetYT);
    }
    const st = scNS('path');
    st.setAttribute('d', scStarPath(sx(state.best.labor), sy(state.best.cost), 11));
    st.setAttribute('fill', SC_BEST_COLOR);
    st.setAttribute('stroke', '#fff');
    st.setAttribute('stroke-width', '1.5');
    gB.appendChild(st);
    gRoot.appendChild(gB);
    scText(gRoot, sx(state.best.labor) + 14, sy(state.best.cost) - 10, 'Лучшее предложение', 'kp-sc-lbl');
  }

  svg.appendChild(gRoot);
  cont.appendChild(svg);
  // ✅ T80: слой наведения — ПОСЛЕ сцены (перекрестие поверх маркеров)
  const gHov = scNS('g');
  gHov.id = 'scHoverLayer';
  svg.appendChild(gHov);
  if (_scHoverKey) scApplyHover(); // перекрестие переживает масштаб/сдвиг

  // ✅ T79: интерактивность — масштаб колесом вокруг курсора (ПОЛНАЯ
  // перерисовка: сетка детализируется, маркеры постоянного размера),
  // сдвиг перетаскиванием, сброс двойным кликом (или «⟲ Сброс»)
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (!_scGeom || !_scDom) return;
    const f = ev.deltaY < 0 ? 1 / 1.22 : 1.22;
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const d0 = _scDom;
    const vx = d0.x0 + (mx - SC_M.l) / pw * (d0.x1 - d0.x0);
    const vy = d0.y1 - (my - SC_M.t) / ph * (d0.y1 - d0.y0);
    const nx0 = vx - (vx - d0.x0) * f;
    const ny1 = vy + (d0.y1 - vy) * f;
    _scDom = { x0: nx0, x1: nx0 + (d0.x1 - d0.x0) * f, y0: ny1 - (d0.y1 - d0.y0) * f, y1: ny1 };
    scClampDom();
    scScheduleDraw();
  }, { passive: false });
  svg.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    _scPan = { x: ev.clientX, y: ev.clientY };
    cont.classList.add('panning');
    ev.preventDefault();
  });
  svg.addEventListener('dblclick', () => {
    _scDom = { x0: _scBase.x0, x1: _scBase.x1, y0: _scBase.y0, y1: _scBase.y1 };
    scScheduleDraw();
  });

  // ✅ T79: клик по кругу предложения — карточка КП; клик сразу после
  // перетаскивания подавляется; обработчик подключается один раз
  if (!cont.dataset.t79click) {
    cont.dataset.t79click = '1';
    cont.addEventListener('click', (ev) => {
      if (_scClickSwallow) { ev.stopPropagation(); _scClickSwallow = false; return; }
      const g = ev.target.closest ? ev.target.closest('[data-sc-key]') : null;
      if (!g || !cont.contains(g)) return;
      const payload = _cellData.get(g.dataset.scKey);
      if (payload && payload.type === 'kp') { hideTip(); openModal(payload); }
      else if (payload && payload.type === 'kpGroup' && payload.openKey) { // ✅ T82
        const kp = _cellData.get(payload.openKey);
        if (kp) { hideTip(); openModal(kp); }
      }
    }, true);
  }

  // тултипы точек + ✅ T80: перекрестие при наведении на предложение
  cont.onmousemove = (ev) => {
    const g = ev.target.closest ? ev.target.closest('[data-sc-key]') : null;
    if (!g || !cont.contains(g)) { hideTip(); scSetHover(null); return; }
    const payload = _cellData.get(g.dataset.scKey);
    if (!payload) { hideTip(); scSetHover(null); return; }
    showTip(payload);
    moveTip(ev);
    // ✅ T82: перекрестие — предложения, группы совпавших точек и итоги
    const hk = g.dataset.scKey || '';
    scSetHover(scHoverable(hk) ? hk : null);
  };
  cont.onmouseleave = () => { hideTip(); scSetHover(null); };
}


// ============================================================
// ✅ T80: ПЕРЕКРЕСТИЕ ПРИ НАВЕДЕНИИ НА ПРЕДЛОЖЕНИЕ — пунктирные линии
// к осям со ЗНАЧЕНИЯМИ линий в концах (бейджи) + подсветка промежутка
// «цель → предложение»: салатовый — предложение дешевле цели (лучше),
// розовый — дороже (хуже). Слой поверх сцены, восстанавливается после
// перерисовки (масштаб/сдвиг).
// ============================================================
function scHoverLayer() {
  const svg = document.querySelector('#kpScatter svg');
  if (!svg) return null;
  let L = svg.querySelector('#scHoverLayer');
  if (!L) { L = scNS('g'); L.id = 'scHoverLayer'; svg.appendChild(L); }
  return L;
}

function scEscSel(key) {
  return '[data-sc-key="' + String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
}

// ✅ T82: ключи, по которым при наведении рисуется перекрестие
function scHoverable(k) {
  if (!k) return false;
  return k.slice(0, 2) === 'o:' || k.slice(0, 4) === 'grp@'
    || k === 'tgtS' || k === 'bestS' || k.slice(0, 3) === 't2:' || k.slice(0, 4) === 't2g@';
}

// установить/снять наведение (key = data-sc-key точки или null)
function scSetHover(key) {
  key = key || null;
  _scHoverKey = key;
  scSyncMatrixCell(key); // ✅ T81/T82: подсветка ячеек матрицы (синхронизация)
  scDrawHover(scHoverEl(key));
}

// ✅ T82: элемент по ключу наведения; предложение, попавшее в группу
// совпавших точек, рисуется группой — резолвим через карту _scO2G
function scHoverEl(key) {
  const cont = document.getElementById('kpScatter');
  if (!cont || !key) return null;
  let g = cont.querySelector(scEscSel(key));
  if (!g && key.slice(0, 2) === 'o:') {
    const gk = _scO2G.get(key);
    if (gk) g = cont.querySelector(scEscSel(gk));
  }
  return g;
}

// ✅ T81: СИНХРОНИЗАЦИЯ «диаграмма → матрица»: подсветить ячейку КП в
// матрице выбора поставщика, соответствующую наведённой точке диаграммы
// (точка 'o:<чертёж>:<фирма>' ↔ ячейка 'c:<чертёж>:<фирма>'). Вызывается
// и при наведении в самой матрице — ячейка под курсором получает ту же
// подсветку, что и точка на графике (двусторонняя синхронизация).
function scSyncMatrixCell(key) {
  const mx = document.getElementById('choiceMatrix');
  if (!mx) return;
  mx.querySelectorAll('.kp-mx-sync-hl').forEach((c) => c.classList.remove('kp-mx-sync-hl')); // ✅ T82
  if (!key) return;
  // ✅ T82: какие ячейки матрицы соответствуют ключу наведения —
  // предложение, итоги (Цель/Лучшее предложение), целевой ромб
  // позиции или группа совпавших точек (сразу все её ячейки)
  const payload = _cellData.get(key);
  let mks = [];
  if (key.slice(0, 2) === 'o:') {
    mks = ['c:' + key.slice(2)];
  } else if (key === 'tgtS') {
    mks = ['st'];
  } else if (key === 'bestS') {
    mks = ['sb'];
  } else if (key.slice(0, 3) === 't2:' && payload && payload.type === 'target') {
    mks = ['t:' + key.slice(3)];
  } else if (payload && (payload.type === 'kpGroup' || payload.type === 'targetGroup') && Array.isArray(payload.mxKeys)) {
    mks = payload.mxKeys;
  }
  mks.forEach((mk) => {
    const sel = '[data-mx-key="' + String(mk).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
    const cell = mx.querySelector(sel);
    if (cell) cell.classList.add('kp-mx-sync-hl');
  });
}

// ✅ T81: ПОЛНОЭКРАННЫЙ РЕЖИМ диаграммы — #scatterWrap растягивается на
// весь экран (position: fixed), сцена перерисовывается под новые размеры
// (ширина — всё окно, высота — окно минус панель инструментов), масштаб
// и сдвиг сохраняются. Выход — кнопка («⤡ Свернуть») или Esc (если
// открыта карточка КП — Esc сначала закрывает её).
function scToggleFs(force) {
  const on = typeof force === 'boolean' ? force : !_scFs;
  if (on === _scFs) return;
  _scFs = on;
  const wrap = document.getElementById('scatterWrap');
  if (wrap) wrap.classList.toggle('sc-fs', on);
  const btn = document.getElementById('btnScatterFull');
  if (btn) {
    btn.textContent = on ? '⤡ Свернуть' : '⛶ Во весь экран';
    btn.title = on ? 'Выйти из полноэкранного режима диаграммы (Esc)'
                   : 'Открыть диаграмму во весь экран (Esc — выход)';
  }
  if (_scatterState) renderScatterT75(_scatterState); // перерисовка под новый размер
}

// восстановить перекрестие после перерисовки сцены (масштаб/сдвиг)
function scApplyHover() {
  if (!_scHoverKey) return;
  scDrawHover(scHoverEl(_scHoverKey)); // ✅ T82: группы — через карту
}

function scDrawHover(gEl) {
  const L = scHoverLayer();
  if (!L) return;
  while (L.firstChild) L.removeChild(L.firstChild);
  if (!gEl || !gEl.dataset || gEl.dataset.scX == null || !_scGeom || !_scDom) return;
  const dom = _scDom, pw = _scGeom.pw, ph = _scGeom.ph;
  const sx = (v) => SC_M.l + (v - dom.x0) / (dom.x1 - dom.x0) * pw;
  const sy = (v) => SC_M.t + ph - (v - dom.y0) / (dom.y1 - dom.y0) * ph;
  const hx = parseFloat(gEl.dataset.scX), hy = parseFloat(gEl.dataset.scY);
  // ✅ T82: группа совпавших точек — отрезок «цель → точка» у каждого
  // члена (своя цель); цвет перекрестия — консенсус, иначе нейтральный
  const cols = new Set();
  let segs = null;
  if (gEl.dataset.scGroup) {
    try { segs = JSON.parse(gEl.dataset.scGroup); } catch (e) { segs = null; }
    if (!Array.isArray(segs) || !segs.length) segs = null;
  }
  if (segs) {
    segs.forEach((s) => {
      if (!s || s.x == null || s.y == null) return;
      const x = parseFloat(s.x), y = parseFloat(s.y);
      const hasT = s.tx != null && s.ty != null;
      const tx = hasT ? parseFloat(s.tx) : 0;
      const ty = hasT ? parseFloat(s.ty) : 0;
      const better = hasT ? (y < ty || (y === ty && x < tx)) : null;
      const col = better === null ? '#7a8794' : (better ? SC_BETTER : SC_WORSE);
      cols.add(col);
      if (hasT) {
        const seg = scNS('line');
        seg.setAttribute('x1', sx(tx)); seg.setAttribute('y1', sy(ty));
        seg.setAttribute('x2', sx(x)); seg.setAttribute('y2', sy(y));
        seg.setAttribute('stroke', col);
        seg.setAttribute('stroke-width', '9');
        seg.setAttribute('stroke-opacity', '0.4');
        seg.setAttribute('stroke-linecap', 'round');
        L.appendChild(seg);
      }
    });
  } else {
    const hasT = gEl.dataset.scTx != null && gEl.dataset.scTy != null;
    const tx = hasT ? parseFloat(gEl.dataset.scTx) : 0;
    const ty = hasT ? parseFloat(gEl.dataset.scTy) : 0;
    // лучше/хуже — по стоимости партии (основной критерий выбора
    // лучшего), при равенстве — по трудоёмкости; цели нет — нейтрально
    const better = hasT ? (hy < ty || (hy === ty && hx < tx)) : null;
    // ✅ T82: у итоговой цели нет «лучше/хуже» — цвет линии цели
    const col = better === null
      ? (gEl.dataset.scKey === 'tgtS' ? SC_TGT_COLOR : '#7a8794')
      : (better ? SC_BETTER : SC_WORSE);
    cols.add(col);
    // подсветка промежутка цель → предложение
    if (hasT) {
      const seg = scNS('line');
      seg.setAttribute('x1', sx(tx)); seg.setAttribute('y1', sy(ty));
      seg.setAttribute('x2', sx(hx)); seg.setAttribute('y2', sy(hy));
      seg.setAttribute('stroke', col);
      seg.setAttribute('stroke-width', '9');
      seg.setAttribute('stroke-opacity', '0.4');
      seg.setAttribute('stroke-linecap', 'round');
      L.appendChild(seg);
    }
  }
  const col = (cols.size === 1) ? cols.values().next().value : '#7a8794';
  // перекрестие: линии к осям, в концах — значения (бейджи)
  const vl = scNS('line');
  vl.setAttribute('x1', sx(hx)); vl.setAttribute('y1', SC_M.t);
  vl.setAttribute('x2', sx(hx)); vl.setAttribute('y2', SC_M.t + ph);
  vl.setAttribute('class', 'kp-sc-hline');
  vl.setAttribute('stroke', col);
  L.appendChild(vl);
  const hl = scNS('line');
  hl.setAttribute('x1', SC_M.l); hl.setAttribute('y1', sy(hy));
  hl.setAttribute('x2', SC_M.l + pw); hl.setAttribute('y2', sy(hy));
  hl.setAttribute('class', 'kp-sc-hline');
  hl.setAttribute('stroke', col);
  L.appendChild(hl);
  scValBadge(L, sx(hx), SC_M.t + ph + 16, scValText(hx), col);
  scValBadge(L, SC_M.l - 26, sy(hy), scValText(hy), col);
}

export function clearChoiceMatrix() {
  const wrap = document.getElementById('matrixWrap');
  const cont = document.getElementById('choiceMatrix');
  if (cont) cont.innerHTML = '';
  if (wrap) wrap.style.display = 'none';
  // ✅ T75: прячем и scatter «Трудоёмкость vs Стоимость»
  const scWrap = document.getElementById('scatterWrap');
  const scCont = document.getElementById('kpScatter');
  if (scCont) scCont.innerHTML = '';
  if (scWrap) scWrap.style.display = 'none';
  hideDecision(); // ✅ T76
  // ✅ T81: свернуть полноэкранный режим (без перерисовки — данные уходят)
  if (_scFs) {
    _scFs = false;
    const wf = document.getElementById('scatterWrap');
    if (wf) wf.classList.remove('sc-fs');
    const bf = document.getElementById('btnScatterFull');
    if (bf) bf.textContent = '⛶ Во весь экран';
  }
  _scatterState = null;
  _scChecked = new Set(); // ✅ T78
  _scPts = []; _scDom = null; _scBase = null; // ✅ T79
  _scHoverKey = null; // ✅ T80
  _scO2G.clear(); // ✅ T82
  _cellData.clear();
  hideTip();
}
