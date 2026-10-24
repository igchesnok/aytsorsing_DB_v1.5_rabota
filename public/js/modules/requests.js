
// ============================================================
// public/js/modules/requests.js
// МОДУЛЬ: ЗАПРОСЫ КП
// Мигрировано на DualListBlock для блоков деталей и фирм
// ОБЪЕДИНЁННАЯ ВЕРСИЯ (merge двух редакций):
//   1. Available-таблица деталей через FilterableTable
//      (availableApiUrl + availableFilterFields + getAvailableFilters/
//       getAvailableRawFilters, серверная фильтрация с debounce 300 мс)
//   2. Фильтры по детали (№ чертежа, Наименование, Авто/Моб/Дет и чекбоксы
//      техопераций) применяются ОДНОВРЕМЕННО к списку запросов И к таблице
//      доступных деталей — как на странице «Формирование плана производства»,
//      где фильтры действуют и на таблицу, и на селект оснастки. Бывший
//      переключатель области (radio fltScope) удалён как избыточный.
//   3. Особый режим «без фактической отправки писем» (чекбокс chkNoSend,
//      dryRun передаётся во все email-API, статусы и даты проставляются)
// ============================================================
import { api, toast, setDateOrText, getDateValue } from '../common/utils.js';
import { state } from '../common/state.js';
import { FilterableTable } from '../common/filterable-table.js';
import { EditLock, isLocked } from '../common/websocket.js';
import { batchManager } from '../common/batch-update.js';
import { sqlDate, sqlDateTime } from '../common/date-helpers.js';
import { DualListBlock } from '../common/dual-list-block.js';
import { FormStateManager } from '../common/form-state-manager.js';
import { DirtyGuard } from '../common/dirty-guard.js';
import { showLockBanner, removeLockBanner } from '../common/ui/auto-lock.js';
import { registerLockAwareRecord } from '../common/lock-aware-registry.js';
import { showExcelPreview, buildEmailPreviewHtml } from '../common/excel-preview.js';   // ✅ T100: рендер письма с редактированием текста
// ============================================================
// Воркфлоу согласования: каждый шаг описан декларативно.
// Рендерер в updateStatusUI() обходит массив и не меняется
// при добавлении/удалении шагов.
// ============================================================
const WORKFLOW = [
  {
    id: 'stepTeh',
    visible: ctx => ctx.hasZapros,
    done: ctx => ctx.techSent,
    buttons: [
      {
        id: 'btnEmailTeh',
        visible: ctx => ctx.hasZapros && !ctx.techSent,
        disabled: ctx => !ctx.techValue,
      }
    ]
  },
  {
    id: 'stepUrl',
    visible: ctx => ctx.techSent,
    done: ctx => ctx.hasURL,
    // ✅ T89: кнопка проверки ссылки — видна, только если ссылка заполнена
    buttons: [
      { id: 'btnCheckUrl', visible: ctx => ctx.hasURL }
    ]
  },
  {
    id: 'stepFirms',
    visible: ctx => ctx.techSent && ctx.urlSaved,
    done: ctx => ctx.firmsSent,
    hint: {
      id: 'stepFirmsHint',
      text: ctx => ctx.firmsSent
        ? (ctx.finished
          ? `✅ Отправлено. Статус: «${ctx.status}»`
          : `✅ Отправлено. Статус: «${ctx.status}». 📧 доступна до выбора лучших КП`)
        : ctx.firmCount > 0
          ? `Выделено фирм: ${ctx.firmCount} — нажмите 📧`
          : 'Выделите фирмы в «Выбранные фирмы» и нажмите 📧'
    },
    firmButtons: {
      btnEmailFirma: {
        // ✅ T88: кнопка отправки СОХРАНЯЕТСЯ до статуса «выбраны лучшие КП»
        // (и «создан заказ по лучшим КП») — можно дослать запрос остальным
        // или новым фирмам; раньше пряталась сразу после отправки (firmsSent)
        visible: ctx => ctx.techSent && ctx.urlSaved && !ctx.finished,
        disabled: ctx => ctx.firmsBlockLocked || !(ctx.techSent && ctx.hasURL) || ctx.finished,
        text: ctx => ctx.firmCount > 0 ? `📧 Отпр. (${ctx.firmCount})` : '📧 Отпр.'
      },
      // ✅ T88: просмотр сохранённого файла запроса «Заявка № …xlsx»
      // (public/Заявки/<год>) — тот же просмотрщик, что при отправке;
      // доступен и после «выбраны лучшие КП» — просмотр безвреден
      btnPreviewZayavka: {
        visible: ctx => ctx.techSent && ctx.urlSaved,
        disabled: ctx => ctx.firmsBlockLocked,
        text: () => '👁 Файл'
      }
    }
  },
  {
    id: 'stepUrlUpdate',
    visible: ctx => ctx.firmsSent,
    done: ctx => ctx.urlUpdated,
    firmButtons: {
      btnUpdateURL: {
        visible: ctx => ctx.firmsSent  && !ctx.finished,
        disabled: ctx => ctx.firmsBlockLocked || !ctx.hasURL,
        text: ctx => ctx.firmCount > 0 ? `🔄 URL (${ctx.firmCount})` : '🔄 URL'
      }
    }
  }
];

export const Requests = {
  _selectedZaprosId: null,
   _lastSelectedId: null, 
  _allFirmy: [],
  _firmyDogovoryMap: {},          // ✅ НОВОЕ: карта «фирма → договор» по правилам автопривязки (фильтр года)
  _dogovorAllById: {},            // ✅ НОВОЕ: справочник договоров по id — для показа фактических договоров КП
  _firmyDogovoryTimer: null,      // ✅ НОВОЕ: дебаунс перезагрузки карты при вводе фильтра года
  _detaliBlock: null,
  _formStateManager: null,
  _firmyBlock: null,
  _cachedKpPromise: null,         // ✅ ФИКС: кэш КП (1 API-вызов вместо 2)
  _cachedKpZaprosId: null,
  _bestKpPlanIds: new Set(),      // ✅ T54: позиции запроса с назначенным лучшим КП (id_plana)
  _lastUrlCheck: null,            // ✅ T90: последний отчёт проверки ссылки (для письма технологу)

  

  // ============================================================
  // ИНИЦИАЛИЗАЦИЯ
  // ============================================================
  async init() {
    const cols = [
      { key: 'n_zaprosa', label: '№ зап.', width: '80px' },
      { key: 'data_form', label: 'От.', width: '100px' },
      { key: 'data_peredach_tehnologu', label: 'Дата -> техн.', width: '110px' },
      {
        key: 'statys', label: 'Статус', width: '200px',
        formatter: (value) => {
          const s = value || 'создание';
          const colorMap = {
            'создание': '#656d76', 'отправлено технологу': '#0969da',
            'отправлено Всем контрагентам': '#1a7f37', 'отправлено не Всем контрагентам': '#bf8700',
            'выбраны лучшие КП': '#8250df', 'создан заказ по лучшим КП': '#0550ae'
          };
          return { text: s, style: { color: colorMap[s] || '#656d76', fontWeight: '600', fontSize: '11px' } };
        }
      }
    ];

    // ✅ 1. ИНИЦИАЛИЗАЦИЯ FormStateManager
    const formFields = [
      { key: 'n_zaprosa', domId: 'zNomer', type: 'text', required: true },
      { key: 'data_form', domId: 'zData', type: 'date', required: true },
      { key: 'srok_predostavleniya_kp', domId: 'zSrok', type: 'text' },
      { key: 'id_tehnologa', domId: 'zTech', type: 'select' },
      { key: 'ssylka_na_chertezh', domId: 'zUrl', type: 'text' },
      { key: 'statys', domId: 'zStatus', type: 'text' },
      { key: 'kommentariy', domId: 'zKoment', type: 'text' },
    ];

    Requests._formStateManager = new FormStateManager({
      fields: formFields,
      formTitleId: 'zaprosFormTitle',
      defaultTitle: 'Новый запрос КП',
      formatTitle: (row) => `Запрос № ${row.n_zaprosa}`,
      onDirtyChange: () => Requests.updateButtonStates()
    });

    // ✅ РЕГИСТРАЦИЯ ВНЕШНИХ ПРОВЕРОК: FormStateManager теперь знает о блоках
    // и будет автоматически применять .form-dirty к .form-panel, если любой блок грязный
    Requests._formStateManager.registerExternalDirtyCheck(() => Requests.hasDirtyBlocks()); 
    state.tables.zapros = new FilterableTable(
      document.getElementById('zaprosTable'), cols, {
        idKey: 'id', apiUrl: '/api/zapros-kp',
        filterFields: {
          fltGod: { dbField: 'god', type: 'text' }, fltFirma: { dbField: 'firma', type: 'text' },
          fltNomerChert: { dbField: 'nomer_chertezha', type: 'text' }, fltNaimenovanie: { dbField: 'naimenovanie', type: 'text' },
          fltAvtoDet: { dbField: 'avto_mob_det', type: 'text' }, fltTO: { dbField: 'zakalka', type: 'checkbox' },
          fltPPD: { dbField: 'ppd', type: 'checkbox' }, fltTisn: { dbField: 'tisnenie', type: 'checkbox' },
          fltPokr: { dbField: 'pokrytie', type: 'checkbox' }, fltTONA: { dbField: 'nitrocementaciya', type: 'checkbox' }
        },
        debounceMs: 300,
            // ✅ ИСПРАВЛЕНИЕ 1: Добавлен onBeforeSelect для перехвата смены строки
        onBeforeSelect: async () => {
          DirtyGuard.register(
            Requests._formStateManager,
            () => Requests.save(),
            () => Requests.onHeaderClick(),
            () => Requests.isDirty() // ✅ КРИТИЧЕСКИ ВАЖНО: проверка перед сменой строки
          );
          return await DirtyGuard.handleRecordChange();
        },
        onSelect: r => Requests.onSelect(r),
        onHeaderClick: () => Requests.onHeaderClick(),
        getLockInfo: (item) => isLocked('zapros_kp', item.id),
        postProcess: (data) => {
          if (Requests._selectedZaprosId && !data.some(z => z.id === Requests._selectedZaprosId)) {
            requestAnimationFrame(() => { state.tables.zapros.clearSelection(); Requests.onHeaderClick(); });
          }
          return data;
        }
      }
    );

    // ===== БЛОК ДЕТАЛЕЙ =====
    Requests._detaliBlock = new DualListBlock({
      key: 'detali', label: 'Оснастка для запроса КП',
      selectedContainerId: 'lstDetaliKP', availableContainerId: 'lstDetali',
      selectedIdKey: 'id', availableIdKey: 'id',
      selectedColumns: [
        // ✅ T54: 🏆 — по позиции назначено лучшее КП (удаление заблокировано)
        { key: 'nomer_chertezha', label: '№ чертежа', width: 120, formatter: (v, row) => (row && row.luchshee
            ? { text: '🏆 ' + (v || ''), style: { color: '#8250df', fontWeight: '600' } }
            : v) },
        { key: 'osn_naimenovanie', label: 'Наименование', width: 200 },
        { key: 'plan_god_kolvo', label: 'План кол-во', width: 80 }
      ],
      availableColumns: [
        { key: 'nomer_chertezha', label: '№ чертежа', width: 120 },
        { key: 'osn_naimenovanie', label: 'Наименование', width: 200 },
        { key: 'plan_god_kolvo', label: 'План кол-во', width: 80 }
      ],
      loadSelected: async (zaprosId) => Requests._fetchKp(zaprosId),
      // ✅ T54: пост-обработка КП-строк левого списка. Заодно считается
      //    _bestKpPlanIds — позиции этого запроса, по которым назначено
      //    лучшее КП (kp.reshenie = 'лучшее предложение'). Набор нужен
      //    синхронным хукам валидации (блокировка удаления) и кнопке «🧹».
      postProcessSelected: (kpRows) => {
        // 1) позиции с назначенным лучшим КП
        Requests._bestKpPlanIds = new Set(
          (kpRows || [])
            .filter(k => k.reshenie === 'лучшее предложение' && k.id_plana)
            .map(k => String(k.id_plana))
        );
        // 2) дедупликация позиций левого списка + флаг «лучшее КП»
        const map = new Map();
        (kpRows || []).forEach(k => {
          if (!k.id_plana || map.has(k.id_plana)) return;
          map.set(k.id_plana, { id: k.id_plana, nomer_chertezha: k.nomer_chertezha || '', osn_naimenovanie: k.osn_naimenovanie || '', plan_god_kolvo: k.plan_god_kolvo || '', luchshee: Requests._bestKpPlanIds.has(String(k.id_plana)) ? 1 : 0 });
        });
        return Array.from(map.values());
      },
      // ✅ available-таблица теперь FilterableTable: серверная фильтрация
      //    с debounce/AbortController/postProcess "из коробки". Маппинг полей
      //    тот же, что у zaprosTable (минус fltFirma — это фильтр списка запросов).
      //    Колбэки getAvailableFilters/getAvailableRawFilters DualListBlock
      //    вызывает сам при reloadAvailable()/applyAvailableFilters().
      availableApiUrl: '/api/plan/available',
      availableFilterFields: {
        fltGod: { dbField: 'god', type: 'text' },
        fltNomerChert: { dbField: 'nomer_chertezha', type: 'text' },
        fltNaimenovanie: { dbField: 'naimenovanie', type: 'text' },
        fltAvtoDet: { dbField: 'avto_mob_det', type: 'text' },
        fltTO: { dbField: 'zakalka', type: 'checkbox' },
        fltPPD: { dbField: 'ppd', type: 'checkbox' },
        fltTisn: { dbField: 'tisnenie', type: 'checkbox' },
        fltPokr: { dbField: 'pokrytie', type: 'checkbox' },
        fltTONA: { dbField: 'nitrocementaciya', type: 'checkbox' }
      },
      // ✅ Фильтры по детали действуют на available-таблицу ВСЕГДА (как на
      //    «Формировании плана производства»): getAvailableFilters() возвращает
      //    актуальные значения всех фильтров страницы, DualListBlock передаёт
      //    их в FilterableTable при applyAvailableFilters()/reloadAvailable().
      getAvailableFilters: () => Requests._availableFiltersPayload(),
      // ✅ Исключения позиций считает СЕРВЕР ('requests.available' в
      //    syntheticTables.js), но клиент дополняет его несохранённой дельтой:
      //    zaprosId — сервер исключает позиции, УЖЕ сохранённые за запросом
      //    (по таблице kp); excludePlanIds — текущий состав левого списка
      //    ВМЕСТЕ с несохранёнными перемещениями, которых сервер не знает.
      //    Без excludePlanIds любая серверная перезагрузка available (печать
      //    фильтра, смена области) вернула бы только что добавленную позицию
      //    обратно — и запись оказалась бы в обеих таблицах сразу.
      getAvailableRawFilters: (selectedIds) => ({
        zaprosId: Requests._selectedZaprosId || '',
        excludePlanIds: (selectedIds || []).join(',')
      }),
      debounceMs: 300,
      moveButtons: [
        { id: 'btnAddDetali', action: 'moveToSelected' },
        { id: 'btnDelDetali', action: 'moveToAvailable' },
        { id: 'btnClearDetali', action: 'clearSelections' }
      ],
      // ✅ T54: валидация перемещений состава запроса:
      //    — добавление: № чертежа позиции не должен повторяться в запросе
      //      (в рамках одного запроса не может быть деталей с одним
      //      номером чертежа; в плане дубликаты допустимы — в запросе нет);
      //    — удаление: позицию с назначенным лучшим КП удалить нельзя —
      //      удаление возможно только до назначения лучшего предложения.
      validateMoveToSelected: (newRows, currentRows) => Requests._validateDetaliDup(newRows, currentRows),
      validateMoveToAvailable: (removedRows, currentRows) => Requests._validateDetaliBestKp(removedRows, currentRows),
      onChange: () => {
          Requests._formStateManager.recalculate();  // ✅ Пересчитываем dirty через FSM
          Requests.updateButtonStates();
      }
    });

    // ===== БЛОК ФИРМ =====
    Requests._firmyBlock = new DualListBlock({
      key: 'firm', label: 'Фирмы для запроса КП',
      selectedContainerId: 'lstFirmKP', availableContainerId: 'lstFirm',
      selectedIdKey: 'id_firmy', availableIdKey: 'id_firmy',
      selectedColumns: [
        { key: 'naimenovanie', label: 'Наименование фирмы', width: 180 },
        // ✅ НОВОЕ: «№ договора и дата» — какой договор попадёт в КП.
        //    Зелёный — уже записан в КП этой фирмы; жёлтый курсив — будет
        //    записан при сохранении (автоподбор по фильтру года); красный —
        //    договора по фильтру нет.
        { key: 'dogovor', label: '№ договора и дата', width: 175, formatter: (v, row) => Requests._dogovorCell(row) },
        { key: 'emails', label: 'Email для отправки', width: 220, formatter: (v) => (!v ? { text: '— нет email —', style: { color: '#cf222e', fontStyle: 'italic' } } : { text: v, style: { fontSize: '10px' } }) },
        { key: 'lastSendDate', label: 'Дата отправки', width: 110, formatter: (v) => (!v ? { text: 'не отправлено', style: { color: '#bf8700', fontStyle: 'italic' } } : { text: v, style: { color: '#1a7f37', fontWeight: '600' } }) },
        { key: 'linkDocDate', label: 'Дата обновл. URL', width: 110, formatter: (v) => (!v ? { text: 'не обновлено', style: { color: '#bf8700', fontStyle: 'italic' } } : { text: v, style: { color: '#0969da', fontWeight: '600' } }) }
      ],
      // ✅ НОВОЕ: в доступных фирмах пользователь тоже сразу видит, какой
      //    договор будет использован при добавлении фирмы в запрос
      availableColumns: [
        { key: 'naimenovanie', label: 'Наименование фирмы', width: 190 },
        { key: 'dogovor', label: '№ договора и дата', width: 175, formatter: (v, row) => Requests._dogovorCell(row) }
      ],
      loadSelected: async (zaprosId) => Requests._fetchKp(zaprosId),
      postProcessSelected: async (kpRows) => {
        const map = new Map();
        (kpRows || []).forEach(k => {
          if (!k.id_firma) return;
          if (!map.has(k.id_firma)) {
            map.set(k.id_firma, { id_firmy: k.id_firma, naimenovanie: k.firma_nazvanie || '', lastSendDate: k.date_otpravki || '', linkDocDate: k.link_dok || '', emails: '', hasEmail: false, dogovorNom: '', dogovorData: '' });
          }
          const ex = map.get(k.id_firma);
          if (k.date_otpravki && (!ex.lastSendDate || k.date_otpravki > ex.lastSendDate)) ex.lastSendDate = k.date_otpravki;
          if (k.link_dok && (!ex.linkDocDate || k.link_dok > ex.linkDocDate)) ex.linkDocDate = k.link_dok;
          // ✅ НОВОЕ: фактический договор КП (первый непустой — после
          //    автопривязки все КП фирмы создаются с одним договором,
          //    персональные смены редки)
          if (k.id_dogovor && k.nom_dogovor && !ex.dogovorNom) {
            ex.dogovorNom = k.nom_dogovor;
            ex.dogovorData = k.data_dogovor || '';
          }
        });
        const firms = Array.from(map.values());
        await Requests.enrichFirmsWithContacts(firms);
        return firms;
      },
      loadAvailable: async (masterId, selectedIds) => {
        const selectedSet = new Set(selectedIds);
        return Requests._allFirmy.filter(f => !selectedSet.has(f.id_firmy)).map(f => ({ id_firmy: f.id_firmy, naimenovanie: f.naimenovanie }));
      },
      moveButtons: [ 
        { id: 'btnAddFirm', action: 'moveToSelected' }, 
        { id: 'btnDelFirm', action: 'moveToAvailable' }, 
        { id: 'btnSelectAllFirms', action: 'selectAll' }, 
        { id: 'btnClearFirm', action: 'clearSelections' }
      ],
      customButtons: [
        { id: 'btnEmailFirma', action: 'custom', handler: 'sendToFirms' },
        { id: 'btnPreviewZayavka', action: 'custom', handler: 'previewZayavka' },
        { id: 'btnUpdateURL', action: 'custom', handler: 'updateURL' }
      ],
      customHandlers: { sendToFirms: () => Requests.sendToFirms(), previewZayavka: () => Requests.previewZayavka(), updateURL: () => Requests.updateURL() },
      onChange: () => {
          Requests._formStateManager.recalculate();  // ✅ Пересчитываем dirty через FSM
          Requests.updateButtonStates();
      }
    });

    Requests._firmyBlock.onSelectionChange = () => Requests.updateStatusUI();

    // ===== Привязки событий =====
    document.getElementById('btnZaprosAdd').onclick = () => Requests.add();
    document.getElementById('btnZaprosSave').onclick = () => Requests.save();
    document.getElementById('btnZaprosDel').onclick = () => Requests.del();
    document.getElementById('btnEmailTeh').onclick = () => Requests.sendToTechnolog();
    // ✅ T89: проверка доступности файлов по ссылке (шаг 2)
    document.getElementById('btnCheckUrl').onclick = () => Requests.checkUrl();
    // ✅ T90: треугольник (как у блоков фильтров) — свернуть/развернуть отчёт проверки
    const btnUrlCheckToggle = document.getElementById('btnUrlCheckToggle');
    if (btnUrlCheckToggle) btnUrlCheckToggle.onclick = () => Requests.toggleUrlCheckResult();
    // ✅ T54: «🧹» — очистка левого списка от дублей № чертежа
    const btnClearDoubles = document.getElementById('btnClearDoubles');
    if (btnClearDoubles) btnClearDoubles.onclick = () => Requests.clearDuplicates();

    // ===== Особый режим: без фактической отправки писем =====
    // Чекбокс на странице: письма не отправляются, но даты
    // и статусы проставляются как при обычной отправке
    const chkNoSend = document.getElementById('chkNoSend');
    if (chkNoSend) {
      chkNoSend.addEventListener('change', () => {
        chkNoSend.closest('.dry-run-label')?.classList.toggle('active', chkNoSend.checked);
        if (chkNoSend.checked) {
          toast('⚠️ Включён режим «без отправки»: письма отправляться не будут, даты и статусы будут проставлены', 'warning');
        }
      });
    }

    ['fltNomerChert', 'fltNaimenovanie', 'fltAvtoDet'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => Requests.applyFilters());
    });
    // ✅ НОВОЕ: фильтры года меняют автоподбор договоров — перезагружаем
    //    карту «фирма → договор» и перерисовываем колонку в списках фирм
    ['fltGod', 'fltGodDo'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => Requests.applyFilters());
      document.getElementById(id).addEventListener('change', () => Requests.loadFirmyDogovoryDebounced());
    });
    // ✅ НОВОЕ: дата запроса — фолбэк года для автоподбора (когда фильтр
    //    года пуст); её смена тоже обновляет колонку договоров
    document.getElementById('zData')?.addEventListener('change', () => Requests.loadFirmyDogovoryDebounced());
    ['fltFirma', 'fltTO', 'fltPPD', 'fltTisn', 'fltPokr', 'fltTONA'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => Requests.applyFilters());
    });
    document.getElementById('btnClearAllFilters').onclick = () => {
      document.getElementById('fltGod').value = new Date().getFullYear();
      ['fltNomerChert', 'fltNaimenovanie', 'fltAvtoDet', 'fltFirma'].forEach(id => document.getElementById(id).value = '');
      ['fltTO', 'fltPPD', 'fltTisn', 'fltPokr', 'fltTONA'].forEach(id => document.getElementById(id).checked = false);
      Requests.applyFilters();
      Requests.loadFirmyDogovoryDebounced();  // ✅ НОВОЕ: карта договоров под новый фильтр года
    };

    // ✅ FormStateManager сам отслеживает изменения через onDirtyChange. 
    // Нам нужно только обновлять UI статусов при вводе URL.
    document.getElementById('zUrl').addEventListener('input', () => Requests.updateStatusUI());
    // ✅ T89: ссылка изменилась — прячем устаревший отчёт проверки
    document.getElementById('zUrl').addEventListener('input', () => Requests.resetUrlCheckUI());
    document.getElementById('zTech').addEventListener('change', () => {
      Requests.updateButtonStates();
      Requests.onTechChange();
    });

    await Requests.loadReferences();

    // ✅ Явная регистрация в реестре lock-aware записей.
    // Мы передаём реальные методы Requests, не полагаясь на скрытые соглашения об именовании.
    registerLockAwareRecord('zapros_kp', {
      form: Requests._formStateManager,
      isDirty: () => Requests.isDirty(), // ✅ КРИТИЧЕСКИ ВАЖНО: учитывает и форму, и блоки
      save: () => Requests.save(),
      onHeaderClick: () => Requests.onHeaderClick(),
      checkForExternalChanges: () => Requests.checkForExternalChanges(),
    });



  },

  // ============================================================
  // СПРАВОЧНИКИ
  // ============================================================
  async loadFirmy() {
    try {
      Requests._allFirmy = await api('GET', '/api/firmy');
      if (!Array.isArray(Requests._allFirmy)) Requests._allFirmy = [];
      const fltFirma = document.getElementById('fltFirma');
      if (!fltFirma) return;
      const currentValue = fltFirma.value;
      fltFirma.innerHTML = '<option value="">Выбор Контрагента</option>';
      Requests._allFirmy.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.id_firmy;
        opt.textContent = f.naimenovanie;
        fltFirma.appendChild(opt);
      });
      if (currentValue && Array.from(fltFirma.options).some(o => o.value === currentValue)) {
        fltFirma.value = currentValue;
      }
    } catch (e) {
      console.warn('Не удалось загрузить фирмы:', e);
    }
  },
// ============================================================
// ПРОВЕРКА КОНФЛИКТА ДАННЫХ (аналог CrudModule.checkForExternalChanges)
// ============================================================
async checkForExternalChanges() {
    const id = Requests._selectedZaprosId;
    if (!id) return { changed: false };
    if (!Requests.isDirty()) return { changed: false };
    
    try {
        const response = await api('GET', `/api/zapros-kp?id=${encodeURIComponent(id)}`);
        const list = Array.isArray(response) ? response : (response ? [response] : []);
        const serverData = list.find(row => row.id === id);
        
        if (!serverData) return { changed: false, deleted: true };
        
        const snapshot = Requests._formStateManager._initialSnapshot;
        if (!snapshot) return { changed: false };
        
        const changes = [];
        for (const key of Object.keys(snapshot)) {
            const field = Requests._formStateManager._fields.find(f => f.key === key);
            const snapshotVal = Requests._normalizeForCompare(snapshot[key], field);
            const serverVal = Requests._normalizeForCompare(serverData[key], field);
            
            if (snapshotVal !== serverVal) {
                changes.push({
                    key,
                    label: field?.label || key,
                    snapshot: Requests._formatForDisplay(snapshot[key], field),
                    server: Requests._formatForDisplay(serverData[key], field)
                });
            }
        }
        
        return { changed: changes.length > 0, changes, serverData };
    } catch (e) {
        return { changed: false, error: e.message };
    }
},

_normalizeForCompare(value, field) {
    if (value === null || value === undefined || value === '') return '';
    if (field?.type === 'checkbox') {
        if (value === true || value === 1) return '1';
        if (value === false || value === 0) return '0';
        const v = String(value).toLowerCase().trim();
        if (['1', 'true', 'да', 'yes', 'истина', 'on'].includes(v)) return '1';
        return '0';
    }
    return String(value).trim();
},

_formatForDisplay(value, field) {
    if (value === null || value === undefined || value === '') return '—';
    if (field?.type === 'checkbox') {
        const norm = Requests._normalizeForCompare(value, field);
        return norm === '1' ? '✅ Да' : '❌ Нет';
    }
    if (field?.type === 'date') {
        const s = String(value).trim();
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return `${m[3]}.${m[2]}.${m[1]}`;
        return s;
    }
    return String(value).trim();
},
  async loadTech() {
    try {
      const tech = await api('GET', '/api/tech');
      const sel = document.getElementById('zTech');
      if (!sel) return;
      const currentValue = sel.value;
      sel.innerHTML = '<option value="">— Выберите технолога —</option>';
      tech.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.fio} (${t.email})`;
        sel.appendChild(opt);
      });
      if (currentValue && Array.from(sel.options).some(o => o.value === currentValue)) {
        sel.value = currentValue;
      }
    } catch (e) {
      console.warn('Не удалось загрузить технологов:', e);
    }
  },

  async loadReferences() {
    // ✅ loadAllKp() удалён: полный список КП клиенту больше не нужен —
    //    исключение КП-позиций выполняется на сервере (/api/plan/available)
    await Promise.all([
      Requests.loadTech(),
      Requests.loadFirmy(),
      Requests.loadFirmyDogovory()  // ✅ НОВОЕ: карта «фирма → договор» для колонки в списках фирм
    ]);
  },

  // ============================================================
  // ✅ НОВОЕ: колонка «№ договора и дата» в списках фирм.
  //   Показывает, какой договор попадёт в КП при создании записей
  //   (по тем же правилам, что и автопривязка при создании запроса).
  //   Приоритет отображения:
  //     1) фактический договор КП фирмы (зелёный, уже записан);
  //     2) автоподбор по текущему фильтру года (жёлтый курсив — будет
  //        записан при сохранении запроса);
  //     3) «— нет —» (красный курсив — договора по фильтру нет, задать
  //        персонально можно на странице «Внесение КП»).
  // ============================================================
  _dogovorCell(row) {
    const fmtDate = (s) => {
      const m = String(s || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
    };
    const label = (nom, data) => {
      const d = fmtDate(data);
      return `№${nom || '—'}${d ? ' от ' + d : ''}`;
    };
    // 1) Фактический договор уже записан в КП этой фирмы
    if (row && row.dogovorNom) {
      return { text: label(row.dogovorNom, row.dogovorData), style: { color: '#1a7f37', fontWeight: '600' } };
    }
    // 2) Автоподбор по текущему фильтру года (как при создании запроса)
    const auto = row && row.id_firmy ? Requests._firmyDogovoryMap[row.id_firmy] : null;
    if (auto) {
      return { text: label(auto.nom_dogovor, auto.data_dogovor), style: { color: '#9a6700', fontStyle: 'italic' } };
    }
    // 3) Договора нет
    return { text: '— нет —', style: { color: '#cf222e', fontStyle: 'italic' } };
  },

  // ============================================================
  // ✅ НОВОЕ: загрузка карты «фирма → договор» с сервера. Сервер резолвит
  //   договоры РОВНО тем же кодом (_parseGodRange + правила
  //   _findDogovorForFirma), что и при создании запроса, поэтому колонка
  //   всегда показывает именно тот договор, который будет записан в КП.
  // ============================================================
  async loadFirmyDogovory() {
    try {
      const q = new URLSearchParams();
      q.set('godFrom', document.getElementById('fltGod')?.value || '');
      q.set('godTo', document.getElementById('fltGodDo')?.value || '');
      q.set('dataForm', document.getElementById('zData')?.value || '');
      const r = await api('GET', `/api/zapros-kp/firmy-dogovory?${q.toString()}`);
      Requests._firmyDogovoryMap = (r && r.dogovory) || {};
      Requests._dogovorAllById = (r && r.allById) || {};
      // Перерисовать оба списка фирм с обновлённой колонкой
      Requests._firmyBlock?.selectedTable?.refresh();
      Requests._firmyBlock?.availableTable?.refresh();
    } catch (e) {
      console.warn('Не удалось загрузить договоры фирм:', e);
    }
  },

  // Дебаунс: фильтр года (number input) дёргает input на каждый символ
  loadFirmyDogovoryDebounced() {
    clearTimeout(Requests._firmyDogovoryTimer);
    Requests._firmyDogovoryTimer = setTimeout(() => Requests.loadFirmyDogovory(), 250);
  },

  // ============================================================
  // КЭШ КП — 1 API-вызов вместо 2
  // ============================================================
  async _fetchKp(zaprosId) {
    if (Requests._cachedKpZaprosId !== zaprosId || !Requests._cachedKpPromise) {
      Requests._cachedKpZaprosId = zaprosId;
      Requests._cachedKpPromise = api('GET', `/api/kom-predl?zaprosId=${encodeURIComponent(zaprosId)}`);
    }
    const result = await Requests._cachedKpPromise;
    return Array.isArray(result) ? result : [];
  },

  // ============================================================
  // ФИЛЬТРЫ И ЗАГРУЗКА
  // ============================================================
  applyFilters() {
    const filters = {
      fltGod: document.getElementById('fltGod').value,
      fltFirma: document.getElementById('fltFirma').value,
      fltNomerChert: document.getElementById('fltNomerChert').value,
      fltNaimenovanie: document.getElementById('fltNaimenovanie').value,
      fltAvtoDet: document.getElementById('fltAvtoDet').value,
      fltTO: document.getElementById('fltTO').checked ? '1' : '',
      fltPPD: document.getElementById('fltPPD').checked ? '1' : '',
      fltTisn: document.getElementById('fltTisn').checked ? '1' : '',
      fltPokr: document.getElementById('fltPokr').checked ? '1' : '',
      fltTONA: document.getElementById('fltTONA').checked ? '1' : ''
    };
    // 1) Список запросов (FilterableTable с собственным debounce + AbortController):
    //    все фильтры, включая детальные, как и прежде.
    const zaprosPayload = filters;
    //    Защита от лишних запросов: applyFilters() зовётся на каждый ввод символа,
    //    а эффективный payload может не меняться.
    const zaprosKey = JSON.stringify(zaprosPayload);
    if (zaprosKey !== Requests._lastZaprosFiltersKey) {
      Requests._lastZaprosFiltersKey = zaprosKey;
      state.tables.zapros.applyFilters(zaprosPayload);
    }

    // 2) Доступные детали — applyAvailableFilters() зовётся ВСЕГДА:
    //    DualListBlock соберёт фильтры через getAvailableFilters()
    //    (см. _availableFiltersPayload) + getAvailableRawFilters и вызовет
    //    availableTable.applyFilters(). Фильтры по детали действуют на
    //    available-таблицу так же безусловно, как на список запросов.
    //    Перезагрузка только при изменении эффективного набора фильтров.
    const availableKey = JSON.stringify(Requests._availableFiltersPayload());
    if (Requests._detaliBlock && availableKey !== Requests._lastAvailableFiltersKey) {
      Requests._lastAvailableFiltersKey = availableKey;
      Requests._detaliBlock.applyAvailableFilters();
    }
  },

  // ============================================================
  // ЭФФЕКТИВНЫЕ ФИЛЬТРЫ AVAILABLE-ТАБЛИЦЫ.
  // Фильтры по детали (№ чертежа, Наименование, Авто/Моб/Дет, чекбоксы
  // техопераций) применяются к таблице доступных деталей БЕЗУСЛОВНО —
  // как на «Формировании плана производства», где фильтры страницы
  // одновременно действуют и на таблицу, и на селект оснастки.
  // fltGod — базовый параметр, применяется всегда (как и в старом loadAvailable).
  // ============================================================
  _availableFiltersPayload() {
    const val = id => document.getElementById(id)?.value ?? '';
    const chk = id => document.getElementById(id)?.checked ? '1' : '';
    return {
      fltGod: val('fltGod') || new Date().getFullYear(),
      fltNomerChert: val('fltNomerChert'),
      fltNaimenovanie: val('fltNaimenovanie'),
      fltAvtoDet: val('fltAvtoDet'),
      fltTO: chk('fltTO'),
      fltPPD: chk('fltPPD'),
      fltTisn: chk('fltTisn'),
      fltPokr: chk('fltPokr'),
      fltTONA: chk('fltTONA')
    };
  },

  async load() {
    await state.tables.zapros.loadImmediate({});
    // ✅ Таблица перезагружена без фильтров — сбрасываем ключ, чтобы
    //    следующий applyFilters() с тем же набором фильтров не был пропущен
    Requests._lastZaprosFiltersKey = null;
  },



  // ============================================================
  // ВЫБОР ЗАПРОСА
  // ============================================================
  async onSelect(row) {
    DirtyGuard.register(
      Requests._formStateManager,                            // formStateManager — нет (ручной трекинг через _formDirty)
      () => Requests.save(),             // saveCallback
      () => Requests.onHeaderClick()        // ✅ ФИКС: customDirtyCheck — учитывает И форму, И блоки
    );
    Requests._lastSelectedId = row.id;

    Requests._selectedZaprosId = row.id;
    Requests._cachedKpPromise = null;
    Requests._cachedKpZaprosId = null;

    // ✅ 2. ИСПОЛЬЗУЕМ FormStateManager для заполнения и создания снимка
    Requests._formStateManager.fillFromRow(row);
    
    // Обработка кастомных полей, которых нет в FSM
    setDateOrText('zDataTeh', row.data_peredach_tehnologu, 'не отправлялось');
    setDateOrText('zDataOtvTeh', row.data_otv_tehnolog, '');
    setDateOrText('zDataUrl', row.date_url_update, '');

    // ✅ T90: при смене выбранного запроса старый отчёт проверки ссылки
    // (и кнопка письма) сбрасываются — отчёт относится к текущей ссылке
    Requests.resetUrlCheckUI();

    await Requests._detaliBlock.load(row.id);
    await Requests._firmyBlock.load(row.id);

    const status = row.statys || 'создание';
    const lockedStatuses = ['отправлено Всем контрагентам', 'отправлено не Всем контрагентам', 'выбраны лучшие КП', 'создан заказ по лучшим КП'];
    
    if (lockedStatuses.includes(status)) {
      Requests._detaliBlock?.availableTable?.setData([]);
      Requests._firmyBlock?.availableTable?.setData([]);
    }

    Requests.updateCompositionVisibility(status);
    Requests._updateClearDoublesBtn(status);   // ✅ T54-c: «🧹» активна до выбора лучших КП
    Requests.updateButtonStates();


    Requests._syncFormLockState(row);
  },
  
  _syncFormLockState(row = null) {
    const formPanel = document.querySelector('#tabZapros .form-panel') || document.querySelector('.form-panel');
    if (!formPanel) return;

    const selectedItem = row || state.tables.zapros.data.find(d => d.id === state.tables.zapros.selectedId);
    if (!selectedItem) {
      removeLockBanner(formPanel);
      formPanel.classList.remove('editing');
      return;
    }

    const locker = isLocked('zapros_kp', selectedItem.id);

    if (locker) {
      // Запись заблокирована ДРУГИМ пользователем
      showLockBanner(formPanel, locker);
      formPanel.classList.remove('editing');
    } else {
      // Запись свободна (или заблокирована нами)
      removeLockBanner(formPanel);
      if (EditLock.current?.table === 'zapros_kp' && EditLock.current?.id === selectedItem.id) {
        formPanel.classList.add('editing');
      } else {
        formPanel.classList.remove('editing');
      }
    }
  },


  // ============================================================
  // ВИДИМОСТЬ СОСТАВА ЗАПРОСА (блокировка по статусу)
  // ============================================================

  // ✅ T54-c: СОСТОЯНИЕ КНОПКИ «🧹» (очистка от дублей № чертежа).
  // Кнопка активна, пока по запросу НЕ выбраны лучшие КП: на «создание»,
  // «отправлено технологу», «отправлено Всем/не Всем контрагентам» она
  // доступна — именно на этих этапах и вычищают дубли перед выбором
  // лучших КП. Гаснет только на «выбраны лучшие КП» и
  // «создан заказ по лучшим КП» (или когда запрос не выбран).
  // ============================================================
  _updateClearDoublesBtn(statusOverride) {
    const btn = document.getElementById('btnClearDoubles');
    if (!btn) return;
    const raw = (statusOverride != null) ? statusOverride
      : (document.getElementById('zStatus')?.value || '');
    const status = String(raw).trim();
    const bestKpChosen = status === 'выбраны лучшие КП' || status === 'создан заказ по лучшим КП';
    btn.disabled = !Requests._selectedZaprosId || bestKpChosen;
    btn.title = bestKpChosen
      ? 'Недоступно: по запросу выбраны лучшие КП'
      : 'Очистить от дублей (убирает повторяющиеся № чертежа; позиции с назначенным лучшим КП не удаляются)';
  },

  updateCompositionVisibility(status) {
     const lockedStatuses = [
        'отправлено Всем контрагентам',
        'отправлено не Всем контрагентам',
        'выбраны лучшие КП',
        'создан заказ по лучшим КП'
    ];
    
    const shouldHide = lockedStatuses.includes(status);
    
    // ✅ УПРАВЛЕНИЕ ВИДИМОСТЬЮ (бизнес-логика)
    const visibility = {
        showAvailable: !shouldHide,
        showButtons: !shouldHide,
        expandSelected: shouldHide
    };
    
    Requests._detaliBlock?.setVisibility(visibility);
    Requests._firmyBlock?.setVisibility(visibility);

   setTimeout(() => {
      Requests._detaliBlock?.selectedTable?.refresh();
      Requests._firmyBlock?.selectedTable?.refresh();
    }, 50);
    // ✅ ВАЖНО: После изменения видимости нужно пересчитать dirty, так как таблицы могли обновиться
    Requests._formStateManager.recalculate(); 
  },

  // ============================================================
  // ОБОГАЩЕНИЕ ФИРМ EMAIL-КОНТАКТАМИ
  // ============================================================
  async enrichFirmsWithContacts(firms) {
    if (!firms || firms.length === 0) return;
    await Promise.all(firms.map(async (firm) => {
      try {
        const c = await api('GET', `/api/email/firm-contacts?id_firmy=${encodeURIComponent(firm.id_firmy)}`);
        firm.emails = c?.emailString || '';
        firm.hasEmail = !!firm.emails;
      } catch (e) {
        firm.emails = '';
        firm.hasEmail = false;
      }
    }));
  },

  // ============================================================
  // ВЫБОР ТЕХНОЛОГА = АВТОСОХРАНЕНИЕ
  // ============================================================
  async onTechChange() {
    if (!Requests._selectedZaprosId) return;
    await Requests.saveSilent();
    toast('Технолог сохранён в запросе');
  },

  async saveSilent() {
    if (!Requests._selectedZaprosId) return;
    const payload = Requests._buildPayload();
    if (!payload.n_zaprosa || !payload.data_form) return;

    const detali = Requests._detaliBlock.getSelectedRows();
    const firmy = Requests._firmyBlock.getSelectedRows();
    if (detali.length === 0 || firmy.length === 0) return;

    await batchManager.withBatch('zapros_kp', async () => {
      const r = await api('PUT',
        `/api/zapros-kp/${Requests._selectedZaprosId}/with-kp`,
        { ...payload,
          combinations: Requests._buildCombinations(),
          // ✅ НОВОЕ: фильтр года — автопривязка договора добавленным КП
          godFrom: document.getElementById('fltGod')?.value || '',
          godTo: document.getElementById('fltGodDo')?.value || ''
        });
      if (r.error) {
        if (r.code === 'CANNOT_ADD_AFTER_SEND' || r.code === 'CHAIN_IN_ORDER') {
          alert(r.error);
          return;
        }
        toast('Ошибка сохранения: ' + r.error, 'error');
        return;
      }
      await Requests.load();
      state.tables.zapros.selectById(Requests._selectedZaprosId);

      Requests._formStateManager.recalculate();
      Requests._detaliBlock.commit();   // ✅ БЫЛО: resetDirty()
      Requests._firmyBlock.commit();    // ✅ БЫЛО: resetDirty()
    });
  },

  // ============================================================
  // ПОСТРОЕНИЕ КОМБИНАЦИЙ детали × фирмы
  // ============================================================
  _buildCombinations() {
    const detali = Requests._detaliBlock.getSelectedRows();
    const firmy = Requests._firmyBlock.getSelectedRows();
    const combinations = [];
    for (const det of detali) {
      for (const firm of firmy) {
        combinations.push({ id_plana: det.id, id_firma: firm.id_firmy || firm.id });
      }
    }
    return combinations;
  },

  // ============================================================
  // ✅ T54: ДУБЛИ № ЧЕРТЕЖА И ЛУЧШЕЕ КП
  //   1) Добавление позиции в запрос блокируется, если этот же № чертежа
  //      уже есть в запросе (или добавляется второй раз в одной пачке).
  //   2) Удаление позиции блокируется, если по ней назначено лучшее КП.
  //   3) Кнопка «🧹» убирает дубли № чертежа (позиции с лучшим КП
  //      не трогаются) и сохраняет запрос.
  // ============================================================
  // Ключ сравнения № чертежа: без внешних пробелов, без учёта регистра
  // («аа123.456» и «АА123.456» — один и тот же чертёж)
  _chertKey(v) {
    return String(v || '').trim().toUpperCase();
  },

  // Хук DualListBlock (validateMoveToSelected): запрет дублирования № чертежа
  _validateDetaliDup(newRows, currentRows) {
    const seen = new Set((currentRows || []).map(r => Requests._chertKey(r.nomer_chertezha)));
    const dups = new Set();
    for (const r of (newRows || [])) {
      const k = Requests._chertKey(r.nomer_chertezha);
      if (!k) continue;
      if (seen.has(k)) dups.add(String(r.nomer_chertezha).trim());
      seen.add(k);
    }
    if (dups.size === 0) return null;
    return '🚫 В запросе уже есть деталь с № чертежа: ' + Array.from(dups).join(', ') +
           '. В рамках одного запроса не может быть позиций с одинаковым номером чертежа. ' +
           'Если дубль уже сохранён в запросе — нажмите «🧹» (очистить от дублей).';
  },

  // Хук DualListBlock (validateMoveToAvailable): позиция с назначенным
  // лучшим КП удалению не подлежит
  _validateDetaliBestKp(removedRows) {
    const best = (removedRows || []).filter(r => Requests._bestKpPlanIds.has(String(r.id)));
    if (best.length === 0) return null;
    const nomers = [...new Set(best.map(r => String(r.nomer_chertezha || '').trim()))].join(', ');
    return '🚫 Нельзя удалить позицию: по детали (№ чертежа ' + nomers +
           ') назначено лучшее КП. Удаление позиций возможно только до назначения лучшего предложения.';
  },

  // Кнопка «🧹 Очистить от дублей»: находит в левом списке позиции с
  // одинаковым № чертежа и убирает дубли. Правила:
  //   1) в группе дублей остаётся одна позиция — приоритет у позиции
  //      с назначенным лучшим КП (её удалять нельзя), иначе первая;
  //   2) дубль с назначенным лучшим КП НЕ удаляется (пропускается);
  //   3) после очистки запрос сохраняется автоматически.
  async clearDuplicates() {
    if (!Requests._selectedZaprosId) { toast('Сначала выберите запрос', 'warning'); return; }
    const rows = Requests._detaliBlock.getSelectedRows();
    if (rows.length === 0) { toast('Список оснастки пуст', 'warning'); return; }

    // Группировка по № чертежа
    const groups = new Map();
    rows.forEach(r => {
      const k = Requests._chertKey(r.nomer_chertezha);
      if (!k) return;                       // без № чертежа не проверяем
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });

    const toRemove = [];       // id позиций, убираемых как дубли
    const skippedWithKp = [];  // № чертежа дублей, которые удалить нельзя (лучшее КП)
    for (const grp of groups.values()) {
      if (grp.length < 2) continue;
      // Оставляем: приоритет — позиция с назначенным лучшим КП, иначе первая
      const keeper = grp.find(r => Requests._bestKpPlanIds.has(String(r.id))) || grp[0];
      for (const r of grp) {
        if (r === keeper) continue;
        if (Requests._bestKpPlanIds.has(String(r.id))) {
          skippedWithKp.push(String(r.nomer_chertezha || '').trim());
        } else {
          toRemove.push(r.id);
        }
      }
    }

    if (toRemove.length === 0) {
      if (skippedWithKp.length > 0) {
        toast('Дубликаты не удалены: по ним назначено лучшее КП (' +
              [...new Set(skippedWithKp)].join(', ') + '). Удаление позиций возможно только до назначения лучшего КП.', 'warning');
      } else {
        toast('Дубликатов № чертежа не найдено', 'success');
      }
      return;
    }

    Requests._detaliBlock.removeRowsByIds(toRemove);
    const removedCount = toRemove.length;
    const skipped = [...new Set(skippedWithKp)];
    await Requests.save();
    if (skipped.length > 0) {
      toast('🧹 Удалено дублей: ' + removedCount + '. Не удалены (назначено лучшее КП): ' + skipped.join(', '), 'warning');
    } else {
      toast('🧹 Очистка от дублей выполнена: удалено ' + removedCount, 'success');
    }
  },

  // ============================================================
  // КЛИК ПО ЗАГОЛОВКУ / ОЧИСТКА ФОРМЫ
  // ============================================================
async onHeaderClick() {
    // 1. Перерегистрация DirtyGuard
    DirtyGuard.register(
        Requests._formStateManager,
        () => Requests.save(),
        () => Requests.onHeaderClick()
    );
    
    // 2. Запоминаем текущий ID (для возврата при отмене)
    const previousSelectedId = Requests._lastSelectedId;
    
    // 3. Если форма грязная — показываем модалку
    if (DirtyGuard._isDirty && DirtyGuard._isDirty()) {
        const canProceed = await DirtyGuard.handleRecordChange();
        if (!canProceed) {
            // Пользователь нажал "Остаться" — возвращаем выбор к предыдущей записи
            if (previousSelectedId) {
                state.tables.zapros.selectById(previousSelectedId);
            }
            return;
        }
    }
    
    // 4. Сбрасываем ID (переход в режим "новая запись")
    Requests._lastSelectedId = null;
    
    // 5. Очистка формы
    Requests.clearForm();
    Requests.updateCompositionVisibility('создание');
    Requests._updateClearDoublesBtn('создание');   // ✅ T54-c
    Requests.updateButtonStates();

    
    // 6. Снятие баннера блокировки (эталонная логика)
    if (Requests._formStateManager._fields && Requests._formStateManager._fields.length > 0) {
        const firstEl = document.getElementById(Requests._formStateManager._fields[0].domId);
        if (firstEl) {
            const formPanel = firstEl.closest('.form-panel');
            if (formPanel) {
                removeLockBanner(formPanel);
                formPanel.classList.remove('editing');
            }
        }
    }
},

  clearForm() {
    Requests._selectedZaprosId = null;
    Requests._cachedKpPromise = null;
    Requests._cachedKpZaprosId = null;
    Requests._bestKpPlanIds = new Set();   // ✅ T54: сброс набора «лучших КП»

    // ✅ 3. ИСПОЛЬЗУЕМ FormStateManager для очистки и сброса снимка
    Requests._formStateManager.clearForm();
    
    setDateOrText('zDataTeh', '', 'не отправлялось');
    setDateOrText('zDataOtvTeh', '', '');
    setDateOrText('zDataUrl', '', '');

    Requests._detaliBlock?.clear();
    Requests._firmyBlock?.clear();

    // ✅ T90: в режиме «новая запись» отчёта проверки ссылки нет
    Requests.resetUrlCheckUI();

    document.getElementById('zaprosFormTitle').textContent = 'Новый запрос КП';
    Requests.lockMainFields(false);
    Requests._detaliBlock?.reloadAvailable();
    Requests._firmyBlock?.reloadAvailable();
    // ✅ ЭТАЛОННАЯ ЛОГИКА ИЗ CrudModule._onHeaderClick():
    // Снимаем баннер блокировки и стиль редактирования.
    // Так как мы уходим в режим "новая запись", никаких блокировок быть не должно.
    if (Requests._formStateManager._fields && Requests._formStateManager._fields.length > 0) {
      const firstEl = document.getElementById(Requests._formStateManager._fields[0].domId);
      if (firstEl) {
        const formPanel = firstEl.closest('.form-panel');
        if (formPanel) {
          removeLockBanner(formPanel);
          formPanel.classList.remove('editing');
        }
      }
    }
    // ✅ T54-c: в режиме «новая запись» запроса нет — «🧹» гаснет
    Requests._updateClearDoublesBtn('создание');
  },

  lockMainFields(locked) {
    ['zNomer', 'zData'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.readOnly = locked;
    });
  },

  _buildPayload() {
    // ✅ 4. Берем данные из FormStateManager (он знает про все стандартные поля)
    const payload = Requests._formStateManager.buildPayload();
    // Добавляем кастомные поля
    payload.data_peredach_tehnologu = getDateValue('zDataTeh');
    payload.data_otv_tehnolog = getDateValue('zDataOtvTeh');
    payload.date_url_update = getDateValue('zDataUrl');
    return payload;
  },

  // ============================================================
  // СОСТОЯНИЕ КНОПОК CRUD
  // ============================================================

  updateButtonStates() {
      const selectedId = Requests._selectedZaprosId;
      const locker = selectedId ? isLocked('zapros_kp', selectedId) : null;
      const lockedByUser = !!locker;
      
      const nomer = document.getElementById('zNomer').value.trim();
      const data = document.getElementById('zData').value;
      const detali = Requests._detaliBlock?.getSelectedRows() || [];
      const firmy = Requests._firmyBlock?.getSelectedRows() || [];

      const btnAdd = document.getElementById('btnZaprosAdd');
      const btnSave = document.getElementById('btnZaprosSave');
      const btnDel = document.getElementById('btnZaprosDel');

      if (!selectedId) {
          btnAdd.disabled = !(nomer && data && detali.length > 0 && firmy.length > 0);
          btnSave.disabled = true;
          btnDel.disabled = true;
      } else {
          btnAdd.disabled = true;
          btnSave.disabled = !(nomer && data) || lockedByUser || detali.length === 0 || firmy.length === 0 || !Requests.isDirty();
          btnDel.disabled = lockedByUser;
      }
      
      // ✅ КРИТИЧЕСКИ ВАЖНО: проверяем, нужно ли реально менять состояние
      // Это предотвращает лишние вызовы setLocked() и разрывает рекурсивный цикл
      if (Requests._detaliBlock && Requests._detaliBlock.locked !== lockedByUser) {
          Requests._detaliBlock.setLocked(lockedByUser);
      }
      if (Requests._firmyBlock && Requests._firmyBlock.locked !== lockedByUser) {
          Requests._firmyBlock.setLocked(lockedByUser);
      }

      // ✅ T54-c: «🧹» — активна, пока не выбраны лучшие КП (и запрос выбран)
      Requests._updateClearDoublesBtn();

      Requests.updateStatusUI();
  },

  // ============================================================
  // DIRTY-ТРЕКИНГ ДЛЯ DIRTYGUARD
  // ============================================================
  isDirty() {
    return Requests._formStateManager.isDirty() || Requests.hasDirtyBlocks();
  },

  hasDirtyBlocks() {
    return (Requests._detaliBlock?.dirty || false) ||
          (Requests._firmyBlock?.dirty || false);
  },

  // ============================================================
  // ОСОБЫЙ РЕЖИМ: БЕЗ ФАКТИЧЕСКОЙ ОТПРАВКИ ПИСЕМ
  // Чекбокс «Без отправки писем (особый случай)» на странице:
  // письма реально не отправляются, но даты и статусы
  // проставляются как при обычной отправке
  // ============================================================
  _isDryRun() {
    return !!document.getElementById('chkNoSend')?.checked;
  },

  async revertBlocks() {
    // ✅ 6. ПРАВИЛЬНЫЙ ОТКАТ: FormStateManager сам вернет значения из своего снимка
    Requests._formStateManager.revertChanges();
    
    // Восстанавливаем кастомные поля из текущей строки в таблице
    if (Requests._selectedZaprosId) {
      const row = state.tables.zapros.data.find(z => z.id === Requests._selectedZaprosId);
      if (row) {
        setDateOrText('zDataTeh', row.data_peredach_tehnologu, 'не отправлялось');
        setDateOrText('zDataOtvTeh', row.data_otv_tehnolog, '');
        setDateOrText('zDataUrl', row.date_url_update, '');
      }
    } else {
      setDateOrText('zDataTeh', '', 'не отправлялось');
      setDateOrText('zDataOtvTeh', '', '');
      setDateOrText('zDataUrl', '', '');
    }

    await Requests._detaliBlock?.revert();
    await Requests._firmyBlock?.revert();
    Requests._formStateManager.recalculate();
    Requests.updateButtonStates();
  },

  // ============================================================
  // ПОШАГОВОЕ СОГЛАСОВАНИЕ (UI)
  // ============================================================
  // ============================================================
  // РЕНДЕР ВОРКФЛОУ (обходит WORKFLOW, не меняется при добавлении шагов)
  // ============================================================
  updateStatusUI() {
    const ctx = Requests._buildWorkflowContext();

    // Глобальные эффекты — не привязаны к конкретному шагу
    const approval = document.getElementById('approvalFieldset');
    if (approval) approval.style.display = ctx.hasZapros ? '' : 'none';
    Requests.lockMainFields(ctx.techSent);

    // Собираем firmButtons из всех шагов для единого вызова setCustomButtons
    const firmButtonsState = {};

    for (const step of WORKFLOW) {
      // Видимость и статус «выполнен»
      const stepEl = document.getElementById(step.id);
      if (stepEl) {
        stepEl.style.display = step.visible(ctx) ? '' : 'none';
        stepEl.classList.toggle('done', !!step.done(ctx));
      }

      // Кнопки внутри шага (например, btnEmailTeh внутри stepTeh)
      if (step.buttons) {
        for (const btn of step.buttons) {
          const btnEl = document.getElementById(btn.id);
          if (!btnEl) continue;
          btnEl.style.display = btn.visible(ctx) ? '' : 'none';
          if (btn.disabled) btnEl.disabled = btn.disabled(ctx);
        }
      }

      // Текст-подсказка
      if (step.hint) {
        const hintEl = document.getElementById(step.hint.id);
        if (hintEl) hintEl.textContent = step.hint.text(ctx);
      }

      // Кнопки в колонке фирм — собираем, не применяем (применим один раз после цикла)
      if (step.firmButtons) {
        for (const [btnId, cfg] of Object.entries(step.firmButtons)) {
          firmButtonsState[btnId] = {
            visible: cfg.visible(ctx),
            disabled: cfg.disabled(ctx),
            text: cfg.text(ctx),
          };
        }
      }
    }

    // Один вызов — все фирменные кнопки
    Requests._firmyBlock?.setCustomButtons(firmButtonsState);
  },

  // ============================================================
  // КОНТЕКСТ ВОРКФЛОУ — все производные значения в одном объекте
  // ============================================================
  _buildWorkflowContext() {
    const status = (document.getElementById('zStatus').value || '').trim();
    const hasZapros = !!Requests._selectedZaprosId;

    const firms = Requests._firmyBlock?.getSelectedRows() || [];
    const firmsSent = firms.length > 0 && firms.every(f => f.lastSendDate);
    const urlUpdated = firms.length > 0 && firms.every(f => f.linkDocDate);
    return {
      status,
      hasZapros,
      techSent: hasZapros && status !== 'создание',
      hasURL: !!document.getElementById('zUrl').value.trim(),
      urlSaved: !!getDateValue('zDataOtvTeh'),
      firmsSent,
      urlUpdated,
      finished: status === 'выбраны лучшие КП' || status === 'создан заказ по лучшим КП',
      techValue: !!document.getElementById('zTech').value,
      firmCount: Requests._firmyBlock?.getSelectedCount() || 0,
      firmsBlockLocked: Requests._firmyBlock?.locked || false,
    };
  },
  


  // ============================================================
  // CRUD
  // ============================================================
  async add() {
    const payload = Requests._buildPayload();
    if (!payload.n_zaprosa || !payload.data_form) {
      toast('Заполните № запроса и дату', 'warning'); return;
    }

    const detali = Requests._detaliBlock.getSelectedRows();
    const firmy = Requests._firmyBlock.getSelectedRows();
    if (detali.length === 0 || firmy.length === 0) {
      toast('Добавьте хотя бы одну деталь и одну фирму', 'warning'); return;
    }

    await batchManager.withBatch('zapros_kp', async () => {
      const r = await api('POST', '/api/zapros-kp/with-kp', {
        ...payload,
        combinations: Requests._buildCombinations(),
        // ✅ НОВОЕ: фильтр года страницы — сервер по нему подбирает каждой
        //    фирме её договор и записывает во все КП фирмы (массовая
        //    операция перенесена со страницы «Внесение КП»)
        godFrom: document.getElementById('fltGod')?.value || '',
        godTo: document.getElementById('fltGodDo')?.value || ''
      });
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }

      const firmsWODog = Array.isArray(r.firmyBezDogovora) ? r.firmyBezDogovora.length : 0;
      toast('Запрос и КП созданы.' + Requests._dogovorAssignmentSuffix(r),
            firmsWODog > 0 ? 'warning' : 'success');
      await Requests.load();
      await Requests.loadReferences();
      state.tables.zapros.selectById(r.id);
      const row = state.tables.zapros.data.find(x => x.id === r.id);
      if (row) await Requests.onSelect(row);
    });
  },

  async save() {
    if (!Requests._selectedZaprosId) return;
    const payload = Requests._buildPayload();
    if (!payload.n_zaprosa || !payload.data_form) {
      toast('Заполните обязательные поля', 'warning'); return;
    }

    const detali = Requests._detaliBlock.getSelectedRows();
    const firmy = Requests._firmyBlock.getSelectedRows();
    if (detali.length === 0) {
      toast('Нельзя сохранить: добавьте хотя бы одну деталь', 'warning'); return;
    }
    if (firmy.length === 0) {
      toast('Нельзя сохранить: добавьте хотя бы одну фирму', 'warning'); return;
    }

    // Логика даты ответа технолога
    const urlValid = payload.ssylka_na_chertezh.startsWith('https://disk.360.yandex.ru/');
    if (urlValid && !payload.data_otv_tehnolog) {
      payload.data_otv_tehnolog = sqlDate();
    } else if (!payload.ssylka_na_chertezh.trim()) {
      payload.data_otv_tehnolog = '';
    }
    // ✅ ФИКС: правильный id (было zDataOvvTeh в оригинале)
    setDateOrText('zDataOtvTeh', payload.data_otv_tehnolog, '');

    await batchManager.withBatch('zapros_kp', async () => {
      const r = await api('PUT',
        `/api/zapros-kp/${Requests._selectedZaprosId}/with-kp`,
        { ...payload,
          combinations: Requests._buildCombinations(),
          // ✅ НОВОЕ: фильтр года — автопривязка договора добавленным КП
          godFrom: document.getElementById('fltGod')?.value || '',
          godTo: document.getElementById('fltGodDo')?.value || ''
        });
      if (r.error) {
        if (r.code === 'CANNOT_ADD_AFTER_SEND') { alert(r.error); return; }
        if (r.code === 'CHAIN_IN_ORDER') { alert(r.error); return; }
        if (r.code === 'DEPENDENT_POSITIONS_EXIST') {
          const msg = r.error + '\nХотите удалить проблемные позиции из зависимых запросов?';
          if (confirm(msg)) {
            let deletedCount = 0;
            let errors = [];
            for (const zapros of r.dependentZaprosy) {
              for (const pos of zapros.positions) {
                try {
                  const delResult = await api('DELETE',
                    `/api/zapros-kp/${zapros.zaprosId}/position/${pos.childPlanId}`);
                  if (delResult.ok) deletedCount++;
                  else errors.push(`Чертёж ${pos.nomerChertezha}: ${delResult.error}`);
                } catch (e) {
                  errors.push(`Чертёж ${pos.nomerChertezha}: ${e.message}`);
                }
              }
            }
            if (errors.length > 0) {
              toast(`Удалено: ${deletedCount}. Ошибок: ${errors.length}`, 'warning');
            } else {
              toast(`Удалено ${deletedCount} проблемных позиций`, 'success');
            }
            return Requests.save();
          }
          return;
        }
        toast('Ошибка: ' + r.error, 'error');
        return;
      }

      const firmsWODog = Array.isArray(r.firmyBezDogovora) ? r.firmyBezDogovora.length : 0;
      toast('Запрос обновлен.' + Requests._dogovorAssignmentSuffix(r),
            firmsWODog > 0 ? 'warning' : 'success');
      // ✅ СТРОГАЯ ПРОВЕРКА: таблица И id должны совпадать
      if (EditLock.current && 
          EditLock.current.table === 'zapros_kp' && 
          EditLock.current.id === Requests._selectedZaprosId) {
          EditLock.release();
      }

        // ② ✅ НОВОЕ: Перезаполняем форму из актуальной строки (как _onSelect в CrudModule)
        const row = state.tables.zapros.data.find(z => z.id === Requests._selectedZaprosId);
        if (row) {
            // Применяем введённые данные к строке (оптимистично)
            Object.assign(row, payload);
            // Перезаполняем форму → новый снимок, сброс dirty
            
            await Requests.onSelect(row);
        }
        
        // ③ ✅ НОВОЕ: Диспатчим событие crud-completed (как в CrudModule)
        window.dispatchEvent(new CustomEvent('crud-completed', {
            detail: {
                action: 'save',
                entity: 'zapros_kp',
                entityId: Requests._selectedZaprosId
            }
        }));
        
        // ④ Фоновая синхронизация с сервером
        Requests._detaliBlock.commit();   
        Requests._firmyBlock.commit();    
        await Requests.load();
        await Requests.loadReferences();
        state.tables.zapros.selectById(Requests._selectedZaprosId);
        Requests.updateButtonStates();

    });
  },

  // ============================================================
  // ✅ НОВОЕ: текст об автопривязке договоров при создании запроса
  //   (массовая запись договора перенесена со страницы «Внесение КП»).
  //   Возвращает суффикс для ОСНОВНОГО тоста — так сообщение не
  //   перезаписывается последующими уведомлениями.
  // ============================================================
  _dogovorAssignmentSuffix(r) {
    const info = Array.isArray(r?.dogovorInfo) ? r.dogovorInfo : [];
    const without = Array.isArray(r?.firmyBezDogovora) ? r.firmyBezDogovora : [];
    if (info.length === 0 && without.length === 0) return '';

    const nameById = new Map(
      (Requests._firmyBlock?.getSelectedRows() || []).map(f => [f.id_firmy, f.naimenovanie])
    );
    const fmtDate = (s) => {
      const m = String(s || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? `${m[3]}.${m[2]}.${m[1]}` : String(s || '');
    };

    let msg = '';
    if (info.length > 0) {
      const parts = info.map(a =>
        `${nameById.get(a.id_firma) || a.id_firma} — дог. №${a.nom_dogovor || '—'} от ${fmtDate(a.data_dogovor)}`
      );
      msg += ' Договор по фильтру года: ' + parts.join('; ') + '.';
    }
    if (without.length > 0) {
      const missing = without.map(id => nameById.get(id) || id).join(', ');
      msg += ' ⚠ Нет договора по фильтру года: ' + missing +
        ' — задайте персонально на странице «Внесение КП».';
    }
    return msg;
  },

  async del() {
    if (!Requests._selectedZaprosId) return;
    const row = state.tables.zapros.data.find(r => r.id === Requests._selectedZaprosId);
    if (!confirm(`Удалить запрос № ${row?.n_zaprosa} и все связанные КП?`)) return;

    await batchManager.withBatch('zapros_kp', async () => {
      if (EditLock.current && 
          EditLock.current.table === 'zapros_kp' && 
          EditLock.current.id === Requests._selectedZaprosId) {
          EditLock.release();
      }
      const r = await api('DELETE', `/api/zapros-kp/${Requests._selectedZaprosId}/with-kp`);
      if (r.error) {
        if (r.code === 'DEPENDENT_POSITIONS_EXIST') {
          const msg = r.error + '\nХотите удалить проблемные позиции из зависимых запросов?';
          if (confirm(msg)) {
            let deletedCount = 0;
            let errors = [];
            for (const zapros of r.dependentZaprosy) {
              for (const pos of zapros.positions) {
                try {
                  const delResult = await api('DELETE',
                    `/api/zapros-kp/${zapros.zaprosId}/position/${pos.childPlanId}`);
                  if (delResult.ok) deletedCount++;
                  else errors.push(`Чертёж ${pos.nomerChertezha}: ${delResult.error}`);
                } catch (e) {
                  errors.push(`Чертёж ${pos.nomerChertezha}: ${e.message}`);
                }
              }
            }
            if (errors.length > 0) {
              toast(`Удалено: ${deletedCount}. Ошибок: ${errors.length}`, 'warning');
            } else {
              toast(`Удалено ${deletedCount} проблемных позиций`, 'success');
            }
            return Requests.del();
          }
          return;
        }
        toast('Ошибка: ' + r.error, 'error');
        return;
      }

      toast('Запрос удален', 'warning');
      await Requests.load();
      await Requests.loadReferences();
      Requests.onHeaderClick();
    });
  },

  // ============================================================
  // ШАГ 1: ОТПРАВКА ТЕХНОЛОГУ
  // ============================================================
  async sendToTechnolog() {
    if (!Requests._selectedZaprosId) return;
    const zapros = state.tables.zapros.data.find(z => z.id === Requests._selectedZaprosId);
    if (!zapros) { toast('Запрос не найден в таблице', 'error'); return; }
    if (!document.getElementById('zTech').value) {
      toast('Выберите технолога', 'warning'); return;
    }

    const detali = Requests._detaliBlock.getSelectedRows();
    if (detali.length === 0) {
      toast('Нет деталей для отправки', 'warning'); return;
    }
    const planIds = detali.map(d => d.id);

    // Особый режим: без фактической отправки письма
    const dryRun = Requests._isDryRun();
    if (dryRun && !confirm('Включён режим «БЕЗ ОТПРАВКИ ПИСЕМ».\n\nПисьмо технологу отправлено НЕ будет, но будут проставлены дата передачи и статус «отправлено технологу».\n\nПродолжить?')) {
      return;
    }

    try {
      toast('Генерация Excel...', 'warning');
      const excelResult = await api('POST', '/api/email/generate-excel', {
        zaprosId: Requests._selectedZaprosId,
        planIds,
        zaprosKPNumber: zapros.n_zaprosa,
        equipmentList: []
      });
      if (excelResult.error) { toast('Ошибка генерации: ' + excelResult.error, 'error'); return; }

      // ✅ T101: предпросмотр письма технологу (по аналогии с T100) —
      // письмо строится серверно тем же конструктором, что и при отправке
      let techPreview = null;
      try {
        const prResult = await api('POST', '/api/email/technolog-email-preview', {
          zaprosId: Requests._selectedZaprosId
        });
        if (prResult && prResult.preview) techPreview = prResult.preview;
      } catch (_) { /* сервер без T101 — модалка без вкладки письма */ }

      // ✅ T101: вкладки «✉ Письмо» (редактируемый текст) и вложения
      // (HTML-превью заявки из generate-excel — тот же файл уйдёт во вложении)
      const techAttachName = (excelResult.zaprosKP && excelResult.zaprosKP.fileName) || 'Заявка (Excel)';
      const techTabs = {};
      if (techPreview) {
        techTabs.email = buildEmailPreviewHtml(techPreview, techAttachName, 'вложение: заявка на коммерческое предложение (Excel)');
      }
      if (excelResult.previews && excelResult.previews.zaprosKP) {
        techTabs.zakaz = excelResult.previews.zaprosKP;
      }

      // ✅ T101: отредактированный текст письма (ключ 'email' — data-tab вкладки)
      let editedTechBody = null;

      if (Object.keys(techTabs).length > 0) {
        const confirmed = await showExcelPreview(techTabs, {
          email: { label: '✉ Письмо' },
          zakaz: { label: `📄 Вложение — ${techAttachName}` }
        }, {
          title: dryRun
            ? '📧 Отправка запроса технологу — предпросмотр письма (РЕЖИМ «БЕЗ ОТПРАВКИ»)'
            : '📧 Отправка запроса технологу — предпросмотр письма',
          confirmText: dryRun ? '✅ Подтвердить (без отправки писем)' : '✅ Подтвердить и отправить'
        });
        if (!confirmed) {
          toast('Отправка отменена пользователем', 'warning');
          return;
        }
        editedTechBody = (confirmed && confirmed.emailBodies && confirmed.emailBodies.email) || null;
      }

      toast(dryRun ? 'Имитация отправки (без письма)...' : 'Отправка письма...', 'warning');
      const sendResult = await api('POST', '/api/email/send-technolog', Object.assign({
        zaprosId: Requests._selectedZaprosId,
        excelPath: excelResult.zaprosKP?.path,
        dryRun                       // ← особый режим: без фактической отправки
      }, editedTechBody ? { body: editedTechBody } : {}));   // ✅ T101: отредактированный текст письма
      if (sendResult.error) { toast('Ошибка отправки: ' + sendResult.error, 'error'); return; }

      setDateOrText('zDataTeh', sendResult.date, 'не отправлялось');
      document.getElementById('zStatus').value = 'отправлено технологу';
      await Requests.save();
      toast(dryRun
        ? '⚠️ Без отправки: письмо технологу НЕ отправлялось, дата и статус проставлены'
        : 'Письмо технологу отправлено ✓', dryRun ? 'warning' : 'success');

      Requests.updateButtonStates();

    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  },



  // ============================================================
  // ШАГ 3: ОТПРАВКА ВЫДЕЛЕННЫМ ФИРМАМ
  // ============================================================
async sendToFirms() {
  if (!Requests._selectedZaprosId) return;

  const url = document.getElementById('zUrl').value.trim();
  if (!url) { toast('Заполните ссылку на документацию', 'warning'); return; }
  if (!url.startsWith('https://disk.360.yandex.ru/')) {
    toast('URL должен начинаться с https://disk.360.yandex.ru/', 'warning'); return;
  }

  // ✅ Берём только ВЫДЕЛЕННЫЕ фирмы из таблицы
  const selectedIds = Requests._firmyBlock.getSelectedIds();
  if (selectedIds.length === 0) {
    toast('Выделите фирмы для отправки (☑ Все или Ctrl+Click)', 'warning'); return;
  }

  const selectedFirms = Requests._firmyBlock.getSelectedRows()
    .filter(f => selectedIds.includes(f.id_firmy));

  const withoutEmail = selectedFirms.filter(f => !f.hasEmail);
  if (withoutEmail.length > 0) {
    toast(`У фирм нет активных email: ${withoutEmail.map(f => f.naimenovanie).join(', ')}`, 'warning');
    return;
  }

  // Особый режим: без фактической отправки писем
  const dryRun = Requests._isDryRun();
  if (dryRun && !confirm(`Включён режим «БЕЗ ОТПРАВКИ ПИСЕМ».\n\nПисьма для ${selectedFirms.length} фирм отправлены НЕ будут, но будут проставлены даты отправки и статус.\n\nПродолжить?`)) {
    return;
  }

  try {
    toast('Генерация Excel...', 'warning');
    const detali = Requests._detaliBlock.getSelectedRows();
    const planIds = detali.map(d => d.id);
    const zapros = state.tables.zapros.data.find(z => z.id === Requests._selectedZaprosId);
    if (!zapros) { toast('Запрос не найден в таблице', 'error'); return; }

    const equipmentList = detali.map(d => ({
      id: d.id,
      id_plana: d.id,
      drawingNumber: d.nomer_chertezha,
      equipmentName: d.osn_naimenovanie
    }));

    // ✅ КРИТИЧЕСКИ ВАЖНО: передаём selectedFirmIds
    const excelResult = await api('POST', '/api/email/generate-excel', {
      zaprosId: Requests._selectedZaprosId,
      planIds,
      zaprosKPNumber: zapros.n_zaprosa,
      equipmentList,
      selectedFirmIds: selectedIds   // ← ДОБАВЛЕНО
    });

    if (excelResult.error) {
      toast('Ошибка генерации: ' + excelResult.error, 'error');
      return;
    }

    // ✅ T100: точные тексты писем выбранных фирм — тот же серверный
    // конструктор, что у реальной отправки (POST_SEND_FIRMS); вкладки
    // «✉ Письмо: <фирма>» в предпросмотре + правка текста. Если endpoint
    // недоступен (сервер без T100) — вкладки писем не показываются.
    let emailPreviews = [];
    try {
      const epResult = await api('POST', '/api/email/firms-email-preview', {
        zaprosId: Requests._selectedZaprosId,
        url3D: url,
        firms: selectedFirms.map(f => ({
          firmKod: f.id_firmy,
          firmName: f.naimenovanie,
          email: f.emails
        }))
      });
      if (epResult && epResult.previews) emailPreviews = epResult.previews;
    } catch (_) { /* сервер без T100 */ }

    // ✅ T100: отредактированные тексты писем (firmKod -> body)
    let editedBodies = {};

    // ✅ Предпросмотр с вкладками по фирмам
    if (excelResult.previews) {
      const confirmed = await Requests.showExcelPreviewV2(excelResult.previews, dryRun, false, emailPreviews);
      if (!confirmed) {
        toast('Отправка отменена пользователем', 'warning');
        return;
      }
      // ✅ T100: отредактированные тексты писем — модалка возвращает
      // emailBodies, собранные ДО удаления DOM (ключ = firmKod фирмы)
      editedBodies = (confirmed && confirmed.emailBodies) || {};
    }

    let sentCount = 0;
    let failedCount = 0;
    const failedFirms = [];

    // ✅ ФИКС СТАТУСА «отправлено Всем/не Всем»:
    //    статус нельзя считать по объектам строк (selectedTable.data) —
    //    во время цикла их АСИНХРОННО заменяют перезагрузки (WS 'requests.kp'
    //    → DualListBlock.load → setData), и мутации lastSendDate теряются.
    //    В реальном режиме SMTP-задержка маскировала гонку, в dry-run цикл
    //    мгновенный — и статус падал в «не Всем».
    //    Решение: снапшот id фирм ДО цикла + накопление отправленных id
    //    локально, независимо от перезагрузок таблицы.
    const zaprosFirmsSnapshot = Requests._firmyBlock.getSelectedRows()
      .map(f => ({ id: f.id_firmy, sentBefore: !!f.lastSendDate }));
    const sentFirmIds = new Set();
    let lastAllSentFromServer = null;   // истина из БД (ответ сервера)

    await batchManager.withBatch('zapros_kp', async () => {
      for (let i = 0; i < selectedFirms.length; i++) {
        const firm = selectedFirms[i];
        const firmToSend = {
          firmKod: firm.id_firmy,
          firmName: firm.naimenovanie,
          email: firm.emails
        };

        toast(dryRun
          ? `Обработка ${i + 1}/${selectedFirms.length} (без письма): ${firm.naimenovanie}...`
          : `Отправка ${i + 1}/${selectedFirms.length}: ${firm.naimenovanie}...`, 'warning');

        try {
          const sendResult = await api('POST', '/api/email/send-firms', Object.assign({
            zaprosId: Requests._selectedZaprosId,
            firms: [firmToSend],
            url3D: url,
            zaprosKPPath: excelResult.zaprosKP?.path,
            obmenByFirma: excelResult.obmenByFirma,   // ← передаём маппинг файлов,
            dryRun                       // ← особый режим: без фактической отправки
          }, editedBodies[String(firm.id_firmy)] ? { body: editedBodies[String(firm.id_firmy)] } : {}));   // ✅ T100: отредактированный текст письма

          if (sendResult.error) {
            failedCount++;
            failedFirms.push({ firmName: firm.naimenovanie, error: sendResult.error });
            toast(`❌ ${firm.naimenovanie}: ${sendResult.error}`, 'error');
          } else {
            sentCount++;
            sentFirmIds.add(firm.id_firmy);   // ✅ копим независимо от перезагрузок
            if (typeof sendResult.allSent === 'boolean') {
              lastAllSentFromServer = sendResult.allSent;   // ✅ истина из БД
            }
            const firmInList = Requests._firmyBlock.getSelectedRows()
              .find(f => f.id_firmy === firm.id_firmy);
            if (firmInList) {
              firmInList.lastSendDate = sendResult.sendDate;
            }
            Requests._firmyBlock.selectedTable.selectedIds.delete(firm.id_firmy);
            Requests._firmyBlock.selectedTable.refresh();
            toast(dryRun
              ? `⚠️ ${firm.naimenovanie} — помечено как отправленное (письмо не отправлялось)`
              : `✅ ${firm.naimenovanie} — отправлено`, dryRun ? 'warning' : 'success');
          }
        } catch (e) {
          failedCount++;
          failedFirms.push({ firmName: firm.naimenovanie, error: e.message });
          toast(`❌ ${firm.naimenovanie}: ${e.message}`, 'error');
        }
      }

      // ✅ ФИКС СТАТУСА: приоритет — ответ сервера (allSent посчитан в БД
      //    после обновлений, одинаково верен для реальной отправки и dry-run).
      //    Fallback — снапшот + накопленные id: фирма считается отправленной,
      //    если была отправлена сейчас (sentFirmIds) или раньше (sentBefore).
      let allSent;
      if (typeof lastAllSentFromServer === 'boolean') {
        allSent = lastAllSentFromServer;
      } else {
        allSent = zaprosFirmsSnapshot.length > 0 &&
          zaprosFirmsSnapshot.every(f => sentFirmIds.has(f.id) || f.sentBefore);
      }
      const newStatus = allSent
        ? 'отправлено Всем контрагентам'
        : 'отправлено не Всем контрагентам';
      document.getElementById('zStatus').value = newStatus;
      Requests.updateCompositionVisibility(newStatus);
      Requests.updateButtonStates();
      await Requests.save();
    });

    let msg = dryRun
      ? `⚠️ РЕЖИМ «БЕЗ ОТПРАВКИ»: помечено как отправленное: ${sentCount}`
      : `✅ Отправлено: ${sentCount}`;
    if (failedCount > 0) {
      msg += `\n❌ Не отправлено: ${failedCount}\nПроблемные фирмы:\n`;
      failedFirms.forEach(f => { msg += `• ${f.firmName} — ${f.error}\n`; });
    }
    toast(msg, failedCount > 0 ? 'warning' : 'success');
  } catch (e) {
    console.error('[sendToFirms] Error:', e);
    toast('Ошибка: ' + e.message, 'error');
  }
},
  // ============================================================
  // ✅ T88: ПРОСМОТР СОХРАНЁННОГО ФАЙЛА ЗАПРОСА
  // «Заявка № …xlsx» из public/Заявки/<год>/ — в том же просмотрщике,
  // что и при отправке (showExcelPreviewV2, режим «только просмотр»).
  // Файл НЕ пересоздаётся: показывается ровно то, что ушло фирмам
  // (или было положено в папку вручную).
  // ============================================================
  async previewZayavka() {
    if (!Requests._selectedZaprosId) return;
    try {
      toast('Загрузка сохранённого файла запроса...', 'warning');
      const r = await api('POST', '/api/email/preview-zayavka', { zaprosId: Requests._selectedZaprosId });
      if (r.error) { toast('❌ ' + r.error, 'error'); return; }
      await Requests.showExcelPreviewV2({ zaprosKP: r.html }, false, true);
    } catch (e) {
      console.error('[previewZayavka] Error:', e);
      toast('Ошибка: ' + e.message, 'error');
    }
  },
  // ============================================================
  // ✅ T89: ПРОВЕРКА ССЫЛКИ НА ДОКУМЕНТАЦИЮ (поле «Ссылка», шаг 2)
  // Сервер проходит по публичной ссылке (Яндекс.Диск), собирает перечень
  // файлов (включая вложенные папки) и ПРОБНО скачивает каждый (Range-GET).
  // Сами файлы не сохраняются. В отчёте — что грузится, а что нет
  // (имена непрогрузившихся файлов — главная цель проверки).
  // ============================================================
  async checkUrl() {
    const url = document.getElementById('zUrl').value.trim();
    if (!url) { toast('Сначала заполните ссылку', 'warning'); return; }
    const btn = document.getElementById('btnCheckUrl');
    const statusEl = document.getElementById('urlCheckStatus');
    const resultEl = document.getElementById('urlCheckResult');
    if (!btn || !statusEl || !resultEl) return;
    btn.disabled = true;
    statusEl.textContent = '⏳ Идёт проверка: получаем перечень файлов и пробно скачиваем каждый...';
    resultEl.style.display = 'none';
    resultEl.innerHTML = '';
    // ✅ T90: на время проверки прячем треугольник отчёта и сбрасываем
    // данные для письма технологу
    const tglEl = document.getElementById('btnUrlCheckToggle');
    if (tglEl) tglEl.style.display = 'none';
    Requests._lastUrlCheck = null;
    // ✅ T90: экранирование нужно и отчёту успеха, и мини-отчёту об ошибке
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const t0 = Date.now();
    try {
      const r = await api('POST', '/api/zapros-kp/check-url', { url });
      if (!r || r.error) {
        const errText = (r && r.error) || 'ошибка проверки';
        statusEl.textContent = '❌ ' + errText;
        toast('Проверка ссылки: ' + errText, 'error');
        // ✅ T90: ссылка внешне корректна, но файлы по ней получить не
        // удалось — мини-отчёт + кнопка письма технологу («ссылка не
        // удается скачать»). Некорректный ввод (пусто/не http) — без отчёта.
        if (/^https?:\/\//i.test(url)) {
          Requests._lastUrlCheck = { url, failed: [], linkDead: true };
          resultEl.innerHTML =
            `<div style="margin-bottom: 6px; padding: 5px 8px; background: #fff1f0; border: 1px solid #f0b6b0; border-radius: 4px;">` +
            `<b style="color:#cf222e;">❌ Не удалось получить файлы по ссылке:</b><br>` +
            `<span style="color:#1f2328;">${esc(url)}</span> — <span style="color:#cf222e;">${esc(errText)}</span>` +
            `<div style="margin-top: 6px;"><button class="btn btn-sm" id="btnEmailUrlProblem" title="Отправить письмо технологу: по ссылке не удается скачать файлы — просим перезаложить их или предоставить новую ссылку" style="font-size:10px;">📧 Сообщить технологу</button></div>` +
            `</div>`;
          resultEl.style.display = '';
          Requests._showUrlCheckToggle(true);
          Requests._bindUrlCheckEmailBtn();
        }
        return;
      }
      const files = Array.isArray(r.files) ? r.files : [];
      const fmtSize = (n) => (n == null || isNaN(n)) ? '' : (n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ');
      const failed = files.filter(f => f.checked && !f.ok);
      const okFiles = files.filter(f => f.checked && f.ok);
      const skipped = files.filter(f => !f.checked);
      const elapsed = Math.round((Date.now() - t0) / 1000);

      // Сводка
      let html = `<div style="margin-bottom: 6px;"><b>«${esc(r.name || url)}»</b> — файлов: ${files.length}`;
      html += ` · <span style="color:#1a7f37;">загружаются: ${okFiles.length}</span>`;
      html += ` · <span style="color:${failed.length ? '#cf222e' : '#1a7f37'};font-weight:600;">НЕ грузятся: ${failed.length}</span>`;
      if (skipped.length) html += ` · не проверено: ${skipped.length}`;
      html += ` (${elapsed} с)</div>`;

      // Имена непрогрузившихся — главный результат проверки
      if (failed.length) {
        html += `<div style="margin-bottom: 6px; padding: 5px 8px; background: #fff1f0; border: 1px solid #f0b6b0; border-radius: 4px;">` +
          `<b style="color:#cf222e;">❌ Не прогрузились (${failed.length}):</b><br>` +
          // ✅ T97: для zip-архива, который открывается как папка, — сразу видно,
          // что документация внутри доступна по отдельности
          failed.map(f => `• <b>${esc(f.name)}</b>${f.error ? ` — ${esc(f.error)}` : ''}` +
            ((f.zipFallback && f.zipFallback.opened && f.zipFallback.total > 0)
              ? ` <span style="color:#9a6700;">— 🔓 открывается как архив: файлов внутри ${f.zipFallback.total}, загружаются ${f.zipFallback.okCount}</span>`
              : '')).join('<br>') +
          // ✅ T90: письмо технологу — перечень непрогрузившихся файлов в тексте
          `<div style="margin-top: 6px;"><button class="btn btn-sm" id="btnEmailUrlProblem" title="Отправить письмо технологу: перечислить файлы, которые не грузятся, и попросить перезаложить их или предоставить новую ссылку" style="font-size:10px;">📧 Сообщить технологу</button></div>` +
          `</div>`;
      }
      if (skipped.length) {
        html += `<div style="margin-bottom: 6px; color: #9a6700;">⏳ Не проверены (лимит времени): ` +
          skipped.map(f => esc(f.name)).join(', ') + `</div>`;
      }
      // Полный список файлов
      html += '<div>';
      for (const f of files) {
        const icon = !f.checked ? '⏳' : (f.ok ? '✅' : '❌');
        const color = !f.checked ? '#9a6700' : (f.ok ? '#1a7f37' : '#cf222e');
        html += `<div style="color:${color};">${icon} <span style="color:#1f2328;">${esc(f.name)}</span>` +
          `${(f.size != null) ? ` <span style="color:var(--muted,#656d76);">(${fmtSize(f.size)})</span>` : ''}` +
          `${((!f.ok && f.checked && f.error) ? ` — <span style="color:#cf222e;">${esc(f.error)}</span>` : '')}` +
          `${((f.ok && f.retried) ? ' <span style="color:#9a6700;">↻ со 2-й попытки</span>' : '')}</div>`;
        // ✅ T97: содержимое zip-архива, проверенное через «открыть как папку»
        if (f.zipFallback && Array.isArray(f.zipFallback.files) && f.zipFallback.files.length) {
          const zf = f.zipFallback;
          html += `<div style="margin: 2px 0 4px 18px; padding: 4px 8px; background: ${zf.ok ? '#f0fff4' : '#fffbeb'}; border: 1px solid ${zf.ok ? '#b7dfb9' : '#f0d47a'}; border-radius: 4px;">`;
          html += zf.opened
            ? `🔓 <b>Содержимое архива проверено по файлам:</b> внутри ${zf.total}, загружаются ${zf.okCount}` +
              `${zf.failCount ? `, НЕ грузятся ${zf.failCount}` : ''}` +
              `${zf.ok ? ' — <span style="color:#1a7f37; font-weight:600;">вся документация доступна по отдельности</span>' : ''}`
            : `🔒 Архив не удалось открыть для просмотра${zf.error ? ` — ${esc(zf.error)}` : ''}`;
          for (const inf of zf.files) {
            const iicon = !inf.checked ? '⏳' : (inf.ok ? '✅' : '❌');
            const icolor = !inf.checked ? '#9a6700' : (inf.ok ? '#1a7f37' : '#cf222e');
            html += `<div style="color:${icolor};">${iicon} <span style="color:#1f2328;">${esc(inf.name)}</span>` +
              `${(inf.size != null) ? ` <span style="color:var(--muted,#656d76);">(${fmtSize(inf.size)})</span>` : ''}` +
              `${((!inf.ok && inf.checked && inf.error) ? ` — <span style="color:#cf222e;">${esc(inf.error)}</span>` : '')}` +
              `${((inf.ok && inf.retried) ? ' <span style="color:#9a6700;">↻ со 2-й попытки</span>' : '')}</div>`;
          }
          html += `</div>`;
        }
      }
      html += '</div>';
      if (!failed.length && !skipped.length) {
        html += '<div style="margin-top: 4px; color: #1a7f37; font-weight: 600;">✅ Все файлы по ссылке доступны для скачивания</div>';
      }
      resultEl.innerHTML = html;
      resultEl.style.display = '';
      statusEl.textContent = '';
      // ✅ T90: запоминаем отчёт для письма, показываем треугольник
      // (отчёт развёрнут — ▲) и вешаем обработчик кнопки письма
      Requests._lastUrlCheck = { url, failed: failed.map(f => ({ name: f.name, error: f.error || '' })), linkDead: false };
      Requests._showUrlCheckToggle(true);
      Requests._bindUrlCheckEmailBtn();
      if (failed.length) {
        toast(`Проверка ссылки: НЕ грузится ${failed.length} из ${files.length} файлов (отчёт — под ссылкой)`, 'warning');
      } else if (skipped.length) {
        toast(`Проверка ссылки: ${okFiles.length} из ${files.length} загружаются, ${skipped.length} не проверены (лимит времени)`, 'warning');
      } else {
        toast(`Проверка ссылки: все ${files.length} файлов загружаются`, 'success');
      }
    } catch (e) {
      console.error('[checkUrl] Error:', e);
      statusEl.textContent = '❌ ' + e.message;
      toast('Ошибка проверки ссылки: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  // ✅ T89: сброс отчёта проверки при изменении ссылки
  // ✅ T90: + прячем треугольник отчёта и данные письма
  resetUrlCheckUI() {
    const statusEl = document.getElementById('urlCheckStatus');
    const resultEl = document.getElementById('urlCheckResult');
    const tgl = document.getElementById('btnUrlCheckToggle');
    if (tgl) tgl.style.display = 'none';
    if (statusEl) statusEl.textContent = '';
    if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }
    Requests._lastUrlCheck = null;
  },

  // ============================================================
  // ✅ T90: СКРЫВАЕМЫЙ ОТЧЁТ ПРОВЕРКИ + ПИСЬМО ТЕХНОЛОГУ
  // Треугольник — тот же, что у сворачиваемых блоков фильтров
  // (class filter-toggle-btn, public/js/common/filters-collapse.js):
  // ▲ свернуть отчёт, ▼ развернуть. Кнопка письма живёт внутри
  // отчёта urlCheckResult и сворачивается вместе с ним.
  // ============================================================
  _showUrlCheckToggle(open) {
    const tgl = document.getElementById('btnUrlCheckToggle');
    if (!tgl) return;
    tgl.style.display = '';
    tgl.textContent = open ? '▲' : '▼';
    tgl.title = open ? 'Свернуть отчёт проверки' : 'Развернуть отчёт проверки';
  },

  toggleUrlCheckResult() {
    const resultEl = document.getElementById('urlCheckResult');
    if (!resultEl) return;
    const willShow = (resultEl.style.display === 'none');
    resultEl.style.display = willShow ? '' : 'none';
    Requests._showUrlCheckToggle(willShow);
  },

  _bindUrlCheckEmailBtn() {
    const btn = document.getElementById('btnEmailUrlProblem');
    if (btn) btn.onclick = () => Requests.sendUrlProblemEmail();
  },

  // ============================================================
  // ✅ T90: ПИСЬМО ТЕХНОЛОГУ «ПО ССЫЛКЕ НЕ УДАЕТСЯ СКАЧАТЬ ФАЙЛЫ»
  // Реализация — аналог кнопки шага «Согласование запроса технологом»
  // (Requests.sendToTechnolog → POST /api/email/send-technolog):
  // технолог из select#zTech, подтверждение dry-run, текст и подпись
  // Чеснокова формируются на сервере. Отличия: письмо БЕЗ вложения,
  // даты и статусы запроса не меняются — шаги согласования не двигаются.
  // ============================================================
  async sendUrlProblemEmail() {
    if (!Requests._selectedZaprosId) return;
    const chk = Requests._lastUrlCheck;
    if (!chk) { toast('Сначала выполните проверку ссылки', 'warning'); return; }
    if (!chk.linkDead && (!Array.isArray(chk.failed) || chk.failed.length === 0)) {
      toast('Все файлы по ссылке загружаются — письмо не требуется', 'info');
      return;
    }
    if (!document.getElementById('zTech').value) {
      toast('Выберите технолога (шаг 1)', 'warning'); return;
    }
    const dryRun = Requests._isDryRun();
    if (dryRun && !confirm('Включён режим «БЕЗ ОТПРАВКИ ПИСЕМ».\n\nПисьмо технологу отправлено НЕ будет.\n\nПродолжить?')) {
      return;
    }
    try {
      toast(dryRun ? 'Имитация отправки (без письма)...' : 'Отправка письма...', 'warning');
      const r = await api('POST', '/api/email/send-url-problem', {
        zaprosId: Requests._selectedZaprosId,
        url: chk.url,
        failedFiles: Array.isArray(chk.failed) ? chk.failed : [],
        dryRun                      // ← особый режим: без фактической отправки
      });
      if (r.error) { toast('Ошибка отправки: ' + r.error, 'error'); return; }
      toast(dryRun
        ? '⚠️ Без отправки: письмо технологу НЕ отправлялось'
        : 'Письмо технологу отправлено ✓', dryRun ? 'warning' : 'success');
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  },

/**
 * ✅ НОВЫЙ: Предпросмотр с вкладками по фирмам
 * Показывает: Заявка + Обменная форма для каждой выделенной фирмы
 */
/**
 * ✅ НОВЫЙ: Предпросмотр с вкладками по фирмам
 * @param {boolean} [viewOnly=false] — ✅ T88: режим «только просмотр»
 *        (кнопки подтверждения отправки нет, отмена = «Закрыть»)
 */
  async showExcelPreviewV2(previews, isDryRun = false, viewOnly = false, emailPreviews = []) {
  return new Promise((resolve) => {
    const hasZayavka = !!previews.zaprosKP;
    const obmenEntries = previews.obmen
      ? Object.entries(previews.obmen).filter(([, v]) => v && v.preview)
      : [];
    const hasObmen = obmenEntries.length > 0;

    if (!hasZayavka && !hasObmen) { resolve(true); return; }

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.6); z-index: 99999;
      display: flex; align-items: center; justify-content: center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background: white; border-radius: 12px; width: 95%; max-width: 1400px;
      height: 90vh; display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    `;

    // Заголовок
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 14px 24px; background: #f6f8fa; border-bottom: 1px solid #d0d7de;
      display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
    `;
    header.innerHTML = `
      <h2 style="margin:0; font-size:15px; color:#1f2328;">
        ${viewOnly ? '📄 Просмотр сохранённого файла запроса' : isDryRun ? '📋 Предпросмотр документов (РЕЖИМ «БЕЗ ОТПРАВКИ ПИСЕМ»)' : '📋 Предпросмотр документов перед отправкой контрагентам'}
      </h2>
      <div style="display:flex; gap:10px;">
        <button id="previewCancel" style="
          padding: 8px 20px; background: #fff; border: 1px solid #d0d7de;
          border-radius: 6px; cursor: pointer; font-size: 13px;
          color: #cf222e; font-weight: 600;
        ">${viewOnly ? '✖ Закрыть' : '✖ Отменить отправку'}</button>
        ${viewOnly ? '' : `<button id="previewConfirm" style="
          padding: 8px 20px; background: ${isDryRun ? '#bf8700' : '#1a7f37'}; color: white; border: none;
          border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;
        ">${isDryRun ? '✅ Подтвердить (без отправки писем)' : '✅ Подтвердить и отправить'}</button>`}
      </div>
    `;
    modal.appendChild(header);

    // Вкладки
    const tabs = [];
    if (hasZayavka) {
      tabs.push({ id: 'zaprosKP', label: '📄 Заявка', html: previews.zaprosKP });
    }
    obmenEntries.forEach(([firmaId, data]) => {
      tabs.push({ id: firmaId, label: `📋 ${data.firmaName || firmaId}`, html: data.preview });
    });

    // ✅ T100: вкладки «✉ Письмо: <фирма>» — точный текст письма каждой
    // фирмы (единый серверный конструктор с реальной отправкой), текст
    // редактируется прямо в предпросмотре
    (emailPreviews || []).forEach(ep => {
      tabs.push({
        id: 'email-' + ep.firmKod,
        label: `✉ Письмо: ${ep.firmName || ep.firmKod}`,
        html: buildEmailPreviewHtml(
          ep,
          'Заявка и обменная форма (Excel)',
          'вложения: заявка (Excel) + обменная форма фирмы'
        ),
        firmKey: String(ep.firmKod)
      });
    });

    if (tabs.length > 1) {
      const tabBar = document.createElement('div');
      tabBar.style.cssText = `
        display: flex; background: #fff; border-bottom: 1px solid #d0d7de;
        padding: 0 16px; flex-shrink: 0; flex-wrap: wrap;
      `;
      tabs.forEach((tab, idx) => {
        const btn = document.createElement('button');
        btn.className = 'preview-tab';
        btn.dataset.tab = tab.id;
        btn.textContent = tab.label;
        btn.style.cssText = `
          padding: 10px 16px; border: none; cursor: pointer;
          font-size: 12px; border-radius: 6px 6px 0 0; margin-right: 2px;
          background: ${idx === 0 ? '#f6f8fa' : 'transparent'};
          border-bottom: 2px solid ${idx === 0 ? '#0969da' : 'transparent'};
          color: ${idx === 0 ? '#0969da' : '#656d76'};
          font-weight: ${idx === 0 ? '600' : '400'};
        `;
        tabBar.appendChild(btn);
      });
      modal.appendChild(tabBar);
    }

    // Контент (ифреймы)
    const content = document.createElement('div');
    content.style.cssText = `flex: 1; overflow: hidden; position: relative;`;

    tabs.forEach((tab, idx) => {
      const iframe = document.createElement('iframe');
      iframe.className = 'preview-iframe';
      iframe.dataset.tab = tab.id;
      if (tab.firmKey) iframe.dataset.firmKey = tab.firmKey;   // ✅ T100: письмо какой фирмы
      iframe.srcdoc = tab.html;
      iframe.style.cssText = `
        width: 100%; height: 100%; border: none;
        display: ${idx === 0 ? 'block' : 'none'};
        position: absolute; top: 0; left: 0;
      `;
      content.appendChild(iframe);
    });
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Переключение вкладок
    modal.querySelectorAll('.preview-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', () => {
        modal.querySelectorAll('.preview-tab').forEach(t => {
          t.style.background = 'transparent';
          t.style.borderBottomColor = 'transparent';
          t.style.color = '#656d76';
          t.style.fontWeight = '400';
        });
        tabBtn.style.background = '#f6f8fa';
        tabBtn.style.borderBottomColor = '#0969da';
        tabBtn.style.color = '#0969da';
        tabBtn.style.fontWeight = '600';

        const targetTab = tabBtn.dataset.tab;
        modal.querySelectorAll('.preview-iframe').forEach(iframe => {
          iframe.style.display = iframe.dataset.tab === targetTab ? 'block' : 'none';
        });
      });
    });

    // Кнопки
    const cleanup = () => {
      document.removeEventListener('keydown', escHandler);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    modal.querySelector('#previewCancel').addEventListener('click', () => {
      cleanup();
      resolve(false);
    });

    const confirmBtn = modal.querySelector('#previewConfirm');   // ✅ T88: в режиме просмотра кнопки нет
    if (confirmBtn) confirmBtn.addEventListener('click', () => {
      // ✅ T100: тексты писем собираем ДО удаления DOM
      const emailBodies = Requests._collectEditedEmailBodies();
      cleanup();
      resolve({ ok: true, emailBodies });   // ✅ T100: объект истинен — прежние проверки работают
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve(false); }
    };
    document.addEventListener('keydown', escHandler);
  });
},

  // ===== ✅ T100: сборщик текстов писем из вкладок предпросмотра
  // (iframe с data-firm-key содержат textarea[data-email-body]; iframe
  // same-origin — доступ к contentDocument разрешён). firmKod -> body.
  // Вызывается при подтверждении рассылки (ДО удаления DOM модалки).
  _collectEditedEmailBodies() {
    const map = {};
    try {
      document.querySelectorAll('iframe.preview-iframe').forEach(fr => {
        if (!fr.dataset.firmKey) return;
        let doc = null;
        try { doc = fr.contentDocument; } catch (_) { doc = null; }
        if (!doc) return;
        const ta = doc.querySelector('textarea[data-email-body]');
        if (ta && String(ta.value).trim()) map[String(fr.dataset.firmKey)] = ta.value;
      });
    } catch (_) { /* ignore */ }
    return map;
  },
  // ============================================================
  // АВТООБНОВЛЕНИЕ EMAIL ПРИ ИЗМЕНЕНИИ КОНТАКТОВ
  // ============================================================
  async refreshFirmEmails() {
    if (!Requests._selectedZaprosId || !Requests._firmyBlock) return;
    console.log('[Requests] 📡 Обновление email фирм...');
    // ✅ ФИКС: обогащаем email без полной перезагрузки (не сбрасываем dirty)
    const firms = Requests._firmyBlock.getSelectedRows();
    if (firms.length === 0) return;
    await Requests.enrichFirmsWithContacts(firms);
    Requests._firmyBlock.selectedTable.refresh();
    Requests.updateStatusUI();
  },

  // ============================================================
  // ШАГ 4: ОБНОВЛЕНИЕ URL
  // ============================================================
  async updateURL() {
    if (!Requests._selectedZaprosId) return;
    const url = document.getElementById('zUrl').value.trim();
    if (!url) { toast('Заполните ссылку на документацию', 'warning'); return; }
    if (!url.startsWith('https://disk.360.yandex.ru/')) {
      toast('URL должен начинаться с https://disk.360.yandex.ru/', 'warning'); return;
    }

    const selectedIds = Requests._firmyBlock.getSelectedIds();
    if (selectedIds.length === 0) {
      toast('Выделите фирмы для уведомления об обновлении URL', 'warning');
      return;
    }

    const firms = Requests._firmyBlock.getSelectedRows()
      .filter(f => selectedIds.includes(f.id_firmy) && f.lastSendDate)
      .map(f => ({ firmKod: f.id_firmy, firmName: f.naimenovanie, email: f.emails }));

    if (firms.length === 0) {
      toast('Среди выделенных нет фирм, которым ранее отправлялся запрос', 'warning');
      return;
    }

    // Особый режим: без фактической отправки писем
    const dryRun = Requests._isDryRun();
    if (dryRun) {
      if (!confirm(`Включён режим «БЕЗ ОТПРАВКИ ПИСЕМ».\n\nУведомления для ${firms.length} фирм отправлены НЕ будут, но будут проставлены даты обновления URL.\n\nПродолжить?`)) return;
    } else {
      if (!confirm(`Уведомить ${firms.length} фирм об обновлении URL?`)) return;
    }

    try {
      let sentCount = 0;
      let failCount = 0;

      for (let i = 0; i < firms.length; i++) {
        const firm = firms[i];
        toast(dryRun
          ? `Обработка ${i + 1}/${firms.length} (без письма): ${firm.firmName}...`
          : `Отправка ${i + 1}/${firms.length}: ${firm.firmName}...`, 'warning');
        try {
          const result = await api('POST', '/api/email/update-url', {
            zaprosId: Requests._selectedZaprosId,
            newUrl: url,
            firms: [firm],
            dryRun                  // ← особый режим: без фактической отправки
          });
          if (result.error) {
            failCount++;
            toast(`❌ ${firm.firmName}: ${result.error}`, 'error');
          } else {
            sentCount++;
            const firmInList = Requests._firmyBlock.getSelectedRows()
              .find(f => f.id_firmy === firm.firmKod);
            if (firmInList) {
              firmInList.linkDocDate = result.sendDate;
            }
            Requests._firmyBlock.selectedTable.selectedIds.delete(firm.firmKod);
            Requests._firmyBlock.selectedTable.refresh();
            toast(dryRun
              ? `⚠️ ${firm.firmName} — помечено как уведомлённое (письмо не отправлялось)`
              : `✅ ${firm.firmName} — URL обновлён`, dryRun ? 'warning' : 'success');
          }
        } catch (e) {
          failCount++;
          toast(`❌ ${firm.firmName}: ${e.message}`, 'error');
        }
      }

      setDateOrText('zDataUrl', sqlDateTime(), '');
      await Requests.save();

      toast(dryRun
        ? `⚠️ Без отправки. Помечено как уведомлённые: ${sentCount}. Ошибок: ${failCount}`
        : `Уведомлено: ${sentCount}. Не отправлено: ${failCount}`,
        (failCount > 0 || dryRun) ? 'warning' : 'success');
      Requests.updateButtonStates();

    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  }
};
