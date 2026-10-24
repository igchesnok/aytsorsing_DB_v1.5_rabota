// ============================================================
// public/js/configs/transportTypes.config.js
// КОНФИГ: Типы перевозок — единый источник истины
// ============================================================
export default {
    // === Метаданные ===
    entity: 'transport_types',          // имя таблицы БД для WS / batchManager
    apiUrl: '/api/transport_types',     // базовый URL API
    idKey: 'id_tipa',                   // первичный ключ (бизнес-ключ, НЕ генерируемый)
    tableTitle: 'Тип перевозки',        // заголовок формы по умолчанию
    wsSync: true,                       // авто-подписка на WS-уведомления

    // === Единое определение полей ===
    fields: [
        {
            key: 'id_tipa',
            label: 'ID типа',
            domId: 'ttIdTipa',
            type: 'text',
            required: true,
            // НЕ ставим readonly здесь — управляем через хуки
            // (readonly только при редактировании, при создании — ввод вручную)
            filter: true,
            filterId: 'fltIdTipa',
            table: true,
            tableWidth: 120,
        },
        {
            key: 'nazvanie_operatsii',
            label: 'Название операции',
            domId: 'ttNazvanie',
            type: 'text',
            required: true,
            filter: true,
            filterId: 'fltNazvanie',
            table: true,
            tableWidth: 360,
        },
        {
            key: 'napravlenie',
            label: 'Направление',
            domId: 'ttNapravlenie',
            type: 'select',
            required: true,
            filter: true,
            filterId: 'fltNapravlenie',
            table: true,
            tableWidth: 140,
            // optionsApi не нужен — опции захардкожены в HTML
        },
        // uchet_v_ostatke НЕ включаем в форму — вычисляется сервером
    ],

    // === Очистка фильтров ===
    filterClearButtons: [
        { buttonId: 'btnClearIdTipa',       filterId: 'fltIdTipa' },
        { buttonId: 'btnClearNazvanie',     filterId: 'fltNazvanie' },
        { buttonId: 'btnClearNapravlenie',  filterId: 'fltNapravlenie' },
    ],
    clearAllFiltersBtn: 'btnClearAllFilters',
};