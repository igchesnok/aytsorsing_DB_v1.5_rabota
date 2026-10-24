// ============================================================
// public/js/app-transport-types.js
// ТОЧКА ВХОДА: СТРАНИЦА ТИПОВ ПЕРЕВОЗОК
// Переписано под методику CrudModule (как страница Плана)
// ============================================================
import { createSimpleCrudApp } from './common/simple-crud-app.js';
import transportTypesConfig from './configs/transportTypes.config.js';

export const TransportTypes = createSimpleCrudApp(transportTypesConfig, {
    tableContainerId: 'ttTable',
    formTitleId: 'ttFormTitle',
    buttons: {
        add:  'btnTTAdd',
        save: 'btnTTSave',
        del:  'btnTTDel',
    },
    hooks: {
        // При выборе записи — блокируем ID (это PK, менять нельзя)
        onSelect: (row, module) => {
            const idInput = document.getElementById('ttIdTipa');
            if (idInput) {
                idInput.disabled = true;
                idInput.title = 'ID нельзя изменить (это первичный ключ)';
            }
        },
        // При клике на заголовок (новая запись) — разблокируем ID
        onHeaderClick: (module) => {
            const idInput = document.getElementById('ttIdTipa');
            if (idInput) {
                idInput.disabled = false;
                idInput.title = '';
            }
        },
    },
});