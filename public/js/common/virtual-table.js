/** ============================================================
 * PROMPT FOR AI: public/js/common/virtual-table.js
 *============================================================
 * ## АРХИТЕКТУРА ФАЙЛА
 *  VirtualTable — базовый класс виртуальной таблицы с поддержкой:
 *    - Виртуализация строк (рендер только видимых + буфер)
 *    - Группировка колонок (двухуровневый заголовок: groups)
 *    - Фиксация первой группы колонок (freezeFirstGroup + sticky)
 *    - MultiSelect (Ctrl+Click, Shift+Click)
 *    - Ресайз колонок перетаскиванием (pointer events)
 *    - Блокировка строк (getLockInfo → lock-badge-inline)
 *    - АВТООБНОВЛЕНИЕ ФОРМЫ при обновлении данных (_autoRefreshForm)
 *    - ПОДВАЛ колонок и групп колонок (footer + group.footer)
 *      • Подвал колонок: агрегаты (sum/avg/median/min/max/count)
 *        или произвольный текст/комментарий
 *      • Подвал групп: произвольная информация по группе
 *      • Sticky-закрепление работает и в подвале (зеркало заголовка)
 *
 * ## КРИТИЧЕСКИЕ ПРАВИЛА
 *  1. НЕ удалять существующую логику виртуализации, ресайза,
 *     группировки, sticky-фиксации и multiSelect.
 *  2. Метод setData() — ЕДИНСТВЕННАЯ точка входа для обновления данных.
 *     После рендера он ОБЯЗАН вызвать _autoRefreshForm() и _renderFooter().
 *  3. _autoRefreshForm() вызывается ВНУТРИ requestAnimationFrame,
 *     ПОСЛЕ _render() и ПОСЛЕ вызова _pendingRenderResolve().
 *  4. Защита от потери данных пользователя:
 *     - Если EditLock.current существует И EditLock.current.id === selectedId
 *       → НЕ обновлять форму (пользователь редактирует, данные не потеряны)
 *     - Если opts.autoRefreshForm === false → пропустить автообновление
 *       (для multiSelect таблиц или специфичных случаев)
 *  5. Если выбранная строка УДАЛЕНА из данных (не найдена):
 *     → clearSelection() + onHeaderClick()
 *     → Форма очищается, выбор сбрасывается
 *  6. _autoRefreshForm() НЕ должен выбрасывать исключения.
 *     Все ошибки оборачиваются в try/catch с console.warn.
 *  7. Фильтр по pageKey НЕ нужен здесь — это уровень synthetic-sync.js.
 *     VirtualTable работает с уже готовыми данными.
 *  8. Подвал рендерится всегда (если включён в конфигурации).
 *     При отсутствии данных агрегаты показывают emptyText ('—' по умолчанию).
 *  9. Sticky-колонки в подвале должны зеркалировать sticky-диапазон
 *     заголовка/тела — те же left-offsets, тот же vt-sticky-edge.
 *
 * ## КОНФИГУРАЦИЯ ПОДВАЛА (НОВОЕ)
 *  Top-level:
 *    opts.footer = {
 *      sticky: true|false,       // sticky-bottom (по умолчанию true)
 *      emptyText: '—',           // текст при отсутствии данных
 *      rowHeight: 26             // высота строк подвала (по умолчанию = rowHeight)
 *    }
 *    // Или просто opts.footer = true для дефолтов
 *    // Или opts.footer = false для полного отключения
 *
 *  Column-level (в каждой колонке):
 *    column.footer = {
 *      type: 'sum'|'avg'|'median'|'min'|'max'|'count'|'text'|'custom',
 *      value: 'Total:',                         // для type='text'
 *      formatter: (val, rows) => string,        // кастомное форматирование
 *      decimals: 2,                             // округление для avg/median
 *      emptyText: '—',                          // override пустого значения
 *      className: 'my-footer-cell',             // доп. CSS-класс
 *      style: { color: '#900', fontWeight: 700 } // инлайн-стили
 *    }
 *
 *  Group-level (в каждой группе):
 *    group.footer = {
 *      value: 'Σ по фирме 1',                   // строка
 *      // ИЛИ
 *      value: (group, rows) => `Σ по ${group.name}: ${rows.length}`,  // функция
 *      className: 'firm',                       // доп. CSS-класс (по умолчанию = colorClass группы)
 *      style: { ... }                           // инлайн-стили
 *    }
 *
 *  Пример:
 *    new VirtualTable(container, [
 *      { key: 'name', label: 'Name', width: 200,
 *        footer: { type: 'text', value: 'Итого:' } },
 *      { key: 'price', label: 'Price', width: 100,
 *        footer: { type: 'sum', decimals: 2 } },
 *      { key: 'qty', label: 'Qty', width: 80,
 *        footer: { type: 'avg', decimals: 1 } },
 *      { key: 'note', label: 'Note', width: 150,
 *        footer: { type: 'text', value: '— проверено —' } }
 *    ], {
 *      groups: [
 *        { name: 'Фирма 1', startIdx: 0, colspan: 4, colorClass: 'firm',
 *          footer: { value: (g, rows) => `Записей: ${rows.length}` } }
 *      ],
 *      freezeFirstGroup: true,
 *      footer: { sticky: true, emptyText: 'нет данных' }
 *    });
 *
 * ## ИНТЕГРАЦИЯ С WEBSOCKET
 *  Поток данных при изменении другим клиентом:
 *    WS data_changed
 *    → synthetic-sync.js → syntheticHandlers[key]()
 *    → модуль.load() → FilterableTable.loadImmediate()
 *    → api('GET', ...) → сервер возвращает свежие данные
 *    → VirtualTable.setData(newData)
 *      → _render()          // таблица перерисована
 *      → _renderFooter()    // подвал пересчитан
 *      → _autoRefreshForm() // форма перезаполнена из свежих данных
 *============================================================
 * END OF PROMPT FOR AI
 *============================================================
 */

import { DirtyGuard } from './dirty-guard.js';
import { toast } from './utils.js';

export class VirtualTable {
  constructor(container, columns, opts = {}) {
    VirtualTable.injectGlobalStyles();
    this.container = container;

    // Преобразуем ширину в числа
    this.columns = columns.map(c => ({
      ...c,
      width: parseInt(c.width) || 150
    }));

    this.rowHeight = opts.rowHeight || 26;
    this.buffer = opts.buffer || 8;
    this.onSelect = opts.onSelect || (() => {});
    this.onDblClick = opts.onDblClick || null;
    this.onHeaderClick = opts.onHeaderClick || (() => {});
    // ✅ НОВОЕ: обработчик клика по заголовку группы.
    //   Если задан — вызывается с (group, gIdx, event) при клике на groupCell.
    //   Если не задан — клик по группе игнорируется (только clearSelection + onHeaderClick).
    this.onGroupClick = opts.onGroupClick || null;
    this.onSelectionChange = opts.onSelectionChange || null;
    this.data = [];
    this.getLockInfo = opts.getLockInfo || null;
    // ✅ НОВОЕ: обобщённый механизм подсветки строк.
    //   Функция (item) => Array<{className, icon, title, badgeText?}>
    //   className — добавляется к vtable-row (CSS-класс подсветки)
    //   icon     — эмодзи/символ иконки для бейджа (✋, 🔥, ⚠ ...)
    //   title    — всплывающая подсказка строки
    //   badgeText — необязательный текст рядом с иконкой (если нет — только иконка)
    //   Возвращает null/[]/undefined если подсветки нет
    this.getRowHighlights = opts.getRowHighlights || null;
    this.rowClassName = opts.rowClassName || null;  // ✅ для обратной совместимости
    this.idKey = opts.idKey || 'id';
    this.multiSelect = opts.multiSelect || false;
    this.selectedIds = new Set();
    this.lastSelectedId = null;
    this.selectedId = null;
    // Автообновление формы при обновлении данных
    // true (по умолчанию) — форма перезаполняется из свежих данных
    // false — отключено (multiSelect, составные формы с вкладками)
    this.autoRefreshForm = opts.autoRefreshForm !== false; // default: true
    this.onBeforeSelect = opts.onBeforeSelect || null;

    // Группировка колонок (двухуровневый заголовок)
    // Формат: [{ name: 'Фирма 1', colspan: 6, colorClass: 'firm' }, ...]
    // Если groups не передан — обычный одноуровневый заголовок
    this.groups = opts.groups || null;
    this.hasGroups = Array.isArray(this.groups) && this.groups.length > 0;

    // ✅ НОВОЕ: схлопывание групп фирм
    //   collapsibleGroups = true → в заголовке группы появляется кнопка [+/−]
    //   клик по которой сворачивает/разворачивает группу.
    //   При сворачивании остаются видимыми только ПОСЛЕДНИЕ N колонок группы
    //   (по умолчанию 1 — например, 'Стоим. партии' у фирмы).
    this.collapsibleGroups = opts.collapsibleGroups === true;
    this.collapsedGroups = new Set();       // множество gIdx свёрнутых групп
    this.collapsibleKeepLastN = opts.collapsibleKeepLastN ?? 1;
    // ✅ НОВОЕ: какие colorClass подлежат схлопыванию (по умолчанию — 'firm')
    this.collapsibleColorClasses = opts.collapsibleColorClasses || ['firm'];
    // ✅ НОВОЕ: при startCollapsed=true — все collapsible-группы сворачиваются
    //   сразу после первой инициализации (удобно для восприятия общей картины).
    this.startCollapsed = opts.startCollapsed === true;
    this.headerHeight = this.hasGroups ? this.rowHeight * 2 : this.rowHeight;

    this._pendingRenderResolve = null;
    this._isResizing = false;
    this._currentColIdx = -1;
    this._startX = 0;
    this._startWidth = 0;
    this.freezeFirstGroup = opts.freezeFirstGroup || false;   // ✅ НОВОЕ
    this._stickyOffsets = [];

    // ============================================================
    // ✅ ПОДВАЛ (НОВОЕ)
    // ============================================================
    // Вычисляем, нужно ли вообще рисовать подвал.
    // Условие: opts.footer !== false И (есть column.footer ИЛИ group.footer)
    this._footerCfg = this._normalizeFooterCfg(opts.footer);
    this._hasColumnFooter = this.columns.some(c => c.footer);
    this._hasGroupFooter = this.hasGroups && this.groups.some(g => g.footer);
    this.hasFooter = this._footerCfg.enabled &&
                     (this._hasColumnFooter || this._hasGroupFooter);
    // Высота подвала = (column-footer? + group-footer?) * rowHeight
    this.footerHeight = this.hasFooter
      ? this._footerCfg.rowHeight *
        (this._hasColumnFooter ? 1 : 0) +
        (this._hasGroupFooter ? 1 : 0) * this._footerCfg.rowHeight
      : 0;

    this._build();
    this._bindScroll();
    this._initResizeObserver();
    this._initResizeEvents();

    // ✅ НОВОЕ: если startCollapsed=true — сворачиваем все collapsible-группы.
    //   Делаем это ПОСЛЕ _build (т.к. _build создаёт header с кнопками),
    //   но БЕЗ вызова _rebuildAfterCollapseChange (он был бы избыточен —
    //   header только что создан). Просто заполняем collapsedGroups и
    //   пересобираем header заново с учётом состояния.
    if (this.startCollapsed && this.collapsibleGroups && Array.isArray(this.groups)) {
      this.groups.forEach((g, gIdx) => {
        if (this.collapsibleColorClasses.includes(g.colorClass)) {
          this.collapsedGroups.add(gIdx);
        }
      });
      // Перестроить header с учётом свёрнутых групп + пересчёт layout
      this._rebuildAfterCollapseChange();
    }
  }

  /** Нормализация конфига подвала */
  _normalizeFooterCfg(raw) {
    const def = {
      enabled: true,
      sticky: true,
      emptyText: '—',
      rowHeight: this.rowHeight || 26
    };
    if (raw === false) return { ...def, enabled: false };
    if (raw === true || raw == null) return def;
    if (typeof raw === 'object') {
      return {
        ...def,
        ...raw,
        enabled: raw.enabled !== false
      };
    }
    return def;
  }

  static injectGlobalStyles() {
    if (VirtualTable._stylesInjected) return;
    VirtualTable._stylesInjected = true;

    const style = document.createElement('style');
    style.textContent = `
      /* ============================================================
        БАЗОВАЯ ТАБЛИЦА
        ============================================================ */
      .vtable-container {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: auto;
        position: relative;
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 12px;
      }

      .vtable {
        position: relative;
        min-width: 100%;
      }

      /* ============================================================
        СТРОКИ И ЯЧЕЙКИ
        ============================================================ */
      .vtable-header,
      .vtable-row {
        display: flex;
        height: var(--row-h);
        line-height: var(--row-h);
        border-bottom: 1px solid #eaeef2;
      }

      .vtable-header {
        position: sticky;
        top: 0;
        z-index: 2;
        background: #f6f8fa;
        font-weight: 600;
        border-bottom: 2px solid var(--border);
      }

      .vtable-cell {
        padding: 0 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        border-right: 1px solid #eaeef2;
        position: relative;
        box-sizing: border-box;
      }

      .vtable-cell:last-child {
        border-right: none;
      }

      .vtable-row {
        position: absolute;
        left: 0;
        right: 0;
        cursor: pointer;
      }

      /* ✅ ЯВНЫЙ HOVER ДЛЯ ОБЫЧНЫХ СТРОК */
      .vtable-row:hover {
        background: #e3f2fd !important; /* Светло-синий, хорошо виден */
      }

      /* ✅ ВЫДЕЛЕННАЯ СТРОКА */
      .vtable-row.selected {
        background: #90caf9 !important; /* Насыщенный синий */
        font-weight: 600;
        color: #0d47a1 !important; /* Тёмно-синий текст для контраста */
      }

      /* ✅ HOVER НА ВЫДЕЛЕННОЙ СТРОКЕ */
      .vtable-row.selected:hover {
        background: #64b5f6 !important; /* Ещё более насыщенный при наведении */
      }

      .vtable-spacer {
        pointer-events: none;
      }

      .vtable-body {
        position: relative;
        min-height: 1px;
      }

      /* ============================================================
        РЕСАЙЗЕР КОЛОНОК
        ============================================================ */
      .vtable .col-resizer {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: 6px;
        cursor: col-resize;
        z-index: 10;
        transition: background-color 0.15s ease;
      }

      .vtable .col-resizer:hover {
        background-color: rgba(0, 120, 255, 0.35);
      }

      .vtable .col-resizer.active {
        background-color: rgba(0, 120, 255, 0.55);
      }

      /* ============================================================
        ГРУППИРОВАННЫЙ ЗАГОЛОВОК (двухуровневый)
        ============================================================ */
      .vtable-header-grouped {
        display: flex;
        flex-direction: column;
        position: sticky;
        top: 0;
        z-index: 2;
        background: #f6f8fa;
        border-bottom: 2px solid var(--border);
      }

      .vtable-header-group {
        display: flex;
        height: 26px;
        line-height: 26px;
        border-bottom: 1px solid var(--border);
      }

      .vtable-header-group-cell {
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 11px;
        color: var(--text);
        border-right: 1px solid var(--border);
        padding: 0 4px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        box-sizing: border-box;
      }

      .vtable-header-group-cell.base {
        background: #e6f3ff;
        color: #0550ae;
      }

      .vtable-header-group-cell.firm {
        background: #fff8e1;
        color: #6a5200;
      }

      .vtable-header-group-cell.result {
        background: #e6ffed;
        color: #0a5c26;
      }

      .vtable-header-sub {
        display: flex;
        height: 26px;
        line-height: 26px;
        background: #f6f8fa;
        font-weight: 600;
        font-size: 11px;
      }

      .vtable-header-sub .vtable-cell {
        font-size: 10px;
        color: var(--muted);
      }

      /* ============================================================
        MULTISELECT
        ============================================================ */
      .vtable.multi-select-mode .vtable-row.selected {
        background: #90caf9 !important;
        border-left: 4px solid #0d47a1;
      }

      .vtable.multi-select-mode .vtable-row.selected:hover {
        background: #64b5f6 !important;
      }

      .vtable-header[title] {
        cursor: help;
      }

      .multi-select-hint {
        font-size: 10px;
        color: var(--muted);
        font-weight: normal;
        font-style: italic;
        margin-left: 8px;
      }

      /* ============================================================
        ✅ НОВОЕ: СХЛОПЫВАНИЕ ГРУПП КОЛОНОК
        ============================================================ */
      .vtable-header-group-cell .group-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        margin-right: 4px;
        background: rgba(255,255,255,.5);
        border: 1px solid rgba(0,0,0,.2);
        border-radius: 3px;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        user-select: none;
        vertical-align: middle;
        transition: background .15s;
      }
      .vtable-header-group-cell .group-toggle:hover {
        background: rgba(255,255,255,.9);
        border-color: rgba(0,0,0,.4);
      }
      .vtable-header-group-cell.collapsed {
        opacity: .8;
        /* ✅ НОВОЕ: при схлопывании прижимаем содержимое (кнопку + название)
        //   к левому краю, чтобы кнопка [+/−] оставалась видимой даже при
        //   узкой ширине группы (только 'Стоим. партии' = 90px) */
        justify-content: flex-start !important;
      }

      /* ============================================================
        БЛОКИРОВКА СТРОК
        ============================================================ */
      .vtable-row.locked {
        background: #fff8e1 !important;
        cursor: not-allowed !important;
        opacity: 0.9;
      }

      .vtable-row.locked:hover {
        background: #ffecb3 !important; /* Более заметный hover для заблокированных */
      }

      .vtable-row.locked.selected {
        background: #ffd54f !important; /* Насыщенный жёлтый для выделенной заблокированной */
        color: #5d4037 !important;
      }

      .vtable-row.locked.selected:hover {
        background: #ffca28 !important;
      }

      /* Бейдж в строке */
      .lock-badge-inline {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        margin-right: 6px;
        background: #ff9800;
        color: #fff;
        font-size: 10px;
        font-weight: 600;
        border-radius: 10px;
        white-space: nowrap;
        vertical-align: middle;
        box-shadow: 0 1px 3px rgba(0,0,0,.2);
        animation: badgeAppear 0.3s ease-out;
      }

      @keyframes badgeAppear {
        from { transform: scale(0.8); opacity: 0; }
        to   { transform: scale(1); opacity: 1; }
      }

      /* ============================================================
        ✅ НОВОЕ: ОБЩИЙ МЕХАНИЗМ ПОДСВЕТКИ СТРОК (getRowHighlights)
        ============================================================
        className → CSS-класс vtable-row.<className>
        Бейдж .row-badge-inline.<className>-badge с указанной иконкой
        ============================================================ */

      /* — Подсветка строк с ручным назначением лучшего КП — */
      .vtable-row.highlight-manual-best {
        background: #e8f5e9 !important;            /* светло-зелёный */
      }
      .vtable-row.highlight-manual-best:hover {
        background: #c8e6c9 !important;
      }
      .vtable-row.highlight-manual-best.selected {
        background: #a5d6a7 !important;
        color: #1b5e20 !important;
      }
      .vtable-row.highlight-manual-best.selected:hover {
        background: #81c784 !important;
      }
      .vtable-row.highlight-manual-best .vt-sticky {
        background: #e8f5e9 !important;
      }
      .vtable-row.highlight-manual-best:hover .vt-sticky {
        background: #c8e6c9 !important;
      }
      .vtable-row.highlight-manual-best.selected .vt-sticky {
        background: #a5d6a7 !important;
        color: #1b5e20 !important;
      }
      .vtable-row.highlight-manual-best.selected:hover .vt-sticky {
        background: #81c784 !important;
      }

      /* Общий стиль бейджа для подсветок (производные от lock-badge-inline) */
      .row-badge-inline {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        margin-right: 6px;
        font-size: 10px;
        font-weight: 600;
        border-radius: 10px;
        white-space: nowrap;
        vertical-align: middle;
        box-shadow: 0 1px 3px rgba(0,0,0,.2);
        animation: badgeAppear 0.3s ease-out;
      }
      .row-badge-inline.manual-best-badge {
        background: #4caf50;
        color: #fff;
      }

      /* ============================================================
        STICKY: ФИКСАЦИЯ ПЕРВОЙ ГРУППЫ КОЛОНОК
        ============================================================ */
      .vt-sticky {
        position: sticky !important;
        z-index: 3;
      }

      /* Заголовок: group-row (имя группы) */
      .vtable-header-grouped .vtable-header-group .vt-sticky {
        z-index: 6;
      }

      /* Заголовок: sub-row (имена колонок) */
      .vtable-header-grouped .vtable-header-sub .vt-sticky {
        z-index: 5;
        background: #f6f8fa;
      }

      /* Тело: обычный фон */
      .vtable-row .vt-sticky {
        z-index: 1;
        background: #fff;
      }

      /* ✅ HOVER ДЛЯ STICKY-КОЛОНОК */
      .vtable-row:hover .vt-sticky {
        background: #e3f2fd !important; /* Тот же цвет, что и обычный hover */
      }

      /* ✅ ВЫДЕЛЕННАЯ STICKY-КОЛОНКА */
      .vtable-row.selected .vt-sticky {
        background: #90caf9 !important;
        color: #0d47a1 !important;
      }

      /* ✅ HOVER НА ВЫДЕЛЕННОЙ STICKY-КОЛОНКЕ */
      .vtable-row.selected:hover .vt-sticky {
        background: #64b5f6 !important;
      }

      /* ✅ ЗАБЛОКИРОВАННАЯ STICKY-КОЛОНКА */
      .vtable-row.locked .vt-sticky {
        background: #fff8e1 !important;
      }

      .vtable-row.locked:hover .vt-sticky {
        background: #ffecb3 !important;
      }

      .vtable-row.locked.selected .vt-sticky {
        background: #ffd54f !important;
        color: #5d4037 !important;
      }

      .vtable-row.locked.selected:hover .vt-sticky {
        background: #ffca28 !important;
      }

      /* Тень-разделитель на последней закреплённой колонке */
      .vt-sticky-edge {
        box-shadow: 2px 0 5px rgba(0,0,0,.14);
      }

      /* ============================================================
        ПОДВАЛ (НОВОЕ)
        ============================================================ */
      .vtable-footer-grouped {
        display: flex;
        flex-direction: column;
        position: sticky;
        bottom: 0;
        z-index: 2;
        background: #f6f8fa;
        border-top: 2px solid var(--border);
      }

      .vtable-footer-grouped.non-sticky {
        position: relative;
        bottom: auto;
      }

      /* Подвал колонок — строка агрегатов/комментариев (ближе к данным) */
      .vtable-footer-sub {
        display: flex;
        height: 26px;
        line-height: 26px;
        background: #f6f8fa;
        font-weight: 600;
        font-size: 11px;
        border-bottom: 1px solid var(--border);
      }

      .vtable-footer-sub .vtable-footer-cell {
        font-size: 11px;
        color: #0d47a1;
        text-align: right;
        justify-content: flex-end;
      }

      .vtable-footer-sub .vtable-footer-cell.text {
        text-align: left;
        justify-content: flex-start;
        color: var(--muted);
        font-style: italic;
      }

      /* Подвал групп — зеркальный к header-group (нижняя строка) */
      .vtable-footer-group {
        display: flex;
        height: 26px;
        line-height: 26px;
        border-top: 1px solid var(--border);
      }

      .vtable-footer-group-cell {
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        font-size: 11px;
        color: var(--text);
        border-right: 1px solid var(--border);
        padding: 0 4px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        box-sizing: border-box;
      }

      .vtable-footer-group-cell.base {
        background: #e6f3ff;
        color: #0550ae;
      }

      .vtable-footer-group-cell.firm {
        background: #fff8e1;
        color: #6a5200;
      }

      .vtable-footer-group-cell.result {
        background: #e6ffed;
        color: #0a5c26;
      }

      /* Подвал без групп — одна строка, без верхней границы */
      .vtable-footer-simple {
        display: flex;
        position: sticky;
        bottom: 0;
        z-index: 2;
        height: 26px;
        line-height: 26px;
        background: #f6f8fa;
        border-top: 2px solid var(--border);
        font-weight: 600;
        font-size: 11px;
      }

      .vtable-footer-simple.non-sticky {
        position: relative;
        bottom: auto;
      }

      .vtable-footer-simple .vtable-footer-cell {
        font-size: 11px;
        color: #0d47a1;
        text-align: right;
        justify-content: flex-end;
      }

      .vtable-footer-simple .vtable-footer-cell.text {
        text-align: left;
        justify-content: flex-start;
        color: var(--muted);
        font-style: italic;
      }

      .vtable-footer-cell {
        padding: 0 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        border-right: 1px solid #eaeef2;
        position: relative;
        box-sizing: border-box;
        display: flex;
        align-items: center;
      }

      .vtable-footer-cell:last-child {
        border-right: none;
      }

      /* Sticky для подвала (зеркало заголовка) */
      .vtable-footer-grouped .vtable-footer-sub .vt-sticky,
      .vtable-footer-grouped .vtable-footer-group .vt-sticky,
      .vtable-footer-simple .vt-sticky {
        z-index: 5;
        background: #f6f8fa;
      }

      /* ============================================================
        КАСТОМНЫЕ СКРОЛЛБАРЫ (появляются при наведении)
        ============================================================ */
      .vtable-container {
        scrollbar-width: thin;
        scrollbar-color: transparent transparent;
        transition: scrollbar-color 0.2s ease;
      }

      .vtable-container:hover {
        scrollbar-color: #ccc #f0f0f0;
      }

      .vtable-container::-webkit-scrollbar {
        width: 6px;
        height: 6px;
        background: transparent;
      }

      .vtable-container::-webkit-scrollbar-track {
        background: transparent;
      }

      .vtable-container::-webkit-scrollbar-thumb {
        background: transparent;
        border-radius: 4px;
        transition: background 0.2s ease;
      }

      .vtable-container:hover::-webkit-scrollbar-thumb {
        background: #ccc;
      }

      .vtable-container:hover::-webkit-scrollbar-track {
        background: #f0f0f0;
      }
    `;
    document.head.appendChild(style);
  }

  _initResizeObserver() {
    this._resizeObserver = new ResizeObserver(() => {
      this._render();
      // ✅ НОВОЕ: ResizeObserver может сработать ДО rAF из setData()
      // и обнулить _pendingRenderResolve. В этом случае _renderFooter()
      // не вызовется из rAF — вызываем здесь, чтобы подвал не оставался пустым.
      this._renderFooter();
      if (this._pendingRenderResolve) {
        const resolve = this._pendingRenderResolve;
        this._pendingRenderResolve = null;
        resolve();
      }
    });
    this._resizeObserver.observe(this.body);
  }

  _build() {
    this.container.innerHTML = '';
    this.table = document.createElement('div');
    this.table.className = 'vtable';
    if (this.multiSelect) this.table.classList.add('multi-select-mode');

    // ✅ НОВОЕ: сначала рассчитываем sticky-offsets, т.к. _buildGroupedHeader
    //   и _buildFooter вызывают _applyHeaderSticky/_applyFooterSticky
    //   которые используют this._stickyOffsets. Без этого ячейки получают
    //   left='0px' и прилипание не работает при первой инициализации.
    this._calcStickyOffsets();

    // ✅ Построение заголовка (с группами или без)
    if (this.hasGroups) {
      this._buildGroupedHeader();
    } else {
      this._buildSimpleHeader();
    }

    this.table.appendChild(this.header);

    this.body = document.createElement('div');
    this.body.className = 'vtable-body';
    this.body.style.position = 'relative';
    this.table.appendChild(this.body);

    // ✅ НОВОЕ: Построение подвала (если включён)
    if (this.hasFooter) {
      this._buildFooter();
      this.table.appendChild(this.footer);
    }

    this.container.appendChild(this.table);

    const totalWidth = this._computeVisibleWidth();
    this._updateTableWidth(totalWidth);

    // ✅ НОВОЕ: дублируем _calcStickyOffsets + _updateStickyPositions
    //   для гарантии корректных left-позиций у всех уже созданных ячеек.
    //   Это страховка на случай, если ширины колонок изменились между
    //   первым _calcStickyOffsets (выше) и созданием ячеек.
    this._calcStickyOffsets();
    if (this.freezeFirstGroup) {
      this._updateStickyPositions();
    }
  }

  // ✅ Простой заголовок (как было)
  _buildSimpleHeader() {
    this.header = document.createElement('div');
    this.header.className = 'vtable-header';
    this.header.style.display = 'flex';

    this.columns.forEach((c, idx) => {
      const cell = this._createHeaderCell(c, idx);
      this.header.appendChild(cell);
    });

    if (this.multiSelect) {
      const hint = document.createElement('span');
      hint.className = 'multi-select-hint';
      hint.textContent = '(Ctrl+click — добавить, Shift+click — диапазон)';
      this.header.appendChild(hint);
    }

    this.header.addEventListener('click', (e) => {
      if (e.target.classList.contains('col-resizer')) return;
      this.clearSelection();
      this.onHeaderClick();
    });
  }

  // ✅ Группированный заголовок (двухуровневый)
  _buildGroupedHeader() {
    this.header = document.createElement('div');
    this.header.className = 'vtable-header-grouped';

    // Первая строка — названия групп
    const groupRow = document.createElement('div');
    groupRow.className = 'vtable-header-group';

    this.groups.forEach((group, gIdx) => {

      const groupCell = document.createElement('div');
      groupCell.className = 'vtable-header-group-cell ' + (group.colorClass || 'firm');

      // ✅ ИЗМЕНЕНО: ширина группы с учётом скрытых (collapsed) колонок
      let groupWidth = this._computeGroupVisibleWidth(group);

      groupCell.style.width = `${groupWidth}px`;
      groupCell.style.minWidth = `${groupWidth}px`;
      // ✅ НОВОЕ: имя группы + кнопка toggle (если collapsibleGroups)
      //   Кнопка появляется только для групп, чей colorClass входит в
      //   collapsibleColorClasses (по умолчанию ['firm']).
      const isCollapsible = this.collapsibleGroups &&
        this.collapsibleColorClasses.includes(group.colorClass);
      if (isCollapsible) {
        const isCollapsed = this.collapsedGroups.has(gIdx);
        if (isCollapsed) groupCell.classList.add('collapsed');
        const toggle = document.createElement('span');
        toggle.className = 'group-toggle';
        toggle.textContent = isCollapsed ? '+' : '−';
        toggle.title = isCollapsed ? 'Развернуть группу' : 'Свернуть группу';
        // ✅ ВАЖНО: stopPropagation — иначе клик по кнопке запустит
        //   clearSelection + onHeaderClick (общий клик-обработчик header)
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleGroup(gIdx);
        });
        groupCell.appendChild(toggle);
        const nameSpan = document.createElement('span');
        nameSpan.textContent = group.name;
        nameSpan.title = group.name;
        groupCell.appendChild(nameSpan);
      } else {
        groupCell.textContent = group.name;
        groupCell.title = group.name;
      }

      if (this.freezeFirstGroup && gIdx === 0) {
        groupCell.classList.add('vt-sticky');
        groupCell.style.left = '0px';
      }

      // ✅ НОВОЕ: обработчик клика по заголовку группы
      //   Если onGroupClick задан — вызываем его с (group, gIdx, event)
      //   и stopPropagation, чтобы не сработал общий header click.
      //   Иначе — клик игнорируется (общий обработчик сделает clearSelection + onHeaderClick).
      if (this.onGroupClick) {
        // Курсор pointer для визуального отклика
        groupCell.style.cursor = 'pointer';
        groupCell.addEventListener('click', (e) => {
          // Не реагируем на клик по кнопке [+/−] (она имеет свой обработчик)
          if (e.target.classList.contains('group-toggle')) return;
          e.stopPropagation();
          try {
            this.onGroupClick(group, gIdx, e);
          } catch (err) {
            console.warn('[VirtualTable.onGroupClick] error:', err.message);
          }
        });
      }

      groupRow.appendChild(groupCell);
    });

    // Вторая строка — названия колонок
    const subRow = document.createElement('div');
    subRow.className = 'vtable-header-sub';

    this.columns.forEach((c, idx) => {
      // ✅ НОВОЕ: пропускаем свёрнутые колонки в sub-row заголовка
      if (this._isColumnCollapsed(idx)) return;
      const cell = this._createHeaderCell(c, idx);
      this._applyHeaderSticky(cell, idx);   // ✅ ДОБАВИТЬ
      subRow.appendChild(cell);
    });

    this.header.appendChild(groupRow);
    this.header.appendChild(subRow);

    this.header.addEventListener('click', (e) => {
      if (e.target.classList.contains('col-resizer')) return;
      this.clearSelection();
      this.onHeaderClick();
    });
  }

  // ============================================================
  // ✅ STICKY: ФИКСАЦИЯ ПЕРВОЙ ГРУППЫ КОЛОНОК
  // ============================================================

  /** Диапазон колонок первой группы (или null) */
  _getFrozenRange() {
      if (!this.freezeFirstGroup || !this.hasGroups || this.groups.length === 0) return null;
      const g = this.groups[0];
      const start = g.startIdx ?? 0;
      const end   = start + (g.colspan ?? 0) - 1;
      return { startIdx: start, endIdx: Math.min(end, this.columns.length - 1) };
  }

  /** Пересчёт left-offset для каждой закреплённой колонки */
  _calcStickyOffsets() {
      const range = this._getFrozenRange();
      if (!range) { this._stickyOffsets = []; return; }
      this._stickyOffsets = [];
      let offset = 0;
      for (let i = range.startIdx; i <= range.endIdx; i++) {
          this._stickyOffsets.push(offset);
          offset += this.columns[i].width;
      }
  }

  // ============================================================
  // ✅ НОВОЕ: СХЛОПЫВАНИЕ ГРУПП КОЛОНОК
  // ============================================================

  /** Проверить, скрыта ли колонка (попадает в свёрнутую группу
   *  И не входит в последние N колонок этой группы). */
  _isColumnCollapsed(colIdx) {
    if (!this.collapsibleGroups || this.collapsedGroups.size === 0) return false;
    if (!Array.isArray(this.groups)) return false;
    for (const gIdx of this.collapsedGroups) {
      const g = this.groups[gIdx];
      if (!g) continue;
      const start = g.startIdx ?? 0;
      const span = g.colspan ?? 0;
      const end = start + span - 1;  // inclusive
      if (colIdx >= start && colIdx <= end) {
        // Колонка попадает в свёрнутую группу.
        // Оставляем видимыми последние N колонок:
        const visibleStart = end - this.collapsibleKeepLastN + 1;
        return colIdx < visibleStart;
      }
    }
    return false;
  }

  /** Переключить состояние группы (свернуть/развернуть). */
  toggleGroup(gIdx) {
    if (!this.collapsibleGroups || !Array.isArray(this.groups)) return;
    const g = this.groups[gIdx];
    if (!g) return;
    // Проверка colorClass
    if (!this.collapsibleColorClasses.includes(g.colorClass)) return;

    if (this.collapsedGroups.has(gIdx)) {
      this.collapsedGroups.delete(gIdx);
    } else {
      this.collapsedGroups.add(gIdx);
    }

    // Перестроить заголовок (обновить кнопку [+/−] и ширину group cell)
    // и пересчитать sticky-offsets + ширину таблицы + перерендерить body
    this._rebuildAfterCollapseChange();
  }

  // ============================================================
  // ✅ НОВОЕ: МАССОВЫЕ ОПЕРАЦИИ СО СВОРАЧИВАНИЕМ
  // ============================================================

  /** Свернуть ВСЕ collapsible-группы (цветовой класс из collapsibleColorClasses). */
  collapseAllGroups() {
    this.setAllGroupsCollapsed(true);
  }

  /** Развернуть ВСЕ collapsible-группы. */
  expandAllGroups() {
    this.setAllGroupsCollapsed(false);
  }

  /** Установить состояние сворачивания для всех collapsible-групп.
   *  @param {boolean} collapsed — true=свернуть все, false=развернуть все
   */
  setAllGroupsCollapsed(collapsed) {
    if (!this.collapsibleGroups || !Array.isArray(this.groups)) return;
    this.groups.forEach((g, gIdx) => {
      if (this.collapsibleColorClasses.includes(g.colorClass)) {
        if (collapsed) {
          this.collapsedGroups.add(gIdx);
        } else {
          this.collapsedGroups.delete(gIdx);
        }
      }
    });
    this._rebuildAfterCollapseChange();
  }

  /** Проверить, свёрнуты ли ВСЕ collapsible-группы.
   *  Используется UI-чекбоксом для отображения текущего состояния.
   */
  areAllGroupsCollapsed() {
    if (!this.collapsibleGroups || !Array.isArray(this.groups)) return false;
    let count = 0, collapsedCount = 0;
    this.groups.forEach((g, gIdx) => {
      if (this.collapsibleColorClasses.includes(g.colorClass)) {
        count++;
        if (this.collapsedGroups.has(gIdx)) collapsedCount++;
      }
    });
    if (count === 0) return false;
    return collapsedCount === count;
  }

  /** Перестроение заголовка + пересчёт раскладки после изменения collapsed-состояния.
   *  Вызывает: перестроение header, пересчёт sticky-offsets, обновление ширины
   *  таблицы и полный _render() тела.
   */
  _rebuildAfterCollapseChange() {
    // Сохраняем scrollLeft, чтобы после перестроения пользователь остался в той же позиции
    const savedScrollLeft = this.container.scrollLeft;
    const savedScrollTop = this.container.scrollTop;

    // Перестроить заголовок (полный rebuild header DOM)
    if (this.header && this.header.parentNode) {
      this.header.parentNode.removeChild(this.header);
    }
    if (this.hasGroups) {
      this._buildGroupedHeader();
    } else {
      this._buildSimpleHeader();
    }
    this.table.insertBefore(this.header, this.body);

    // Пересчитать ширину таблицы с учётом скрытых колонок
    const totalWidth = this._computeVisibleWidth();
    this._updateTableWidth(totalWidth);

    // Перестроить footer (если есть) — он тоже зависит от ширины
    if (this.hasFooter) {
      if (this.footer && this.footer.parentNode) {
        this.footer.parentNode.removeChild(this.footer);
      }
      this._buildFooter();
      this.table.appendChild(this.footer);
      this._renderFooter();
    }

    // Пересчитать sticky-offsets (т.к. скрытые колонки не участвуют в layout)
    if (this.freezeFirstGroup) {
      this._calcStickyOffsets();
      this._updateStickyPositions();
    }

    // ✅ НОВОЕ: повторно инициализировать resize-events на новом header.
    //   Слушатель pointerdown был привязан к СТАРОМУ header, который мы
    //   удалили выше. Без этого resize колонок перестаёт работать после
    //   первого же схлопывания/раскрытия группы.
    this._initResizeEvents();

    // Перерендерить body с учётом скрытых колонок
    this._render();

    // Восстановить scroll (после пересчёта layout браузер мог его сбросить)
    requestAnimationFrame(() => {
      this.container.scrollLeft = savedScrollLeft;
      this.container.scrollTop = savedScrollTop;
    });
  }

  /** Подсчёт видимой ширины таблицы (с учётом скрытых колонок).
   *  Скрытые колонки не занимают место в layout.
   */
  _computeVisibleWidth() {
    let total = 0;
    this.columns.forEach((c, idx) => {
      if (!this._isColumnCollapsed(idx)) {
        total += c.width;
      }
    });
    return total;
  }

  /** Подсчёт ширины конкретной группы (с учётом скрытых колонок).
   *  Используется в _buildGroupedHeader и _renderFooter.
   */
  _computeGroupVisibleWidth(group) {
    if (!group) return 0;
    const start = group.startIdx ?? 0;
    const span = group.colspan ?? 0;
    const end = start + span;
    let w = 0;
    for (let i = start; i < end && i < this.columns.length; i++) {
      if (!this._isColumnCollapsed(i)) {
        w += this.columns[i].width;
      }
    }
    return w;
  }

  /** Подсчёт ЛЕВОГО смещения колонки (с учётом скрытых).
   *  Используется в _render для позиционирования видимых ячеек тела.
   */
  _computeLeftOffset(colIdx) {
    let off = 0;
    for (let i = 0; i < colIdx; i++) {
      if (!this._isColumnCollapsed(i)) {
        off += this.columns[i].width;
      }
    }
    return off;
  }

  /** Sticky для ячейки заголовка (sub-row) */
  _applyHeaderSticky(cell, colIdx) {
      const range = this._getFrozenRange();
      if (!range || colIdx < range.startIdx || colIdx > range.endIdx) return;
      const si = colIdx - range.startIdx;
      cell.classList.add('vt-sticky');
      cell.style.left = (this._stickyOffsets[si] || 0) + 'px';
      if (colIdx === range.endIdx) cell.classList.add('vt-sticky-edge');
  }

  /** Sticky для ячейки тела */
  _applyBodySticky(cell, colIdx) {
      const range = this._getFrozenRange();
      if (!range || colIdx < range.startIdx || colIdx > range.endIdx) return;
      const si = colIdx - range.startIdx;
      cell.classList.add('vt-sticky');
      cell.style.left = (this._stickyOffsets[si] || 0) + 'px';
      if (colIdx === range.endIdx) cell.classList.add('vt-sticky-edge');
  }

  /** ✅ НОВОЕ: Sticky для ячейки подвала (column-footer-row) */
  _applyFooterSticky(cell, colIdx) {
      const range = this._getFrozenRange();
      if (!range || colIdx < range.startIdx || colIdx > range.endIdx) return;
      const si = colIdx - range.startIdx;
      cell.classList.add('vt-sticky');
      cell.style.left = (this._stickyOffsets[si] || 0) + 'px';
      if (colIdx === range.endIdx) cell.classList.add('vt-sticky-edge');
  }

  /** ✅ НОВОЕ: Sticky для ячейки подвала группы (group-footer-row) */
  _applyFooterGroupSticky(cell, gIdx) {
      if (!this.freezeFirstGroup || gIdx !== 0) return;
      const range = this._getFrozenRange();
      if (!range) return;
      cell.classList.add('vt-sticky');
      cell.style.left = '0px';
      if (range.endIdx === this.columns.length - 1) {
        cell.classList.add('vt-sticky-edge');
      }
  }

  /** Обновить left у уже отрисованных sticky-ячеек (при ресайзе) */
  _updateStickyPositions() {
      const range = this._getFrozenRange();
      if (!range) return;

      // sub-row заголовка
      const subCells = this.header.querySelectorAll('.vtable-header-sub .vtable-cell');
      for (let i = range.startIdx; i <= range.endIdx && i < subCells.length; i++) {
          subCells[i].style.left = (this._stickyOffsets[i - range.startIdx] || 0) + 'px';
      }

      // тело
      this.body.querySelectorAll('.vtable-row').forEach(row => {
          const cells = row.querySelectorAll('.vtable-cell');
          for (let i = range.startIdx; i <= range.endIdx && i < cells.length; i++) {
              cells[i].style.left = (this._stickyOffsets[i - range.startIdx] || 0) + 'px';
          }
      });

      // ✅ НОВОЕ: подвал
      if (this.footer) {
          // ✅ ИЗМЕНЕНО: column-footer-row — поиск через data-colIdx,
          //   т.к. свёрнутые колонки не создают footer-ячеек и прямой
          //   индекс footerCells[i] не совпадёт с индексом колонки.
          //   frozen range — это только ПЕРВАЯ группа (base), она не сворачивается,
          //   поэтому все её footer-ячейки существуют. Но всё равно надёжнее
          //   идти через data-colIdx.
          const footerCells = this.footer.querySelectorAll('.vtable-footer-sub .vtable-footer-cell');
          footerCells.forEach(cell => {
              const colIdx = parseInt(cell.dataset.colIdx, 10);
              if (isNaN(colIdx)) return;
              if (colIdx < range.startIdx || colIdx > range.endIdx) return;
              const si = colIdx - range.startIdx;
              cell.style.left = (this._stickyOffsets[si] || 0) + 'px';
              if (colIdx === range.endIdx) cell.classList.add('vt-sticky-edge');
          });
          // simple-footer (без групп)
          const simpleCells = this.footer.querySelectorAll('.vtable-footer-simple .vtable-footer-cell');
          simpleCells.forEach(cell => {
              const colIdx = parseInt(cell.dataset.colIdx, 10);
              if (isNaN(colIdx)) return;
              if (colIdx < range.startIdx || colIdx > range.endIdx) return;
              const si = colIdx - range.startIdx;
              cell.style.left = (this._stickyOffsets[si] || 0) + 'px';
              if (colIdx === range.endIdx) cell.classList.add('vt-sticky-edge');
          });
      }
  }

  // ✅ Создание ячейки заголовка колонки (общий метод)
  _createHeaderCell(c, idx) {
    const cell = document.createElement('div');
    cell.className = 'vtable-cell';
    // ✅ НОВОЕ: сохраняем индекс колонки в dataset для корректного
    //   поиска ячейки после схлопывания групп (когда массив ячеек
    //   укорочен из-за пропущенных свёрнутых колонок)
    cell.dataset.colIdx = idx;
    cell.style.width = `${c.width}px`;
    cell.style.minWidth = `${c.width}px`;
    cell.style.position = 'relative';
    cell.style.boxSizing = 'border-box';

    const textSpan = document.createElement('span');
    textSpan.textContent = c.label;
    cell.appendChild(textSpan);

    // ✅ T103: тултип заголовка колонки — расшифровка короткого названия
    if (c.tip) cell.title = c.tip;

    // Ресайзер
    const resizer = document.createElement('div');
    resizer.className = 'col-resizer';
    resizer.dataset.index = idx;
    resizer.style.position = 'absolute';
    resizer.style.right = '0';
    resizer.style.top = '0';
    resizer.style.bottom = '0';
    resizer.style.width = '6px';
    resizer.style.cursor = 'col-resize';
    resizer.style.zIndex = '10';
    cell.appendChild(resizer);

    return cell;
  }

  // ============================================================
  // ✅ НОВОЕ: ПОДВАЛ
  // ============================================================

  /** Диспетчер построения подвала */
  _buildFooter() {
    if (this.hasGroups) {
      this._buildGroupedFooter();
    } else {
      this._buildSimpleFooter();
    }
  }

  /** Простой подвал (без групп) — одна строка агрегатов */
  _buildSimpleFooter() {
    this.footer = document.createElement('div');
    this.footer.className = 'vtable-footer-simple';
    if (!this._footerCfg.sticky) this.footer.classList.add('non-sticky');

    this.columns.forEach((c, idx) => {
      // ✅ НОВОЕ: пропускаем свёрнутые колонки в простом подвале
      if (this._isColumnCollapsed(idx)) return;
      const cell = this._createFooterCell(c, idx);
      this._applyFooterSticky(cell, idx);
      this.footer.appendChild(cell);
    });
  }

  /** Группированный подвал — две строки:
   *  1. vtable-footer-sub   — агрегаты по колонкам (ближе к данным)
   *  2. vtable-footer-group  — информация по группам (нижняя строка)
   *
   *  Если _hasColumnFooter=false — первая строка не рисуется.
   *  Если _hasGroupFooter=false — вторая строка не рисуется.
   */
  _buildGroupedFooter() {
    this.footer = document.createElement('div');
    this.footer.className = 'vtable-footer-grouped';
    if (!this._footerCfg.sticky) this.footer.classList.add('non-sticky');

    // 1. Строка агрегатов колонок
    if (this._hasColumnFooter) {
      const subRow = document.createElement('div');
      subRow.className = 'vtable-footer-sub';

      this.columns.forEach((c, idx) => {
        // ✅ НОВОЕ: пропускаем свёрнутые колонки в подвале колонок
        if (this._isColumnCollapsed(idx)) return;
        const cell = this._createFooterCell(c, idx);
        this._applyFooterSticky(cell, idx);
        subRow.appendChild(cell);
      });

      this.footer.appendChild(subRow);
    }

    // 2. Строка информации по группам
    if (this._hasGroupFooter) {
      const groupRow = document.createElement('div');
      groupRow.className = 'vtable-footer-group';

      this.groups.forEach((group, gIdx) => {
        const groupCell = document.createElement('div');
        groupCell.className = 'vtable-footer-group-cell ' +
                              (group.footer?.className || group.colorClass || 'firm');
        groupCell.dataset.groupIdx = gIdx;

        // ✅ ИЗМЕНЕНО: ширина группы с учётом свёрнутых колонок
        //   (используем _computeGroupVisibleWidth, как в header-group)
        const groupWidth = this._computeGroupVisibleWidth(group);
        groupCell.style.width = `${groupWidth}px`;
        groupCell.style.minWidth = `${groupWidth}px`;

        // Инлайн-стили из конфига
        if (group.footer?.style) {
          Object.assign(groupCell.style, group.footer.style);
        }

        this._applyFooterGroupSticky(groupCell, gIdx);
        groupRow.appendChild(groupCell);
      });

      this.footer.appendChild(groupRow);
    }
  }

  /** Создание ячейки подвала колонки (с пустым значением — заполнится в _renderFooter) */
  _createFooterCell(c, idx) {
    const cell = document.createElement('div');
    cell.className = 'vtable-footer-cell';
    cell.style.width = `${c.width}px`;
    cell.style.minWidth = `${c.width}px`;
    cell.style.position = 'relative';
    cell.style.boxSizing = 'border-box';
    cell.dataset.colIdx = idx;

    if (c.footer?.className) cell.classList.add(c.footer.className);
    if (c.footer?.style) Object.assign(cell.style, c.footer.style);

    // Маркер text-типа (выравнивание по левому краю, курсив)
    if (c.footer && c.footer.type === 'text') cell.classList.add('text');

    return cell;
  }

  /** Вычисление значения подвала колонки */
  _computeFooterValue(col) {
    const cfg = col.footer;
    if (!cfg) return '';
    const rows = this.data;
    const emptyText = cfg.emptyText ?? this._footerCfg.emptyText ?? '—';

    // Текстовый комментарий
    if (cfg.type === 'text') {
      if (typeof cfg.value === 'function') {
        try { return cfg.value(rows, col); } catch (e) { return emptyText; }
      }
      return cfg.value ?? '';
    }

    // Кастомный агрегат
    if (cfg.type === 'custom') {
      if (typeof cfg.value === 'function') {
        try { return cfg.value(rows, col); } catch (e) { return emptyText; }
      }
      if (typeof cfg.formatter === 'function') {
        try { return cfg.formatter(null, rows, col); } catch (e) { return emptyText; }
      }
      return emptyText;
    }

    // Нет данных — показываем emptyText
    if (!rows.length) return emptyText;

    // Собираем числовые значения
    const values = rows
      .map(r => r[col.key])
      .filter(v => v !== null && v !== undefined && v !== '' && !isNaN(Number(v)))
      .map(v => Number(v));

    if (!values.length) return emptyText;

    let result;
    switch (cfg.type) {
      case 'sum':     result = values.reduce((a, b) => a + b, 0); break;
      case 'avg':     result = values.reduce((a, b) => a + b, 0) / values.length; break;
      case 'count':   result = values.length; break;
      case 'min':     result = Math.min(...values); break;
      case 'max':     result = Math.max(...values); break;
      case 'median': {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        result = sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
        break;
      }
      default:
        return emptyText;
    }

    // Округление (для avg/median по умолчанию, но применяется ко всем)
    if (typeof cfg.decimals === 'number' && isFinite(result)) {
      result = Number(result.toFixed(cfg.decimals));
    }

    // Кастомный форматтер
    if (typeof cfg.formatter === 'function') {
      try { return cfg.formatter(result, rows, col); } catch (e) { return String(result); }
    }

    return String(result);
  }

  /** Вычисление значения подвала группы */
  _computeGroupFooterValue(group) {
    const cfg = group.footer;
    if (!cfg) return '';

    // Собираем строки этой группы (по диапазону колонок — на самом деле
    // строки не привязаны к группе, но передаём все данные; пользователь
    // может фильтровать сам в value-функции)
    const rows = this.data;

    if (typeof cfg.value === 'function') {
      try { return cfg.value(group, rows); } catch (e) { return ''; }
    }
    return cfg.value ?? '';
  }

  /** Перерисовка значений подвала (вызывается из setData после _render) */
  _renderFooter() {
    if (!this.hasFooter || !this.footer) return;

    // 1. Обновляем ячейки подвала колонок
    if (this._hasColumnFooter) {
      const cells = this.footer.querySelectorAll('.vtable-footer-sub .vtable-footer-cell, .vtable-footer-simple .vtable-footer-cell');
      cells.forEach(cell => {
        const idx = parseInt(cell.dataset.colIdx, 10);
        const col = this.columns[idx];
        if (!col || !col.footer) return;
        const val = this._computeFooterValue(col);
        cell.textContent = val;
        cell.title = val;
      });
    }

    // 2. Обновляем ячейки подвала групп
    if (this._hasGroupFooter) {
      const groupCells = this.footer.querySelectorAll('.vtable-footer-group-cell');
      groupCells.forEach(cell => {
        const gIdx = parseInt(cell.dataset.groupIdx, 10);
        const group = this.groups[gIdx];
        if (!group || !group.footer) return;
        const val = this._computeGroupFooterValue(group);
        cell.textContent = val;
        cell.title = val;
      });
    }
  }

  _initResizeEvents() {
    this.header.addEventListener('pointerdown', (e) => {
      if (!e.target.classList.contains('col-resizer')) return;
      e.preventDefault();
      e.stopPropagation();
      this._isResizing = true;
      this._currentColIdx = parseInt(e.target.dataset.index);
      this._startX = e.clientX;
      this._startWidth = this.columns[this._currentColIdx].width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      this._boundPointerMove = this._onPointerMove.bind(this);
      this._boundPointerUp = this._onPointerUp.bind(this);
      window.addEventListener('pointermove', this._boundPointerMove);
      window.addEventListener('pointerup', this._boundPointerUp);
    });
  }

  _onPointerMove(e) {
    if (!this._isResizing || this._currentColIdx === -1) return;
    const deltaX = e.clientX - this._startX;
    let newWidth = this._startWidth + deltaX;
    if (newWidth < 40) newWidth = 40;

    this.columns[this._currentColIdx].width = newWidth;

    // Обновляем ширину в подстроке (для группированного заголовка)
    // ✅ ИЗМЕНЕНО: используем querySelector с data-colIdx для надёжного
    //   поиска ячейки, т.к. свёрнутые колонки НЕ создают ячейки в sub-row
    //   и прямой индекс headerCells[idx] не совпадёт с позицией в DOM.
    let totalWidth = this._computeVisibleWidth();
    this.columns.forEach((c, idx) => {
      // ✅ НОВОЕ: ищем ячейку по data-colIdx, а не по индексу в массиве
      const headerCell = this.header.querySelector(`.vtable-cell[data-col-idx="${idx}"]`);
      if (headerCell) {
        headerCell.style.width = `${c.width}px`;
        headerCell.style.minWidth = `${c.width}px`;
      }
    });

    // ✅ Обновляем ширины групп (если есть)
    if (this.hasGroups) {
      const groupCells = this.header.querySelectorAll('.vtable-header-group-cell');
      this.groups.forEach((group, gIdx) => {
        // ✅ ИЗМЕНЕНО: ширина группы с учётом свёрнутых колонок
        const groupWidth = this._computeGroupVisibleWidth(group);
        if (groupCells[gIdx]) {
          groupCells[gIdx].style.width = `${groupWidth}px`;
          groupCells[gIdx].style.minWidth = `${groupWidth}px`;
        }
      });
    }

    // ✅ НОВОЕ: Обновляем ширины ячеек подвала
    if (this.footer) {
      // ✅ ИЗМЕНЕНО: используем data-colIdx для индексации, т.к.
      //   свёрнутые колонки НЕ создают footer-ячейки (пропускаются в _buildFooter),
      //   и прямой индекс footerCells[idx] не совпадёт с реальной позицией.
      const footerCells = this.footer.querySelectorAll('.vtable-footer-cell');
      footerCells.forEach(cell => {
        const idx = parseInt(cell.dataset.colIdx, 10);
        if (isNaN(idx)) return;
        const c = this.columns[idx];
        if (!c) return;
        cell.style.width = `${c.width}px`;
        cell.style.minWidth = `${c.width}px`;
      });

      // ✅ ИЗМЕНЕНО: Группы в подвале — используем _computeGroupVisibleWidth
      //   для учёта свёрнутых колонок
      const footerGroupCells = this.footer.querySelectorAll('.vtable-footer-group-cell');
      this.groups.forEach((group, gIdx) => {
        const groupWidth = this._computeGroupVisibleWidth(group);
        if (footerGroupCells[gIdx]) {
          footerGroupCells[gIdx].style.width = `${groupWidth}px`;
          footerGroupCells[gIdx].style.minWidth = `${groupWidth}px`;
        }
      });
    }

    this._updateTableWidth(totalWidth);

    if (this.freezeFirstGroup) {          // ✅ ДОБАВИТЬ
      this._calcStickyOffsets();
      this._updateStickyPositions();
    }

    this._render();
  }

  _onPointerUp() {
    if (!this._isResizing) return;
    this._isResizing = false;
    this._currentColIdx = -1;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', this._boundPointerMove);
    window.removeEventListener('pointerup', this._boundPointerUp);
  }

  _updateTableWidth(totalWidth) {
    this.table.style.width = `${totalWidth}px`;
    this.header.style.width = `${totalWidth}px`;
    this.body.style.width = `${totalWidth}px`;
    if (this.footer) this.footer.style.width = `${totalWidth}px`;
  }

  _bindScroll() {
    this.container.addEventListener('scroll', () => this._render());
  }

  async setData(data) {
    this.data = data || [];
    this.body.style.height = (this.data.length * this.rowHeight) + 'px';
    return new Promise(resolve => {
      this._pendingRenderResolve = resolve;
      requestAnimationFrame(() => {
        if (this._pendingRenderResolve) {
          this._render();
          // ✅ НОВОЕ: пересчёт подвала (агрегаты по свежим данным)
          this._renderFooter();
          // Это гарантирует, что await setData() завершится
          // только после обновления формы
          this._autoRefreshForm();// АВТООБНОВЛЕНИЕ ФОРМЫ
          this._pendingRenderResolve();
          this._pendingRenderResolve = null;
        }

      });
    });
  }

  // ===== СЕЛЕКЦИЯ =====
  clearSelection() {
    this.selectedId = null;
    this.selectedIds.clear();
    this.lastSelectedId = null;
    this.body.querySelectorAll('.vtable-row.selected')
      .forEach(r => r.classList.remove('selected'));
    if (this.onSelectionChange) this.onSelectionChange([]);
  }

  selectById(id) {
    if (this.multiSelect) {
      this.selectedIds.add(id);
      this.lastSelectedId = id;
    } else {
      this.selectedId = id;
    }
    this._render();
    this._scrollToId(id);
  }

  _scrollToId(id) {
    const row = this.body.querySelector(`.vtable-row[data-id="${id}"]`);
    if (!row) return;
    const rowTop = parseInt(row.style.top);
    const containerHeight = this.container.clientHeight;
    const scrollTop = this.container.scrollTop;
    if (rowTop < scrollTop || rowTop > scrollTop + containerHeight - this.rowHeight) {
      this.container.scrollTop = rowTop - containerHeight / 2;
    }
  }

  // ============================================================
  // ✅ НОВОЕ: scrollToGroup — горизонтальный скролл к группе колонок.
  // ------------------------------------------------------------
  //   groupIdx      — индекс в this.groups (0-based)
  //   options.align — 'start' (по умолчанию) | 'center' | 'end'
  //
  // ВАЖНО: при freezeFirstGroup=true первая группа (Деталь) закреплена
  // слева и занимает frozenWidth px viewport. Эти px — «мёртвая зона»
  // для прокручиваемых колонок. Поэтому:
  //
  //   • align='start' (по умолчанию):
  //       Левая граница группы = правая граница закреплённой группы.
  //       Формула: scrollLeft = groupLeft - frozenWidth
  //       (groupLeft — смещение группы от начала таблицы;
  //        frozenWidth — ширина закреплённой группы)
  //       Это самый наглядный режим: выбранная фирма оказывается
  //       сразу после закреплённой группы «Деталь».
  //
  //   • align='center':
  //       Центр группы в центре доступной (незакреплённой) области.
  //       Формула: scrollLeft = groupLeft + groupWidth/2
  //                          - (viewWidth - frozenWidth)/2 - frozenWidth
  //
  //   • align='end':
  //       Правая граница группы = правая граница viewport.
  //
  // Если freezeFirstGroup=true и groupIdx=0 — ничего не делаем
  // (первая группа и так закреплена слева).
  // ============================================================
  scrollToGroup(groupIdx, options = {}) {
    if (!this.hasGroups || !Array.isArray(this.groups)) return;
    if (groupIdx < 0 || groupIdx >= this.groups.length) return;

    const align = options.align || 'start';

    // Если первая группа закреплена и просят её — она и так видна
    if (this.freezeFirstGroup && groupIdx === 0) {
      this.container.scrollLeft = 0;
      return;
    }

    const group = this.groups[groupIdx];
    const startIdx = group.startIdx ?? 0;
    const colspan = group.colspan ?? 0;
    if (colspan <= 0) return;
    if (startIdx >= this.columns.length) return;

    // ✅ T28-ФИКС: все смещения считаем ТОЛЬКО по ВИДИМЫМ колонкам.
    // ------------------------------------------------------------
    // Свёрнутая группа схлопывается до последних N колонок
    // (collapsibleKeepLastN, по умолчанию 1), остальные её колонки
    // скрыты и НЕ занимают места в layout: тело рисуется через
    // _computeLeftOffset, шапка групп — через _computeGroupVisibleWidth,
    // общая ширина — через _computeVisibleWidth (все visible-aware).
    // Прежний код суммировал ширины ВСЕХ колонок подряд, поэтому при
    // наличии свёрнутых групп (кнопка [+/−] или чекбокс «Свернуть все
    // группы») groupLeft завышался на ширину скрытых колонок групп,
    // стоящих левее целевой, и scrollLeft промахивался: при выборе
    // фирмы в #fltFirma её группа вставала не у правого края
    // закреплённой области, а дальше вправо (или обрезалась по
    // maxScroll). Теперь используем те же хелперы, что и раскладка.
    // Без свёрнутых групп _isColumnCollapsed() всегда false и суммы
    // совпадают с прежними — поведение не меняется.

    // groupLeft = смещение от начала таблицы до левого края группы.
    // Для СВЁРНУТОЙ целевой группы это одновременно левый край её
    // видимого «хвоста» (скрытые колонки дают нулевой вклад).
    const groupLeft = this._computeLeftOffset(startIdx);

    // groupWidth = ВИДИМАЯ ширина самой группы
    // (свёрнутая группа — только последние N колонок)
    const groupWidth = this._computeGroupVisibleWidth(group);

    // ✅ frozenWidth — ВИДИМАЯ ширина закреплённой группы (если есть).
    // Это «мёртвая зона» в левой части viewport, занятая sticky-колонками.
    // Видимая область для прокручиваемых колонок = viewWidth - frozenWidth.
    // (Закреплённая группа «Деталь» не входит в collapsibleColorClasses,
    //  но считаем через visible-хелпер для устойчивости к будущим
    //  изменениям конфигурации.)
    let frozenWidth = 0;
    if (this.freezeFirstGroup && this.groups.length > 0) {
      frozenWidth = this._computeGroupVisibleWidth(this.groups[0]);
    }

    const viewWidth = this.container.clientWidth;
    let targetScrollLeft;

    if (align === 'end') {
      // ПРАВАЯ граница группы = ПРАВАЯ граница viewport
      targetScrollLeft = groupLeft + groupWidth - viewWidth;
    } else if (align === 'center') {
      // Центр группы в центре доступной (незакреплённой) области
      const effectiveViewWidth = viewWidth - frozenWidth;
      targetScrollLeft = groupLeft + groupWidth / 2
                       - effectiveViewWidth / 2
                       - frozenWidth;
    } else {
      // align === 'start' (по умолчанию)
      // ЛЕВАЯ граница группы = ПРАВАЯ граница закреплённой группы.
      // В viewport-координатах: groupLeft - scrollLeft = frozenWidth
      // → scrollLeft = groupLeft - frozenWidth
      targetScrollLeft = groupLeft - frozenWidth;
    }

    // Не выходим за пределы
    const maxScroll = Math.max(0, this.table.offsetWidth - viewWidth);
    targetScrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScroll));

    this.container.scrollLeft = Math.round(targetScrollLeft);
    // _render вызовется автоматически по событию scroll
  }

  // ============================================================
  // ✅ НОВОЕ: scrollToGroupByPredicate — найти группу по условию
  // и проскроллить к ней. Удобно для поиска по name или colorClass.
  // ------------------------------------------------------------
  //   predicate — функция (group, idx) => boolean
  //   options.align — 'start' (по умолчанию) | 'center' | 'end'
  // Возвращает true, если группа найдена и скролл выполнен.
  // ============================================================
  scrollToGroupByPredicate(predicate, options = {}) {
    if (!this.hasGroups || !Array.isArray(this.groups)) return false;
    if (typeof predicate !== 'function') return false;
    const idx = this.groups.findIndex((g, i) => {
      try { return predicate(g, i); } catch (e) { return false; }
    });
    if (idx < 0) return false;
    this.scrollToGroup(idx, options);
    return true;
  }

  getSelectedIds() {
    return this.multiSelect
      ? Array.from(this.selectedIds)
      : (this.selectedId ? [this.selectedId] : []);
  }

  getSelectedCount() {
    return this.multiSelect ? this.selectedIds.size : (this.selectedId ? 1 : 0);
  }

  isSelected(id) {
    return this.multiSelect ? this.selectedIds.has(id) : this.selectedId === id;
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  async _handleRowClick(item, e) {
    const id = item[this.idKey];

        // Если это ДРУГАЯ запись (не текущая) — проверяем DirtyGuard
    if (this.onBeforeSelect && this.selectedId && this.selectedId !== id) {
        const canProceed = await this.onBeforeSelect();
        if (!canProceed) return;  // пользователь отменил
    }

    if (this.multiSelect) {
      if (e.ctrlKey || e.metaKey) {
        if (this.selectedIds.has(id)) this.selectedIds.delete(id);
        else this.selectedIds.add(id);
        this.lastSelectedId = id;
      } else if (e.shiftKey && this.lastSelectedId !== null) {
        const startIdx = this.data.findIndex(d => d[this.idKey] === this.lastSelectedId);
        const endIdx = this.data.findIndex(d => d[this.idKey] === id);
        if (startIdx >= 0 && endIdx >= 0) {
          const from = Math.min(startIdx, endIdx);
          const to = Math.max(startIdx, endIdx);
          for (let i = from; i <= to; i++) {
            this.selectedIds.add(this.data[i][this.idKey]);
          }
        }
      } else {
        this.selectedIds.clear();
        this.selectedIds.add(id);
        this.lastSelectedId = id;
        this.onSelect(item);
      }
      if (this.onSelectionChange) {
        this.onSelectionChange(Array.from(this.selectedIds));
      }
    } else {
      this.selectedId = id;
      this.body.querySelectorAll('.vtable-row.selected')
        .forEach(r => r.classList.remove('selected'));
      this.onSelect(item);
    }
    this._render();
  }

  /**  АВТООБНОВЛЕНИЕ ФОРМЫ
   * Автоматически перезаполняет форму данными выбранной строки
   * после обновления данных таблицы (setData).
   * `_autoRefreshForm()` синхронизирует форму
   * с актуальной строкой, вызывая onSelect() для текущего selectedId.
   *
   * Защита от потери данных:
   * - Если пользователь РЕДАКТИРУЕТ запись (EditLock) — НЕ обновлять
   * - Если autoRefreshForm === false — пропустить
   * - Если выбранная строка удалена — сбросить выбор + onHeaderClick
   *
   * Вызывается ТОЛЬКО из setData(), после _render().
   */
  _autoRefreshForm() {
      try {
          // 1. Явное отключение (multiSelect таблицы, спец. случаи)
          if (this.autoRefreshForm === false) return;

          // 2. Нет выбранной строки — нечего обновлять
          if (!this.selectedId) return;

          // 3. Нет callback заполнения формы
          if (!this.onSelect) return;

            // ✅ ИСПРАВЛЕНО: Проверка 2 — форма "грязная" (прямой импорт DirtyGuard)
            // Если пользователь ввёл данные, но ещё не сохранил → НЕ перезаписывать форму
            if (DirtyGuard._isDirty && DirtyGuard._isDirty()) {
                 toast(` 🛡 Автообновление пропущено для текущего выбора`);
                return;
            }
          // 5. Ищем обновлённую строку в данных
          const updatedRow = this.data.find(d => d[this.idKey] === this.selectedId);

          if (updatedRow) {
              // Строка существует — перезаполняем форму актуальными данными
              // ✅ T21-FIX: без тоста «🔄 Автообновление…» — он срабатывал на КАЖДОЙ
              // перезагрузке данных (WS/сохранение) и затирал реальные сообщения
              // («Шаг N сохранён», ошибки сервера); пользователь не видел результат
              this.onSelect(updatedRow);
          } else {
              // Строка УДАЛЕНА другим клиентом — сбрасываем выбор
              toast(` ⚠️ Выбранная строка удалена — сброс выбора`);
              this.clearSelection();
              if (this.onHeaderClick) this.onHeaderClick();
          }
      } catch (e) {
          console.warn('[VirtualTable._autoRefreshForm] Ошибка:', e.message);
      }
  }

  // ===== РЕНДЕР =====
  _render() {
    const scrollTop = this.container.scrollTop;
    // ✅ НОВОЕ: учитываем высоту подвала при расчёте видимой области
    const footerH = this.footer ? this.footer.offsetHeight : 0;
    const viewH = this.container.clientHeight - this.header.offsetHeight - footerH;
    if (viewH <= 0) return;

    const startIdx = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.buffer);
    const endIdx = Math.min(
      this.data.length,
      Math.ceil((scrollTop + viewH) / this.rowHeight) + this.buffer
    );

    this.body.innerHTML = '';

    if (startIdx > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'vtable-spacer';
      spacer.style.height = (startIdx * this.rowHeight) + 'px';
      this.body.appendChild(spacer);
    }

    for (let i = startIdx; i < endIdx; i++) {
      const item = this.data[i];
      if (!item) continue;

      const id = item[this.idKey];
      const row = document.createElement('div');
      row.className = 'vtable-row';
      row.style.display = 'flex';
      row.style.position = 'absolute';
      row.style.left = '0';
      row.style.top = (i * this.rowHeight) + 'px';
      row.style.height = this.rowHeight + 'px';
      row.dataset.id = id;

      // ✅ НОВОЕ: Добавляем CSS-класс строки
      if (this.rowClassName && typeof this.rowClassName === 'function') {
        const extraClass = this.rowClassName(item);
        if (extraClass) row.classList.add(extraClass);
      }

      if (this.isSelected(id)) row.classList.add('selected');

      this.columns.forEach((c, colIdx) => {
        // ✅ НОВОЕ: пропускаем свёрнутые колонки (не рендерим их)
        if (this._isColumnCollapsed(colIdx)) return;

        const cell = document.createElement('div');
        cell.className = 'vtable-cell';
        cell.style.width = `${c.width}px`;
        cell.style.minWidth = `${c.width}px`;
        cell.style.boxSizing = 'border-box';

        // ✅ НОВОЕ: Поддержка formatter
        let value = item[c.key];
        if (c.formatter && typeof c.formatter === 'function') {
          const formatted = c.formatter(value, item);
          if (typeof formatted === 'object' && formatted !== null) {
            value = formatted.text || '';
            if (formatted.style) Object.assign(cell.style, formatted.style);
            if (formatted.className) cell.classList.add(formatted.className);
          } else {
            value = formatted;
          }
        }

        cell.textContent = value == null ? '' : value;
        // t67: тултип колонки (c.tooltip) — полное значение при наведении
        // (ячейка обрезается CSS: nowrap + ellipsis)
        if (c.tooltip) cell.title = value == null ? '' : String(value);
        this._applyBodySticky(cell, colIdx);
        row.appendChild(cell);
      });

        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this._handleRowClick(item, e);

        });
        // ===== НОВОЕ: Двойной клик по строке =====
        if (this.onDblClick) {
          row.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.onDblClick(item);
          });
        }
      // Индикатор блокировки
      if (this.getLockInfo) {
          const locker = this.getLockInfo(item);
          if (locker) {
              row.classList.add('locked');
              row.title = `🔒 Редактирует: ${locker}`;

              const firstCell = row.querySelector('.vtable-cell');
              if (firstCell) {
                  // ✅ УЛУЧШЕНО: бейдж с именем пользователя
                  const badge = document.createElement('span');
                  badge.className = 'lock-badge-inline';
                  badge.innerHTML = `🔒 ${this.escapeHtml(locker)}`;
                  badge.title = `Редактирует: ${locker}`;
                  firstCell.insertBefore(badge, firstCell.firstChild);
              }
          }
      }

      // ✅ НОВОЕ: обобщённый механизм подсветки строк (getRowHighlights)
      //   Позволяет модулю указать набор подсветок для строки:
      //   { className, icon, title, badgeText? }
      //   className → добавляется к vtable-row
      //   icon + badgeText → бейдж в первой ячейке (.row-badge-inline.<className>-badge)
      //   title → всплывающая подсказка на строке
      if (this.getRowHighlights) {
          try {
              const highlights = this.getRowHighlights(item);
              if (Array.isArray(highlights) && highlights.length > 0) {
                  const titles = [];
                  for (const h of highlights) {
                      if (!h || !h.className) continue;
                      row.classList.add(h.className);
                      if (h.title) titles.push(h.title);
                      if (h.icon) {
                          const firstCell = row.querySelector('.vtable-cell');
                          if (firstCell) {
                              const badge = document.createElement('span');
                              badge.className = `row-badge-inline ${h.className}-badge`;
                              const txt = h.badgeText ? ` ${this.escapeHtml(h.badgeText)}` : '';
                              badge.innerHTML = `${h.icon}${txt}`;
                              if (h.title) badge.title = h.title;
                              firstCell.insertBefore(badge, firstCell.firstChild);
                          }
                      }
                  }
                  // Не перетираем title от lockInfo
                  if (titles.length > 0 && !row.title) {
                      row.title = titles.join(' | ');
                  }
              }
          } catch (e) {
              console.warn('[VirtualTable.getRowHighlights] error:', e.message);
          }
      }

      this.body.appendChild(row);
    }

    const bottomH = (this.data.length - endIdx) * this.rowHeight;
    if (bottomH > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'vtable-spacer';
      spacer.style.height = bottomH + 'px';
      this.body.appendChild(spacer);
    }
  }

  refresh() {
    requestAnimationFrame(() => {
      this._render();
      this._renderFooter();
    });
  }

  destroy() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }
}