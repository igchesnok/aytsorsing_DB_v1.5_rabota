// ============================================================
// app-plan.js ТОЧКА ВХОДА: СТРАНИЦА ПЛАНА ПРОИЗВОДСТВА
// ============================================================
import { createSimpleCrudApp } from './common/simple-crud-app.js';
import planConfig from './configs/plan.config.js';
import { state } from './common/state.js';
import { api } from './common/utils.js';
// ✅ Кир→Лат: переключатель гомоглиф-поиска (общий хелпер)
import { isEnabled as hgEnabled, setEnabled as hgSetEnabled } from './common/homoglyph-helper.js';

// ✅ Маркер версии конфига импорта — виден в консоли DevTools при загрузке
// страницы. Если этой строки НЕТ — браузер исполняет старый app-plan.js
// (файл не заменён или закэширован — Ctrl+F5), и текст чертежа будет
// уходить на сервер без преобразования в ID
console.info('[app-plan] importConfig v3.1: lookupFields (чертёж->ID, цех->ID) активны');

export const Plan = createSimpleCrudApp(planConfig, {
    tableContainerId: 'planTable',
    formTitleId: 'planFormTitle',
    buttons: {
        add: 'btnPlanAdd',
        save: 'btnPlanSave',
        del: 'btnPlanDel',
        paste: 'btnPlanPaste',   // ✅ НОВАЯ кнопка — импорт из буфера (нужен HTML <button id="btnPlanPaste">)
    },
    // ✅ СИНТЕТИЧЕСКИЕ ОБРАБОТЧИКИ
    syntheticHandlers: {
        // 1. Изменился сам план -> перезагружаем таблицу плана
        'plan.list': () => Plan.load(),

        // 2. Изменилась оснастка -> перезагружаем таблицу (т.к. JOIN-поля изменились)
        //                      И перезагружаем комбобокс оснастки в форме
        'osnastka.list': () => {
            Plan.load();
            Plan._loadSelectOptions('pOsnastka');
        },

        // 3. Изменились цеха -> перезагружаем комбобокс цехов в форме
        // (таблицу перезагружать не обязательно, если цех не отображается в таблице,
        // но если есть JOIN по цеху - добавьте и Plan.load())
        'cex.list': async () => {
        await Plan._loadSelectOptions('pCexZatrat');   // дожидаемся новых option с dataset.peredel
        const cexSelect = document.getElementById('pCexZatrat');
        if (cexSelect) Plan.updatePeredelFromCex(cexSelect);  // аналогично клику по цеху
        },

        // 4. Изменились фирмы -> перезагружаем таблицу (JOIN firma_nazvanie)
        //                      И перезагружаем фильтр-селект фирм
        'firmy.list': () => {
            Plan.load();
            Plan._loadSelectOptions('fltFirma');
        }
    },

    hooks: {
        onInit: (module) => {
            // ✅ Кир→Лат: флажок нечёткого поиска (гомоглифы А=A, В=B, Е=E, Р=P…).
            // Состояние — в localStorage (homoglyphSearch); FilterableTable и
            // VirtualSelect сами подставляют hg=0, когда режим выключен.
            const hgChk = document.getElementById('fltHG');
            if (hgChk) {
                hgChk.checked = hgEnabled();
                hgChk.addEventListener('change', () => {
                    hgSetEnabled(hgChk.checked);
                    // ✅ applyFilters (НЕ load!): пересобирает фильтры из DOM
                    // (чтобы не потерять god/naimenovanie/...) и перезагружает
                    // и таблицу, и VirtualSelect с fixedParams в новом режиме
                    module.applyFilters();
                });
            }
            // Уникальная логика: автообновление информации при смене оснастки
            const osnSelect = document.getElementById('pOsnastka');
            if (osnSelect) {
                osnSelect.addEventListener('change', () => {
                    Plan.updateOsnastkaInfo(osnSelect.value);
                    module.updateButtonStates();
                });
            }
            // Уникальная логика: автозаполнение передела при смене цеха
            const cexSelect = document.getElementById('pCexZatrat');
            if (cexSelect) {
                cexSelect.addEventListener('change', () => {
                    Plan.updatePeredelFromCex(cexSelect);
                    module.updateButtonStates();
                });
            }
        },
        onSelect: (row, module) => {
            Plan.updateOsnastkaInfo(row.id_osnastka);
            Plan.updatePeredelFromCex(document.getElementById('pCexZatrat'));

            // Отображение служебной информации для дочерних позиций
            const serviceInfo = document.getElementById('planServiceInfo');
            if (serviceInfo) {
                if (row.is_child_plan === 1) {
                    serviceInfo.style.display = 'block';
                    serviceInfo.innerHTML = `
                        <div style="padding: 8px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; margin-top: 6px; font-size: 11px;">
                            <b>ℹ️ Служебная информация:</b><br>
                            ${row.is_no_kp_plan === 1 ? '⚠️ <b>Позиция без КП</b> (остаток после распределения)<br>' : ''}
                            📎 Родитель: <code>${row.parent_plan_id || '—'}</code><br>
                            📝 Запрос: <code>${row.zapros_kp_id || '—'}</code><br>
                            🏷️ Группа: <b>${row.split_group || '—'}</b><br>
                            💡 Причина: ${row.split_reason || '—'}
                        </div>
                    `;
                } else {
                    serviceInfo.style.display = 'none';
                }
            }
        },
        onHeaderClick: (module) => {
            const serviceInfo = document.getElementById('planServiceInfo');
            if (serviceInfo) serviceInfo.style.display = 'none';
            Plan.updateOsnastkaInfo('');
        }
    },

    // ============================================================
    // ИМПОРТ ИЗ БУФЕРА (clipboard-import.js v3.1)
    // ============================================================
    // БД plan: god, id_osnastka, plan_god_kolvo, cena_pto, stoim_zagot,
    //          cex_zatrat, peredel, zak_pto, data_zak, data_yes_zagot,
    //          plan_izgot, kol_fakt_got, stat_poz, n_nazv_osnovn_det_zakaza, primechanie
    //
    // Порядок колонок в Excel:
    //   Год * | Деталь (№ чертежа) * | План кол-во * | Цена ПТО | Стоимость заготовки |
    //   Цех затрат (№/название) | Передел | № заказа ПТО | Дата заказа |
    //   Дата обеспеч. заготовкой | План. срок изгот. | Кол-во факт. закрыто |
    //   Статус позиции | Наим. осн. детали | Примечание
    //
    // ✅ lookupFields — текст из Excel преобразуется в ID справочника:
    //      «А123БВ» или «210-01-4600 — Стойка» -> id_osnastka (по nomer_chertezha,
    //      чертёж UNIQUE, поэтому по названию детали НЕ ищем — исключаем путаницу);
    //      «03 — Заготовительный» / «Заготовительный» / «12» -> cex_zatrat
    //      + передел подтягивается из найденного цеха (autofill, как dataProps комбобокса).
    //
    // ✅ requiredFields: [] — клиентская проверка отключена. Как это работает:
    //      - ненайденная деталь (lookupFields.id_osnastka.required: true) — строка
    //        пропускается с понятной причиной (сервер всё равно вернул бы 400);
    //      - ненайденный цех — строка импортируется, cex_zatrat остаётся пустым;
    //      - пустое «План кол-во» -> numericFields превратит '' в 0 -> сервер
    //        вернёт 400 «Заполните обязательные поля…» (тост на каждую строку).
    //
    // ✅ ДУБЛИКАТЫ ДОПУСТИМЫ (одна и та же деталь повторяется в течение года):
    //      isDuplicate: () => false обязателен! Без него работает сравнение
    //      «по умолчанию по всем полям», и строки, совпавшие с существующими,
    //      молча пропускались бы как «дубликат».
    importConfig: {
        fields: [
            'god',                      // Год *
            'id_osnastka',              // Деталь (№ чертежа) *  -> ID оснастки
            'plan_god_kolvo',           // План кол-во *
            'cena_pto',                 // Цена ПТО
            'stoim_zagot',              // Стоимость заготовки
            'cex_zatrat',               // Цех затрат (№/название) -> ID цеха
            'peredel',                  // Передел (пусто -> подставится из цеха)
            'zak_pto',                  // № заказа ПТО
            'data_zak',                 // Дата заказа
            'data_yes_zagot',           // Дата обеспеч. заготовкой
            'plan_izgot',               // План. срок изгот.
            'kol_fakt_got',             // Кол-во факт. закрыто
            'stat_poz',                 // Статус позиции
            'n_nazv_osnovn_det_zakaza', // Наим. осн. детали
            'primechanie',              // Примечание
        ],
        requiredFields: [],             // ✅ ничего не блокируем на клиенте
        numericFields: ['plan_god_kolvo'],                          // «10 000» -> 10000, «1,5» -> 1.5
        dateFields: ['data_zak', 'data_yes_zagot', 'plan_izgot'],   // 01.02.2026 -> 2026-02-01
        columnHints: [
            'Год *',
            'Деталь (№ чертежа) *',
            'План кол-во *',
            'Цена ПТО',
            'Стоимость заготовки',
            'Цех затрат (№/название)',
            'Передел (пусто = из цеха)',
            '№ заказа ПТО',
            'Дата заказа',
            'Дата обеспеч. заготовкой',
            'План. срок изгот.',
            'Кол-во факт. закрыто',
            'Статус позиции',
            'Наим. осн. детали',
            'Примечание',
        ],

        // Текст -> ID справочника (новый штатный механизм clipboard-import v3.1)
        lookupFields: {
            id_osnastka: {
                url: '/api/osnastka',
                valueKey: 'id',
                matchFields: ['nomer_chertezha'],   // ищем по № чертежа (UNIQUE)
                displayFormat: (row) => `${row.nomer_chertezha} — ${row.naimenovanie}`,
                label: 'Деталь (оснастка)',
                required: true,   // не найдена -> строка пропускается с причиной
            },
            cex_zatrat: {
                url: '/api/cex',
                valueKey: 'id',
                matchFields: ['ceh', 'nazvanie'],
                displayFormat: (row) => `${row.ceh} — ${row.nazvanie}`,
                label: 'Цех затрат',
                required: false,  // не найден -> поле пустое, строка импортируется
                autofill: { peredel: 'peredel' },
            },
        },

        // Дубликаты допустимы: каждая строка создаёт НОВУЮ запись (POST)
        isDuplicate: () => false,
    },
});

// ============================================================
// УНИКАЛЬНЫЕ МЕТОДЫ ПЛАНА
// ============================================================
// Счётчик запросов — защита от гонки при быстром переключении строк
// (ответ более раннего запроса не должен перезаписать более поздний)
let _osnInfoToken = 0;

Plan.updateOsnastkaInfo = function(osnId) {
    const infoNomer = document.getElementById('infoNomerChertezha');
    const infoNaim = document.getElementById('infoNaimenovanie');
    if (!infoNomer || !infoNaim) return;

    if (!osnId) {
        infoNomer.textContent = '—';
        infoNaim.textContent = '—';
    } else {
        // 1) Мгновенно: у VirtualSelect данные выбранной детали лежат
        //    в dataset внутреннего input (dataProps из plan.config.js).
        //    container.vs — обратная ссылка на экземпляр VirtualSelect
        const osnSelect = document.getElementById('pOsnastka');
        const vs = osnSelect?.vs;
        const ds = vs?.input?.dataset || {};
        // ✅ T96: быстрый путь — ТОЛЬКО если dataset гарантированно относится
        // к выбранной детали: ds_id (id из dataProps) совпадает с osnId.
        // Раньше сверялся только getValue(), но dataset заполняется
        // асинхронно (_loadValue), и при клике по другой строке плана
        // info-панель показывала данные ПРЕДЫДУЩЕЙ записи («затормаживание»).
        // Несовпадение -> корректный API-fallback ниже (защищён токеном).
        if (vs && vs.getValue() === osnId && String(ds.ds_id ?? '') === String(osnId) && ds.nomer_chertezha) {
            infoNomer.textContent = ds.nomer_chertezha;
            infoNaim.textContent = ds.osn_naimenovanie || '—';
        } else {
            // 2) Fallback: запрос к API (например, сразу после fillFromRow,
            //    когда display-текст VirtualSelect ещё загружается)
            const token = ++_osnInfoToken;
            api('GET', `/api/osnastka?id=${encodeURIComponent(osnId)}`)
                .then(rows => {
                    if (token !== _osnInfoToken) return;   // ответ устарел
                    const item = Array.isArray(rows) ? rows[0] : null;
                    infoNomer.textContent = item?.nomer_chertezha || '—';
                    infoNaim.textContent = item?.naimenovanie || '—';
                })
                .catch(() => {
                    if (token !== _osnInfoToken) return;
                    infoNomer.textContent = '—';
                    infoNaim.textContent = '—';
                });
        }
    }

    const currentRow = Plan.table?.data.find(r => r.id === Plan.table.selectedId);
    if (currentRow && currentRow.firma_nazvanie) {
        document.getElementById('infoFirma').textContent = currentRow.firma_nazvanie;
    } else {
        document.getElementById('infoFirma').textContent = 'Не определена';
    }
};

Plan.updatePeredelFromCex = function(cexSelect) {
    const peredelInput = document.getElementById('pPeredel');
  if (!cexSelect || !peredelInput) return;

  const selectedOption = cexSelect.options[cexSelect.selectedIndex];

  if (selectedOption && selectedOption.value) {
    // value = id цеха, peredel уже лежит в dataset (dataProps из конфига)
    peredelInput.value = selectedOption.dataset.peredel || '';
  } else {
    peredelInput.value = '';
  }

  // ✅ НОВОЕ: программное изменение value не вызывает событие 'input',
  // поэтому вручную пересчитываем dirty-state формы
  if (Plan.form) Plan.form.recalculate();
};
