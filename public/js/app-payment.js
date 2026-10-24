// ============================================================
// ТОЧКА ВХОДА: СТРАНИЦА «ОПЛАТА РАБОТ» (✅ T102)
// ============================================================
import { api } from './common/utils.js';
import { initCommonUI } from './common/ui/index.js';
import { connectWs, EditLock, setHandlers } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import { OplataRabot } from './modules/oplataRabot.js';
import { state } from './common/state.js';

function getCurrentEditContext() {
    return {
        table: 'oplata_rabot',
        id: OplataRabot.selectedOplId
    };
}

document.addEventListener('DOMContentLoaded', async () => {
    connectWs();

    initCommonUI({
        contextResolver: getCurrentEditContext,
        onTabChange: () => OplataRabot.updateButtons()
    });

    setHandlers({
        onDataChanged: (msg) => {
            if (EditLock.current?.table === msg.table && EditLock.current?.id === msg.id) return;
            if (msg.table === 'oplata_rabot' || msg.table === 'gryz_poz') {
                if (OplataRabot.selectedOperId) {
                    Promise.all([OplataRabot.loadOpl(), OplataRabot.loadPoz()]);
                }
            }
            if (msg.table === 'transport_oper') {
                OplataRabot.loadOpers();
            }
        },
        updateButtons: () => OplataRabot.updateButtons()
    });

    await OplataRabot.init();

    initResizers();
    resetResizerStylesOnResize();

    await OplataRabot.loadFilters();
    await OplataRabot.loadOpers();
    // ✅ T106: стартовое состояние через resetOperState — фильтры пусты и
    // так, повторная загрузка операций не нужна (полный сброс onHeaderOper
    // теперь только для кликов по заголовкам таблиц)
    OplataRabot.resetOperState();
});
