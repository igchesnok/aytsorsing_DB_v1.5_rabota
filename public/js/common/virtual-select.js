// public/js/common/virtual-select.js
import { api } from './utils.js';
// ✅ Кир→Лат: состояние переключателя гомоглифов (localStorage)
import { isEnabled as hgEnabled } from './homoglyph-helper.js';

export class VirtualSelect {
  constructor(config) {
    this.config = config;
    this.container = document.getElementById(config.domId);
    if (!this.container) {
      console.error(`[VirtualSelect] Контейнер #${config.domId} не найден`);
      return;
    }

    this.valueKey = config.valueKey || 'id';
    this.labelKey = config.labelKey || 'name';
    this.displayFormat = config.displayFormat || null;
    this.placeholder = config.placeholder || '— Поиск —';
    this.onChange = config.onChange || null;
    this.dataProps = config.dataProps || {};
    this.bufferSize = config.bufferSize || 10;
    this.debounceMs = config.debounceMs || 300;

    // ✅ НОВОЕ: имя GET-параметра поиска на сервере (по умолчанию — labelKey,
    // как раньше). Например 'search' — обобщённый OR-поиск по справочнику.
    this.searchParam = config.searchParam || null;
    // ✅ НОВОЕ: фиксированные GET-параметры, добавляемые к КАЖДОМУ поисковому
    // запросу. Объект или функция, возвращающая объект (функция читает
    // актуальное состояние DOM при каждом запросе). Пример: фильтры страницы
    // применяются и к списку опций селекта (plan.config.js -> pOsnastka).
    this.fixedParams = config.fixedParams || null;
    // ✅ T94: опциональный колбэк результата поиска — вызывается после каждого
    // завершения _search с числом найденных записей (route-editor: «N позиций»)
    this.onSearchResult = config.onSearchResult || null;
    // Последнее значение, о котором уведомили событием 'change'
    // (защита от ложных change при повторном выборе того же элемента)
    this._lastNotifiedValue = '';

    // ✅ T96: токен загрузки значения (_loadValue). Ответ более раннего
    // _loadValue не должен перезаписать dataset/display-текст, если пока
    // он летел значение снова изменили (setValue/clear/_selectItem) —
    // иначе «затормаживание» данных предыдущей записи
    this._loadValueToken = 0;

    // Текущее состояние
    this._value = '';
    this._displayText = '';
    this._previousValue = '';
    this._previousDisplayText = '';

    this._debounceTimer = null;
    this._isOpen = false;
    this._items = [];
    this._selectedIndex = -1;
    this._isLoading = false;
    this._currentQuery = '';

    // Виртуализация DOM
    this._rowHeight = 32;
    this._visibleCount = 10;
    this._scrollTop = 0;

    this._build();
    this._bindEvents();

    // ✅ НОВОЕ: обратная ссылка на экземпляр (container.vs) — внешний код
    // (app-plan.js и др.) может получить доступ к .input, .getValue(), .reload()
    this.container.vs = this;
  }

  _build() {
    this.container.innerHTML = '';
    this.container.className = 'virtual-select';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'virtual-select-input';
    this.input.placeholder = this.placeholder;
    this.input.autocomplete = 'off';

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'virtual-select-dropdown';
    this.dropdown.style.display = 'none';

    this.listContainer = document.createElement('div');
    this.listContainer.className = 'virtual-select-list-container';
    this.listContainer.style.height = `${this._visibleCount * this._rowHeight}px`;
    this.listContainer.style.overflow = 'auto';

    this.listInner = document.createElement('div');
    this.listInner.className = 'virtual-select-list-inner';
    this.listInner.style.position = 'relative';
    this.listContainer.appendChild(this.listInner);

    this.loadingIndicator = document.createElement('div');
    this.loadingIndicator.className = 'virtual-select-loading';
    this.loadingIndicator.style.display = 'none';
    this.loadingIndicator.textContent = 'Загрузка...';

    this.dropdown.appendChild(this.listContainer);
    this.dropdown.appendChild(this.loadingIndicator);

    this.hiddenInput = document.createElement('input');
    this.hiddenInput.type = 'hidden';
    this.hiddenInput.name = this.config.name;

    // ✅ НОВОЕ: маркер-треугольник (как у комбобокса)
    this.marker = document.createElement('div');
    this.marker.className = 'virtual-select-marker';
    this.marker.innerHTML = '<svg width="10" height="6" viewBox="0 0 10 6"><path d="M0 0 L5 6 L10 0 Z" fill="currentColor"/></svg>';
    this.marker.title = 'Открыть/закрыть список';

    // Обёртка для input + маркера (чтобы маркер был внутри input'а)
    this.inputWrapper = document.createElement('div');
    this.inputWrapper.className = 'virtual-select-input-wrapper';
    this.inputWrapper.appendChild(this.input);
    this.inputWrapper.appendChild(this.marker);

    this.container.appendChild(this.inputWrapper);
    this.container.appendChild(this.dropdown);
    this.container.appendChild(this.hiddenInput);

    // ✅ НОВОЕ: прокси .value и .disabled на контейнере — внешний код
    // (FormStateManager, CrudModule, баннер блокировки) работает с
    // VirtualSelect как с нативным select:
    //   container.value -> getValue(), container.value = X -> setValue(X),
    //   container.disabled = true -> блокируется внутренний input
    Object.defineProperty(this.container, 'value', {
      get: () => this.getValue(),
      set: (v) => this.setValue(v ?? ''),
      configurable: true,
    });
    Object.defineProperty(this.container, 'disabled', {
      get: () => this.input.disabled,
      set: (v) => {
        this.input.disabled = !!v;
        this.container.classList.toggle('vs-disabled', !!v);
      },
      configurable: true,
    });

    // Инжект стилей
    if (!document.getElementById('vs-styles')) {
      const style = document.createElement('style');
      style.id = 'vs-styles';
      style.textContent = `
        .virtual-select { position: relative; width: 100%; }
        .virtual-select-input {
          width: 100%; padding: 6px 10px; border: 1px solid #d0d7de;
          border-radius: 6px; font-size: 14px; background: #fff;
          box-sizing: border-box;
        }
        .virtual-select-input:focus {
          outline: none; border-color: #0969da;
          box-shadow: 0 0 0 3px rgba(9,105,218,0.1);
        }
        .virtual-select-dropdown {
          position: absolute; top: 100%; left: 0; right: 0;
          margin-top: 4px; background: #fff; border: 1px solid #d0d7de;
          border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.12);
          z-index: 1000; overflow: hidden;
        }
        .virtual-select-list-container { overflow-y: auto; overflow-x: hidden; }
        .virtual-select-list-inner { position: relative; }
        .virtual-select-option {
          padding: 0 12px; cursor: pointer; font-size: 14px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          height: 32px; line-height: 32px;
        }
        .virtual-select-option:hover,
        .virtual-select-option.selected { background-color: #ddf4ff; }
        .virtual-select-empty {
          padding: 12px; text-align: center; color: #656d76;
          font-size: 13px; font-style: italic;
        }
        .virtual-select-loading {
          padding: 8px; text-align: center; color: #0969da;
          font-size: 12px; background: #f6f8fa; border-top: 1px solid #d0d7de;
        }
        .virtual-select-list-container::-webkit-scrollbar { width: 8px; }
        .virtual-select-list-container::-webkit-scrollbar-track { background: #f6f8fa; }
        .virtual-select-list-container::-webkit-scrollbar-thumb {
          background: #d0d7de; border-radius: 4px;
        }
           /* ✅ НОВОЕ: маркер-треугольник */
        .virtual-select-marker {
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          width: 16px;
          height: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          color: #57606a;
          transition: transform 0.2s ease, color 0.15s;
          border-radius: 3px;
          user-select: none;
        }
        .virtual-select-marker:hover {
          color: #0969da;
          background: rgba(9, 105, 218, 0.08);
        }
        .virtual-select-marker svg {
          transition: transform 0.2s ease;
        }
        .virtual-select-marker.open svg {
          transform: rotate(180deg);
        }
        /* ✅ НОВОЕ: состояние disabled (setEnabled / баннер блокировки) */
        .virtual-select.vs-disabled .virtual-select-input {
          background: #f6f8fa; color: #8b949e; cursor: not-allowed;
        }
        /* ✅ НОВОЕ: подсветка изменённого поля — FormStateManager вешает
           класс field-modified на КОНТЕЙНЕР, красим внутренний input */
        .virtual-select.field-modified .virtual-select-input {
          background-color: #fff8e1; border-color: #ffc107;
          box-shadow: 0 0 0 2px rgba(255, 193, 7, 0.2);
        }
      `;
      document.head.appendChild(style);
    }
  }

  _bindEvents() {
    this.input.addEventListener('input', () => this._onInput());
    this.input.addEventListener('focus', () => this._onFocus());
    this.input.addEventListener('blur', () => this._onBlur());
    this.input.addEventListener('keydown', (e) => this._onKeyDown(e));
    this.listContainer.addEventListener('scroll', () => this._onScroll());

    // ✅ НОВОЕ: клик по маркеру — toggle списка
    this.marker.addEventListener('mousedown', (e) => {
      e.preventDefault();  // предотвращаем blur input'а
      e.stopPropagation();
      this._onMarkerClick();
    });

    document.addEventListener('mousedown', (e) => {
      if (!this.container.contains(e.target)) {
        this._handleOutsideClick();
      }
    });
  }

  _onInput() {
    // ✅ ИСПРАВЛЕНИЕ: Если список закрыт (например, после предыдущего выбора), 
    // принудительно открываем его при начале ввода текста
    if (!this._isOpen) {
      this.open();
    }

    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._search(this.input.value.trim());
    }, this.debounceMs);
  }

  _onFocus() {
    this.open();
    // Если список пуст - загрузить первые записи
    if (this._items.length === 0 && !this._currentQuery) {
      this._search('');
    }
    this._updateMarkerState();
  }

  // ✅ НОВОЕ: обработчик клика по маркеру — toggle списка
  _onMarkerClick() {
    if (this.input.disabled) return;  // ✅ НОВОЕ: заблокирован — игнорируем
    if (this._isOpen) {
      // Список открыт — закрываем БЕЗ отката значения
      this.close();
    } else {
      // Список закрыт — открываем и загружаем данные
      this.input.focus();
      this.open();
      if (this._items.length === 0 && !this._currentQuery) {
        this._search('');
      }
    }
    this._updateMarkerState();
  }

  // ✅ НОВОЕ: обновление состояния маркера (поворот стрелки)
  _updateMarkerState() {
    if (this.marker) {
      this.marker.classList.toggle('open', this._isOpen);
    }
  }

  _onBlur() {
    setTimeout(() => {
      this._handleBlur();
    }, 150);
  }

  _handleBlur() {
    if (this._isOpen) {
      if (this._selectedIndex < 0 || !this._items[this._selectedIndex]) {
        this._revertToPrevious();
      } else {
        this._selectItem(this._selectedIndex);
      }
    } else {
      this._revertToPrevious();
    }
    this.close();
  }

  _revertToPrevious() {
    this._value = this._previousValue;
    this._displayText = this._previousDisplayText;
    this.input.value = this._previousDisplayText;
    this.hiddenInput.value = this._previousValue;
  }

  _handleOutsideClick() {
    if (this._isOpen) {
      this._handleBlur();
    }
  }

  _onKeyDown(e) {
    if (!this._isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        this.open();
        if (this._items.length === 0) this._search(this.input.value.trim());
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._selectNext();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this._selectPrev();
        break;
      case 'Enter':
        e.preventDefault();
        if (this._selectedIndex >= 0) {
          this._selectItem(this._selectedIndex);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this._revertToPrevious();
        this.close();
        break;
    }
  }

  _onScroll() {
    this._scrollTop = this.listContainer.scrollTop;
    this._renderVisibleItems();
  }

  // ✅ НОВОЕ: собрать параметры поискового запроса — текст пользователя
  // плюс fixedParams (фильтры страницы). Пустые значения пропускаются.
  _buildSearchParams(query) {
    const params = new URLSearchParams();
    if (query) {
      params.append(this.searchParam || this.labelKey, query);
    }
    const fixed = typeof this.fixedParams === 'function'
      ? (this.fixedParams() || {})
      : (this.fixedParams || {});
    for (const [key, val] of Object.entries(fixed)) {
      if (val !== undefined && val !== null && String(val) !== '') {
        params.append(key, val);
      }
    }
    // ✅ Кир→Лат: при выключенном переключателе — строгий режим сервера (hg=0)
    if (!hgEnabled()) {
      params.append('hg', '0');
    }
    return params;
  }

  // ✅ ИСПРАВЛЕНО: загружаем ВСЕ записи сразу (без пагинации)
  async _search(query) {
    this._currentQuery = query;
    this._items = [];
    this._selectedIndex = -1;
    this._isLoading = true;
    this.loadingIndicator.style.display = 'block';
    this._renderVisibleItems();

    try {
      // ✅ fixedParams: к запросу добавляются фильтры страницы (если заданы)
      const params = this._buildSearchParams(query);
      // ✅ НЕ передаём limit/offset — сервер вернёт все совпадения
      const url = `${this.config.apiUrl}?${params.toString()}`;
      const data = await api('GET', url);

      this._items = Array.isArray(data) ? data : [];

      if (this._items.length > 0) {
        this._selectedIndex = 0;
      }
    } catch (e) {
      console.error('[VirtualSelect] Ошибка поиска:', e);
      this._items = [];
    } finally {
      this._isLoading = false;
      this.loadingIndicator.style.display = 'none';
      this._renderVisibleItems();
      // ✅ T94: уведомить о результате поиска (кол-во найденных, запрос)
      if (this.onSearchResult) {
        try { this.onSearchResult(this._items.length, query); } catch (e) { /* не критично */ }
      }
    }
  }

  _renderVisibleItems() {
    this.listInner.innerHTML = '';

    if (this._items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'virtual-select-empty';
      empty.textContent = this._isLoading
        ? 'Загрузка...'
        : (this._currentQuery ? 'Ничего не найдено' : 'Нет данных');
      this.listInner.appendChild(empty);
      this.listInner.style.height = 'auto';
      return;
    }

    // ✅ ПРАВИЛЬНЫЙ РАСЧЁТ: высота = ВСЕ загруженные записи * rowHeight
    const totalHeight = this._items.length * this._rowHeight;
    this.listInner.style.height = `${totalHeight}px`;

    // Вычисляем видимый диапазон + буфер
    const startIndex = Math.max(0, Math.floor(this._scrollTop / this._rowHeight) - this.bufferSize);
    const endIndex = Math.min(
      this._items.length,
      Math.ceil((this._scrollTop + this.listContainer.clientHeight) / this._rowHeight) + this.bufferSize
    );

    // Top spacer
    if (startIndex > 0) {
      const topSpacer = document.createElement('div');
      topSpacer.style.height = `${startIndex * this._rowHeight}px`;
      this.listInner.appendChild(topSpacer);
    }

    // Видимые элементы
    for (let i = startIndex; i < endIndex; i++) {
      const item = this._items[i];
      const option = document.createElement('div');
      option.className = 'virtual-select-option' + (i === this._selectedIndex ? ' selected' : '');
      option.style.height = `${this._rowHeight}px`;
      option.style.lineHeight = `${this._rowHeight}px`;

      const text = this.displayFormat
        ? this.displayFormat(item)
        : (item[this.labelKey] || '');

      option.textContent = text;
      option.dataset.index = i;

      option.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._selectItem(i);
      });

      option.addEventListener('mouseenter', () => {
        this._selectedIndex = i;
        this._updateSelection();
      });

      this.listInner.appendChild(option);
    }

    // Bottom spacer
    if (endIndex < this._items.length) {
      const bottomSpacer = document.createElement('div');
      bottomSpacer.style.height = `${(this._items.length - endIndex) * this._rowHeight}px`;
      this.listInner.appendChild(bottomSpacer);
    }
  }

  _selectNext() {
    if (this._items.length === 0) return;
    this._selectedIndex = Math.min(this._selectedIndex + 1, this._items.length - 1);
    this._updateSelection();
    this._scrollToSelected();
  }

  _selectPrev() {
    if (this._items.length === 0) return;
    this._selectedIndex = Math.max(this._selectedIndex - 1, 0);
    this._updateSelection();
    this._scrollToSelected();
  }

  _scrollToSelected() {
    const selectedTop = this._selectedIndex * this._rowHeight;
    const containerHeight = this.listContainer.clientHeight;

    if (selectedTop < this._scrollTop) {
      this.listContainer.scrollTop = selectedTop;
    } else if (selectedTop + this._rowHeight > this._scrollTop + containerHeight) {
      this.listContainer.scrollTop = selectedTop - containerHeight + this._rowHeight;
    }
  }

  _updateSelection() {
    this.listInner.querySelectorAll('.virtual-select-option').forEach((opt) => {
      const idx = parseInt(opt.dataset.index);
      opt.classList.toggle('selected', idx === this._selectedIndex);
    });
  }

  _selectItem(index) {
    const item = this._items[index];
    if (!item) return;

    // ✅ T96: явный выбор пользователя — отменяем идущий _loadValue,
    // чтобы его ответ не перезаписал display/dataset этой выборки
    this._loadValueToken++;

    this._value = item[this.valueKey];
    this._displayText = this.displayFormat
      ? this.displayFormat(item)
      : (item[this.labelKey] || '');

    this.input.value = this._displayText;
    this.hiddenInput.value = this._value;

    this._previousValue = this._value;
    this._previousDisplayText = this._displayText;

    for (const [propName, fieldName] of Object.entries(this.dataProps)) {
      this.input.dataset[propName] = item[fieldName] ?? '';
    }

    this.close();

    // ✅ НОВОЕ: событие 'change' на контейнере — dirty-tracking
    // FormStateManager и updateButtonStates() работают автоматически
    this._emitChange();

    if (this.onChange) {
      this.onChange(this._value, item);
    }
  }

  // ✅ НОВОЕ: диспатчер события 'change' на контейнере (как у нативного select).
  // Формируется ТОЛЬКО при реальном изменении значения.
  _emitChange() {
    if (this._value === this._lastNotifiedValue) return;
    this._lastNotifiedValue = this._value;
    this.container.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ✅ НОВОЕ: перезагрузить список опций (выбранное значение сохраняется).
  // Вызывается из CrudModule._loadSelectOptions / reloadVirtualSelects
  // при WS-уведомлении об изменении справочника.
  async reload() {
    await this._search(this._currentQuery || '');
  }

  open() {
    this._isOpen = true;
    this.dropdown.style.display = 'block';
    this._renderVisibleItems();
    this._updateMarkerState();
  }

  close() {
    this._isOpen = false;
    this.dropdown.style.display = 'none';
    this._updateMarkerState();
  }

  getValue() {
    return this._value;
  }

  setValue(value) {
    this._value = value;
    this.hiddenInput.value = value;
    this._previousValue = value;

    // ✅ T96: программная установка значения (fillFromRow и т.п.) —
    // dataProps ПРЕДЫДУЩЕГО выбора удаляем из dataset СРАЗУ, синхронно:
    // асинхронный _loadValue обновит их только после ответа API, а до
    // тех пор в dataset лежали данные прошлой записи (app-plan.js
    // updateOsnastkaInfo показывал «заторможенную» деталь). Заодно
    // отменяем ещё идущий _loadValue предыдущего значения.
    this._loadValueToken++;
    for (const propName of Object.keys(this.dataProps)) {
      delete this.input.dataset[propName];
    }

    if (value) {
      this._loadValue(value);
    } else {
      this._displayText = '';
      this._previousDisplayText = '';
      this.input.value = '';
    }
  }

  async _loadValue(value) {
    // ✅ T96: токен — если пока летел запрос значение снова изменили
    // (setValue/clear/_selectItem), устаревший ответ не применяем
    const token = ++this._loadValueToken;
    try {
      const params = new URLSearchParams();
      params.append(this.valueKey, value);
      const url = `${this.config.apiUrl}?${params.toString()}`;
      const data = await api('GET', url);

      if (token !== this._loadValueToken) return;   // ответ устарел

      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        this._displayText = this.displayFormat
          ? this.displayFormat(item)
          : (item[this.labelKey] || '');

        this.input.value = this._displayText;
        this._previousDisplayText = this._displayText;

        for (const [propName, fieldName] of Object.entries(this.dataProps)) {
          this.input.dataset[propName] = item[fieldName] ?? '';
        }
      }
    } catch (e) {
      console.error('[VirtualSelect] Ошибка загрузки значения:', e);
    }
  }

  clear() {
    this._value = '';
    this._displayText = '';
    this._previousValue = '';
    this._previousDisplayText = '';
    this.input.value = '';
    this.hiddenInput.value = '';
    // ✅ T96: очищаем и dataProps прошлого выбора, отменяем идущий _loadValue
    this._loadValueToken++;
    for (const propName of Object.keys(this.dataProps)) {
      delete this.input.dataset[propName];
    }
    this._items = [];
    this._renderVisibleItems();
  }

  getSelectedOption() {
    return this._items.find(item => item[this.valueKey] === this._value) || null;
  }
}