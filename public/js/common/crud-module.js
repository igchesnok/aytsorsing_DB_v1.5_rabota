// ============================================================
// CrudModule — базовый класс: таблица + форма + CRUD
// Теперь наследуется от RecordController: вся логика
// DirtyGuard/EditLock/WS-синхронизации/баннера блокировки
// вынесена в базовый класс. Здесь остаётся только то, что
// специфично для формы, построенной по конфигу полей.
// ============================================================
import { FilterableTable } from './filterable-table.js';
import { VirtualSelect } from './virtual-select.js';
import { registerLockAwareRecord } from './lock-aware-registry.js';
import { FormStateManager } from './form-state-manager.js';
import { isLocked } from './websocket.js';
import { api, toast } from './utils.js';
import { state } from './state.js';
import { RecordController } from './record-controller.js';

// ✅ Маркер версии: откройте консоль DevTools (F12) — если этой строки нет,
// браузер использует ЗАКАЧИРОВАННУЮ старую версию файла (Ctrl+F5)
console.info('[crud-module] v1.1: importConfig прокидывается в импорт ЦЕЛИКОМ (lookupFields + dateFields)');

// Отдельный реестр CrudModule (используется auto-lock.js через .form —
// НЕ путать с реестром RecordController, они независимы).


export class CrudModule extends RecordController {
  /**
   * @param {Object} config — конфиг сущности
   * @param {Object} opts — DOM-привязки: tableContainerId, formTitleId, buttons, hooks, importConfig...
   */
  constructor(config, opts) {
    super({
      entity: config.entity,
      syntheticHandlers: config.syntheticHandlers || opts.syntheticHandlers,
      wsSync: config.wsSync
    });

    this.config = config;
    this.opts = opts;
    this.form = new FormStateManager({
      ...config,
      onDirtyChange: () => this.updateButtonStates()
    });
    this.btns = {};
    // ✅ Реестр виртуальных селектов (VirtualSelect) по domId —
    // заполняется в _loadSelectOptions, используется в reloadVirtualSelects
    this._virtualSelects = new Map();
    this._resolveButtons();

    registerLockAwareRecord(config.entity, {
      form: this.form,
      save: () => this.save(),
      onHeaderClick: () => this._onHeaderClick(),
      checkForExternalChanges: () => this.checkForExternalChanges(),
    });
  }

  // ============================================================
  // РЕАЛИЗАЦИЯ ОБЯЗАТЕЛЬНЫХ ХУКОВ RecordController
  // ============================================================
  fillForm(row) {
    this.form.fillFromRow(row);
    this._updateFormTitle(row);
  }

  clearForm() {
    this.form.clearForm();
    this._updateFormTitle(null);
  }

  isDirty() {
    return this.form.isDirty();
  }

  getFormPanelEl() {
    const firstField = this.form._fields?.[0];
    if (!firstField) return null;
    const firstEl = document.getElementById(firstField.domId);
    return firstEl?.closest('.form-panel') || null;
  }

  async afterSelect(row) {
    this.updateButtonStates();
    if (this.opts.hooks?.onSelect) this.opts.hooks.onSelect(row, this);
  }

  async afterHeaderClick() {
    this.updateButtonStates();
    if (this.opts.hooks?.onHeaderClick) this.opts.hooks.onHeaderClick(this);
  }

  // ─── Геттеры совместимости со старым API ──────────────────
  get selectedId() {
    return this.table?.selectedId || null;
  }

  get contextResolver() {
    return () => {
      if (!this.table) return null;
      return { table: this.config.entity, id: this.table.selectedId };
    };
  }

  // ─── Построение из конфига ───────────────────────────
  _buildTableColumns() {
    return this.config.fields
      .filter(f => f.table)
      .map(f => {
        const col = { key: f.key, label: f.label, width: `${f.tableWidth}px` };
        if (f.formatter) col.formatter = f.formatter;
        if (f.tooltip) col.tooltip = true; // t67: тултип — полное значение при наведении
        return col;
      });
  }

  _buildFilterFields() {
    const result = {};
    for (const f of this.config.fields) {
      if (!f.filter || !f.filterId) continue;
      const filterType = f.filterType || f.type;
      result[f.filterId] = {
        // ✅ filterDbField: имя GET-параметра на сервере, если оно отличается
        // от ключа поля (например, osn_naimenovanie -> серверный 'naimenovanie')
        dbField: f.filterDbField || f.key,
        type: filterType === 'checkbox' ? 'checkbox' : 'text',
      };
    }
    return result;
  }

  _resolveButtons() {
    const b = this.opts.buttons || {};
    this.btns.add   = b.add   ? document.getElementById(b.add)   : null;
    this.btns.save  = b.save  ? document.getElementById(b.save)  : null;
    this.btns.del   = b.del   ? document.getElementById(b.del)   : null;
    this.btns.paste = b.paste ? document.getElementById(b.paste) : null;
  }

  get fields() { return this.config.fields; }

  // ─── Инициализация ────────────────────────────────────
  async init() {
    const container = document.getElementById(this.opts.tableContainerId);
    if (!container) {
      console.error(`[CrudModule] Контейнер таблицы #${this.opts.tableContainerId} не найден`);
      return;
    }

    const table = new FilterableTable(container, this._buildTableColumns(), {
      idKey: this.config.idKey,
      apiUrl: this.config.apiUrl,
      filterFields: this._buildFilterFields(),
      debounceMs: 300,
      getLockInfo: (item) => isLocked(this.config.entity, item[this.config.idKey]),
      ...this.opts.tableOptions
    });

    // ✅ Вся связка onBeforeSelect (DirtyGuard) / onSelect / onHeaderClick /
    //    getLockInfo теперь настраивается базовым классом.
    this.attachTable(table);

    if (!state.tables) state.tables = {};
    state.tables[this.config.entity] = this.table;

    if (this.btns.add)   this.btns.add.onclick   = () => this.add();
    if (this.btns.save)  this.btns.save.onclick  = () => this.save();
    if (this.btns.del)   this.btns.del.onclick   = () => this.del();
    if (this.btns.paste && this.opts.importConfig) {
      this.btns.paste.onclick = () => this._importFromClipboard();
    }

    this._bindFilterListeners();
    this._bindFilterClearButtons();
    this._bindFormInputListeners();
    this._loadSelectOptions();
    this._bindExtraButtons();

    // ✅ WS-синхронизация теперь через базовый класс
    await this.initWsSync({ updateButtons: () => this.updateButtonStates() });

    if (this.opts.hooks?.onInit) this.opts.hooks.onInit(this);
  }

  // ─── Автоматическая привязка ──────────────────────────
  _bindFilterListeners() {
    for (const f of this.config.fields) {
      if (!f.filter || !f.filterId) continue;
      const el = document.getElementById(f.filterId);
      if (!el) continue;
      const filterType = f.filterType || f.type;
      const eventType = (filterType === 'checkbox' || filterType === 'select') ? 'change' : 'input';
      el.addEventListener(eventType, () => this.applyFilters());
    }
  }

  _bindFilterClearButtons() {
    const clears = this.config.filterClearButtons || [];
    for (const { buttonId, filterId } of clears) {
      const btn = document.getElementById(buttonId);
      if (!btn) continue;
      btn.onclick = () => {
        const el = document.getElementById(filterId);
        if (el) {
          el.value = '';
          if (el.type === 'checkbox') el.checked = false;
        }
        this.applyFilters();
      };
    }
    const clearAll = this.config.clearAllFiltersBtn;
    if (clearAll) {
      const btn = document.getElementById(clearAll);
      if (btn) btn.onclick = () => this.clearAllFilters();
    }
  }

  _bindFormInputListeners() {
    for (const f of this.fields) {
      if (!f.domId) continue;
      const el = document.getElementById(f.domId);
      if (!el) continue;
      const eventType = (f.type === 'checkbox' || f.type === 'select') ? 'change' : 'input';
      el.addEventListener(eventType, () => this.updateButtonStates());
    }
  }

  // ─── Фильтры ──────────────────────────────────────────
  applyFilters() {
    const filters = {};
    for (const f of this.config.fields) {
      if (!f.filter || !f.filterId) continue;
      const el = document.getElementById(f.filterId);
      if (!el) continue;
      const filterType = f.filterType || f.type;
      filters[f.filterId] = filterType === 'checkbox' ? (el.checked ? '1' : '') : el.value;
    }
    this.table.applyFilters(filters);

    // ✅ НОВОЕ: фильтры страницы применяются и к виртуальным селектам,
    // у которых задан fixedParams (например, pOsnastka на странице плана:
    // в выпадающем списке остаются только детали, удовлетворяющие фильтрам).
    // Дебаунс — как у таблицы, чтобы не дёргать API на каждый символ.
    if (this._virtualSelects.size > 0) {
      clearTimeout(this._vsFilterTimer);
      this._vsFilterTimer = setTimeout(() => {
        for (const vs of this._virtualSelects.values()) {
          if (vs.config.fixedParams) vs.reload();
        }
      }, 300);
    }
  }

  clearAllFilters() {
    for (const f of this.config.fields) {
      if (!f.filter || !f.filterId) continue;
      const el = document.getElementById(f.filterId);
      if (!el) continue;
      const filterType = f.filterType || f.type;
      if (filterType === 'checkbox') el.checked = false;
      else el.value = '';
    }
    this.applyFilters();
  }

  _updateFormTitle(row) {
    const titleEl = document.getElementById(this.opts.formTitleId);
    if (!titleEl) return;
    if (!row) {
      titleEl.textContent = this.config.tableTitle || 'Новая запись';
      return;
    }
    const firstField = this.config.fields.find(f => f.table);
    const val = firstField ? (row[firstField.key] || '') : '';
    titleEl.textContent = `${this.config.tableTitle || ''}: ${val}`.trim();
  }

  // ─── Состояние кнопок ─────────────────────────────────
  updateButtonStates() {
    const parentId = this.opts.getParentId?.();
    const selectedId = this.table?.selectedId;
    const locker = selectedId ? isLocked(this.config.entity, selectedId) : null;
    const hasData = this.form.hasRequiredData();
    const isDirty = this.form.isDirty();

    if (this.config.parentEntity && !parentId) {
      if (this.btns.add) this.btns.add.disabled = true;
      if (this.btns.save) this.btns.save.disabled = true;
      if (this.btns.del) this.btns.del.disabled = true;
      return;
    }

    if (!selectedId) {
      if (this.btns.add) this.btns.add.disabled = !hasData;
      if (this.btns.save) this.btns.save.disabled = true;
      if (this.btns.del) this.btns.del.disabled = true;
    } else {
      if (this.btns.add) this.btns.add.disabled = true;
      if (this.btns.save) this.btns.save.disabled = !hasData || !isDirty || !!locker;
      if (this.btns.del) this.btns.del.disabled = !!locker;
    }
  }

  // ─── CRUD ─────────────────────────────────────────────
  async load() {
    const parentId = this.opts.getParentId?.();

    if (this.config.parentEntity && !parentId) {
      this.table.setData([]);
      return;
    }

    const rawDbFilters = {};
    if (this.config.parentEntity && parentId) {
      rawDbFilters[this.config.fkField] = parentId;
    }

    await this.table.loadImmediate({}, rawDbFilters);
    this._syncFormLockState();
    if (this.opts.hooks?.afterLoad) this.opts.hooks.afterLoad(this);
  }

  setEnabled(enabled) {
    if (this.btns.add) this.btns.add.disabled = !enabled || !this.form.hasRequiredData();
    if (this.btns.save) this.btns.save.disabled = true;
    if (this.btns.del) this.btns.del.disabled = true;
    if (this.btns.paste) this.btns.paste.disabled = !enabled;

    this.form._fields.forEach(f => {
      const el = document.getElementById(f.domId);
      if (el) el.disabled = !enabled;
    });
  }

  clear() {
    this.table.setData([]);
    this.form.clearForm();
    this.updateButtonStates();
  }

  async add() {
    const v = this.form.validate();
    if (!v.ok) {
      toast(`Заполните: ${v.missing.join(', ')}`, 'warning');
      return;
    }
    let payload = this.form.buildPayload();
    if (this.opts.hooks?.beforeSave) payload = this.opts.hooks.beforeSave(payload) || payload;

    await this.withBatch(async () => {
      const r = await api('POST', this.config.apiUrl, payload);
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      toast('Запись добавлена');
      await this.load();
      this.table.selectById(r.id);
      const row = this.table.data.find(x => x[this.config.idKey] === r.id);
      if (row) await this._onSelect(row);
      this.dispatchCrudCompleted('add', r.id);
    });
  }

  async save() {
    const selectedId = this._lastSelectedId || this.table.selectedId;
    if (!selectedId) {
      toast('Не выбрана запись для сохранения', 'warning');
      return;
    }

    const v = this.form.validate();
    if (!v.ok) {
      toast(`Заполните: ${v.missing.join(', ')}`, 'warning');
      return;
    }

    let payload = this.form.buildPayload();
    if (this.opts.hooks?.beforeSave) payload = this.opts.hooks.beforeSave(payload) || payload;

    await this.withBatch(async () => {
      const r = await api('PUT', `${this.config.apiUrl}/${selectedId}`, payload);
      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        return;
      }

      toast('Запись обновлена');
      if (EditLockCurrentMatches(selectedId)) {}

      const row = this.table.data.find(x => x[this.config.idKey] === selectedId);
      if (row) {
        Object.assign(row, payload);
        if (this.table.refresh) this.table.refresh();
        await this._onSelect(row);
      }

      this.dispatchCrudCompleted('save', selectedId);
      this.load();
    });
  }

  async del() {
    const selectedId = this.table.selectedId;
    if (!selectedId) return;
    const row = this.table.data.find(r => r[this.config.idKey] === selectedId);
    const display = row ? Object.values(row).slice(0, 2).join(' — ') : selectedId;
    if (!confirm(`Удалить запись «${display}»?`)) return;

    if (this.form) this.form.clearForm();

    await this.withBatch(async () => {
      const r = await api('DELETE', `${this.config.apiUrl}/${selectedId}`);
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      toast('Запись удалена', 'warning');
      await this.load();
      await this._onHeaderClick();
      this.dispatchCrudCompleted('del', selectedId);
    });
  }
    /**
   * Нормализация значения для сравнения.
   * Для checkbox: true/1/"1"/"true"/"да" → "1", всё остальное → "0"
   * Для остальных полей: trim + строковое представление
   */
  _normalizeForCompare(value, field) {
      if (value === null || value === undefined || value === '') return '';

      if (field?.type === 'checkbox') {
          if (value === true || value === 1) return '1';
          if (value === false || value === 0) return '0';
          const v = String(value).toLowerCase().trim();
          if (['1', 'true', 'да', 'yes', 'истина', 'on'].includes(v)) return '1';
          return '0';
      }

      return String(value).trim();
  }

  /**
   * Форматирование значения для отображения в модальном окне конфликта.
   * Для checkbox: "Да" / "Нет"
   * Для даты: DD.MM.YYYY
   * Для остальных: как есть
   */
  _formatForDisplay(value, field) {
      if (value === null || value === undefined || value === '') return '—';

      if (field?.type === 'checkbox') {
          const norm = this._normalizeForCompare(value, field);
          return norm === '1' ? '✅ Да' : '❌ Нет';
      }

      if (field?.type === 'date') {
          const s = String(value).trim();
          const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (m) return `${m[3]}.${m[2]}.${m[1]}`;
          return s;
      }

      return String(value).trim();
  }
  /** Проверяет, были ли изменены данные записи на сервере с момента fillFromRow(). */
  async checkForExternalChanges() {
    const id = this._lastSelectedId || this.table.selectedId;
    if (!id) return { changed: false };
    if (!this.form.isDirty()) return { changed: false };

    try {
      const baseUrl = this.config.detailApiUrl || this.config.apiUrl;
      const url = `${baseUrl}?id=${encodeURIComponent(id)}`;
      const response = await api('GET', url);
      const list = Array.isArray(response) ? response : (response ? [response] : []);
      const serverData = list.find(row => row[this.config.idKey] === id);

      if (!serverData) return { changed: false, deleted: true };

      const snapshot = this.form._initialSnapshot;
      if (!snapshot) return { changed: false };

      const changes = [];
      for (const key of Object.keys(snapshot)) {
          const field = this.config.fields.find(f => f.key === key);
          const snapshotVal = this._normalizeForCompare(snapshot[key], field);
          const serverVal = this._normalizeForCompare(serverData[key], field);
          if (snapshotVal !== serverVal) {
              changes.push({
                  key,
                  label: field?.label || key,
                  snapshot: this._formatForDisplay(snapshot[key], field),
                  server: this._formatForDisplay(serverData[key], field)
              });
          }
      }

      return { changed: changes.length > 0, changes, serverData };
    } catch (e) {
      console.error('[CrudModule.checkForExternalChanges] Error:', e);
      return { changed: false, error: e.message };
    }
  }

  // ─── Загрузка опций селектов из API ─────────────────────────
  async _loadSelectOptions(specificDomId = null) {
    const promises = [];

    for (const f of this.config.fields) {
      if (f.type !== 'select' || !f.optionsApi) continue;
      if (specificDomId && f.domId !== specificDomId) continue;

      const el = document.getElementById(f.domId);
      if (!el) continue;

      // ✅ ВИРТУАЛЬНЫЙ СЕЛЕКТ: создаём VirtualSelect вместо заполнения <option>.
      // Список подгружается с сервера лениво (при фокусе/вводе),
      // поиск выполняется на сервере (optionsApi.searchParam).
      // Повторный вызов (WS-сигнал об изменении справочника) — reload списка.
      if (f.virtualSelect) {
        let vs = this._virtualSelects.get(f.domId);
        if (!vs) {
          vs = new VirtualSelect({
            domId: f.domId,
            name: f.key,
            apiUrl: f.optionsApi.url,
            valueKey: f.optionsApi.valueKey || 'id',
            labelKey: f.optionsApi.labelKey || 'name',
            displayFormat: f.optionsApi.displayFormat || null,
            placeholder: f.optionsApi.placeholder || '— Выберите —',
            searchParam: f.optionsApi.searchParam || null,
            dataProps: f.optionsApi.dataProps || {},
            // ✅ НОВОЕ: фиксированные параметры (фильтры страницы -> список
            // опций). Объект или функция — VirtualSelect вызовет её при
            // каждом поиске, поэтому значения всегда актуальные.
            fixedParams: f.optionsApi.fixedParams || null,
          });
          this._virtualSelects.set(f.domId, vs);
        } else {
          vs.reload();
        }
        continue;
      }

      const currentValue = el.value;
      const apiUrl = typeof f.optionsApi === 'object' ? f.optionsApi.url : f.optionsApi;

      promises.push(
        api('GET', apiUrl)
          .then(data => {
            const placeholderText = f.optionsApi?.placeholder || '— Выберите —';
            el.innerHTML = `<option value="">${placeholderText}</option>`;
            const items = Array.isArray(data) ? data : [];
            const valueKey = f.optionsApi?.valueKey || f.optionsValueKey || 'id';
            const labelKey = f.optionsApi?.labelKey || f.optionsLabelKey || 'name';

            items.forEach(item => {
              const opt = document.createElement('option');
              opt.value = item[valueKey];
              opt.textContent = f.optionsApi?.displayFormat
                ? f.optionsApi.displayFormat(item)
                : (item[labelKey] ?? '');

              if (f.optionsApi?.dataProps) {
                for (const [k, v] of Object.entries(f.optionsApi.dataProps)) {
                  opt.dataset[k] = item[v] ?? '';
                }
              }
              el.appendChild(opt);
            });

            if (currentValue && Array.from(el.options).some(o => o.value === currentValue)) {
              el.value = currentValue;
            }
          })
          .catch(err => console.warn(`[CrudModule] Ошибка загрузки ${apiUrl}:`, err))
      );
    }

    await Promise.all(promises);
  }

  _bindExtraButtons() {
    if (!this.config.extraButtons) return;
    for (const btn of this.config.extraButtons) {
      const el = document.getElementById(btn.id);
      if (!el) continue;
      el.onclick = () => {
        if (btn.requiresSelection && !this.table.selectedId) {
          toast('Выберите запись', 'warning');
          return;
        }
        let url = btn.url;
        if (btn.passSelectedId && this.table.selectedId) {
          url += `?editId=${encodeURIComponent(this.table.selectedId)}`;
        }
        window.open(url, '_blank', btn.windowFeatures || '');
      };
    }
  }

  // ============================================================
  // ИМПОРТ ИЗ БУФЕРА ОБМЕНА
  // ✅ Полная прокидка параметров из opts.importConfig в
  //    универсальный clipboard-import.js + авто-генерация
  //    columnHints из config.fields[].label, если явно не задано.
  // ============================================================
  async _importFromClipboard() {
    const { importFromClipboard } = await import('./clipboard-import.js');
    const cfg = this.opts.importConfig || {};

    // Определяем список полей, которые будут вставляться
    const importFields = cfg.fields || this.config.fields.map(f => f.key);

    // ✅ Авто-генерация columnHints из config.fields[].label
    //    Если в cfg.columnHints задано — используем как есть.
    //    Иначе для каждого ключа в importFields ищем label в config.fields.
    let columnHints = cfg.columnHints;
    if (!columnHints || columnHints.length === 0) {
      columnHints = importFields.map(key => {
        const f = this.config.fields.find(x => x.key === key);
        return f?.label || key;
      });
    }

    return importFromClipboard({
      // ✅ v1.1 КЛЮЧЕВОЙ ФИКС: прокидываем ВСЕ ключи importConfig РАЗОМ.
      // Раньше ключи копировались вручную по списку эпохи v3.0, из-за чего
      // новые опции механизма (lookupFields — текст->ID справочника,
      // dateFields — дд.мм.гггг->гггг-мм-дд) МОЛЧА ТЕРЯЛИСЬ по дороге:
      // текст чертежа уходил на сервер без преобразования в ID (400
      // «Оснастка … не найдено в справочнике osnastka»). Spread гарантирует,
      // что любые будущие опции дойдут до clipboard-import автоматически.
      ...cfg,

      // Базовые параметры — вычисляемые значения стоят ПОСЛЕ spread и перекрывают его
      tableName: this.config.entity,
      apiUrl: this.config.apiUrl,
      fields: importFields,
      requiredFields: cfg.requiredFields ||
        this.config.fields.filter(f => f.required).map(f => f.key),

      // ✅ Подсказка о порядке колонок (авто-генерация из config.fields[].label,
      //    если в importConfig.columnHints явно не задано)
      columnHints,

      // Колбэги состояния формы/таблицы — всегда живые ссылки на этот модуль
      // (booleanFields/numericFields/delimiter/preprocessRow/isDuplicate/
      //  onDuplicate/beforeParse/lookupFields/dateFields и прочие опции
      //  уходят из ...cfg как есть; undefined -> модуль применит свои дефолты)
      getData:       () => this.table.data,
      load:          () => this.load(),
      clearForm:     () => this._onHeaderClick(),
      updateButtons: () => this.updateButtonStates(),
    });
  }

    /**
   * Обновить все виртуальные селекты при изменении данных в БД.
   * Вызывается из syntheticHandlers при получении WS-сигнала data_changed.
   *
   * Логика:
   * - Обновляет СПИСОК опций во всех виртуальных селектах
   * - НЕ трогает выбор, если пользователь его изменил (dirty state)
   * - Если выбранная запись удалена — очищает селект
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.forceFull=false] — принудительно перезагрузить списки
   */
  async reloadVirtualSelects(opts = {}) {
    for (const vs of this._virtualSelects.values()) {
      await vs.reload(opts);
    }
  }

}

// Небольшой хелпер-заглушка, чтобы не тянуть EditLock напрямую в save()
// (было в оригинале как EditLock.current?.id === selectedId → EditLock.release())
import { EditLock } from './websocket.js';
function EditLockCurrentMatches(id) {
  if (EditLock.current?.id === id) EditLock.release();
  return true;
}
