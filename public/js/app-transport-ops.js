// ============================================================
// app-transport-ops.js — транспортные операции с авто‑синхронизацией
// ============================================================

import { initCommonUI } from './common/ui/index.js';
import { connectWs, EditLock } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';

import { TransportOps } from './modules/transportOps.js';
import { TransportOpsCustomer } from './modules/transportOpsCustomer.js';
import { TransportOpsReceiver } from './modules/transportOpsReceiver.js';
import { TransportOpsDriver } from './modules/transportOpsDriver.js';
import { TransportOpsParams } from './modules/transportOpsParams.js';

import { initSyntheticSync, loadSubscriptions } from './common/synthetic-sync.js';


function getCurrentEditContext() {
  return {
    table: 'transport_oper',
    id: TransportOps._selectedOperId
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  connectWs();

  await loadSubscriptions('/api/synthetic/dependencies');

  initCommonUI({
    contextResolver: getCurrentEditContext,
    onTabChange: () => {}
  });

  initSyntheticSync({
    pageKey: 'transportOps',

    syntheticHandlers: {
      'transportOps.list': () => TransportOps.load(),

      'transportOps.positions': () => {
        if (TransportOps._selectedOperId) {
          TransportOps.refreshCurrentPositions();
        }
        TransportOps.refreshAvailablePositions();
      },

      'transportOps.available': () => TransportOps.refreshAvailablePositions(),

      // Справочники
      'firms.list': () => {
        console.log('[WS] 🔄 Фирмы изменены — обновляем справочники');
        TransportOps.loadReferences();
      },
      'firms.withContracts': () => {
          console.log('[WS] 🔄 Фирмы с договорами изменены — обновляем');
          TransportOps.loadFirms();
      },
      'transportOps.perevozchik': () => {
        console.log('[WS] 🔄 Перевозчики изменены — обновляем справочники');
        TransportOpsDriver.reloadPerevozchiki();
      },

      'kont.list': () => {
        console.log('[WS] 🔄 Контакты изменены — обновляем ПТО и фирму');
        TransportOpsCustomer.reloadPTOContacts();
        TransportOpsReceiver.reloadFirmContacts();
      },

      'adres.list': () => {
        console.log('[WS] 🔄 Адреса изменены — обновляем фирму');
        TransportOpsReceiver.reloadFirmAddresses();
      },
      'dogovor.list': () => {
           console.log('[WS] 🔄 Договоры изменены — обновляем');
           TransportOps.loadReferences();
      },
      'cex.list': () => {
        console.log('[WS] 🔄 Цеха изменены — обновляем параметры');
        TransportOpsParams.reloadCex();
      }
    },

    updateButtons: () =>  TransportOps.updateButtonStates() ,

    onLocksUpdate: () =>  console.log('[WS] 🔄 onLocksUpdate') ,

    onDataChangedExtra: (msg) => {
      // Дополнительная логика страницы
      if (msg.table === 'transport_oper') {
        // ✅ T19: селекты «Тип транспорта»/«Способ загрузки»/«Требование» —
        // ЖЁСТКИЕ списки, история не нужна; «Наименование» (Т17) —
        // история обновляется после записи операции
        TransportOpsParams.loadGruzNames();
      }
    }
  });

  await TransportOps.init();
  initResizers();
  resetResizerStylesOnResize();
  await TransportOps.load();
  TransportOps.onHeaderClick();
});
