// ============================================================
// public/js/configs/osnastka.config.js 
// КОНФИГ: Оснастка — единый источник истины
// ============================================================
export default {
  entity: 'osnastka',
  apiUrl: '/api/osnastka',
  idKey: 'id',
  tableTitle: 'Данные оснастки',
  wsSync: true,

  fields: [
    {
      key: 'nomer_chertezha', label: '№ чертежа', domId: 'oNomer',
      type: 'text', required: true,
      filter: true, filterId: 'fltNomer',
      table: true, tableWidth: 120,
    },
    {
      key: 'naimenovanie', label: 'Наименование', domId: 'oNaim',
      type: 'text', required: false,
      filter: true, filterId: 'fltNaim',
      table: true, tableWidth: 200,
    },
    {
      key: 'avto_mob_det', label: 'Авто/Моб/Дет', domId: 'oAvto',
      type: 'text', required: false,
      filter: true, filterId: 'fltAvto',
      table: true, tableWidth: 100,
    },
    {
      key: 'marka_materiala', label: 'Марка материала', domId: 'oMarka',
      type: 'text', required: false, table: true, tableWidth: 110,
    },
    {
      key: 'ves_det', label: 'Вес дет.', domId: 'oVesDet',
      type: 'text', required: false, table: true, tableWidth: 70,
    },
    {
      key: 'ves_zag', label: 'Вес заг.', domId: 'oVesZag',
      type: 'text', required: false, table: false,
    },
    {
      key: 'trudoemkost_pto', label: 'Трудоёмкость ПТО', domId: 'oTrudPTO',
      type: 'text', required: false, table: false,
    },
    {
      key: 'dlina', label: 'Длина', domId: 'oDlina',
      type: 'text', required: false, table: true, tableWidth: 60,
    },
    {
      key: 'shirina', label: 'Ширина', domId: 'oShirina',
      type: 'text', required: false, table: true, tableWidth: 60,
    },
    {
      key: 'vysota', label: 'Высота', domId: 'oVysota',
      type: 'text', required: false, table: true, tableWidth: 60,
    },
    {
      key: 'zakalka', label: 'ТО (закалка)', domId: 'oTO',
      type: 'checkbox', required: false,
      filter: true, filterId: 'fltTO', table: false,
    },
    {
      key: 'ppd', label: 'ППД', domId: 'oPPD',
      type: 'checkbox', required: false,
      filter: true, filterId: 'fltPPD', table: false,
    },
    {
      key: 'tisnenie', label: 'Тиснение', domId: 'oTisn',
      type: 'checkbox', required: false,
      filter: true, filterId: 'fltTisn', table: false,
    },
    {
      key: 'pokrytie', label: 'Покрытие', domId: 'oPokr',
      type: 'checkbox', required: false,
      filter: true, filterId: 'fltPokr', table: false,
    },
    {
      key: 'nitrocementaciya', label: 'TONA', domId: 'oTONA',
      type: 'checkbox', required: false,
      filter: true, filterId: 'fltTONA', table: false,
    },
    {
      key: 'cena_zagotovki', label: 'Цена заготовки', domId: 'oCenaZag',
      type: 'text', required: false, table: false,
    },
    {
      key: 'trudoemkost_frez_universal', label: 'Фрез. универс.', domId: 'oFrezUniv',
      type: 'text', required: false, table: false,
    },
    {
      key: 'trudoemkost_frez_chpu', label: 'Фрез. ЧПУ', domId: 'oFrezChpu',
      type: 'text', required: false, table: false,
    },
    {
      key: 'trudoemkost_tokarn', label: 'Токарн.', domId: 'oTokarn',
      type: 'text', required: false, table: false,
    },
    {
      key: 'trudoemkost_tokarn_chpu', label: 'Токарн. ЧПУ', domId: 'oTokarnChpu',
      type: 'text', required: false, table: false,
    },
    // Вычисляемая колонка (заполняется через postProcess)
    {
      key: '_tech', label: 'ТО/ППД/Покр', domId: null,
      type: 'text', required: false, table: true, tableWidth: 100,
    },
  ],

  filterClearButtons: [
    { buttonId: 'btnClearNomer', filterId: 'fltNomer' },
    { buttonId: 'btnClearNaim',  filterId: 'fltNaim' },
    { buttonId: 'btnClearAvto',  filterId: 'fltAvto' },
  ],
  clearAllFiltersBtn: 'btnClearAllFilters',
};