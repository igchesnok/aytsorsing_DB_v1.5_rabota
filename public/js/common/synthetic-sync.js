// ============================================================
// common/synthetic-sync.js
// Автоматическая синхронизация синтетических таблиц через WebSocket
// ============================================================

import { setHandlers, EditLock } from './websocket.js';
import { batchManager } from './batch-update.js';
import { api } from './utils.js';

/**  Глобальный маппинг зависимостей синтетических таблиц.
 * Формат:{baseTableName: [ 'pageKey.syntheticKey1', 'pageKey.syntheticKey2', ... ] }
 * Загружается с сервера один раз при инициализации страницы.
 * Используется для определения того, какие синтетические таблицы
 * должны обновляться при изменении базовой таблицы.
 * @type {Object<string, string[]>}
 */
let SYNTHETIC_SUBSCRIPTIONS = {};

/** Таймеры DEBOUNCE для каждого syntheticKey.
 * Ключ: syntheticKey (например, 'transportOps.list')
 * Значение: идентификатор setTimeout.
 * Используется для предотвращения множественных обновлений,
 * если сервер присылает несколько событий подряд.
 * @type {Map<string, number>}
 */
const _refreshTimers = new Map();

/**Интервал задержки перед выполнением обновления синтетической таблицы.
 * Если за это время приходит новое событие — предыдущий таймер отменяется.
 * @type {number}
 */
const DEBOUNCE_MS = 150;

/**Загружает маппинг зависимостей синтетических таблиц с сервера.
 * Вызывается один раз при старте страницы.
 * Сервер формирует зависимости на основе JOIN‑логики syntheticTables.js.
 * @param {string} [apiUrl='/api/synthetic/dependencies'] — URL API для загрузки зависимостей
 * @returns {Promise<void>}
 */
export async function loadSubscriptions(apiUrl = '/api/synthetic/dependencies') {
  try {
    const result = await api('GET', apiUrl);
    if (result && result.subscriptions) {
      SYNTHETIC_SUBSCRIPTIONS = result.subscriptions;
      console.log('[SyntheticSync] 📋 Глобальный маппинг загружен с сервера:', SYNTHETIC_SUBSCRIPTIONS);
    }
  } catch (e) {
    console.error('[SyntheticSync] Ошибка загрузки маппинга зависимостей:', e);
    SYNTHETIC_SUBSCRIPTIONS = {};
  }
}

/**Инициализирует авто‑синхронизацию синтетических таблиц для конкретной страницы
 * и одновременно настраивает все WebSocket‑обработчики для этой страницы.
 *
 * Логика:
 *  - подписывается на WebSocket‑события через setHandlers
 *  - при получении data_changed:
 *      * проверяет batch‑операции
 *      * проверяет свои блокировки (EditLock)
 *      * обновляет синтетические таблицы по маппингу
 *      * вызывает дополнительный пользовательский обработчик (если задан)
 *  - обновление кнопок и обработка блокировок также задаются здесь
 *
 * @param {Object} config
 * @param {Object<string, Function>} config.syntheticHandlers — маппинг syntheticKey → функция обновления
 * @param {string} config.pageKey — ключ страницы (например, 'orders', 'transportOps')
 * @param {Function} [config.onDataChangedExtra] — доп. обработчик data_changed
 * @param {Function} [config.updateButtons] — обработчик обновления кнопок
 * @param {Function} [config.onLocksUpdate] — обработчик обновления блокировок
 * @param {Object} [config.options]
 * @param {boolean} [config.options.skipBatchCheck=false] — пропускать ли проверку batchManager
 *
 * @returns {void}
 */
export function initSyntheticSync(config) {
  const {
    syntheticHandlers,
    pageKey,
    onDataChangedExtra,
    updateButtons,
    onLocksUpdate,
    options = {}
  } = config;

  const skipBatchCheck = !!options.skipBatchCheck;

  /*** Внутренний обработчик data_changed:
   *  - защита от batch‑операций
   *  - защита от своих же изменений (EditLock)
   *  - синхронизация синтетических таблиц
   *  - вызов доп. пользовательского обработчика
   * @param {Object} msg — сообщение WebSocket
   * @returns {void}
   */
  function handleDataChanged(msg) {

    // Защита от batch-операций
    if (!skipBatchCheck && batchManager.isProcessing(msg.table)) {
      console.log(`[SyntheticSync] ⏸ Игнорируем ${msg.table} — идёт batch update`);
      return;
    }

    // Защита от своих же изменений
    if (EditLock.current?.table === msg.table && EditLock.current?.id === msg.id) {
      return;
    }

    // Ищем синтетические таблицы, которые зависят от изменённой базовой
    const syntheticKeys = SYNTHETIC_SUBSCRIPTIONS[msg.table] || [];

    for (const key of syntheticKeys) {
      // Обрабатываем только ключи текущей страницы
      if (!syntheticHandlers[key]) continue;

      console.log(`[SyntheticSync] 🔄 ${msg.table} изменён → планируем обновление ${key}`);

      // DEBOUNCE: если для этого ключа уже запущен таймер — отменяем
      if (_refreshTimers.has(key)) {
        clearTimeout(_refreshTimers.get(key));
      }

      const timer = setTimeout(() => {
        try {
          console.log(`[SyntheticSync] ⚡ Выполняем обновление: ${key}`);
          syntheticHandlers[key]();
        } catch (e) {
          console.error(`[SyntheticSync] Ошибка обновления ${key}:`, e);
        }
        _refreshTimers.delete(key);
      }, DEBOUNCE_MS);

      _refreshTimers.set(key, timer);
    }

    // Дополнительная пользовательская логика, если задана
    if (typeof onDataChangedExtra === 'function') {
      onDataChangedExtra(msg);
    }
  }

  // ЕДИНЫЙ вызов setHandlers — вся страница конфигурируется здесь
  setHandlers({
    onDataChanged: handleDataChanged,
    updateButtons,
    onLocksUpdate
  });
}

/**Расширяет глобальный маппинг зависимостей синтетических таблиц.
 * Используется для кастомных страниц, которые добавляют свои зависимости
 * поверх стандартных, загруженных с сервера.

 * Формат newSubscriptions:{ baseTableName: [ 'pageKey.syntheticKey1', 'pageKey.syntheticKey2' ]}
 *
 * @param {Object<string, string[]>} newSubscriptions — новые зависимости
 * @returns {void}
 */
export function extendSubscriptions(newSubscriptions) {
  for (const [table, keys] of Object.entries(newSubscriptions)) {
    if (!SYNTHETIC_SUBSCRIPTIONS[table]) {
      SYNTHETIC_SUBSCRIPTIONS[table] = [];
    }
    keys.forEach(key => {
      if (!SYNTHETIC_SUBSCRIPTIONS[table].includes(key)) {
        SYNTHETIC_SUBSCRIPTIONS[table].push(key);
      }
    });
  }
}
