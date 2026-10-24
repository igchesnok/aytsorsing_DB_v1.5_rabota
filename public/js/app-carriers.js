// ============================================================
// public/js/app-carriers.js
// СПРАВОЧНИК ПЕРЕВОЗЧИКОВ — единая точка входа (CrudModule)
// ============================================================
import { api } from './common/utils.js';
import { createSimpleCrudApp } from './common/simple-crud-app.js';
import carriersConfig from './configs/carriers.config.js';

export const Carriers = createSimpleCrudApp(carriersConfig, {
  tableContainerId: 'carriersTable',
  formTitleId: 'carriersFormTitle',
  buttons: {
    add:   'btnCarriersAdd',
    save:  'btnCarriersSave',
    del:   'btnCarriersDel',
    paste: 'btnCarriersPaste',   // ✅ НОВАЯ кнопка — нужен HTML <button id="btnCarriersPaste">
  },

  // Сохраняем хук автовыделения записи из URL-параметра ?editId=XXX
  hooks: {
    afterLoad: (module) => {
      const urlParams = new URLSearchParams(window.location.search);
      const editId = urlParams.get('editId');
      if (editId) {
        // setTimeout(0) — чтобы выполнилось ПОСЛЕ _onHeaderClick()
        // в createSimpleCrudApp
        setTimeout(() => {
          const row = module.table.data.find(r => r.id === editId);
          if (row) {
            module.table.selectById(editId);
            module._onSelect(row);
          }
        }, 0);
      }
    },
  },

  // ============================================================
  // ИМПОРТ ИЗ БУФЕРА (clipboard-import.js v3.0)
  // ============================================================
  // БД perevozchik: marka_tc, gos_n, vodit_ud, fio_vodit, kontakt, firma
  //
  // Порядок колонок в Excel:
  //   Марка ТС | Гос. номер * | Удостоверение * | ФИО водителя | Контакт | Фирма *
  //
  // ✅ Обязательные поля (соответствуют серверной валидации):
  //    gos_n + vodit_ud + firma
  //
  // ✅ Уникальность определяется связкой: gos_n + vodit_ud
  //    (на сервере именно эта пара проверяется в POST и PUT).
  //
  // При дубликате: PUT-обновление по id.
  importConfig: {
    fields: ['marka_tc', 'gos_n', 'vodit_ud', 'fio_vodit', 'kontakt', 'firma'],
    requiredFields: ['gos_n', 'vodit_ud', 'firma'],   // ✅ все три обязательны
    columnHints: [
      'Марка ТС',
      'Гос. номер *',
      'Удостоверение *',
      'ФИО водителя',
      'Контакт',
      'Фирма *',
    ],

    // Дедупликация по паре (gos_n, vodit_ud) — как на сервере.
    // Нормализация: trim + lower + удаляем все пробелы
    // (чтобы "А 123 БВ 77" и "а123бв77" считались одним ключом).
    isDuplicate: (existingRow, newObj) => {
      const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
      return norm(existingRow.gos_n)    === norm(newObj.gos_n) &&
             norm(existingRow.vodit_ud) === norm(newObj.vodit_ud);
    },

    // PUT-обновление: новые значения затирают старые, пустые — сохраняют старое.
    // Обязательные поля (gos_n, vodit_ud, firma) берём через || — гарантированно
    // останутся заполненными (либо новым значением, либо существующим).
    // Опциональные — через ??, чтобы пустое значение в Excel не затёрло старое.
    onDuplicate: async (existingRow, newObj) => {
      const payload = {
        marka_tc:  newObj.marka_tc  || existingRow.marka_tc  || '',
        gos_n:     newObj.gos_n     || existingRow.gos_n,
        vodit_ud:  newObj.vodit_ud   || existingRow.vodit_ud,
        fio_vodit: newObj.fio_vodit ?? existingRow.fio_vodit ?? '',
        kontakt:   newObj.kontakt   ?? existingRow.kontakt   ?? '',
        firma:     newObj.firma     || existingRow.firma,
      };
      const r = await api('PUT', `/api/perevozchik/${existingRow.id}`, payload);
      if (r.error) throw new Error(r.error);
    },
  },
});
