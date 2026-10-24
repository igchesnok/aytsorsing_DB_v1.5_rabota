// ============================================================
// public/js/common/dual-list-block.js
// БЛОК "ДВЕ ТАБЛИЦЫ + КНОПКИ ПЕРЕМЕЩЕНИЯ"
// ============================================================
import { VirtualTable } from './virtual-table.js';
import { FilterableTable } from './filterable-table.js';
import { toast } from './utils.js';

export class DualListBlock {
  constructor(cfg) {
    this.cfg = cfg;
    this.key = cfg.key;
    this.label = cfg.label || cfg.key;

    this.selectedIdKey = cfg.selectedIdKey || 'id';
    this.availableIdKey = cfg.availableIdKey || 'id';

    this._loadSelected = cfg.loadSelected;
    this._loadAvailable = cfg.loadAvailable;            // legacy-путь (если availableApiUrl не задан)
    this._postProcessSelected = cfg.postProcessSelected || null;
    this._postProcessAvailable = cfg.postProcessAvailable || null;
    this._onChange = cfg.onChange || null;
    this._customHandlers = cfg.customHandlers || {};

    // ✅ T54: хуки валидации перемещений (вызываются ПЕРЕД изменением
    //    таблиц; возвращают текст ошибки или null/undefined):
    //      validateMoveToSelected(newRows, currentRows)  — перед добавлением
    //      validateMoveToAvailable(removedRows, currentRows) — перед удалением
    //    Дубликаты № чертежа в запросе и позиции с назначенным лучшим КП
    //    блокируются на этом уровне (см. requests.js).
    this._validateMoveToSelected = cfg.validateMoveToSelected || null;
    this._validateMoveToAvailable = cfg.validateMoveToAvailable || null;

    this._masterId = null;
    this._initialSnapshot = new Set();
    // ✅ НЕСОХРАНЁННЫЕ УДАЛЕНИЯ: строки, убранные из левого списка кнопкой,
    // но ещё не сохранённые на сервере (id → row). Сервер их не отдаёт
    // (в БД они ещё числятся за записью), поэтому после КАЖДОЙ серверной
    // перезагрузки available возвращаем их сами. Очищается при load/commit/revert.
    this._removedUnsaved = new Map();
    this._dirty = false;
    this._locked = false;
    this._onSelectionChange = null;

    // ✅ НОВОЕ: сохраняем колбэки для FilterableTable-режима available
    this._getAvailableFilters = cfg.getAvailableFilters || null;
    this._getAvailableRawFilters = cfg.getAvailableRawFilters || null;

    this.selectedTable = this._createTable(cfg.selectedContainerId, cfg.selectedColumns, this.selectedIdKey);

    // ✅ НОВОЕ: available-таблица может быть FilterableTable (если задан availableApiUrl)
    this.availableTable = this._createAvailableTable();

    // ✅ АВТОМАТИЧЕСКИЙ ПОИСК КОНТЕЙНЕРА: ближайший общий родитель двух таблиц
    this._containerEl = this._computeBlockContainer(
      document.getElementById(cfg.selectedContainerId),
      document.getElementById(cfg.availableContainerId)
    );

    this._moveButtons = cfg.moveButtons || [];
    this._bindButtons(this._moveButtons);
    this._bindCustomButtons(cfg.customButtons || []);
  }

  // --- ПУБЛИЧНОЕ СОСТОЯНИЕ ---
  get value() { return this.selectedTable?.data || []; }
  get dirty() { return this._dirty; }
  get locked() { return this._locked; }

  // --- ВЫЧИСЛЕНИЕ КОНТЕЙНЕРА ДЛЯ ПОДСВЕТКИ ---
  _computeBlockContainer(selEl, availEl) {
    if (!selEl || !availEl) return null;
    let node = selEl.parentElement;
    while (node && node !== document.body) {
      if (node.contains(availEl)) return node;
      node = node.parentElement;
    }
    return null;
  }

  // --- СОЗДАНИЕ ТАБЛИЦЫ ---
  _createTable(containerId, columns, idKey) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.warn(`[DualListBlock:${this.label}] Контейнер #${containerId} не найден`);
      return null;
    }
    return new VirtualTable(container, columns, {
      idKey,
      multiSelect: true,
      autoRefreshForm: false,
      onSelectionChange: () => {
        this._updateButtonsState();
        if (this._onSelectionChange) this._onSelectionChange();
      }
    });
  }

  // ✅ НОВОЕ: создание available-таблицы — FilterableTable если задан apiUrl,
  //    иначе обычный VirtualTable (legacy для блоков с ручным loadAvailable callback)
  _createAvailableTable() {
    const containerId = this.cfg.availableContainerId;
    const container = document.getElementById(containerId);
    if (!container) {
      console.warn(`[DualListBlock:${this.label}] Контейнер #${containerId} не найден`);
      return null;
    }

    // Если задан availableApiUrl — создаём FilterableTable с серверной фильтрацией
    if (this.cfg.availableApiUrl) {
      return new FilterableTable(container, this.cfg.availableColumns, {
        idKey: this.availableIdKey,
        multiSelect: true,
        autoRefreshForm: false,
        apiUrl: this.cfg.availableApiUrl,
        filterFields: this.cfg.availableFilterFields || {},
        debounceMs: this.cfg.debounceMs || 300,
        postProcess: this._postProcessAvailable,
        onSelectionChange: () => {
          this._updateButtonsState();
          if (this._onSelectionChange) this._onSelectionChange();
        }
      });
    }

    // Иначе — обычный VirtualTable (старый путь: данные грузятся через _loadAvailable)
    return new VirtualTable(container, this.cfg.availableColumns, {
      idKey: this.availableIdKey,
      multiSelect: true,
      autoRefreshForm: false,
      onSelectionChange: () => {
        this._updateButtonsState();
        if (this._onSelectionChange) this._onSelectionChange();
      }
    });
  }

  setCustomButtons(states) {
    if (!this.cfg.customButtons) return;
    let anyVisible = false;
    this.cfg.customButtons.forEach(btnConfig => {
        const btn = document.getElementById(btnConfig.id);
        if (!btn) return;
        const state = states[btnConfig.id];
        if (!state) return;
        if (state.visible !== undefined) {
            btn.style.display = state.visible ? '' : 'none';
            if (state.visible) anyVisible = true;
        }
        if (state.disabled !== undefined) btn.disabled = state.disabled;
        if (state.text !== undefined) btn.textContent = state.text;
    });
    const selectionContainer = document.querySelector(`.${this.cfg.key}-selection-container`);
    if (selectionContainer) {
        selectionContainer.style.display = anyVisible ? 'flex' : 'none';
    }
  }

  // --- ПРИВЯЗКА КНОПОК ---
  _bindButtons(buttons) {
    for (const btn of buttons) {
      const el = document.getElementById(btn.id);
      if (!el) continue;
      switch (btn.action) {
        case 'moveToSelected':   el.onclick = () => this.moveToSelected(); break;
        case 'moveToAvailable':  el.onclick = () => this.moveToAvailable(); break;
        case 'selectAll':        el.onclick = () => this.selectAll(); break;
        case 'clearSelections':  el.onclick = () => this.clearSelections(); break;
      }
    }
  }

  _bindCustomButtons(buttons) {
    for (const btn of buttons) {
      const el = document.getElementById(btn.id);
      if (!el) continue;
      if (btn.action === 'custom' && btn.handler) {
        const handler = this._customHandlers[btn.handler];
        if (handler) el.onclick = () => handler(this);
      }
    }
  }

  // --- ЗАГРУЗКА ДАННЫХ ---
  async load(masterId) {
    this._masterId = masterId;
    this._removedUnsaved = new Map(); // ✅ новая запись — несохранённой дельты нет
    if (masterId && this._loadSelected) {
      try {
        let data = await this._loadSelected(masterId, this);
        if (this._postProcessSelected) data = await this._postProcessSelected(data, this);
        this.selectedTable.setData(data || []);
      } catch (e) {
        console.error(`[DualListBlock:${this.label}] Ошибка загрузки selected:`, e);
        this.selectedTable.setData([]);
      }
    } else {
      this.selectedTable.setData([]);
    }
    await this._reloadAvailable();
    this._takeSnapshot();
    this._updateButtonsState();
    this._emitChange();
  }

  async reloadAvailable() { await this._reloadAvailable(); }

  // ✅ НОВОЕ: публичный метод для applyFilters извне (debounce + rawDbFilters).
  //    Используется модулем Requests когда radio scope=available/both —
  //    чтобы фильтры уходили в available-таблицу, а не в zapros table.
  async applyAvailableFilters() {
    if (!(this.availableTable instanceof FilterableTable)) {
      // legacy-путь — просто перезагружаем вручную
      await this._reloadAvailable();
      return;
    }
    const filters = this._getAvailableFilters ? this._getAvailableFilters() : {};
    const selectedIds = this.selectedTable.data.map(row => row[this.selectedIdKey]);
    const rawDbFilters = this._getAvailableRawFilters ? this._getAvailableRawFilters(selectedIds) : {};
    this.availableTable.applyFilters(filters, rawDbFilters);
  }

  async _reloadAvailable() {
    // ✅ НОВОЕ: если availableTable — FilterableTable, идём серверным путём
    //    с loadImmediate (сбрасываем debounce, AbortController внутри сам отменит
    //    предыдущий запрос). postProcess применяется внутри FilterableTable.load().
    if (this.availableTable instanceof FilterableTable) {
      try {
        const filters = this._getAvailableFilters ? this._getAvailableFilters() : {};
        const selectedIds = this.selectedTable.data.map(row => row[this.selectedIdKey]);
        const rawDbFilters = this._getAvailableRawFilters ? this._getAvailableRawFilters(selectedIds) : {};
        await this.availableTable.loadImmediate(filters, rawDbFilters);
        // ✅ После серверного ответа возвращаем несохранённые удаления —
        //    сервер о них не знает и эти строки в available не отдаёт
        this._applyUnsavedDeltaToAvailable();
      } catch (e) {
        console.error(`[DualListBlock:${this.label}] Ошибка загрузки available (FilterableTable):`, e);
        this.availableTable.setData([]);
      } finally {
        this._updateButtonsState();
      }
      return;
    }

    // legacy-путь: обычный VirtualTable + ручной loadAvailable callback
    if (!this._loadAvailable) return;
    try {
      const selectedIds = this.selectedTable.data.map(row => row[this.selectedIdKey]);
      let data = await this._loadAvailable(this._masterId, selectedIds, this);
      if (this._postProcessAvailable) data = await this._postProcessAvailable(data, this);
      this.availableTable.setData(data || []);
      this._applyUnsavedDeltaToAvailable();
      this._updateButtonsState();
    } catch (e) {
      console.error(`[DualListBlock:${this.label}] Ошибка загрузки available:`, e);
      this.availableTable.setData([]);
      this._updateButtonsState();
    }
  }

  // ✅ ВОССТАНОВЛЕНИЕ НЕСОХРАНЁННОЙ ДЕЛЬТЫ после серверной перезагрузки available:
  //    строки, убранные из левого списка кнопкой, но ещё не сохранённые.
  //    Сервер их не отдаёт (в БД они ещё числятся за записью), поэтому
  //    добавляем их в available сами — иначе несохранённые изменения «исчезают»
  //    при любой перезагрузке (печать фильтра, смена области фильтра).
  _applyUnsavedDeltaToAvailable() {
    if (!this.availableTable || this._removedUnsaved.size === 0) return;
    const currentIds = new Set(this.availableTable.data.map(r => String(r[this.availableIdKey])));
    const rowsToAdd = [];
    for (const [id, row] of this._removedUnsaved) {
      // строка не пришла с сервера и не находится сейчас в левом списке
      const backInSelected = this.selectedTable.data.some(r => String(r[this.selectedIdKey]) === id);
      if (!currentIds.has(id) && !backInSelected) rowsToAdd.push(row);
    }
    if (rowsToAdd.length > 0) {
      this.availableTable.setData([...this.availableTable.data, ...rowsToAdd]);
    }
  }

  // --- ДЕЙСТВИЯ ПЕРЕМЕЩЕНИЯ ---
  // ✅ ПЕРЕМЕЩЕНИЕ — ТОЛЬКО ЛОКАЛЬНАЯ ОПЕРАЦИЯ, БЕЗ СЕРВЕРА.
  // Запись не может существовать в двух таблицах: добавили слева — убрали
  // справа, и наоборот. Серверную перезагрузку здесь делать НЕЛЬЗЯ:
  // несохранённые изменения серверу неизвестны (добавленная позиция ещё не
  // в БД, удалённая всё ещё в БД), и его ответ затирает результат.
  // Серверная перезагрузка происходит при load()/applyAvailableFilters() —
  // а локальная дельта восстанавливается в _applyUnsavedDeltaToAvailable().
  moveToSelected() {
    if (this._locked) { toast('Состав заблокирован', 'warning'); return; }
    const ids = this.availableTable.getSelectedIds();
    if (ids.length === 0) { toast('Выберите позиции для добавления', 'warning'); return; }

    const newRows = ids.map(id => this.availableTable.data.find(r => r[this.availableIdKey] === id)).filter(Boolean);
    const current = this.selectedTable.data;
    const currentIds = new Set(current.map(r => r[this.selectedIdKey]));
    const uniqueNewRows = newRows.filter(r => !currentIds.has(r[this.selectedIdKey]));

    // ✅ T54: валидация ДО изменения левого списка (дубликаты № чертежа)
    if (typeof this._validateMoveToSelected === 'function') {
      const err = this._validateMoveToSelected(uniqueNewRows, current);
      if (err) { toast(err, 'warning'); return; }
    }

    this.selectedTable.setData([...current, ...uniqueNewRows]);

    // Локально убираем перемещённые записи из available (без запроса к серверу)
    this.availableTable.clearSelection();
    if (uniqueNewRows.length > 0) {
      const movedIds = new Set(uniqueNewRows.map(r => String(r[this.availableIdKey])));
      this.availableTable.setData(
        this.availableTable.data.filter(r => !movedIds.has(String(r[this.availableIdKey])))
      );
      // Если запись раньше была «несохранённо удалена», а теперь вернулась
      // в левый список — она больше не числится в дельте удалений
      uniqueNewRows.forEach(r => this._removedUnsaved.delete(String(r[this.availableIdKey])));
    }

    this._recalcDirty();
    this._updateButtonsState();
    this._emitChange();
  }

  moveToAvailable() {
    if (this._locked) { toast('Состав заблокирован', 'warning'); return; }
    const ids = this.selectedTable.getSelectedIds();
    if (ids.length === 0) { toast('Выберите позиции для удаления', 'warning'); return; }

    // 1. ЗАПОМИНАЕМ удаляемые строки ДО изменения selectedTable
    const removedRows = this.selectedTable.data.filter(r => ids.includes(r[this.selectedIdKey]));

    // ✅ T54: валидация ДО удаления (позиции с назначенным лучшим КП
    //    удалять нельзя — только до назначения лучшего предложения)
    if (typeof this._validateMoveToAvailable === 'function') {
      const err = this._validateMoveToAvailable(removedRows, this.selectedTable.data);
      if (err) { toast(err, 'warning'); return; }
    }

    // 2. Обновляем selectedTable локально
    const remaining = this.selectedTable.data.filter(r => !ids.includes(r[this.selectedIdKey]));
    this.selectedTable.setData(remaining);
    this.selectedTable.clearSelection();

    // 3. Локально возвращаем удалённые строки в available (без запроса к серверу).
    // Запоминаем их в _removedUnsaved — сервер при перезагрузке их не отдаст
    // (в БД они ещё числятся за записью), вернём после каждой перезагрузки.
    // В дельту попадают только строки из снимка (сохранённые): несохранённо
    // добавленная и тут же удалённая строка серверу неизвестна — он её сам вернёт.
    if (removedRows.length > 0 && this.availableTable) {
      const currentAvailableIds = new Set(this.availableTable.data.map(r => String(r[this.availableIdKey])));
      const rowsToAdd = removedRows.filter(removedRow => {
        const removedId = String(removedRow[this.selectedIdKey]);
        return !currentAvailableIds.has(removedId);
      });
      if (rowsToAdd.length > 0) {
        this.availableTable.setData([...this.availableTable.data, ...rowsToAdd]);
      }
      removedRows.forEach(removedRow => {
        const removedId = String(removedRow[this.selectedIdKey]);
        if (this._initialSnapshot.has(removedRow[this.selectedIdKey])) {
          this._removedUnsaved.set(removedId, removedRow);
        } else {
          this._removedUnsaved.delete(removedId);
        }
      });
    }

    this._recalcDirty();
    this._updateButtonsState();
    this._emitChange();
  }

  selectAll() {
    if (!this.selectedTable.data.length) { toast('Нет позиций для выделения', 'warning'); return; }
    this.selectedTable.selectedIds = new Set(this.selectedTable.data.map(r => r[this.selectedIdKey]));
    this.selectedTable.refresh();
    this._updateButtonsState();
  }

  clearSelections() {
    this.selectedTable.clearSelection();
    this.availableTable.clearSelection();
    this._updateButtonsState();
  }

  // ✅ T54: ПРОГРАММНОЕ УДАЛЕНИЕ конкретных строк левого списка
  //    (кнопка «Очистить от дублей» в requests.js). Логика полностью
  //    повторяет moveToAvailable: строка возвращается в available,
  //    сохранённые строки попадают в _removedUnsaved (сервер о них
  //    не знает и вернёт после перезагрузки), dirty пересчитывается.
  removeRowsByIds(removeIds) {
    if (this._locked) { toast('Состав заблокирован', 'warning'); return; }
    const idSet = new Set((removeIds || []).map(String));
    if (idSet.size === 0) return;
    const removedRows = this.selectedTable.data.filter(r => idSet.has(String(r[this.selectedIdKey])));
    if (removedRows.length === 0) return;
    const removedIdSet = new Set(removedRows.map(r => String(r[this.selectedIdKey])));

    // Обновляем selectedTable локально
    const remaining = this.selectedTable.data.filter(r => !removedIdSet.has(String(r[this.selectedIdKey])));
    this.selectedTable.setData(remaining);
    this.selectedTable.clearSelection();

    // Возвращаем удалённые строки в available + дельта несохранённых удалений
    if (this.availableTable) {
      const currentAvailableIds = new Set(this.availableTable.data.map(r => String(r[this.availableIdKey])));
      const rowsToAdd = removedRows.filter(removedRow =>
        !currentAvailableIds.has(String(removedRow[this.selectedIdKey])));
      if (rowsToAdd.length > 0) {
        this.availableTable.setData([...this.availableTable.data, ...rowsToAdd]);
      }
      removedRows.forEach(removedRow => {
        const removedId = String(removedRow[this.selectedIdKey]);
        if (this._initialSnapshot.has(removedRow[this.selectedIdKey])) {
          this._removedUnsaved.set(removedId, removedRow);
        } else {
          this._removedUnsaved.delete(removedId);
        }
      });
    }

    this._recalcDirty();
    this._updateButtonsState();
    this._emitChange();
  }

  // --- GETTERS (для совместимости) ---
  getSelectedRows()   { return this.selectedTable?.data || []; }
  getSelectedIds()    { return this.selectedTable?.getSelectedIds() || []; }
  getSelectedCount()  { return this.selectedTable?.getSelectedCount() || 0; }
  getAvailableRows()  { return this.availableTable?.data || []; }
  getAvailableIds()   { return this.availableTable?.getSelectedIds() || []; }
  getAvailableCount() { return this.availableTable?.getSelectedCount() || 0; }

  // --- DIRTY-ТРЕКИНГ ---
  _takeSnapshot() {
    this._initialSnapshot = new Set(this.selectedTable.data.map(r => r[this.selectedIdKey]));
    this._dirty = false;
  }

  _recalcDirty() {
    const currentIds = new Set(this.selectedTable.data.map(r => r[this.selectedIdKey]));
    let dirty = currentIds.size !== this._initialSnapshot.size;
    if (!dirty) {
      for (const id of currentIds) {
        if (!this._initialSnapshot.has(id)) { dirty = true; break; }
      }
    }
    this._dirty = dirty;
  }

  async revert() {
    this._removedUnsaved = new Map(); // ✅ откат — дельта удалений недействительна
    const restoredRows = this.selectedTable.data.filter(r => this._initialSnapshot.has(r[this.selectedIdKey]));
    this.selectedTable.setData(restoredRows);
    await this._reloadAvailable();
    this._dirty = false;
    this._emitChange();
  }

  commit() {
    this._removedUnsaved.clear(); // ✅ после сохранения сервер знает состав сам
    this._takeSnapshot();
    this._emitChange();
  }
   // ============================================================
  // ✅ ЯДРО ИНКАПСУЛЯЦИИ: Блок сам управляет состоянием своих кнопок
  // ============================================================
  _updateButtonsState() {
    const selectedIds = this.selectedTable?.getSelectedIds() || [];
    const availableIds = this.availableTable?.getSelectedIds() || [];
    const selectedCount = this.selectedTable?.data.length || 0;

    for (const btn of this._moveButtons) {
      const el = document.getElementById(btn.id);
      if (!el) continue;

      switch (btn.action) {
        case 'moveToSelected':
          el.disabled = this._locked || availableIds.length === 0;
          break;

        case 'moveToAvailable':
          el.disabled = this._locked || selectedIds.length === 0 || selectedCount <= 1;
          break;

        case 'selectAll':
          el.disabled = this._locked || selectedCount === 0 || selectedIds.length === selectedCount;
          break;

        case 'clearSelections':
          el.disabled = this._locked || (selectedIds.length === 0 && availableIds.length === 0);
          break;
      }
    }
  }
  /**
   * Управление видимостью блоков в зависимости от статуса
   */
  setVisibility(visibility) {
      const { showAvailable, showButtons, expandSelected } = visibility;

      const availContainer = document.querySelector(`.${this.cfg.key}-available-container`);
      const buttonsContainer = document.querySelector(`.${this.cfg.key}-buttons-container`);
      const selectedContainer = document.querySelector(`.${this.cfg.key}-selected-container`);

      if (availContainer)     availContainer.classList.toggle('composition-locked', !showAvailable);
      if (buttonsContainer)   buttonsContainer.classList.toggle('composition-locked', !showButtons);
      if (selectedContainer)  selectedContainer.classList.toggle('composition-expanded', expandSelected);

      setTimeout(() => {
          this.selectedTable?.refresh();
      }, 50);
  }
  // --- БЛОКИРОВКА ---
  setLocked(locked) {
    const newLocked = !!locked;
    if (this._locked === newLocked) return;

    this._locked = newLocked;

    for (const btn of this._moveButtons) {
        if (btn.action === 'moveToSelected' || btn.action === 'moveToAvailable') {
            const el = document.getElementById(btn.id);
            if (el) el.disabled = this._locked;
        }
    }
    if (this.cfg.customButtons) {
        for (const btn of this.cfg.customButtons) {
            const el = document.getElementById(btn.id);
            if (el) el.disabled = this._locked;
        }
    }

    document.getElementById(this.cfg.selectedContainerId)?.classList.toggle('composition-locked', this._locked);
    document.getElementById(this.cfg.availableContainerId)?.classList.toggle('composition-locked', this._locked);

    this._updateButtonsState();
    this._emitChange();
  }

  // --- ОЧИСТКА ---
  clear() {
    this._masterId = null;
    this.selectedTable.setData([]);
    this.availableTable.setData([]);
    this._initialSnapshot = new Set();
    this._removedUnsaved = new Map();
    this._dirty = false;
    this._emitChange();
  }
  // --- ВИЗУАЛЬНАЯ ПОДСВЕТКА + ВЫХОД СОСТОЯНИЯ ---
  _applyDirtyHighlight() {
    if (this._containerEl) {
      this._containerEl.classList.toggle('field-modified', this._dirty);
    }
  }
  // --- ВЫХОД СОСТОЯНИЯ ---
  _emitChange() {
    this._applyDirtyHighlight();
    if (this._onChange) {
      this._onChange({ value: this.value, dirty: this._dirty, locked: this._locked }, this);
    }
  }

  set onSelectionChange(handler) { this._onSelectionChange = handler; }
}
