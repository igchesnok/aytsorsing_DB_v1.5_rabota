// ============================================================
// public/js/configs/tech.config.js 
// КОНФИГ: Ответственные технологи — единый источник истины
// ============================================================
export default {
  // === Метаданные ===
  entity: 'tech',                        // имя таблицы БД для WS / batchManager
  apiUrl: '/api/tech',                   // базовый URL API
  idKey: 'id',                           // первичный ключ
  tableTitle: 'Данные технолога',        // заголовок формы по умолчанию
  wsSync: true,

  // === Единое определение полей ===
  fields: [
    {
      key: 'fio',
      label: 'ФИО технолога',
      domId: 'tFio',
      type: 'text',
      required: true,
      filter: true,
      filterId: 'fltFio',
      table: true,
      tableWidth: 280,
    },
    {
      key: 'email',
      label: 'E-mail',
      domId: 'tEmail',
      type: 'text',
      required: false,
      filter: true,
      filterId: 'fltEmail',
      table: true,
      tableWidth: 240,
    },
    {
      key: 'telefon',
      label: 'Телефон',
      domId: 'tTelefon',
      type: 'text',
      required: false,
      filter: true,
      filterId: 'fltTelefon',
      table: true,
      tableWidth: 140,
    },
    {
      key: 'tip_osnastki',
      label: 'Тип оснастки',
      domId: 'tTip',
      type: 'text',
      required: false,
      filter: true,
      filterId: 'fltTip',
      table: true,
      tableWidth: 200,
    },
  ],

  // === Очистка фильтров (группы кнопок ×) ===
  filterClearButtons: [
    { buttonId: 'btnClearFio',      filterId: 'fltFio' },
    { buttonId: 'btnClearEmail',    filterId: 'fltEmail' },
    { buttonId: 'btnClearTelefon',  filterId: 'fltTelefon' },
    { buttonId: 'btnClearTip',      filterId: 'fltTip' },
  ],
  clearAllFiltersBtn: 'btnClearAllFilters',
};