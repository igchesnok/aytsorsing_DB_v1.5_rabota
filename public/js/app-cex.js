// ============================================================
// public/js/app-cex.js
// СПРАВОЧНИК ЦЕХОВ ЗАТРАТ — единая точка входа
// ============================================================
import { api } from './common/utils.js';
import { createSimpleCrudApp } from './common/simple-crud-app.js';
import cexConfig from './configs/cex.config.js';

export const Cex = createSimpleCrudApp(cexConfig, {
    tableContainerId: 'cexTable',
    formTitleId: 'cexFormTitle',
    buttons: {
        add:   'btnCexAdd',
        save:  'btnCexSave',
        del:   'btnCexDel',
        paste: 'btnCexPaste',
    },

    // ============================================================
    // ИМПОРТ ИЗ БУФЕРА (clipboard-import.js v3.0)
    // ============================================================
    // БД cex_zatrat: ceh, peredel, nazvanie (NOT NULL), nach_ceha, telefon, email
    // Порядок колонок в Excel: Цех | Передел | Название | Нач. цеха | Телефон | Email
    // Дубликат: по составному ключу (ceh, peredel, nazvanie)
    // При дубликате: PUT-обновление по id
    importConfig: {
        fields: ['ceh', 'peredel', 'nazvanie', 'nach_ceha', 'telefon', 'email'],
        requiredFields: ['ceh', 'peredel', 'nazvanie'],
        columnHints: [
            'Цех',
            'Передел',
            'Название',
            'Нач. цеха',
            'Телефон',
            'Email',
        ],

        // Дедупликация по составному бизнес-ключу
        isDuplicate: (existingRow, newObj) => {
            const eq = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
            return eq(existingRow.ceh, newObj.ceh) &&
                   eq(existingRow.peredel, newObj.peredel) &&
                   eq(existingRow.nazvanie, newObj.nazvanie);
        },

        // PUT-обновление: новые значения затирают старые, пустые — сохраняют старое
        onDuplicate: async (existingRow, newObj) => {
            const payload = {
                ceh:       newObj.ceh       || existingRow.ceh,
                peredel:   newObj.peredel   || existingRow.peredel,
                nazvanie:  newObj.nazvanie  || existingRow.nazvanie,
                nach_ceha: newObj.nach_ceha ?? existingRow.nach_ceha ?? '',
                telefon:   newObj.telefon   ?? existingRow.telefon   ?? '',
                email:     newObj.email     ?? existingRow.email     ?? '',
            };
            const r = await api('PUT', `/api/cex/${existingRow.id}`, payload);
            if (r.error) throw new Error(r.error);
        },
    },
});
