// ============================================================
// public/js/common/simple-crud-app.js
// Фабрика для создания простых справочников
// ============================================================
import { initCommonUI } from './ui/index.js';
import { connectWs } from './websocket.js';
import { initResizers, resetResizerStylesOnResize } from './resizer.js';
import { CrudModule } from './crud-module.js';

/**
 * Создаёт и инициализирует простое CRUD-приложение.
 *
 * @param {Object} config — конфиг сущности (из configs/*.config.js)
 * @param {Object} opts — опции CrudModule
 * @param {string} opts.tableContainerId
 * @param {string} opts.formTitleId
 * @param {Object} opts.buttons — { add, save, del, paste? }
 * @param {Object} [opts.importConfig]
 * @param {Object} [opts.hooks]
 * @returns {CrudModule} — созданный экземпляр (для доступа извне)
 */
export function createSimpleCrudApp(config, opts) {
    const module = new CrudModule(config, opts);

    document.addEventListener('DOMContentLoaded', async () => {
        connectWs();
        initCommonUI({
            contextResolver: module.contextResolver,
            onTabChange: () => module.updateButtonStates()
        });

        module.init();
        initResizers();
        resetResizerStylesOnResize();
        await module.load();
        module._onHeaderClick();
    });

    return module;
}