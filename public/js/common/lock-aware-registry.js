// ============================================================
// public/js/common/lock-aware-registry.js
// ЕДИНЫЙ ЯВНЫЙ ИНТЕРФЕЙС для записей, участвующих в авто-блокировке.
// ============================================================
const _registry = new Map();

/**
 * @param {string} entity — имя таблицы БД (используется в EditLock/isLocked)
 * @param {Object} api
 * @param {Object} [api.form] — FormStateManager (если используется)
 * @param {Function} [api.isDirty] — Альтернатива form: () => boolean (для составных форм)
 * @param {Function} api.save — () => Promise<void>|void
 * @param {Function} api.onHeaderClick — () => Promise<void>|void (очистка формы / сброс выбора)
 * @param {Function} [api.checkForExternalChanges] — () => Promise<{changed, deleted, ...}>
 */

export function registerLockAwareRecord(entity, api) {
  if (!entity) throw new Error('registerLockAwareRecord: entity обязателен');
  if (!api || typeof api.save !== 'function' || typeof api.onHeaderClick !== 'function') {
    throw new Error(`registerLockAwareRecord(${entity}): api.save и api.onHeaderClick обязательны`);
  }
  // Теперь разрешено иметь И form (для отката), И isDirty (для комбинированной проверки)
  if (!api.form && typeof api.isDirty !== 'function') {
    throw new Error(`registerLockAwareRecord(${entity}): нужен либо api.form, либо api.isDirty`);
  }
  _registry.set(entity, api);
}
export function getLockAwareRecord(entity) {
  return _registry.get(entity) || null;
}

export function unregisterLockAwareRecord(entity) {
  _registry.delete(entity);
}