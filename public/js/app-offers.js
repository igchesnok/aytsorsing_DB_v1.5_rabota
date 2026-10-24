// ============================================================
// public/js/app-offers.js
// ТОЧКА ВХОДА: ВНЕСЕНИЕ КОММЕРЧЕСКИХ ПРЕДЛОЖЕНИЙ
// Архитектура строго аналогична app-requests.js:
//   FormStateManager + registerLockAwareRecord +
//   checkForExternalChanges + DirtyGuard + initSyntheticSync +
//   batchManager.withBatch + dispatchCrudCompleted
// ============================================================
import { initCommonUI } from './common/ui/index.js';
import { connectWs, EditLock } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import { Offers } from './modules/offers.js';
import { initSyntheticSync, loadSubscriptions } from './common/synthetic-sync.js';
import { DirtyGuard } from './common/dirty-guard.js';

// ============================================================
// 1. РЕЗОЛВЕР КОНТЕКСТА ДЛЯ АВТОБЛОКИРОВКИ
// ============================================================
function getCurrentEditContext() {
  return { table: 'kp', id: Offers._selectedKpId };
}

// ============================================================
// 2. ТОЧКА ВХОДА
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  connectWs();
  await loadSubscriptions();

  // Единый UI: вкладки, автоблокировка, blur, inactivity
  initCommonUI({
    contextResolver: getCurrentEditContext,
    onTabChange: () => Offers.updateButtonStates(),
  });

  // ============================================================
  // 3. ЕДИНАЯ ДЕКЛАРАТИВНАЯ КОНФИГУРАЦИЯ WS-СИНХРОНИЗАЦИИ
  // ============================================================
  initSyntheticSync({
    pageKey: 'offers',
    syntheticHandlers: {
      // Статус запроса изменился → обновляем лейбл + комбобокс
      'offers.status': async () => {
        if (Offers._selectedZaprosId) {
          await Offers._refreshStatusLabel();
        }
        await Offers.loadZaprosy();
      },
      // КП изменились → перезагружаем детали и сводную
      'offers.kp': async () => {
        if (Offers._selectedZaprosId) {
          await Offers._reloadKPAndSummary();
          if (Offers._selectedFirmaId) {
            await Offers.onFirmaChange();
          }
        }
      },
      // План изменился → обновляем комбобокс запросов
      'plan.list': async () => {
        if (Offers._selectedZaprosId) {
          await Offers.loadZaprosy();
        }
      },
      // Справочники
      'dogovor.list': () => Offers._reloadDogovory(),
      'firms.list': () => Offers._reloadDogovory(),
    },
    updateButtons: () => Offers.updateButtonStates(),
    onLocksUpdate: () => {
      Offers._syncFormLockState();
      Offers.updateButtonStates();   // ← ДОБАВЛЕНО
    },
    onDataChangedExtra: (msg) => {
      if (msg.table === 'zapros_kp') {
        Offers.loadZaprosy();
      }
    },
  });

  // ============================================================
  // 4. ИНИЦИАЛИЗАЦИЯ МОДУЛЯ
  // ============================================================
  await Offers.init();

  // ============================================================
  // 5. ИНТЕГРАЦИЯ С DirtyGuard (как в app-requests.js)
  // ============================================================
  DirtyGuard.register(
    Offers._formStateManager,
    () => Offers.saveSingleKP(),
    () => Offers.onHeaderClick(),
    () => Offers.isDirty()
  );

  // ============================================================
  // 6. ИНИЦИАЛИЗАЦИЯ UI
  // ============================================================
  initResizers();
  resetResizerStylesOnResize();

  // Первичная загрузка
  await Offers.loadZaprosy();
  Offers.onHeaderClick();
});