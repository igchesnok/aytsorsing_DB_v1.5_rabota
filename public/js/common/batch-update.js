// ============================================================
// МЕНЕДЖЕР ПАКЕТНЫХ ОБНОВЛЕНИЙ
// Автоматическая блокировка обработки WebSocket-уведомлений
// во время операций с таблицами
// ============================================================

export class BatchUpdateManager {
    constructor() {
        // Set таблиц, которые сейчас в процессе обновления
        this._processingTables = new Set();
        
        // Счётчик вложенных вызовов для каждой таблицы
        this._depth = new Map();
    }

    /**
     * Начать пакетное обновление для таблицы
     * Все уведомления data_changed для этой таблицы будут игнорироваться
     */
    begin(table) {
        this._processingTables.add(table);
        const currentDepth = this._depth.get(table) || 0;
        this._depth.set(table, currentDepth + 1);
        console.log(`[BatchUpdate] ▶ begin(${table}) depth=${currentDepth + 1}`);
    }

    /**
     * Завершить пакетное обновление для таблицы
     */
    end(table) {
        const currentDepth = this._depth.get(table) || 0;
        const newDepth = Math.max(0, currentDepth - 1);
        this._depth.set(table, newDepth);
        
        if (newDepth === 0) {
            this._processingTables.delete(table);
            this._depth.delete(table);
        }
        
        console.log(`[BatchUpdate]  end(${table}) depth=${newDepth}`);
    }

  /** Проверяет, выполняется ли пакетная обработка данных для указанной ИЛИ редактирование записи таблицы.
 *
 * Используется для подавления событий `data_changed`, чтобы не перерисовывать
 * интерфейс во время массовых обновлений.
 *
 * @param {string} table — имя таблицы
 * @returns {boolean} true, если пакетная обработка активна
 */
    isProcessing(table) {
        return this._processingTables.has(table);
    }

    /** Обёртка для автоматического управления флагом
     * Гарантирует снятие флага даже при ошибке
     * 
     * @param {string} table - имя таблицы
     * @param {Function} fn - асинхронная функция для выполнения
     * @returns {Promise<*>} результат fn
     */
    async withBatch(table, fn) {
        this.begin(table);
        try {
            const result = await fn();
            return result;
        } finally {
            this.end(table);
        }
    }

    /**
     * Получить список всех таблиц в процессе обновления
     */
    getProcessingTables() {
        return Array.from(this._processingTables);
    }

    /**
     * Сбросить все флаги (для аварийных ситуаций)
     */
    reset() {
        this._processingTables.clear();
        this._depth.clear();
        console.log('[BatchUpdate] ⟲ reset all');
    }
}

// Singleton экземпляр
export const batchManager = new BatchUpdateManager();