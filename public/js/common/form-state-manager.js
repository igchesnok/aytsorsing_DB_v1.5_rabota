// ============================================================
// public/js/common/form-state-manager.js
// ЕДИНЫЙ менеджер состояния формы:
//   • автоматический dirty-tracking
//   • визуализация изменённых полей (field-modified)
//   • fillFromRow / clearForm / buildPayload из ОДНОГО массива
//   • поддержка новой архитектуры (domId из конфига сущности)
// ============================================================

export class FormStateManager {
  /**
   * @param {Object} config — конфиг сущности
   * @param {Array<FieldDef>} config.fields     — определения полей
   * @param {string}  [config.formTitleId]      — ID элемента заголовка формы
   * @param {string}  [config.defaultTitle]     — заголовок для clearForm
   * @param {Function}[config.formatTitle]      — (row) => string для fillFromRow
   * @param {Function}[config.onDirtyChange]    — (isDirty: boolean) => void
   * @param {Function}[config.onStateChange]    — (currentState) => void
   *
   * FieldDef:
   * {
   *   domId: 'cCeh',         // DOM element ID (поддерживается и 'id')
   *   key: 'ceh',            // ключ в row и payload
   *   type: 'text',          // text | date | checkbox | select | number
   *   required: false,       // обязательно для валидации
   *   skipDirty: false,      // ИСКЛЮЧЕНИЕ: не учитывается в dirty-check
   *   default: '',           // значение для clearForm
   *   trim: true,            // авто-trim для text
   *   label: 'Цех',          // для сообщений об ошибках валидации
   * }
   */
  constructor(config) {
    this.config = config;
    
    // Поддержка обоих вариантов именования: domId и id
    this._fields = (config.fields || []).map(f => ({
      ...f,
      domId: f.domId || f.id,
      id: f.domId || f.id,
    })).filter(f => f.domId);

    this._formTitleId = config.formTitleId || null;
    this._defaultTitle = config.defaultTitle || '';
    this._formatTitle = config.formatTitle || null;
    this._onDirtyChange = config.onDirtyChange || (() => {});
    this._onStateChange = config.onStateChange || (() => {});

    this._initialSnapshot = null;   // снимок после fillFromRow
    this._isDirty = false;
    this._isNewMode = true;         // true = новая запись, false = редактирование

    this.requiredFields = this._fields.filter(f => f.required);

    this._attachListeners();
     // ✅ НОВОЕ: массив внешних проверок dirty (например, DualListBlock)
    this._externalDirtyChecks = [];
  }

  // ============================================================
  // ПУБЛИЧНЫЙ API
  // ============================================================

  // ============================================================
  //  Регистрация внешней проверки dirty
  // ============================================================
  /**
   * Регистрирует внешнюю функцию проверки dirty-состояния.
   * Используется для интеграции с DualListBlock и другими
   * компонентами, которые имеют собственное dirty-состояние.
   *
   * @param {Function} checkFn — () => boolean
   *
   * @example
   * formStateManager.registerExternalDirtyCheck(() => block.isDirty);
   */
  registerExternalDirtyCheck(checkFn) {
    if (typeof checkFn === 'function' && !this._externalDirtyChecks.includes(checkFn)) {
      this._externalDirtyChecks.push(checkFn);
    }
  }

    /**
   * Удаляет регистрацию внешней проверки.
   * @param {Function} checkFn
   */
  unregisterExternalDirtyCheck(checkFn) {
    this._externalDirtyChecks = this._externalDirtyChecks.filter(fn => fn !== checkFn);
  }

  /**
   * Заполнить форму данными из строки таблицы.
   * Вызывается в onSelect().
   * Сохраняет снимок для последующего dirty-check.
   */
  fillFromRow(row) {
    this.fillForm(row);

    // Снимок СОСТОЯНИЯ (только поля, участвующие в dirty-check)
    this._initialSnapshot = this._takeSnapshot();
    this._isNewMode = false;
    this._isDirty = false;
    this._clearAllHighlights();
    this._updateFormDirtyClass();
    this._onDirtyChange(false);

    // Заголовок формы
    if (this._formTitleId) {
      const titleEl = document.getElementById(this._formTitleId);
      if (titleEl) {
        titleEl.textContent = this._formatTitle
          ? this._formatTitle(row)
          : this._defaultTitle;
      }
    }
  }

  /**
   * Заполнить форму из объекта (строки таблицы) — без снимка.
   */
  fillForm(row) {
    for (const field of this._fields) {
      // t71: поле-«только фильтр» не трогаем — выбор строки таблицы
      // не должен менять значения фильтров пользователя
      if (this._isFilterOnlyField(field)) continue;
      const el = document.getElementById(field.domId);
      if (!el) continue;
      this._setFieldValue(el, field, row[field.key]);
    }
  }
  /**
     * Откатить все изменения и вернуть форму к состоянию на момент fillFromRow.
     * Используется при нажатии «Сбросить» в модальном окне DirtyGuard.
     * 
     * В отличие от clearForm():
     * - НЕ очищает поля, а восстанавливает значения из _initialSnapshot
     * - НЕ переключает в режим «новая запись»
     * - Сбрасывает dirty-state и убирает подсветки
     */
    revertChanges() {
        if (!this._initialSnapshot) {
            // Снимка нет (не было fillFromRow) — очищаем как fallback
            this.clearForm();
            return;
        }
        // Восстанавливаем значения из снимка
        for (const field of this._fields) {
            // t71: поле-«только фильтр» не трогаем (см. _isFilterOnlyField)
            if (this._isFilterOnlyField(field)) continue;
            const el = document.getElementById(field.domId);
            if (!el) continue;
            this._setFieldValue(el, field, this._initialSnapshot[field.key]);
        }
        // Сбрасываем dirty-state
        this._isDirty = false;
        this._clearAllHighlights();
        this._updateFormDirtyClass();
        this._onDirtyChange(false);
        this._onStateChange(this.buildPayload());
    }
  /**
   * Очистить форму. Вызывается в onHeaderClick().
   * Сбрасывает снимок → режим «новая запись».
   */
  clearForm() {
    for (const field of this._fields) {
      // t71: поле-«только фильтр» не трогаем — сброс формы (клик по шапке
      // таблицы, удаление записи) не должен очищать фильтры пользователя
      if (this._isFilterOnlyField(field)) continue;
      const el = document.getElementById(field.domId);
      if (!el) continue;
      this._setFieldValue(el, field, field.default ?? '');
    }

    this._initialSnapshot = null;
    this._isNewMode = true;
    this._isDirty = false;
    this._clearAllHighlights();
    this._updateFormDirtyClass();
    this._onDirtyChange(false);

    if (this._formTitleId) {
      const titleEl = document.getElementById(this._formTitleId);
      if (titleEl) titleEl.textContent = this._defaultTitle;
    }
  }

  /** Прочитать все поля формы → объект (алиас для buildPayload) */
  readForm() {
    return this.buildPayload();
  }


  /**
   * Собрать payload из текущих значений формы.
   * ✅ Виртуальные поля (virtual: true) НЕ отправляются на сервер.
   */
  buildPayload() {
      const payload = {};
      for (const field of this._fields) {
          if (field.virtual) continue;  // ✅ Пропускаем виртуальные поля
          const el = document.getElementById(field.domId);
          if (!el) continue;
          payload[field.key] = this._getFieldValue(el, field);
      }
      return payload;
  }

  /** Форма изменена относительно снимка? */
  isDirty() {
    return this._isDirty;
  }

  /** Режим новой записи (нет выбранной строки)? */
  isNewMode() {
    return this._isNewMode;
  }

  /** Все обязательные поля заполнены? */
  hasValidData() {
    return this.validateRequired().length === 0;
  }

  /** Все обязательные поля заполнены? (алиас для совместимости) */
  hasRequiredData() {
    return this.hasValidData();
  }


  /** Массив полей, не прошедших валидацию */
  validateRequired() {
      const missing = [];
      for (const field of this._fields) {
          if (!field.required) continue;
          if (field.virtual) continue;  // ✅ Виртуальные поля не валидируем
          
          const el = document.getElementById(field.domId);
          if (!el) continue;
          const value = this._getFieldValue(el, field);
          if (value === '' || value === null || value === undefined || value === false) {
              missing.push(field);
          }
      }
      return missing;
  }

  /** Валидация обязательных полей → { ok, missing } */
  validate() {
    const missing = this.validateRequired();
    return {
      ok: missing.length === 0,
      missing: missing.map(f => f.label || f.key),
    };
  }

  /** Программно пересчитать dirty-state (после внешних изменений) */
  recalculate() {
    this._updateDirtyState();
  }
    
  // ============================================================
  // ВНУТРЕННЯЯ ЛОГИКА
  // ============================================================

  _attachListeners() {
    for (const field of this._fields) {
      const el = document.getElementById(field.domId);
      if (!el) continue;
          // ✅ НОВОЕ: readonly из конфига
      if (field.readonly && el.tagName === 'INPUT') {
        el.readOnly = true;
      }
      const eventType = (field.type === 'checkbox' || field.type === 'select')
        ? 'change' : 'input';

      el.addEventListener(eventType, () => this._onFieldChanged(field));
    }
  }

  _onFieldChanged(field) {
    this._updateDirtyState();
    this._updateFieldHighlight(field);
    this._onStateChange(this.buildPayload());
  }

  _updateDirtyState() {
    let dirty;

    if (this._isNewMode || !this._initialSnapshot) {
      // Режим новой записи: dirty = есть данные в обязательных полях
      dirty = this.hasValidData();
    } else {
      // Режим редактирования: сравнение со снимком
      const current = this._takeSnapshot();
      dirty = false;
      for (const key of Object.keys(this._initialSnapshot)) {
        if (this._normalize(this._initialSnapshot[key]) !== this._normalize(current[key])) {
          dirty = true;
          break;
        }
      }
    }

     //  учитываем внешние dirty-источники (DualListBlock и т.п.)
    if (!dirty) {
      for (const checkFn of this._externalDirtyChecks) {
        try {
          if (checkFn()) {
            dirty = true;
            break;
          }
        } catch (e) {
          console.warn('[FormStateManager] Ошибка во внешней проверке dirty:', e);
        }
      }
    }

    const wasDirty = this._isDirty;
    this._isDirty = dirty;

    if (wasDirty !== dirty) {
      this._updateFormDirtyClass();
      this._onDirtyChange(dirty);
    }
  }

  /** Снимок текущих значений (без skipDirty и virtual полей) */
  // ✅ ИЗМЕНЕНО: Добавлен параметр sourceData для переиспользования логики
  _takeSnapshot(sourceData = null) {
      const snapshot = {};
      for (const field of this._fields) {
          if (field.skipDirty) continue;
          if (field.virtual) continue;
          
          if (sourceData) {
              // Если переданы данные с сервера — берем из объекта
              if (sourceData.hasOwnProperty(field.key)) {
                  snapshot[field.key] = sourceData[field.key];
              }
          } else {
              // Иначе читаем из DOM (стандартное поведение)
              const el = document.getElementById(field.domId);
              if (!el) continue;
              snapshot[field.key] = this._getFieldValue(el, field);
          }
      }
      return snapshot;
  }

  // ✅ НОВЫЙ МЕТОД: Тонкая обертка над _takeSnapshot для подавления конфликта
  acknowledgeExternalChanges(serverData) {
      // Переиспользуем логику _takeSnapshot, передав туда серверные данные
      this._initialSnapshot = this._takeSnapshot(serverData);
  }
  _normalize(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  // t71: поле-«только фильтр» — его DOM-элемент совмещён с элементом фильтра
  // (domId === filterId; в проекте это «Фирма» на странице плана: селект #fltFirma
  // одновременно и элемент конфига, и фильтр). Значение такого элемента
  // принадлежит фильтру: fillForm / clearForm / revertChanges его НЕ перезаписывают.
  _isFilterOnlyField(field) {
    return !!(field && field.filter && field.filterId && field.domId === field.filterId);
  }

  // --- Чтение значения из DOM ---
  _getFieldValue(el, field) {
    switch (field.type) {
      case 'checkbox':
        return el.checked;
      case 'number':
        if (el.value === '') return '';
        const n = parseFloat(el.value.replace(',', '.'));
        return isNaN(n) ? '' : n;
      case 'date':
        return el.value || '';
      case 'select':
        return el.value || '';
      default: // text
        return field.trim !== false ? (el.value || '').trim() : (el.value || '');
    }
  }

  // --- Запись значения в DOM ---
  _setFieldValue(el, field, value) {
    switch (field.type) {
      case 'checkbox':
        el.checked = value === 1 || value === true || value === '1';
        break;
      case 'number':
        el.value = (value !== null && value !== undefined && value !== '') ? value : '';
        break;
      case 'date':
        el.value = value || '';
        break;
      case 'select':
        el.value = value || '';
        break;
      default: // text
        el.value = (value !== null && value !== undefined) ? String(value) : '';
        break;
    }
  }

  // --- Визуализация: подсветка изменённого поля ---
  _updateFieldHighlight(field) {
    if (field.skipDirty) return;
    if (this._isNewMode || !this._initialSnapshot) return;

    const el = document.getElementById(field.domId);
    if (!el) return;

    const initVal = this._normalize(this._initialSnapshot[field.key]);
    const curVal = this._normalize(this._getFieldValue(el, field));

    el.classList.toggle('field-modified', initVal !== curVal);
  }

  _clearAllHighlights() {
    for (const field of this._fields) {
      const el = document.getElementById(field.domId);
      if (el) el.classList.remove('field-modified');
    }
  }

  // --- Визуализация: класс на панели формы ---
  _updateFormDirtyClass() {
    // Ищем ближайшую .form-panel
    const firstEl = document.getElementById(this._fields[0]?.domId);
    if (!firstEl) return;
    const panel = firstEl.closest('.form-panel');
    if (!panel) return;
    panel.classList.toggle('form-dirty', this._isDirty);
  }
}