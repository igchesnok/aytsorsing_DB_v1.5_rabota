// ============================================================
// app-orders.js — точка входа: страница заказов по договорам
// ============================================================

import { initCommonUI } from './common/ui/index.js';
import { connectWs, EditLock } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import { Orders } from './modules/orders.js';
import { initSyntheticSync, loadSubscriptions } from './common/synthetic-sync.js';

function getCurrentEditContext() {
  return {
    table: 'zakaz_po_dogovoru',
    id: Orders._selectedZakazId
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  connectWs();

  await loadSubscriptions();

  initCommonUI({
    contextResolver: getCurrentEditContext,
    onTabChange: () => Orders.updateButtonStates()
  });

  // ЕДИНАЯ точка настройки WS‑обработчиков
  initSyntheticSync({
    pageKey: 'orders',

    syntheticHandlers: {
      'orders.zakazy': () => Orders.load(),

      'orders.positions': () => {
        if (Orders._selectedZakazId) {
          Orders.loadPositions(Orders._selectedZakazId);
        }
        Orders.refreshAvailablePositions();
      },

      'orders.available': () => Orders.refreshAvailablePositions(),

      'dogovor.list': () => Orders.reloadDogovory()
    },

    updateButtons: () => Orders.updateButtonStates(),

    onLocksUpdate: () => {},

    onDataChangedExtra: (msg) => {
      // Дополнительная логика страницы
      if (msg.table === 'dogovor') { }
    }
  });

  await Orders.init();
  initResizers();
  resetResizerStylesOnResize();
  await Orders.load();
  Orders.onHeaderClick();
});
