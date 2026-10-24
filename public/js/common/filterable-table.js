// ============================================================
// public/js/common/filterable-table.js
// ФИЛЬТРУЕМАЯ ТАБЛИЦА (серверная фильтрация через SQL)
// ============================================================
import { VirtualTable } from './virtual-table.js';
import { api } from './utils.js';
// ✅ Кир→Лат: состояние переключателя гомоглифов (localStorage)
import { isEnabled as hgEnabled } from './homoglyph-helper.js';

export class FilterableTable extends VirtualTable {
    /**
     * @param {HTMLElement} container
     * @param {Array} columns - колонки таблицы
     * @param {Object} opts
     * @param {string} opts.apiUrl - URL API endpoint (например, '/api/osnastka')
     * @param {Object} opts.filterFields - маппинг полей фильтрации
     *   {
     *     fltNomer: { dbField: 'nomer_chertezha', type: 'text' },
     *     fltTO: { dbField: 'zakalka', type: 'checkbox' }
     *   }
     * @param {number} opts.debounceMs - задержка перед запросом (мс)
     * @param {Function} opts.postProcess - функция обработки данных перед setData
     *   (data) => data  // модифицирует массив (например, добавляет вычисляемые поля)
     */
    constructor(container, columns, opts = {}) {
        super(container, columns, opts);

        this.apiUrl = opts.apiUrl;
        this.filterFields = opts.filterFields || {};
        this.debounceMs = opts.debounceMs || 300;
        this.postProcess = opts.postProcess || null;

        // Защита от параллельных вызовов
        this._isFiltering = false;
        this._filterQueued = false;
        this._abortController = null;
        this._debounceTimer = null;

        // Кэшируем все данные для клиентской фильтрации (если нужно)
        this._allData = [];

        // ✅ НОВОЕ: последние переданные фильтры (для повтора в _filterQueued)
        this._lastFilters = {};
        this._lastRawDbFilters = {};
    }

    /**
     * Загрузить данные с сервера с фильтрами
     * Добавлен параметр rawDbFilters для инъекции прямых SQL-фильтров (например, id_firmy)
     */
    async load(filters = {}, rawDbFilters = {}) {
        if (this._isFiltering) {
            this._filterQueued = true;
            this._lastFilters = filters;
            this._lastRawDbFilters = rawDbFilters;
            return;
        }
        this._isFiltering = true;

        try {
            if (this._abortController) {
                this._abortController.abort();
            }
            this._abortController = new AbortController();

            const queryParams = new URLSearchParams();

            // 1. Стандартные фильтры из DOM-инпутов
            for (const [filterId, config] of Object.entries(this.filterFields)) {
                const value = filters[filterId];
                if (value !== undefined && value !== null && value !== '') {
                    queryParams.append(config.dbField, value);
                }
            }

            // 2. Сырые фильтры от MasterDetailModule (parentEntity)
            for (const [dbField, value] of Object.entries(rawDbFilters)) {
                if (value !== undefined && value !== null && value !== '') {
                    queryParams.append(dbField, value);
                }
            }

            // ✅ Кир→Лат: при выключенном переключателе просим сервер строгий
            // режим (hg=0). По умолчанию сервер ищет с гомоглифами.
            if (!hgEnabled()) {
                queryParams.append('hg', '0');
            }

            const queryString = queryParams.toString();
            const url = queryString ? `${this.apiUrl}?${queryString}` : this.apiUrl;

            console.log(`[FilterableTable] GET ${url}`, { filters, rawDbFilters });

            let data = await api('GET', url, null, this._abortController.signal);

            if (!Array.isArray(data)) {
                console.warn('[FilterableTable] Ответ не является массивом:', data);
                data = [];
            }

            if (this.postProcess && typeof this.postProcess === 'function') {
                data = this.postProcess(data) || data;
            }

            this._allData = data;
            this.setData(this._allData);

        } catch (e) {
            if (e.name === 'AbortError') return;
            console.error('[FilterableTable] Ошибка загрузки:', e);
            this._allData = [];
            this.setData([]);
        } finally {
            this._isFiltering = false;
            if (this._filterQueued) {
                this._filterQueued = false;
                await this.load(this._lastFilters, this._lastRawDbFilters);
            }
        }
    }

    /**
     * Мгновенная загрузка (без debounce)
     */
    async loadImmediate(filters = {}, rawDbFilters = {}) {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        await this.load(filters, rawDbFilters);
    }

    /**
     * Применить фильтры с debounce.
     * ✅ ИЗМЕНЕНО: принимаем опциональный rawDbFilters — пробрасываем в load().
     * Раньше rawDbFilters (например, excludePlanIds) терялись при debounce-вызове,
     * из-за чего в отфильтрованной таблице могли появляться уже выбранные строки.
     */
    applyFilters(filters, rawDbFilters = {}) {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(() => {
            this.load(filters, rawDbFilters);
        }, this.debounceMs);
    }

    /**
     * Очистить все фильтры
     */
    clearFilters() {
        const filters = {};
        for (const filterId of Object.keys(this.filterFields)) {
            filters[filterId] = '';
        }
        this.applyFilters(filters);
    }

    /**
     * Уничтожение (очистка таймеров)
     */
    destroy() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
        if (this._abortController) {
            this._abortController.abort();
        }
    }
}
