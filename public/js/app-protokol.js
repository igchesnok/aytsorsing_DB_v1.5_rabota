import { api, toast } from './common/utils.js';
import { initCommonUI } from './common/ui/index.js';
import { connectWs, setHandlers } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import { Meeting } from './modules/meeting.js';
import { state } from './common/state.js';

// Таблицы, изменение которых должно обновлять список совещания
const WATCHED_TABLES = new Set([
  'fakt_marshruta', 'operatsii_marshruta', 'transport_oper',
  'gryz_poz', 'plan_perevozok', 'shagi_marshruta'
]);

document.addEventListener('DOMContentLoaded', async () => {
  connectWs();

  initCommonUI();

  setHandlers({
    onDataChanged: async (msg) => {
      if (!WATCHED_TABLES.has(msg.table)) return;
      // обновляем список; затем перечитываем открытую карточку,
      // если её партия ещё в списке
      await Meeting.loadAll();
      if (Meeting.selectedGpId) {
        const row = Meeting._positions.find(p => p.gp_id === Meeting.selectedGpId);
        if (row) await Meeting.onSelect(row);
      }
    }
  });

  await Meeting.init();

  initResizers();
  resetResizerStylesOnResize();

  await Meeting.loadFirms();
  await Meeting.loadPositions();
});
