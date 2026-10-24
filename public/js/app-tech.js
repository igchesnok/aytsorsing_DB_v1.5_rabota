// ============================================================
// public/js/app-tech.js
// СПРАВОЧНИК ТЕХНОЛОГОВ — единая точка входа (CrudModule)
// ============================================================
import { api } from './common/utils.js';
import { createSimpleCrudApp } from './common/simple-crud-app.js';
import techConfig from './configs/tech.config.js';

export const Tech = createSimpleCrudApp(techConfig, {
  tableContainerId: 'techTable',
  formTitleId: 'techFormTitle',
  buttons: {
    add:   'btnTechAdd',
    save:  'btnTechSave',
    del:   'btnTechDel',
    paste: 'btnTechPaste',
  },

  // ============================================================
  // ИМПОРТ ИЗ БУФЕРА (clipboard-import.js v3.0)
  // ============================================================
  // БД tech: fio (NOT NULL), email, telefon, tip_osnastki
  // Порядок колонок в Excel: ФИО | Email | Телефон | Тип оснастки
  // Дубликат: по ФИО (case-insensitive). Если у вас бывают однофамильцы —
  //   добавьте в isDuplicate проверку по email.
  // При дубликате: PUT-обновление по id
  importConfig: {
    fields: ['fio', 'email', 'telefon', 'tip_osnastki'],
    requiredFields: ['fio'],
    columnHints: [
      'ФИО',
      'Email',
      'Телефон',
      'Тип оснастки',
    ],

    // Дедупликация по ФИО (case-insensitive, с trim)
    isDuplicate: (existingRow, newObj) =>
      String(existingRow.fio ?? '').trim().toLowerCase() ===
      String(newObj.fio ?? '').trim().toLowerCase(),

    // PUT-обновление
    onDuplicate: async (existingRow, newObj) => {
      const payload = {
        fio:          newObj.fio          || existingRow.fio,
        email:        newObj.email        ?? existingRow.email        ?? '',
        telefon:      newObj.telefon      ?? existingRow.telefon      ?? '',
        tip_osnastki: newObj.tip_osnastki ?? existingRow.tip_osnastki ?? '',
      };
      const r = await api('PUT', `/api/tech/${existingRow.id}`, payload);
      if (r.error) throw new Error(r.error);
    },
  },
});
