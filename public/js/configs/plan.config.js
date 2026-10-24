// ============================================================
// public/js/configs/plan.config.js
// КОНФИГ: План производства — единый источник истины
// ============================================================
export default {
    entity: 'plan',
    apiUrl: '/api/plan',
    idKey: 'id',
    tableTitle: 'Позиция годового плана',
    wsSync: false, // Управляется через syntheticHandlers в app-plan.js

    fields: [
        // ======================================================
        // ОСНОВНЫЕ ПОЛЯ (Форма + Таблица + Фильтры)
        // ======================================================
        { 
            key: 'god', label: 'Год', domId: 'pGod', type: 'text', required: true, 
            table: true, tableWidth: 60, filter: true, filterId: 'fltGod' 
        },

        // t67: «Фирма» — второй колонкой: фирма лучшего КП позиции
        // (plan.id_kp -> kp -> firmy — как в «Плоской таблице» и «Графике изготовления»);
        // tooltip — полное значение видно при наведении
        { key: 'firma_nazvanie', label: 'Фирма', virtual: true, table: true, tableWidth: 150, tooltip: true },
        // t70: «№ чертежа» и «Наименование» — сразу после «Фирмы» (перенесены из блока
        // виртуальных полей ниже; свойства фильтров не изменены)
        { key: 'nomer_chertezha', label: '№ чертежа', virtual: true, table: true, tableWidth: 120, filter: true, filterId: 'fltNomer' },
        // ✅ filterDbField: серверный фильтр /api/plan называется 'naimenovanie'
        // (ключ поля osn_naimenovanie — это алиас JOIN o.naimenovanie)
        { key: 'osn_naimenovanie', label: 'Наименование', virtual: true, table: true, tableWidth: 200, filter: true, filterId: 'fltNaim', filterDbField: 'naimenovanie' },
        // t70: «№ зак.» переименована в «№ зак. ПТО» (лейбл формы — «№ заказа ПТО»)
        { key: 'zak_pto', label: '№ зак. ПТО', domId: 'pZakPTO', type: 'text', table: true, tableWidth: 110, tooltip: true },
        // t71: «№ запроса» — виртуальное: запрос КП, в который включена позиция
        // (kp.id_plana -> kp.id_zaprosa_kp -> zapros_kp.n_zaprosa; без КП — пусто).
        // t72: + фильтр fltZapros (серверный dbField = ключ zapros_nomer)
        { key: 'zapros_nomer', label: '№ запроса', virtual: true, table: true, tableWidth: 100, tooltip: true, filter: true, filterId: 'fltZapros' },
        // t70: «№ зак. по дог.» — виртуальное: номер и дата заказа по договору, в котором
        // состоит позиция (poz_zakaz_dogovora -> zakaz_po_dogovoru), формат «<№> от <ДД.ММ.ГГГГ>»
        { key: 'zak_po_dog', label: '№ зак. по дог.', virtual: true, table: true, tableWidth: 160, tooltip: true },
        { 
            key: 'plan_god_kolvo', label: 'План кол-во', domId: 'pPlanKolvo', type: 'text', required: true, 
            table: true, tableWidth: 80 
        },
        { 
            key: 'plan_izgot', label: 'План. срок изгот.', domId: 'pPlanIzgot', type: 'date', 
            table: true, tableWidth: 90 
        },
        { 
            key: 'stat_poz', label: 'Статус позиции', domId: 'pStatPoz', type: 'text', 
            table: true, tableWidth: 80 
        },

        // ======================================================
        // ВИРТУАЛЬНЫЕ ПОЛЯ (Фильтры из JOIN; t70: «№ чертежа» и «Наименование»
        // перенесены в таблицу — сразу после «Фирмы»)
        // Не отправляются на сервер, не участвуют в dirty-check
        // ======================================================
        
        // Виртуальные фильтры (Тех. операции)
        { key: 'avto_mob_det', label: 'Авто/Моб/Дет', virtual: true, skipDirty: true, filter: true, filterId: 'fltAvto' },
        { key: 'zakalka', label: 'ТО', virtual: true, skipDirty: true, type: 'checkbox', filter: true, filterId: 'fltTO' },
        { key: 'ppd', label: 'ППД', virtual: true, skipDirty: true, type: 'checkbox', filter: true, filterId: 'fltPPD' },
        { key: 'tisnenie', label: 'Тиснение', virtual: true, skipDirty: true, type: 'checkbox', filter: true, filterId: 'fltTisn' },
        { key: 'pokrytie', label: 'Покрытие', virtual: true, skipDirty: true, type: 'checkbox', filter: true, filterId: 'fltPokr' },
        { key: 'nitrocementaciya', label: 'TONA', virtual: true, skipDirty: true, type: 'checkbox', filter: true, filterId: 'fltTONA' },

        // Виртуальный фильтр-селект (Фирмы)
        { 
            key: 'firma', label: 'Фирма', type: 'select', virtual: true, skipDirty: true, 
            domId: 'fltFirma', filter: true, filterId: 'fltFirma',
            optionsApi: { 
                url: '/api/firmy', 
                valueKey: 'id_firmy', 
                labelKey: 'naimenovanie',
                placeholder: 'Все фирмы'
            } 
        },

        // ======================================================
        // ПОЛЯ ФОРМЫ (Комбобоксы с загрузкой из API)
        // ======================================================
        { 
            key: 'id_osnastka', label: 'Деталь (оснастка)', domId: 'pOsnastka', type: 'select', required: true,
            // ✅ НОВОЕ: VirtualSelect вместо нативного <select> — позиций много,
            // список грузится лениво с серверным поиском (searchParam)
            virtualSelect: true,
            optionsApi: { 
                url: '/api/osnastka', 
                valueKey: 'id', 
                labelKey: 'nomer_chertezha',
                // Кастомное отображение в выпадающем списке
                displayFormat: (row) => `${row.nomer_chertezha} — ${row.naimenovanie}`,
                placeholder: '— Выберите деталь —',
                // ✅ Обобщённый поиск на сервере: ИЛИ по № чертежа и наименованию
                searchParam: 'search',
                // ✅ Данные выбранной детали — в dataset input (для info-панели формы)
                // ✅ T96: ds_id — id детали в dataset; updateOsnastkaInfo (app-plan.js)
                // сверяет его с запрошенным id, чтобы быстрый путь не показал
                // данные предыдущей записи (dataset заполняется асинхронно)
                dataProps: { nomer_chertezha: 'nomer_chertezha', osn_naimenovanie: 'naimenovanie', ds_id: 'id' },
                // ✅ ФИЛЬТРЫ СТРАНИЦЫ ПРИМЕНЯЮТСЯ И К СПИСКУ ДЕТАЛЕЙ:
                // VirtualSelect добавляет их к каждому запросу /api/osnastka,
                // поэтому в выпадающем списке остаются только позиции,
                // удовлетворяющие текущим фильтрам таблицы (№ чертежа,
                // Наименование, Авто/Моб/Дет, ТО, ППД, Тиснение, Покрытие, TONA).
                // Функция (не объект!) — значения читаются при каждом поиске.
                // Фирма не передаётся: в osnastka нет поля фирмы (она приходит
                // через КП только в /api/plan).
                fixedParams: () => {
                    const val = (id) => { const el = document.getElementById(id); return el ? String(el.value).trim() : ''; };
                    const chk = (id) => { const el = document.getElementById(id); return el && el.checked ? '1' : ''; };
                    return {
                        nomer_chertezha:  val('fltNomer'),
                        naimenovanie:     val('fltNaim'),
                        avto_mob_det:     val('fltAvto'),
                        zakalka:          chk('fltTO'),
                        ppd:              chk('fltPPD'),
                        tisnenie:         chk('fltTisn'),
                        pokrytie:         chk('fltPokr'),
                        nitrocementaciya: chk('fltTONA'),
                    };
                }
            } 
        },
        { 
            key: 'cex_zatrat', label: 'Цех затрат', domId: 'pCexZatrat', type: 'select',
            optionsApi: { 
                url: '/api/cex', 
                valueKey: 'id', 
                labelKey: 'nazvanie',
                displayFormat: (row) => `${row.ceh} — ${row.nazvanie}`,
                // Сохраняем доп. данные в data-атрибуты option
                dataProps: { peredel: 'peredel' },
                placeholder: '— Выберите цех —'
            } 
        },
       
        // ======================================================
        // ОСТАЛЬНЫЕ ПОЛЯ ФОРМЫ (Text / Date)
        // ======================================================
        { key: 'cena_pto', label: 'Цена ПТО', domId: 'pCenaPTO', type: 'text' },
        { key: 'stoim_zagot', label: 'Стоимость заготовки', domId: 'pStoimZagot', type: 'text' },
        { key: 'data_zak', label: 'Дата заказа', domId: 'pDataZak', type: 'date' },
        { key: 'data_yes_zagot', label: 'Дата обеспеч. заготовкой', domId: 'pDataYesZagot', type: 'date' },
        { key: 'kol_fakt_got', label: 'Кол-во факт. закрыто', domId: 'pKolFaktGot', type: 'text' },
        { key: 'n_nazv_osnovn_det_zakaza', label: 'Наим. осн. детали', domId: 'pNNazvOsnovnDet', type: 'text' },
        { key: 'primechanie', label: 'Примечание', domId: 'pPrimechanie', type: 'text' },
         //Исключение поля peredel из отслеживания изменений
        { key: 'peredel', label: 'Передел', domId: 'pPeredel', type: 'text', virtual: true },
    ],

    // ======================================================
    // КНОПКИ И ФИЛЬРЫ
    // ======================================================
    filterClearButtons: [
        { buttonId: 'btnClearGod',    filterId: 'fltGod' },
        { buttonId: 'btnClearNomer',  filterId: 'fltNomer' },
        { buttonId: 'btnClearNaim',   filterId: 'fltNaim' },
        { buttonId: 'btnClearAvto',   filterId: 'fltAvto' },
        { buttonId: 'btnClearFirma',  filterId: 'fltFirma' },
        { buttonId: 'btnClearZapros', filterId: 'fltZapros' }
    ],
    clearAllFiltersBtn: 'btnClearAllFilters',

    // Дополнительные кнопки (не CRUD, не снимают блокировку)
    extraButtons: [
        { 
            id: 'btnEditGrafik', 
            requiresSelection: true, 
            url: '/pages/grafik.html', 
            passSelectedId: true, // Добавит ?editId=... в URL
            windowFeatures: 'width=1400,height=900,menubar=no,toolbar=no' 
        }
    ]
};