// ============================================================
// js/common/websocket.js
// ============================================================
import { state } from './state.js';
import { toast } from './utils.js';
import { batchManager } from './batch-update.js';

let ws = null;
/** Возвращает текущий WebSocket‑экземпляр.
 *
 * Используется для прямой отправки сообщений, проверки состояния
 * соединения и работы с блокировками.
 *
 * @returns {WebSocket|null} активный WebSocket или null, если соединение не установлено
 */
export function getWs() { return ws; }
/**  Устанавливает WebSocket‑соединение с сервером и настраивает обработчики.
 *
 * Логика:
 *  - создаёт новый WebSocket
 *  - отправляет серверу init‑сообщение с clientId и userName
 *  - обрабатывает входящие сообщения через handleWsMessage
 *  - автоматически переподключается при разрыве
 *  - отправляет ping каждые 25 секунд для поддержания соединения
 *
 * Используется как основной механизм связи клиента с сервером.
 *
 * @returns {void}
 */
export function connectWs() {
  ws = new WebSocket(`ws://${location.host}`);
  
  ws.onopen = () => {
    console.log('WebSocket connected');
    
    // ✅ НОВОЕ: получаем имя пользователя из auth
    let userName = state.userName || 'Аноним';
    
    try {
      const userJson = localStorage.getItem('auth_user');
      if (userJson) {
        const user = JSON.parse(userJson);
        userName = user.fio || user.login || userName;
      }
    } catch (e) {
      console.warn('[WS] Не удалось получить имя пользователя:', e);
    }
    
    // ✅ НОВОЕ: отправляем clientId И userName на сервер
    ws.send(JSON.stringify({
      type: 'init',
      clientId: state.clientId,
      userName: userName  // ← ДОБАВЛЕНО
    }));
  };
  
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWsMessage(msg);
  };
  
  ws.onclose = () => {
    console.log('WebSocket closed, reconnecting...');
    updateWsStatus(false);
    setTimeout(connectWs, 2000);
  };
  
  ws.onerror = (e) => console.error('WS error', e);
  
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 25000);
}
/** Обновляет визуальный и логический статус WebSocket‑подключения.
 *
 * Используется после успешной инициализации или при потере соединения.
 * Может обновлять индикаторы в UI, внутренние флаги состояния и
 * запускать дополнительные обработчики.
 *
 * @param {boolean} isConnected — текущее состояние соединения (true/false)
 * @returns {void}
 */
function updateWsStatus(connected) {
  const el = document.getElementById('wsStatus');
  if (!el) return;
  
  if (connected) {
    el.className = 'ws-status connected';
    el.textContent = `🟢 ${state.userName}`;
  } else {
    el.className = 'ws-status disconnected';
    el.textContent = '⚫ Offline';
  }
}
/**  Внешний обработчик события изменения данных.
 *
 * Вызывается, когда сервер прислал `data_changed`, и событие не было
 * проигнорировано. Обычно обновляет UI, перерисовывает таблицу или форму.
 *
 * @param {Object} msg — сообщение WebSocket
 * @returns {void}
 */
let _onDataChangedHandler = null;
/**  Внешний обработчик обновления состояния кнопок интерфейса.
 *
 * Вызывается после получения `locks_update`, чтобы обновить доступность
 * кнопок редактирования, удаления, сохранения и других элементов UI.
 *
 * @returns {void}
 */
let _updateButtonsHandler = null;
/** Внешний обработчик обновления блокировок.
 *
 * Используется для перерисовки индикаторов блокировок, обновления
 * состояния форм, таблиц и других элементов интерфейса.
 *
 * @returns {void}
 */
let _onLocksUpdateHandler = null;
/** Устанавливает внешние обработчики событий WebSocket.
 *
 * Позволяет подключать UI‑логику:
 *  - обработку изменения данных
 *  - обновление состояния кнопок
 *  - обновление блокировок
 *
 * @param {Object} handlers
 * @param {Function} [handlers.onDataChanged] — обработчик data_changed
 * @param {Function} [handlers.updateButtons] — обработчик обновления кнопок
 * @param {Function} [handlers.onLocksUpdate] — обработчик обновления блокировок
 *
 * @returns {void}
 */
export function setHandlers({ onDataChanged, updateButtons, onLocksUpdate }) {
  if (onDataChanged !== undefined) _onDataChangedHandler = onDataChanged;
  if (updateButtons !== undefined) _updateButtonsHandler = updateButtons;
  if (onLocksUpdate !== undefined) _onLocksUpdateHandler = onLocksUpdate;
}
/** Центральный обработчик всех входящих WebSocket‑сообщений.
 *
 * Функция выступает как универсальный диспетчер событий WebSocket.
 * В зависимости от типа сообщения выполняет обновление состояния клиента,
 * синхронизацию данных, управление блокировками и уведомление пользователя.
 *
 * Поддерживаемые типы сообщений:
 *
 * 1) init_ok
 *    — Успешная инициализация соединения.
 *      Обновляет имя пользователя, сохраняет его в localStorage,
 *      обновляет статус WebSocket и выводит информацию в консоль.
 *
 * 2) locks_update
 *    — Сервер присылает актуальный список блокировок.
 *      Полностью пересобирает карту блокировок, обновляет таблицы,
 *      вызывает внешние обработчики обновления UI.
 *
 * 3) data_changed
 *    — Уведомление об изменении данных в таблице.
 *      Игнорируется, если идёт пакетная загрузка или запись редактируется текущим пользователем.
 *      В остальных случаях вызывает внешний обработчик изменения данных.
 *
 * 4) lock_denied
 *    — Попытка заблокировать запись отклонена.
 *      Показывает уведомление с именем пользователя, удерживающего блокировку.
 *
 * @param {Object} msg — сообщение от WebSocket‑сервера
 * @param {string} msg.type — тип сообщения
 * @param {string} [msg.userName] — имя пользователя (для init_ok)
 * @param {Array} [msg.locks] — список блокировок (для locks_update)
 * @param {string} [msg.table] — таблица, где произошло изменение (для data_changed)
 * @param {string} [msg.id] — идентификатор записи (для data_changed)
 * @param {string} [msg.by] — имя пользователя, удерживающего блокировку (для lock_denied)
 *
 * @returns {void}
 */
function handleWsMessage(msg) {
  const { type } = msg;

  const handlers = {
    init_ok: () => {
      state.userName = msg.userName;
      localStorage.setItem('userName', state.userName);
      updateWsStatus(true);
      console.log(`👤 Logged in as: ${state.userName}`);
       // ✅ НОВОЕ: Заполняем state.locks из msg.locks
        if (msg.locks && Array.isArray(msg.locks)) {
            state.locks.clear();
            msg.locks.forEach(lock => {
                state.locks.set(`${lock.table}:${lock.id}`, lock.userName);
            });
            console.log(`🔒 Загружено блокировок при подключении: ${msg.locks.length}`);

            // ✅ Перерисовываем все таблицы с учётом блокировок
            Object.values(state.tables).forEach(t => t?.refresh());

            // ✅ Вызываем обработчик обновления блокировок (если задан)
            _onLocksUpdateHandler?.();
        }
        
    },

    locks_update: () => {
      state.locks.clear();
      msg.locks.forEach(lock => state.locks.set(`${lock.table}:${lock.id}`, lock.userName));
      Object.values(state.tables).forEach(t => t?.refresh());
      _updateButtonsHandler?.();
      _onLocksUpdateHandler?.();
    },

    data_changed: () => {
      if (batchManager.isProcessing(msg.table)) {
        console.log(`[WS] ⏸ Игнорируем data_changed(${msg.table}) — идёт batch update`);
        return;
      }
      if (EditLock.current?.table === msg.table &&  EditLock.current?.id === msg.id)  return;
      _onDataChangedHandler?.(msg);
    },

    lock_denied: () => toast(`🔒 Запись редактирует: ${msg.by}`, 'warning')
  };

  const handler = handlers[type];
  if (handler) handler();
}
/** Получить имя пользователя, заблокировавшего запись
 * @param {string} table
 * @param {string} id
 * @returns {string|null} имя пользователя или null
 */
export function getLockerName(table, id) {
    const key = `${table}:${id}`;
    return state.locks.get(key) || null;
}
/** Проверяет, заблокирована ли запись другим пользователем.
 *
 * Если запись заблокирована текущим пользователем — возвращает null.
 * Если запись свободна — возвращает null.
 * Если запись заблокирована другим пользователем — возвращает его имя.
 *
 * @param {string} table — имя таблицы
 * @param {string} id — идентификатор записи
 * @returns {string|null} имя пользователя или null
 */
export function isLocked(table, id) {
  const key = `${table}:${id}`;
  const locker = state.locks.get(key);
  
  if (!locker) return null;
  
  if (EditLock.current && 
      EditLock.current.table === table && 
      EditLock.current.id === id) {
    return null;
  }
  
  return locker;
}

export const EditLock = {
/** Текущая блокировка редактирования, установленная пользователем.
 *
 * @typedef {Object} EditLockEntry
 * @property {string} table — таблица
 * @property {string} id — идентификатор записи
 *
 * @type {EditLockEntry|null}
 */
current: null,
 /** Интервал автоматического продления блокировки.
 *
 * Хранит идентификатор setInterval, который каждые 20 секунд отправляет
 * серверу сообщение renew, чтобы блокировка не истекла.
 *
 * Если null — продление не активно.
 *
 * @type {number|null}
 */
renewInterval: null,
/** Таймер неактивности пользователя.
 *
 * Хранит идентификатор setTimeout, который отсчитывает время бездействия.
 * Если пользователь не выполняет действий в течение INACTIVITY_TIMEOUT,
 * блокировка автоматически снимается.
 *
 * Если null — таймер неактивности не запущен.
 *
 * @type {number|null}
 */
inactivityTimer: null,
/** Максимальное время неактивности пользователя перед автоматическим снятием блокировки.
 *
 * Значение задаётся в миллисекундах.
 * По умолчанию — 5 минут (5 * 60 * 1000).
 *
 * Используется в _startInactivityTimer() для определения порога бездействия.
 *
 * @type {number}
 */
INACTIVITY_TIMEOUT: 50000,

  /** Запускает таймер неактивности пользователя.
 *
 * Если пользователь не выполняет действий в течение INACTIVITY_TIMEOUT,
 * блокировка автоматически снимается, UI выходит из режима редактирования,
 * и показывается уведомление.
 *
 * @returns {void}
 */
  _startInactivityTimer() {
    this._stopInactivityTimer();
    this.inactivityTimer = setTimeout(async () => {
      console.log('⏰ Неактивность 5 минут — снимаем блокировку');
       this.release();
      document.querySelectorAll('.form-panel.editing')
        .forEach(p => p.classList.remove('editing'));
      toast('Блокировка снята из-за неактивности', 'warning');
    }, this.INACTIVITY_TIMEOUT);
  },
  /**  Останавливает таймер неактивности.
 * Вызывается при любых действиях пользователя или при снятии блокировки.
 * @returns {void}
 */
  _stopInactivityTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  },
  /**Перезапускает таймер неактивности, если есть активная блокировка.
 * Используется при любых действиях пользователя в режиме редактирования.
 * @returns {void}
 */
  resetInactivity() { if (this.current) this._startInactivityTimer();},
  /** Пытается установить блокировку на запись.
 *
 * Логика:
 *  - отправляет серверу запрос на блокировку
 *  - ждёт ответ lock_acquired или lock_denied
 *  - автоматически продлевает блокировку и запускает таймер неактивности
 *
 * Возвращает Promise:
 *  - true — блокировка получена
 *  - false — блокировка отклонена или произошла ошибка
 *
 * @param {string} table — имя таблицы
 * @param {string} id — идентификатор записи
 * @returns {Promise<boolean>} результат попытки блокировки
 */
  async acquire(table, id) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast('Нет соединения с сервером', 'error');
      return false;
    }
    
    if (this.current && this.current.table === table && this.current.id === id) {
      this._startRenew();
      this._startInactivityTimer();
      return true;
    }
    
    return new Promise((resolve) => {
      let settled = false;
      
      const cleanup = () => {
        clearTimeout(timeout);
        ws.removeEventListener('message', handler);
        ws.removeEventListener('close', onClose);
        ws.removeEventListener('error', onError);
      };
      
      const settle = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      
      const timeout = setTimeout(() => {
        console.warn('[EditLock] Lock request timeout');
        settle(false);
      }, 3000);
      
      const handler = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        
        if (msg.table !== table || msg.id !== id) return;
        
        if (msg.type === 'lock_acquired') {
          this.current = { table, id };
          this._startRenew();
          this._startInactivityTimer();
          settle(true);
        } else if (msg.type === 'lock_denied') {
          toast(`🔒 Запись редактирует: ${msg.by}`, 'warning');
          settle(false);
        }
      };
      
      const onClose = () => settle(false);
      const onError = () => settle(false);
      
      ws.addEventListener('message', handler);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
      
      ws.send(JSON.stringify({ type: 'lock', table, id }));
    });
  },
  /** Снимает текущую блокировку редактирования.
 *
 * Отправляет серверу unlock‑сообщение, останавливает таймеры
 * продления блокировки и неактивности, очищает состояние.
 *
 * @returns {void}
 */
  release() {
    if (!this.current) return;
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'unlock',
        table: this.current.table,
        id: this.current.id
      }));
    }
    
    this._stopRenew();
    this._stopInactivityTimer();
    this.current = null;
  },
  /** Запускает периодическое продление блокировки.
 *
 * Каждые 20 секунд отправляет серверу renew‑сообщение,
 * чтобы блокировка не истекла.
 *
 * @returns {void}
 */
  _startRenew() {
    this._stopRenew();
    this.renewInterval = setInterval(() => {
      if (this.current && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'renew',
          table: this.current.table,
          id: this.current.id
        }));
      }
    }, 20000);
  },
  /** Останавливает продление блокировки.
   *
   * Вызывается при снятии блокировки или при разрыве соединения.
   *
   * @returns {void}
   */
  _stopRenew() {
    if (this.renewInterval) {
      clearInterval(this.renewInterval);
      this.renewInterval = null;
    }
  }
};