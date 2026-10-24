

// ============================================================
// public/js/app-requests.js
// ТОЧКА ВХОДА: ЗАПРОСЫ КП
// Минимальная точка входа — вся логика в modules/requests.js
// ============================================================
import { initCommonUI } from './common/ui/index.js';
import { connectWs, EditLock } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import { Requests } from './modules/requests.js';
import { initSyntheticSync, loadSubscriptions } from './common/synthetic-sync.js';
import { DirtyGuard } from './common/dirty-guard.js';

// ============================================================
// 1. РЕЗОЛВЕР КОНТЕКСТА ДЛЯ АВТОБЛОКИРОВКИ
// ============================================================
function getCurrentEditContext() {
  return { table: 'zapros_kp', id: Requests._selectedZaprosId };
}

// ============================================================
// 2. ТОЧКА ВХОДА
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  connectWs();

  // Загружаем серверный маппинг зависимостей синтетических таблиц
  await loadSubscriptions();

  // Единый UI: вкладки, автоблокировка, blur, inactivity
  initCommonUI({
    contextResolver: getCurrentEditContext,
    onTabChange: () => Requests.updateButtonStates()
  });

  // ============================================================
  // 3. ЕДИНАЯ ДЕКЛАРАТИВНАЯ КОНФИГУРАЦИЯ WS-СИНХРОНИЗАЦИИ
  // ============================================================
  initSyntheticSync({
    pageKey: 'requests',
    syntheticHandlers: {
      // Запрос изменился → перезагружаем таблицу + форму
      'requests.zaprosy': async () => {
        await Requests.load();
      },

      // Доступные детали изменились (план/оснастка) → перезагружаем список
      'requests.available': async () => {
        if (Requests._selectedZaprosId) {
          await Requests._detaliBlock?.reloadAvailable();
        }
      },

      // Справочники
      'firms.list': () => Requests.loadFirmy(),
      'tech.list': () => Requests.loadTech(),

      // КП изменились → перезагружаем выбранные детали/фирмы
      'requests.kp': async () => {
        await Requests.loadAllKp();
        if (Requests._selectedZaprosId) {
          if (typeof DirtyGuard._isDirty === 'function' && DirtyGuard._isDirty()) {
            toast('🛡 Автообновление блоков пропущено — есть несохранённые изменения', 'warning');
            return;
          }
          // Инвалидируем кэш КП и перезагружаем оба блока
          Requests._cachedKpPromise = null;
          Requests._cachedKpZaprosId = null;
          await Requests._detaliBlock?.load(Requests._selectedZaprosId);
          await Requests._firmyBlock?.load(Requests._selectedZaprosId);
        }
      },

      // Контакты изменились → обновляем email в выбранных фирмах
      'kont.list': async () => {
        if (Requests._selectedZaprosId) {
          await Requests.refreshFirmEmails();
        }
      }
    },
    updateButtons: () => Requests.updateButtonStates(),
    onLocksUpdate: () => Requests._syncFormLockState()
  });

  // ============================================================
  // 4. ИНИЦИАЛИЗАЦИЯ МОДУЛЯ
  // ============================================================
  await Requests.init();

  // ============================================================
  // 5. ИНТЕГРАЦИЯ С DirtyGuard
  // ============================================================
  // Вся логика dirty теперь через customDirtyCheck
  DirtyGuard.register(
    Requests._formStateManager,
    () => Requests.save(),
    () => Requests.onHeaderClick(),
    () => Requests.isDirty() // ✅ Форма + блоки (детали/фирмы)
  );

  // Регистрируем callback отката блоков для модалки DirtyGuard
  DirtyGuard.registerRevertCallback(async () => {
    await Requests.revertBlocks();
  });

  // ============================================================
  // 6. ИНИЦИАЛИЗАЦИЯ UI
  // ============================================================
  initResizers();
  resetResizerStylesOnResize();

  // Первичная загрузка
  await Requests.load();
  Requests.onHeaderClick();
});