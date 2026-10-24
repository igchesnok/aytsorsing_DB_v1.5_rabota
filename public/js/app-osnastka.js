// ============================================================
// public/js/app-osnastka.js
// СПРАВОЧНИК ОСНАСТКИ — единая точка входа (CrudModule)
// ============================================================
import { api } from './common/utils.js';
import { createSimpleCrudApp } from './common/simple-crud-app.js';
import osnastkaConfig from './configs/osnastka.config.js';

export const Osnastka = createSimpleCrudApp(osnastkaConfig, {
  tableContainerId: 'osnTable',
  formTitleId: 'osnFormTitle',
  buttons: {
    add:   'btnOsnAdd',
    save:  'btnOsnSave',
    del:   'btnOsnDel',
    paste: 'btnOsnPaste',
  },

  // ============================================================
  // ИМПОРТ ИЗ БУФЕРА (clipboard-import.js v3.0)
  // ============================================================
  // Порядок колонок как в Excel/1С (19 полей).
  // БД: nomer_chertezha UNIQUE → при совпадении делаем PUT-обновление.
  //
  // Чекбоксы (5 шт.) — обрабатываются через booleanFields:
  //   понимает 1/0, true/false, да/нет, yes/no, истина/ложь, вкл/выкл, on/off.
  //
  // Числовые поля (11 шт.) — обработка через numericFields:
  //   "1 234,56" → 1234.56 (пробелы убираются, запятая → точка).
  //
  // columnHints задаём явно, чтобы пользователь видел подсказку
  // "(0/1)" для чекбоксов и понимал формат ввода.
  importConfig: {
    fields: [
      'nomer_chertezha',          // 1
      'naimenovanie',             // 2
      'avto_mob_det',             // 3
      'ves_det',                  // 4
      'ves_zag',                  // 5
      'trudoemkost_pto',          // 6
      'dlina',                    // 7
      'shirina',                  // 8
      'vysota',                   // 9
      'nitrocementaciya',         // 10
      'zakalka',                  // 11
      'ppd',                      // 12
      'pokrytie',                 // 13
      'tisnenie',                 // 14
      'cena_zagotovki',           // 15
      'trudoemkost_frez_universal', // 16
      'trudoemkost_frez_chpu',    // 17
      'trudoemkost_tokarn',       // 18
      'trudoemkost_tokarn_chpu',  // 19
    ],
    requiredFields: ['nomer_chertezha'],
    booleanFields: ['nitrocementaciya', 'zakalka', 'ppd', 'pokrytie', 'tisnenie'],
    numericFields: [
      'ves_det', 'ves_zag', 'trudoemkost_pto',
      'dlina', 'shirina', 'vysota',
      'cena_zagotovki', 'trudoemkost_frez_universal',
      'trudoemkost_frez_chpu', 'trudoemkost_tokarn', 'trudoemkost_tokarn_chpu'
    ],
    booleanTrueValues:  ['1', 'true', 'да', 'yes', 'истина', 'истинно', 'вкл', 'on'],
    booleanFalseValues: ['0', 'false', 'нет', 'no', 'ложь', 'ложно', 'выкл', 'off'],

    // ✅ Явные заголовки для подсказки в модалке
    columnHints: [
      '№ чертежа',
      'Наименование',
      'Авто/Моб/Дет',
      'Вес дет.',
      'Вес заг.',
      'Трудоёмкость ПТО',
      'Длина',
      'Ширина',
      'Высота',
      'TONA (0/1)',
      'ТО-закалка (0/1)',
      'ППД (0/1)',
      'Покрытие (0/1)',
      'Тиснение (0/1)',
      'Цена заготовки',
      'Фрез. универс.',
      'Фрез. ЧПУ',
      'Токарн.',
      'Токарн. ЧПУ',
    ],

    // ✅ Дедупликация по номеру чертежа (UNIQUE в БД)
    isDuplicate: (existingRow, newObj) =>
      String(existingRow.nomer_chertezha ?? '').trim().toLowerCase() ===
      String(newObj.nomer_chertezha ?? '').trim().toLowerCase(),

    // ✅ При дубликате — PUT-обновление по id
    // Все поля: новые значения затирают старые, пустые — сохраняют старое
    onDuplicate: async (existingRow, newObj) => {
      const payload = {
        nomer_chertezha:             newObj.nomer_chertezha             || existingRow.nomer_chertezha,
        naimenovanie:                newObj.naimenovanie                ?? existingRow.naimenovanie               ?? '',
        avto_mob_det:                newObj.avto_mob_det                ?? existingRow.avto_mob_det               ?? '',
        ves_det:                     newObj.ves_det                     ?? existingRow.ves_det                    ?? '',
        ves_zag:                     newObj.ves_zag                    ?? existingRow.ves_zag                    ?? '',
        trudoemkost_pto:             newObj.trudoemkost_pto             ?? existingRow.trudoemkost_pto            ?? '',
        dlina:                       newObj.dlina                       ?? existingRow.dlina                      ?? '',
        shirina:                     newObj.shirina                     ?? existingRow.shirina                    ?? '',
        vysota:                      newObj.vysota                      ?? existingRow.vysota                     ?? '',
        // ✅ Чекбоксы: 0 тоже валидное значение → используем ?? а не ||
        nitrocementaciya:            newObj.nitrocementaciya            ?? existingRow.nitrocementaciya           ?? 0,
        zakalka:                     newObj.zakalka                     ?? existingRow.zakalka                    ?? 0,
        ppd:                         newObj.ppd                         ?? existingRow.ppd                        ?? 0,
        pokrytie:                    newObj.pokrytie                    ?? existingRow.pokrytie                   ?? 0,
        tisnenie:                    newObj.tisnenie                    ?? existingRow.tisnenie                   ?? 0,
        cena_zagotovki:              newObj.cena_zagotovki              ?? existingRow.cena_zagotovki             ?? 0,
        trudoemkost_frez_universal:  newObj.trudoemkost_frez_universal  ?? existingRow.trudoemkost_frez_universal ?? 0,
        trudoemkost_frez_chpu:       newObj.trudoemkost_frez_chpu       ?? existingRow.trudoemkost_frez_chpu      ?? 0,
        trudoemkost_tokarn:          newObj.trudoemkost_tokarn          ?? existingRow.trudoemkost_tokarn         ?? 0,
        trudoemkost_tokarn_chpu:     newObj.trudoemkost_tokarn_chpu     ?? existingRow.trudoemkost_tokarn_chpu    ?? 0,
      };
      const r = await api('PUT', `/api/osnastka/${existingRow.id}`, payload);
      if (r.error) throw new Error(r.error);
    },
  },

  // postProcess для вычисляемой колонки _tech (ТО/ППД/Покр/Тисн/TONA)
  tableOptions: {
    postProcess: (data) => {
      data.forEach(row => {
        const flags = [];
        if (row.zakalka) flags.push('ТО');
        if (row.ppd) flags.push('ППД');
        if (row.pokrytie) flags.push('Покр');
        if (row.tisnenie) flags.push('Тисн');
        if (row.nitrocementaciya) flags.push('TONA');
        row._tech = flags.join('/');
      });
      return data;
    },
  },
});
