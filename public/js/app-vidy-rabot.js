// public/js/app-vidy-rabot.js
// ТОЧКА ВХОДА: ВИДЫ РАБОТ ПО ДОГОВОРАМ
import { initCommonUI } from './common/ui/index.js';
import { connectWs, EditLock, setHandlers } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import { VidyRabot } from './modules/vidyRabot.js';
import { DirtyGuard } from './common/dirty-guard.js';
import { state } from './common/state.js';   // ← ДОБАВЛЕН ИМПОРТ
import { registerLockAwareRecord } from './common/lock-aware-registry.js';   // ← ДОБАВЛЕН ИМПОРТ

function getCurrentEditContext() {
  return {
    table: 'vidy_rabot_dogovor',
    id: VidyRabot._selectedVrId,
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  connectWs();

  initCommonUI({
    contextResolver: getCurrentEditContext,
    onTabChange: () => VidyRabot.updateButtonStates(),
  });

  // ✅ Регистрация в реестре lock-aware (для авто-блокировки и DirtyGuard)
  registerLockAwareRecord('vidy_rabot_dogovor', {
    isDirty: () => VidyRabot.isDirty(),
    save: () => VidyRabot.save(),
    onHeaderClick: () => VidyRabot.onHeaderClick(),
  });

  setHandlers({
    onDataChanged: (msg) => {
      if (EditLock.current?.table === msg.table && EditLock.current?.id === msg.id) return;
      if (msg.table === 'vidy_rabot_dogovor' || msg.table === 'dogovor' || msg.table === 'firmy') {
        if (msg.table === 'vidy_rabot_dogovor' && VidyRabot._selectedDogovorId) {
          VidyRabot.load();
        }
        if (msg.table === 'firmy' || msg.table === 'dogovor') {
          VidyRabot.loadReferences().then(() => {
            if (VidyRabot._selectedFirmaId) VidyRabot.onFirmaChange();
          });
        }
      }
    },
    updateButtons: () => VidyRabot.updateButtonStates(),
    onLocksUpdate: () => {
      // Перерисовка таблицы с учётом блокировок
      if (state.tables.vidy_rabot) state.tables.vidy_rabot.refresh();   // ← теперь state доступен
    },
  });

  // DirtyGuard
  DirtyGuard.register(
    null,
    () => VidyRabot.save(),
    () => VidyRabot.onHeaderClick(),
    () => VidyRabot.isDirty()
  );

  await VidyRabot.init();

  const btnPaste = document.getElementById('btnVrPaste');
  if (btnPaste) {
    btnPaste.onclick = () => VidyRabot.pasteFromClipboard();
  }

  initResizers();
  resetResizerStylesOnResize();
  VidyRabot.updateButtonStates();
});