// ============================================================
// public/js/configs/cex.config.js 
// КОНФИГ: Цеха затрат — единый источник истины
// ============================================================
export default {
  // === Метаданные ===
  entity: 'cex_zatrat',                    // имя таблицы БД для WS / batchManager
  apiUrl: '/api/cex',               // базовый URL API
  idKey: 'id',                      // первичный ключ
  tableTitle: 'Данные цеха',        // заголовок формы по умолчанию
wsSync: true,
  // === Единое определение полей ===
  // Каждое поле описано ОДИН РАЗ и используется для:
  //   • Формы (DOM-элементы)
  //   • Таблицы (колонки)
  //   • Фильтров (FilterableTable.filterFields)
  //   • Payload (отправка на сервер)
  //   • Валидации (required)
  fields: [
    {
      key: 'ceh',
      label: 'Код цеха',
      domId: 'cCeh',                 // id input/select в HTML
      type: 'text',                  // text | number | date | checkbox | select | textarea
      required: true,
      filter: true,                  // ← показывать фильтр
      filterId: 'fltCeh',            // DOM id фильтра
      table: true,                   // ← показывать в таблице
      tableWidth: 80,
    },
    {
      key: 'peredel',
      label: 'Передел',
      domId: 'cPeredel',
      type: 'text',
      required: true,
      filter: true,
      filterId: 'fltPeredel',
      table: true,
      tableWidth: 80,
    },
    {
      key: 'nazvanie',
      label: 'Название цеха',
      domId: 'cNazvanie',
      type: 'text',
      required: true,
      filter: true,
      filterId: 'fltNazvanie',
      table: true,
      tableWidth: 300,
    },
    {
      key: 'nach_ceha',
      label: 'Начальник',
      domId: 'cNach',
      type: 'text',
      required: false,
      filter: true,
      filterId: 'fltNach',
      table: true,
      tableWidth: 200,
    },
    {
      key: 'telefon',
      label: 'Телефон',
      domId: 'cTelefon',
      type: 'text',
      required: false,
      filter: false,                 // без фильтра
      table: true,
      tableWidth: 100,
    },
    {
      key: 'email',
      label: 'Email',
      domId: 'cEmail',
      type: 'text',
      required: false,
      filter: false,
      table: true,
      tableWidth: 200,
    },
  ],

  // === Очистка фильтров (группы кнопок ×) ===
  filterClearButtons: [
    { buttonId: 'btnClearCeh',      filterId: 'fltCeh' },
    { buttonId: 'btnClearPeredel',  filterId: 'fltPeredel' },
    { buttonId: 'btnClearNazvanie', filterId: 'fltNazvanie' },
    { buttonId: 'btnClearNach',     filterId: 'fltNach' },
  ],
  clearAllFiltersBtn: 'btnClearAllFilters',
};