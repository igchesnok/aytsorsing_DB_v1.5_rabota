// ============================================================
// ТОЧКА ВХОДА: ИНИЦИАЛИЗАЦИЯ ВСЕХ ОБЩИХ UI-ОБРАБОТЧИКОВ
// ============================================================
import { initTabs } from './tabs.js';
import { initAutoLock } from './auto-lock.js';
import { initBlurRelease } from './blur-release.js';
import { initInactivityTracker } from './inactivity.js';
import { enableTabs } from './tabs.js'
// t73: сворачиваемый блок фильтров — общая схема для всех страниц
import '../filters-collapse.js';

/**
 * Единая функция инициализации всех общих UI-обработчиков.
 * Вызывается ОДИН РАЗ на странице.
 *
 * @param {Object} options
 * @param {Function} options.contextResolver - функция, возвращающая {table, id} текущей редактируемой записи
 * @param {Function} [options.onTabChange] - колбэк при смене вкладки
 */
export function initCommonUI({ contextResolver, onTabChange } = {}) {
  initTabs({ onTabChange });
  if (contextResolver) initAutoLock(contextResolver);
  initBlurRelease();
  initInactivityTracker();
}
// ✅ Экспортируем enableTabs для использования в модулях
export { enableTabs };