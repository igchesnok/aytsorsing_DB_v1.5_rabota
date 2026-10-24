class LockManager {
  constructor() {
    this.locks = new Map();
    this.clientLocks = new Map();
    this.lockTimeout = 60000; // 60 сек — автоосвобождение если нет renew
	this.renewTimeout = 90000;     // 90 сек — максимальное время без renew
    this._startCleanup();
  }

  key(table, id) { return `${table}:${id}`; }

  acquire(table, id, clientId, userName) {
    const k = this.key(table, id);
    const existing = this.locks.get(k);
    
    if (existing && existing.clientId !== clientId) {
        // ✅ Возвращаем имя пользователя, который заблокировал
        return { 
            ok: false, 
            by: existing.userName,  // ← имя пользователя
            clientId: existing.clientId 
        };
    }
    
    const now = Date.now();
    this.locks.set(k, {
        clientId, 
        userName,
        timestamp: now,
        lastRenew: now
    });
    
    if (!this.clientLocks.has(clientId)) {
        this.clientLocks.set(clientId, new Set());
    }
    this.clientLocks.get(clientId).add(k);
    
    return { ok: true };
}

  // Продление блокировки (heartbeat от клиента)
  renew(table, id, clientId) {
    const k = this.key(table, id);
    const lock = this.locks.get(k);
    if (!lock || lock.clientId !== clientId) return false;
    lock.timestamp = Date.now();
	lock.lastRenew = Date.now();   // ← добавляем отдельный таймстамп
    return true;
  }

  release(table, id, clientId) {
    const k = this.key(table, id);
    const lock = this.locks.get(k);
    if (!lock || lock.clientId !== clientId) return false;
    this.locks.delete(k);
    const set = this.clientLocks.get(clientId);
    if (set) set.delete(k);
    return true;
  }

  releaseAllByClient(clientId) {
    const set = this.clientLocks.get(clientId);
    if (!set) return [];
    const released = [];
    set.forEach(k => {
      this.locks.delete(k);
      const [table, id] = k.split(':');
      released.push({ table, id });
    });
    this.clientLocks.delete(clientId);
    return released;
  }

  getLocker(table, id) {
    const lock = this.locks.get(this.key(table, id));
    return lock ? { userName: lock.userName, clientId: lock.clientId } : null;
  }

  getAll() {
    const list = [];
    this.locks.forEach((v, k) => {
      const [table, id] = k.split(':');
      list.push({ table, id, userName: v.userName, clientId: v.clientId });
    });
    return list;
  }

  // Автоочистка устаревших блокировок
  _startCleanup() {
    setInterval(() => {
      const now = Date.now();
      let changed = false;
      this.locks.forEach((lock, k) => {
         const lastRenew = lock.lastRenew || lock.timestamp;
        if (now - lastRenew > this.renewTimeout) {
          console.log(`🔓 Auto-release lock (no renew): ${k} by ${lock.userName}`);
          this.locks.delete(k);
          const set = this.clientLocks.get(lock.clientId);
          if (set) set.delete(k);
          changed = true;
        }
      });
      if (changed && this.onChange) this.onChange();
    }, 10000);
  }

  setChangeCallback(cb) { this.onChange = cb; }
}

module.exports = LockManager;