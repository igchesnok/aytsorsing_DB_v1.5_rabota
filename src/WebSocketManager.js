// ============================================================
// src/WebSocketManager.js
// ============================================================
const WebSocket = require('ws');
const LockManager = require('./LockManager');
const { validateToken } = require('./authUtils');  // ← ДОБАВИТЬ импорт

class WebSocketManager {
  // ✅ ДОБАВЛЯЕМ параметр db
  constructor(server, db, onChangeCallback) {
    this.db = db;  // ← СОХРАНЯЕМ db
    this.wss = new WebSocket.Server({ noServer: true });
    this.clients = new Map();
    this.locks = new LockManager();
    this.onChange = onChangeCallback;
    
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    
    server.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });
    
    this._startHeartbeat();
  }
  
  // ===== Получение IP клиента =====
  _getClientIP(req) {
    let ip = req.socket.remoteAddress || req.connection.remoteAddress;
    if (ip && ip.startsWith('::ffff:')) {
      ip = ip.substring(7);
    }
    return ip || '127.0.0.1';
  }
  
  // ===== Подключение клиента =====
  async _onConnection(ws, req) {
    ws.isAlive = true;
    ws.clientIP = this._getClientIP(req);
    
    // ✅ Аутентификация через токен
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    try {
      // ✅ Защита от падения: если db не передан — пропускаем валидацию
      if (this.db && token) {
        const auth = await validateToken(this.db, token);
        if (auth) {
          ws.userId = auth.user.id;
          ws.userName = auth.user.login;
          ws.userRole = auth.user.role;
          console.log(`🔌 WS подключён: ${ws.userName} (${ws.userRole})`);
        } else {
          ws.userName = ws.clientIP;
          ws.userRole = 'anonymous';
          console.log(`⚠️ WS подключён без авторизации: ${ws.clientIP}`);
        }
      } else {
        ws.userName = ws.clientIP;
        ws.userRole = 'anonymous';
      }
    } catch (e) {
      console.error('[WS] Ошибка аутентификации:', e.message);
      ws.userName = ws.clientIP;
      ws.userRole = 'anonymous';
    }
    
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => this._handleMessage(ws, raw.toString()));
    ws.on('close', () => this._handleDisconnect(ws));
    ws.on('error', () => this._handleDisconnect(ws));
  }

  _handleMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const info = this.clients.get(ws);
    if (!info && msg.type !== 'init') return;

    switch (msg.type) {
      case 'init': {
        const clientId = msg.clientId;
        
        // ✅ НОВОЕ: берём имя из сообщения, если есть
        // Если нет — fallback на IP (для анонимных клиентов)
        let userName = msg.userName;
        
        if (!userName || userName === 'Аноним') {
          userName = ws.clientIP || `Client-${clientId.substr(-4)}`;
        }
        
        // ✅ Сохраняем userName в объект клиента
        ws.userName = userName;
        
        if (clientId) {
          this.clients.set(ws, { clientId, userName });
          console.log(`👤 Client connected: ${userName} (ID: ${clientId})`);
        }
        
        this.clientLocksSet(clientId);
        
        ws.send(JSON.stringify({
          type: 'init_ok',
          userName: userName,
          locks: this.locks.getAll()
        }));
        break;
      }

      case 'lock': {
          const info = this.clients.get(ws);
          const result = this.locks.acquire(msg.table, msg.id, info.clientId, info.userName);
          
          if (result.ok) {
              ws.send(JSON.stringify({ 
                  type: 'lock_acquired', 
                  table: msg.table, 
                  id: msg.id 
              }));
              
              // ✅ УЛУЧШЕНО: рассылаем обновления всем
              this.broadcast({ 
                  type: 'locks_update', 
                  locks: this.locks.getAll() 
              }, ws);
          } else {
              // ✅ УЛУЧШЕНО: отправляем имя блокирующего
              ws.send(JSON.stringify({
                  type: 'lock_denied', 
                  table: msg.table, 
                  id: msg.id, 
                  by: result.by  // ← имя пользователя, который заблокировал
              }));
          }
          break;
      }

      case 'unlock': {
        const info = this.clients.get(ws);
        if (this.locks.release(msg.table, msg.id, info.clientId)) {
          this.broadcast({ type: 'locks_update', locks: this.locks.getAll() });
        }
        break;
      }

      case 'renew': {
        const info = this.clients.get(ws);
        if (info) {
          this.locks.renew(msg.table, msg.id, info.clientId);
        }
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }

  clientLocksSet(clientId) {
    if (!this.locks.clientLocks.has(clientId)) {
      this.locks.clientLocks.set(clientId, new Set());
    }
  }

  _handleDisconnect(ws) {
    const info = this.clients.get(ws);
    if (info) {
      const released = this.locks.releaseAllByClient(info.clientId);
      if (released.length) {
        this.broadcast({ type: 'locks_update', locks: this.locks.getAll() });
      }
      this.clients.delete(ws);
    }
  }

  _startHeartbeat() {
    setInterval(() => {
      this.clients.forEach((info, ws) => {
        if (ws.isAlive === false) {
          console.log(`💀 Client ${info.userName} timed out`);
          this._handleDisconnect(ws);
          return ws.terminate();
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (e) {
          this._handleDisconnect(ws);
          ws.terminate();
        }
      });
    }, 15000);

    setInterval(() => {
      this.clients.forEach((info, ws) => {
        if (ws.readyState !== WebSocket.OPEN) {
          this._handleDisconnect(ws);
          ws.terminate();
        }
      });
    }, 120000);
  }

  broadcast(msg, exceptWs = null) {
    const data = JSON.stringify(msg);
    this.clients.forEach((info, ws) => {
      if (ws !== exceptWs && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }

  notifyDataChange(table, action, id) {
    this.broadcast({ type: 'data_changed', table, action, id });
    if (this.onChange) this.onChange(table, action, id);
  }
  /**
   * Уведомление с авто-зависимостями из QueryBuilder/SyntheticTables
   * Рассылает data_changed для всех связанных таблиц
   *
   * @param {Set<string>|string[]} dependencies - набор имён таблиц
   * @param {string} action - 'add' | 'update' | 'delete' | 'batch_add'
   * @param {string} id - ID изменённой записи (или 'batch')
   */
  notifyWithDependencies(dependencies, action, id) {
      // ✅ Нормализация: строка → массив из одного элемента
      const tables = dependencies instanceof Set
          ? Array.from(dependencies)
          : Array.isArray(dependencies)
              ? dependencies
              : [dependencies];  // строка, число, null → оборачиваем

      for (const table of tables) {
          this.broadcast({ type: 'data_changed', table, action, id });
      }

      if (this.onChange) {
          this.onChange(tables[0], action, id);
      }
  }
}

module.exports = WebSocketManager;