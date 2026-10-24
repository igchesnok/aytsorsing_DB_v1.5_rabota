// app-firms.js
import { MasterDetailModule } from './common/master-detail-module.js';
import { initCommonUI } from './common/ui/index.js';
import { connectWs, EditLock, setHandlers } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import firmsConfig from './configs/firms.config.js';

const Firms = new MasterDetailModule(firmsConfig);

document.addEventListener('DOMContentLoaded', async () => {
  connectWs();
  
  // Единый резолвер контекста для авто-блокировок (auto-lock.js) и DirtyGuard
  initCommonUI({
    contextResolver: () => {
      const activeTab = document.querySelector('.tab.active');
      if (!activeTab) return null;
      
      const tabId = activeTab.dataset.tab;
      
      if (tabId === 'tabFirma') {
        return { table: 'firmy', id: Firms.selectedMasterId };
      }
      
      if (tabId === 'tabUslov') {
        const uslov = Firms.getStandalone('sprav_uslov');
        return { table: 'sprav_uslov', id: uslov?.selectedId };
      }
      
      for (const childCfg of firmsConfig.children) {
        if (childCfg.tabId === tabId) {
          const child = Firms.getChild(childCfg.entity);
          return { table: childCfg.entity, id: child?.selectedId };
        }
      }
      return null;
    },
    onTabChange: (tabId) => {
      if (tabId === 'tabFirma') Firms.getMaster().updateButtonStates();
      if (tabId === 'tabUslov') Firms.getStandalone('sprav_uslov')?.updateButtonStates();
      
      for (const childCfg of firmsConfig.children) {
        if (childCfg.tabId === tabId) {
          Firms.getChild(childCfg.entity)?.updateButtonStates();
        }
      }
    }
  });

  // Глобальные WebSocket-обработчики для страницы
  setHandlers({
    onDataChanged: (msg) => {
      if (EditLock.current?.table === msg.table && EditLock.current?.id === msg.id) return;
      
      if (msg.table === 'firmy') Firms.getMaster().load();
      if (msg.table === 'sprav_uslov') Firms.getStandalone('sprav_uslov')?.load();
      
      // НОВОЕ: Проверяем, выбрана ли фирма, и только тогда грузим дочерние
      if (Firms.selectedMasterId) {
        if (msg.table === 'fakt_adres') Firms.getChild('fakt_adres')?.load();
        if (msg.table === 'kont') Firms.getChild('kont')?.load();
        if (msg.table === 'dogovor') Firms.getChild('dogovor')?.load();
      }
    },
    updateButtons: () => {
      Firms.getMaster().updateButtonStates();
      for (const child of Object.values(Firms.children)) {
        child.updateButtonStates();
      }
      Firms.getStandalone('sprav_uslov')?.updateButtonStates();
    },
    // ✅ НОВОЕ: Синхронизация баннеров на всех формах при обновлении блокировок
    onLocksUpdate: () => {
      Firms.getMaster()._syncFormLockState();
      for (const child of Object.values(Firms.children)) {
        child._syncFormLockState();
      }
      Firms.getStandalone('sprav_uslov')?._syncFormLockState();
    }
  });

  // Инициализация модулей
  await Firms.init();
  
  // Инициализация ресайзеров
  initResizers();
  resetResizerStylesOnResize();
  
  // Загрузка данных
  await Firms.loadMaster();
  await Firms.loadStandalone();
  
  // Сброс к новой записи мастера (очистка формы и блокировка дочерних вкладок)
  Firms.getMaster()._onHeaderClick();
});