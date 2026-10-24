// ============================================================
// МОДУЛЬ: ОПЛАТА РАБОТ (✅ T102)
//
// Процесс: оператор выбирает транспортную операцию (фильтры «фирма /
// дата отправки / тип перевозки»), заполняет оплату (акт/УПД, сумма без
// НДС — НДС считается из договора позиций), затем привязывает оплату
// к грузовым позициям документа выбранной операции.
//
// ✅ T104:
//   • РЕЖИМЫ: заголовок таблицы оплат / кнопка «➕» — СОЗДАНИЕ новой
//     оплаты; выделение платежного документа — РЕДАКТИРОВАНИЕ;
//   • обязательные фильтры «Фирма» и «№ зак. дог.» (платежка жёстко
//     привязана к фирме и заказу) — дублируются в форме для информации;
//   • автофильтры по типу оплаты: «аванс» → № эт. = 1; иначе (окончательный
//     расчёт) → тип перевозки «Получение готовой продукции»;
//   • распределение суммы платежки по грузовым позициям ( oplata_poz ):
//     по каждой позиции указывается ЧАСТЬ суммы документа; сумма всех
//     распределений не превышает сумму документа (итого с НДС);
//     позиция может входить в несколько платежек (аванс + окончательный),
//     «Оплачено ₽» позиции — сумма всех платежек позиции.
//
// ✅ T105:
//   • сравнение «Распределено X из Y» — по сумме платежки БЕЗ НДС
//     (НДС и итого с НДС — расчётные величины, показываются рядом);
//   • предзаполнение сумм по позициям (модалка распределения):
//     «аванс» → Стоимость ₽ позиции × % аванса договора (predoplata_pr);
//     «окончательный расчёт» → Стоимость ₽ − оплачено позиции другими
//     платежками (аванс; равно колонке «Оплачено ₽»); кнопка
//     «⟳ Автозаполнение» пересчитывает все поля.
//
// ✅ T106:
//   • вместо «Распределено по позициям» — «НЕ РАСПРЕДЕЛЕНО» (форма и
//     таблица оплат): оператор распределяет свободные средства и должен
//     видеть остаток платежки, который ещё можно распределить
//     (сумма документа без НДС минус распределено);
//   • панель последовательных шагов работы с платежкой (эталон —
//     «Заказы по договорам»):
//     шаг 1 — прикрепить PDF платёжного документа;
//     шаг 2 — аванс: отправить PDF на почту из поля «Email»;
//             окончательный расчёт: дата занесения акта в 1С;
//     шаг 3 (окончательный) — распечатать реестр по шаблону (заглушка);
//     шаг 4 (окончательный) — прикрепить скан подписанного реестра (PDF).
//
// ✅ T106 (продолжение — фильтры и заголовки таблиц):
//   • выбор или изменение ЛЮБОГО поля фильтров перезагружает состояние
//     ВСЕХ таблиц страницы (applyFilters): транспортные операции, а если
//     операция осталась выбранной — ещё её оплаты и грузовые позиции
//     (устаревших данных в таблицах не остаётся);
//   • клик по заголовку ЛЮБОЙ таблицы — ПОЛНЫЙ сброс состояния страницы:
//     выделения строк, форма (режим создания), таблицы оплат и позиций,
//     ВСЕ ФИЛЬТРЫ — затем перезагрузка операций без фильтров.
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { VirtualTable } from '../common/virtual-table.js';
import { EditLock, isLocked } from '../common/websocket.js';

const TIP_OPLATY_LABELS = {
    avans: 'Предоплата (аванс)',
    okonchatelny_raschet: 'Окончательный расчёт'
};

// ✅ T104: тип перевозки автофильтра окончательного расчёта
const TIP_AUTO_GOTOVAYA = 'Получение готовой продукции';

// деньги: 1234.5 → '1 234.50' (без лишнего — просто 2 знака)
function money(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return '';
    return n.toFixed(2);
}

export const OplataRabot = {
    _opers: [],          // транспортные операции (с учётом фильтров)
    _opl: [],            // оплаты выбранной операции
    _poz: [],            // грузовые позиции выбранной операции
    _rasp: new Map(),    // ✅ T104: распределение текущей оплаты {id_gryz_poz → summa}
    _raspCtx: null,      // ✅ T104: контекст открытой модалки распределения
    mode: null,          // ✅ T104: null | 'create' | 'edit'
    selectedOperId: null,
    selectedOplId: null,

    async init() {
        // Таблица транспортных операций
        // ✅ T103: «№ этапа» и «Тип перевозки» — как в «Текущем плане перевозок»
        // («План перевозок»); короткие названия, расшифровки в тултипах (tip)
        const operCols = [
            { key: 'otgruzka_data', label: 'Дата отправки', width: '100px' },
            { key: 'firma_name', label: 'Фирма', width: '160px' },
            { key: 'nom_shag', label: '№ эт.', width: '60px',
              tip: '№ этапа маршрута (по заявкам, партии которых в операции)' },
            { key: 'tip_perevozki', label: 'Тип перев.', width: '130px',
              tip: 'Тип перевозки — шаг маршрута (по заявкам, партии которых в операции)' },
            { key: 'gruz_name', label: 'Груз', width: '220px' },
            { key: 'poz_count', label: 'Позиций', width: '70px' },
            { key: 'opl_count', label: 'Оплат', width: '60px' },
            { key: 'status', label: 'Статус', width: '110px' }
        ];
        state.tables.oplOpers = new VirtualTable(
            document.getElementById('operTable'), operCols,
            {
                idKey: 'id',
                autoRefreshForm: false, // иначе setData (loadOpers) повторно звал
                                        // onSelectOper -> onHeaderOpl и стирал форму оплаты
                onSelect: r => OplataRabot.onSelectOper(r),
                onHeaderClick: () => OplataRabot.onHeaderOper(),
                getLockInfo: (item) => isLocked('transport_oper', item.id)
            }
        );

        // Таблица оплат выбранной операции
        // ✅ T104: «Распред. ₽» — сколько из суммы документа уже отнесено позициям
        const oplCols = [
            { key: 'tip_oplaty', label: 'Тип оплаты', width: '150px',
              formatter: (v) => TIP_OPLATY_LABELS[v] || v || '' },
            { key: 'nomer_akta_upd', label: '№ акта/УПД', width: '110px' },
            { key: 'nomer_schet_faktura', label: '№ счёт-фактуры', width: '110px' },
            { key: 'data_predostavleniya_dok', label: 'Дата предост. док.', width: '110px' },
            { key: 'summa_k_oplate', label: 'Сумма (без НДС), ₽', width: '120px',
              formatter: (v) => money(v) },
            { key: 'summa_nds', label: 'НДС, ₽', width: '100px',
              formatter: (v) => (v === null || v === undefined) ? '—' : money(v) },
            { key: 'summa_s_nds', label: 'Итого с НДС, ₽', width: '120px',
              formatter: (v) => (v === null || v === undefined) ? '—' : money(v) },
            { key: 'ne_rasp', label: 'Не распр. ₽', width: '100px',
              formatter: (v, row) => money(v),
              tip: '✅ T106: НЕ распределено по позициям, ₽ (сумма платежки без НДС минус распределено) — остаток, который ещё можно распределить' },
            { key: 'poz_count', label: 'Позиций', width: '70px' },
            { key: 'primechanie', label: 'Примечание', width: '160px' }
        ];
        state.tables.oplZapisi = new VirtualTable(
            document.getElementById('oplTable'), oplCols,
            {
                idKey: 'id',
                autoRefreshForm: false, // иначе setData (loadOpl) при пропаже оплаты
                                        // из списка (нет позиций) сбрасывал форму через
                                        // onHeaderClick — терялась выбранная оплата
                onSelect: r => OplataRabot.onSelectOpl(r),
                // ✅ T106: клик по заголовку таблицы оплат — ПОЛНЫЙ сброс
                // страницы (выделения + форма + ВСЕ фильтры + перезагрузка);
                // режим создания с сохранением операции — кнопка «➕»
                onHeaderClick: () => OplataRabot.onHeaderOplClick(),
                getLockInfo: (item) => isLocked('oplata_rabot', item.id)
            }
        );

        // Таблица грузовых позиции выбранной операции (multiSelect — отметка
        // позиций документа для привязки к оплате)
        // ✅ T103: короткие названия, расшифровки — в тултипах (tip);
        // ✅ T104: «К опл. ₽» — часть суммы ТЕКУЩЕЙ платежки, отнесённая позиции;
        //          «Оплачено ₽» — сумма ВСЕХ платежек позиции
        const pozCols = [
            { key: 'nomer_chertezha', label: '№ чертежа', width: '120px' },
            { key: 'naimenovanie', label: 'Наименование оснастки', width: '180px' },
            { key: 'kolvo', label: 'Кол-во', width: '60px',
              tip: 'Количество в грузовой позиции (годные + брак)' },
            { key: 'n_zaprosa', label: '№ запр.', width: '70px',
              tip: '№ запроса КП позиции (как в «Плане производства»)' },
            { key: 'zak_po_dog', label: '№ зак. дог.', width: '110px',
              tip: '№ заказа к договору (с датой; как в «Плане производства»)' },
            { key: 'kolvo_zak', label: 'Кол. зак.', width: '70px',
              tip: 'Количество по заказу (= план по позиции)' },
            { key: 'cena_kp', label: 'Цена КП', width: '90px',
              formatter: (v) => money(v),
              tip: 'Стоимость одной детали по лучшему КП, ₽ (без НДС)' },
            { key: 'stoim_plan', label: 'Стоимость ₽', width: '100px',
              formatter: (v) => (v === null || v === undefined) ? '' : money(v),
              tip: 'Стоимость планового количества, ₽ = кол-во по заказу × цена КП' },
            { key: 'opl_curr', label: 'К опл. ₽', width: '90px',
              formatter: (v, row) => {
                  const s = OplataRabot._rasp.get(row.id);
                  return s ? money(s) : '';
              },
              tip: '✅ T104: из текущей платежки отнесено позиции, ₽ (часть суммы документа)' },
            { key: 'oplacheno', label: 'Оплачено ₽', width: '100px',
              formatter: (v, row) => (parseFloat(v) > 0) ? money(v) : '',
              tip: 'Оплачено по позиции, ₽ (сумма частей ВСЕХ платежек, привязанных к позиции)' },
            { key: 'opl_link', label: 'Оплата (акт/УПД)', width: '150px',
              formatter: (v, row) => (row && row.opl_akty)
                ? { text: row.opl_akty, style: { color: '#1a7f37', fontWeight: '600' } }
                : '' },
            { key: 'nom_dogovor', label: 'Договор', width: '100px' }
        ];
        state.tables.oplPoz = new VirtualTable(
            document.getElementById('pozTable'), pozCols,
            {
                idKey: 'id',
                multiSelect: true,
                onSelectionChange: () => OplataRabot.updateButtons(),
                // ✅ T106: клик по заголовку позиций — ПОЛНЫЙ сброс страницы
                // (снимаются отметки позиций, выделение платежки и фильтры)
                onHeaderClick: () => OplataRabot.onHeaderPozClick()
            }
        );

        // Кнопки оплат
        document.getElementById('btnOplAdd').onclick = () => OplataRabot.onHeaderOpl();
        document.getElementById('btnOplSave').onclick = () => OplataRabot.save();
        document.getElementById('btnOplDel').onclick = () => OplataRabot.del();

        // Привязка позиций
        document.getElementById('btnPrivyazat').onclick = () => OplataRabot.privyazat();
        document.getElementById('btnOtvyazat').onclick = () => OplataRabot.otvyazat();

        // ✅ T106: «🔄» — обновить состояние ВСЕХ таблиц (операции + оплаты
        // + позиции выбранной операции)
        document.getElementById('btnReloadOpers').onclick = () => OplataRabot.applyFilters();

        // ✅ T106: выбор или изменение ЛЮБОГО поля фильтров перезагружает
        // состояние ВСЕХ таблиц страницы (applyFilters): операции + оплаты
        // + грузовые позиции выбранной операции
        document.getElementById('fltFirma').addEventListener('change', () => OplataRabot.applyFilters());
        document.getElementById('fltDataOtgruzki').addEventListener('change', () => OplataRabot.applyFilters());
        document.getElementById('fltTipPerevozki').addEventListener('change', () => OplataRabot.applyFilters());
        // ✅ T104: фильтр «№ эт.» (аванс → № эт. = 1 ставится автоматически)
        document.getElementById('fltNomShag').addEventListener('change', () => OplataRabot.applyFilters());
        document.getElementById('fltZakDog').addEventListener('change', () => OplataRabot.applyFilters());
        document.getElementById('fltZakPTO').addEventListener('change', () => OplataRabot.applyFilters());
        document.getElementById('btnResetFilters').onclick = () => OplataRabot.resetFilters();

        // Пересчёт сумм с НДС при вводе
        document.getElementById('oplSumma').addEventListener('input', () => OplataRabot.recomputeSums());

        // ✅ T104: автофильтры по типу оплаты:
        //   «аванс» → № эт. = 1; иначе (окончательный расчёт) → тип перевозки
        //   «Получение готовой продукции»; дальше оператор выбирает операцию сам
        document.getElementById('oplTipOplaty').addEventListener('change', () => OplataRabot.autoFilterByTip());

        // ✅ T104: модалка распределения суммы по позициям
        document.getElementById('raspOk').onclick = () => OplataRabot.raspOk();
        document.getElementById('raspCancel').onclick = () => OplataRabot.raspClose();
        // ✅ T105: пересчёт предзаполненных сумм по типу платежа
        document.getElementById('raspAutofill').onclick = () => OplataRabot.raspPrefill(true);

        // ✅ T106: панель шагов работы с платежкой
        document.getElementById('ost1Attach').onclick = () => document.getElementById('fileOplDoc').click();
        document.getElementById('fileOplDoc').addEventListener('change', e =>
            OplataRabot.uploadStepFile(e.target, 'doc', 'ssylka_doc'));
        document.getElementById('ost1Clear').onclick = () =>
            OplataRabot.clearStepField('ssylka_doc', 'прикреплённый PDF платёжного документа');
        document.getElementById('ost2Send').onclick = () => OplataRabot.sendDocEmail();
        document.getElementById('ost2Data1s').addEventListener('change', () =>
            OplataRabot.putStep({ data_vneseniya_1s: document.getElementById('ost2Data1s').value || '' }));
        document.getElementById('ost3Print').onclick = () =>
            toast('Печать реестра по шаблону — заглушка: функциональность будет реализована позднее', 'warning');
        document.getElementById('ost4Attach').onclick = () => document.getElementById('fileOplReestr').click();
        document.getElementById('fileOplReestr').addEventListener('change', e =>
            OplataRabot.uploadStepFile(e.target, 'reestr', 'ssylka_scan_reestra'));
        document.getElementById('ost4Clear').onclick = () =>
            OplataRabot.clearStepField('ssylka_scan_reestra', 'прикреплённый скан подписанного реестра');
    },

    // ---------- справочники фильтров ----------
    async loadFilters() {
        try {
            const firmy = await api('GET', '/api/firmy');
            const selF = document.getElementById('fltFirma');
            const curF = selF.value;
            selF.innerHTML = '<option value="">— выберите фирму —</option>';
            (Array.isArray(firmy) ? firmy : []).forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.id_firmy;
                opt.textContent = f.naimenovanie || f.kod || f.id_firmy;
                selF.appendChild(opt);
            });
            if (curF) selF.value = curF;

            const all = await api('GET', '/api/oplata/operatsii');
            const list = Array.isArray(all) ? all : [];

            // ✅ T103: типы перевозок — из шагов маршрута партий операций
            const tips = [...new Set(list
                .flatMap(o => String(o.tip_perevozki || '').split(','))
                .map(s => s.trim()).filter(Boolean))].sort();
            const selT = document.getElementById('fltTipPerevozki');
            const curT = selT.value;
            selT.innerHTML = '<option value="">Все типы</option>';
            tips.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t;
                opt.textContent = t;
                selT.appendChild(opt);
            });
            // ✅ T104: тип автофильтра окончательного расчёта присутствует всегда
            if (!Array.from(selT.options).some(o => o.value === TIP_AUTO_GOTOVAYA)) {
                const opt = document.createElement('option');
                opt.value = TIP_AUTO_GOTOVAYA;
                opt.textContent = TIP_AUTO_GOTOVAYA;
                selT.appendChild(opt);
            }
            if (curT && (tips.includes(curT) || curT === TIP_AUTO_GOTOVAYA)) selT.value = curT;

            // ✅ T104: фильтр «№ эт.» — этапы шагов маршрута операций
            const shagi = [...new Set(list
                .flatMap(o => String(o.nom_shag || '').split(','))
                .map(s => s.trim()).filter(Boolean))]
                .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
            const selS = document.getElementById('fltNomShag');
            const curS = selS.value;
            selS.innerHTML = '<option value="">Все этапы</option>';
            shagi.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s;
                opt.textContent = s;
                selS.appendChild(opt);
            });
            if (curS && shagi.includes(curS)) selS.value = curS;

            // ✅ T104: фильтр «№ зак. дог.» — select по заказам позиций операций
            const zaks = [...new Set(list
                .flatMap(o => String(o.zak_dog_list || '').split(','))
                .map(s => s.trim()).filter(Boolean))].sort();
            const selZ = document.getElementById('fltZakDog');
            const curZ = selZ.value;
            selZ.innerHTML = '<option value="">— выберите заказ —</option>';
            zaks.forEach(z => {
                const opt = document.createElement('option');
                opt.value = z;
                opt.textContent = z;
                selZ.appendChild(opt);
            });
            if (curZ && zaks.includes(curZ)) selZ.value = curZ;
        } catch (e) {
            console.error('[OplataRabot.loadFilters]', e);
        }
    },

    // ✅ T106: фильтры — в исходное состояние (без перезагрузки таблиц;
    // перезагрузку выполняет вызвавший — applyFilters или onHeader*)
    clearFiltersSilently() {
        document.getElementById('fltFirma').value = '';
        document.getElementById('fltDataOtgruzki').value = '';
        document.getElementById('fltTipPerevozki').value = '';
        document.getElementById('fltNomShag').value = '';
        document.getElementById('fltZakDog').value = '';
        document.getElementById('fltZakPTO').value = '';
    },

    // ✅ T106: кнопка «✖ Сброс» — очистить фильтры и перезагрузить ВСЕ таблицы
    resetFilters() {
        OplataRabot.clearFiltersSilently();
        OplataRabot.applyFilters();
    },

    // ✅ T106: ЕДИНАЯ реакция на выбор/изменение любого фильтра —
    // перезагрузка состояния ВСЕХ таблиц страницы:
    //   1) транспортные операции — по текущим фильтрам;
    //   2) если операция осталась выбранной — её оплаты и грузовые позиции
    //      перечитываются с сервера (устаревших данных не остаётся);
    //   3) если выбрана платежка — заново её распределение («К опл. ₽»).
    async applyFilters() {
        await OplataRabot.loadOpers();
        if (OplataRabot.selectedOperId) {
            await Promise.all([OplataRabot.loadOpl(), OplataRabot.loadPoz()]);
            if (OplataRabot.selectedOplId) await OplataRabot.loadRasp();
        }
        OplataRabot.updateInfo();   // дубль фильтров в форме + «Не распределено»
        OplataRabot.updateButtons();
    },

    // ✅ T104: обязательные фильтры платежки — фирма и № зак. дог.
    requiredFiltersReady() {
        return !!(document.getElementById('fltFirma').value &&
                  document.getElementById('fltZakDog').value);
    },

    // ---------- транспортные операции ----------
    async loadOpers() {
        const firma = document.getElementById('fltFirma').value || '';
        const data  = document.getElementById('fltDataOtgruzki').value || '';
        const tip   = document.getElementById('fltTipPerevozki').value || '';
        const shag  = document.getElementById('fltNomShag').value || '';  // ✅ T104
        const zakdog = document.getElementById('fltZakDog').value.trim(); // ✅ T103
        const zakpto = document.getElementById('fltZakPTO').value.trim(); // ✅ T103
        const params = new URLSearchParams();
        if (firma) params.set('firma', firma);
        if (data)  params.set('data', data);
        if (tip)   params.set('tip', tip);
        if (shag)  params.set('nomshag', shag);   // ✅ T104
        if (zakdog) params.set('zakdog', zakdog);
        if (zakpto) params.set('zakpto', zakpto);
        const qs = params.toString() ? ('?' + params.toString()) : '';
        const rows = await api('GET', '/api/oplata/operatsii' + qs);
        OplataRabot._opers = Array.isArray(rows) ? rows : [];

        // выбранная операция могла пропасть из-за фильтра
        // (✅ T106: внутренний сброс resetOperState — ФИЛЬТРЫ НЕ ТРОГАЕТ)
        const still = OplataRabot._opers.find(o => o.id === OplataRabot.selectedOperId);
        if (!still) {
            OplataRabot.selectedOperId = null;
            OplataRabot.resetOperState();
        }
        state.tables.oplOpers.setData(OplataRabot._opers);
        OplataRabot.updateButtons();
    },

    async onSelectOper(row) {
        OplataRabot.selectedOperId = row.id;
        document.getElementById('infoOper').textContent =   // ✅ T103: тип из шага маршрута
            `${row.firma_name || '—'} · ${row.otgruzka_data || ''} · ${row.tip_perevozki || ''}`;
        OplataRabot.onHeaderOpl();          // форма — в режим новой оплаты
        await Promise.all([OplataRabot.loadOpl(), OplataRabot.loadPoz()]);
        // ставка НДС для новой оплаты — после загрузки позиций (их договоры)
        document.getElementById('oplNdsRate').value = OplataRabot.rateFromPoz() ?? '';
        OplataRabot.recomputeSums();
        OplataRabot.updateInfo();
        OplataRabot.updateButtons();
    },

    // ✅ T106: внутренний сброс состояния «операция не выбрана» — выделение,
    // форма (режим создания), таблицы оплат и позиций. ФИЛЬТРЫ НЕ ТРОГАЕТ
    // и таблицу операций не перезагружает (вызывается из loadOpers, когда
    // выбранная операция пропала из-за фильтра, и при старте страницы).
    resetOperState() {
        OplataRabot.selectedOperId = null;
        state.tables.oplOpers.clearSelection();
        OplataRabot.onHeaderOpl();
        OplataRabot._opl = [];
        OplataRabot._poz = [];
        state.tables.oplZapisi.setData([]);
        state.tables.oplPoz.setData([]);
        document.getElementById('infoOper').textContent = '— не выбрана —';
        OplataRabot.updateInfo();
        OplataRabot.updateButtons();
    },

    // ✅ T106: клик по заголовку «Транспортные операции» — ПОЛНЫЙ сброс
    // состояния страницы: выделения, форма, таблицы оплат/позиций
    // И ВСЕ ФИЛЬТРЫ, затем перезагрузка операций без фильтров.
    async onHeaderOper() {
        OplataRabot.resetOperState();
        OplataRabot.clearFiltersSilently();
        await OplataRabot.loadOpers();
    },

    // ✅ T106: клик по заголовку «Оплаты по выбранной операции» — тот же
    // ПОЛНЫЙ сброс страницы (форма — в режим создания, фильтры очищаются).
    // Для создания оплаты с сохранением текущей операции служит кнопка
    // «➕» (onHeaderOpl — фильтры и выбор операции не трогает).
    async onHeaderOplClick() {
        await OplataRabot.onHeaderOper();
    },

    // ✅ T106: клик по заголовку «Грузовые позиции операции» — тот же
    // ПОЛНЫЙ сброс страницы (снимаются отметки позиций, выделение
    // платежки и все фильтры).
    async onHeaderPozClick() {
        await OplataRabot.onHeaderOper();
    },

    // ---------- оплаты операции ----------
    async loadOpl() {
        if (!OplataRabot.selectedOperId) { OplataRabot._opl = []; state.tables.oplZapisi.setData([]); return; }
        const rows = await api('GET', '/api/oplata/zapisi?operId=' + encodeURIComponent(OplataRabot.selectedOperId));
        OplataRabot._opl = Array.isArray(rows) ? rows : [];
        state.tables.oplZapisi.setData(OplataRabot._opl);
        // выбранная оплата могла пропасть из списка: отвязана от всех позиций
        // (список строится через oplata_poz) или удалена другим пользователем.
        // Форму НЕ сбрасываем — оператор может привязать оплату заново
        // («🔗 Привязать») или удалить («✖»); при реальном удалении сервер
        // вернёт «Оплата не найдена» на следующем действии.
        OplataRabot.updateButtons();
        OplataRabot.renderSteps();   // ✅ T106: шаги следуют за данными платежки
    },

    async loadPoz() {
        if (!OplataRabot.selectedOperId) { OplataRabot._poz = []; state.tables.oplPoz.setData([]); return; }
        const rows = await api('GET', '/api/oplata/pozicii?operId=' + encodeURIComponent(OplataRabot.selectedOperId));
        OplataRabot._poz = Array.isArray(rows) ? rows : [];
        state.tables.oplPoz.setData(OplataRabot._poz);
        OplataRabot.updateButtons();
    },

    // ✅ T104: распределение текущей оплаты по позициям (для колонки «К опл. ₽»)
    async loadRasp() {
        OplataRabot._rasp = new Map();
        if (!OplataRabot.selectedOplId) {
            state.tables.oplPoz.setData(OplataRabot._poz); // перерисовать без «К опл. ₽»
            return;
        }
        try {
            const rows = await api('GET', '/api/oplata/raspredelenie?oplId=' + encodeURIComponent(OplataRabot.selectedOplId));
            (Array.isArray(rows) ? rows : []).forEach(r => OplataRabot._rasp.set(r.id_gryz_poz, parseFloat(r.summa) || 0));
        } catch (e) {
            console.error('[OplataRabot.loadRasp]', e);
        }
        state.tables.oplPoz.setData(OplataRabot._poz); // перерисовать «К опл. ₽»
        OplataRabot.updateInfo(); // строка «Распределено по позициям»
    },

    async onSelectOpl(row) {
        OplataRabot.selectedOplId = row.id;
        document.getElementById('oplTipOplaty').value = row.tip_oplaty || '';
        document.getElementById('oplDataPredDok').value = row.data_predostavleniya_dok || '';
        document.getElementById('oplNomerAktaUpd').value = row.nomer_akta_upd || '';
        document.getElementById('oplNomerSchetFaktura').value = row.nomer_schet_faktura || '';
        document.getElementById('oplSumma').value = (row.summa_k_oplate ?? '') === '' ? '' : row.summa_k_oplate;
        document.getElementById('oplPrimechanie').value = row.primechanie || '';
        document.getElementById('oplNdsRate').value = row.nds_rate != null ? String(row.nds_rate) : '';
        document.getElementById('oplDogInfo').textContent = row.nds_nom_dogovor
            ? `Ставка НДС — из договора №${row.nds_nom_dogovor}.`
            : 'Ставка НДС не определена (у позиций нет договора).';
        OplataRabot.mode = 'edit';                  // ✅ T104: режим РЕДАКТИРОВАНИЯ
        OplataRabot.setFormTitle(row);
        OplataRabot.recomputeSums(row);
        await OplataRabot.loadRasp();
        OplataRabot.updateInfo();
        OplataRabot.updateButtons();
        OplataRabot.renderSteps();   // ✅ T106: шаги — по выбранной платежке
    },

    // ✅ T104: заголовок формы по режиму
    setFormTitle(oplRow) {
        const t = document.getElementById('oplFormTitle');
        if (OplataRabot.mode === 'create') {
            t.textContent = 'Оплата работ — СОЗДАНИЕ новой оплаты';
            t.style.color = '#1a7f37';
        } else if (OplataRabot.mode === 'edit') {
            const num = oplRow && oplRow.nomer_akta_upd ? ` № ${oplRow.nomer_akta_upd}` : '';
            t.textContent = `Оплата работ — РЕДАКТИРОВАНИЕ${num}`;
            t.style.color = '#0b5cad';
        } else {
            t.textContent = 'Оплата работ';
            t.style.color = '';
        }
    },

    // Новая оплата (клик по заголовку таблицы оплат / кнопка ➕):
    // ✅ T104: явный режим СОЗДАНИЯ — форма и выделение сбрасываются полностью
    onHeaderOpl() {
        OplataRabot.selectedOplId = null;
        OplataRabot.mode = 'create';
        state.tables.oplZapisi.clearSelection();
        state.tables.oplPoz.clearSelection();
        ['oplTipOplaty', 'oplDataPredDok', 'oplNomerAktaUpd', 'oplNomerSchetFaktura',
         'oplSumma', 'oplPrimechanie', 'oplNdsRate', 'oplNdsSumma', 'oplSummaSNds']
            .forEach(id => { document.getElementById(id).value = ''; });
        OplataRabot._rasp = new Map();
        document.getElementById('oplNdsRate').value = OplataRabot.rateFromPoz() ?? '';
        document.getElementById('oplDogInfo').textContent = OplataRabot.selectedOperId
            ? 'Ставка НДС определяется по договору грузовых позиций выбранной операции.'
            : 'Сначала выберите транспортную операцию.';
        OplataRabot.setFormTitle();
        OplataRabot.recomputeSums();
        OplataRabot.updateInfo();
        OplataRabot.updateButtons();
        OplataRabot.renderSteps();   // ✅ T106: без сохраненной платежки шаги заблокированы
    },

    // ✅ T104: автофильтры по типу оплаты (change «Тип оплаты» в форме):
    //   аванс → фильтр «№ эт.» = 1; иначе → тип перевозки «Получение готовой
    //   продукции»; остальные авто-фильтр сбрасывает (оператор донастраивает
    //   вручную только остальные поля)
    autoFilterByTip() {
        // ✅ T105: если транспортная операция уже выбрана — автофильтры не
        // применяем (выбор оператора имеет приоритет: смена типа оплаты
        // не должна «терять» уже выбранную операцию)
        if (OplataRabot.selectedOperId) return;
        const tip = document.getElementById('oplTipOplaty').value;
        const selS = document.getElementById('fltNomShag');
        const selT = document.getElementById('fltTipPerevozki');
        if (tip === 'avans') {
            if (Array.from(selS.options).some(o => o.value === '1')) selS.value = '1';
            selT.value = '';
        } else if (tip === 'okonchatelny_raschet') {
            selS.value = '';
            selT.value = TIP_AUTO_GOTOVAYA;
        } else {
            return; // тип не выбран — фильтры не трогаем
        }
        OplataRabot.applyFilters();   // ✅ T106: перезагрузить ВСЕ таблицы
    },

    // Ставка НДС для новой оплаты — по договору первой позиции операции
    rateFromPoz() {
        const row = OplataRabot._poz.find(p => p.hdc !== null && p.hdc !== undefined && String(p.hdc).trim() !== '');
        if (!row) return null;
        const n = parseFloat(String(row.hdc).replace(',', '.'));
        return Number.isFinite(n) ? n : null;
    },

    // Живой пересчёт: Сумма НДС = Сумма × НДС% / 100; Итого = Сумма + НДС
    recomputeSums(baseRow) {
        const sEl = document.getElementById('oplSumma');
        const s = parseFloat(String(sEl.value).replace(',', '.'));
        let rate = null;
        if (baseRow && baseRow.nds_rate != null) rate = baseRow.nds_rate;
        else {
            const sel = OplataRabot._opl.find(o => o.id === OplataRabot.selectedOplId);
            if (sel && sel.nds_rate != null) rate = sel.nds_rate;
            else rate = OplataRabot.rateFromPoz();
        }
        const nds = (Number.isFinite(s) && rate != null) ? Math.round(s * rate) / 100 : null;
        document.getElementById('oplNdsSumma').value = nds != null ? nds.toFixed(2) : '';
        document.getElementById('oplSummaSNds').value = (nds != null && Number.isFinite(s)) ? (s + nds).toFixed(2) : '';
        const rateEl = document.getElementById('oplNdsRate');
        if (rate == null && !rateEl.value) rateEl.value = '';
        OplataRabot.updateInfo(); // ✅ T104: строка «Распределено» следует за суммой
    },

    // ✅ T105: лимит распределения текущей оплаты — сумма платежки БЕЗ НДС
    // (НДС и итого с НДС — расчётные, в сравнении «Распределено X из Y»
    // не участвуют)
    oplLimitNow() {
        const sEl = parseFloat(String(document.getElementById('oplSumma').value).replace(',', '.'));
        return Number.isFinite(sEl) ? Math.round(sEl * 100) / 100 : 0;
    },

    updateInfo() {
        const oper = OplataRabot._opers.find(o => o.id === OplataRabot.selectedOperId);
        const dogSet = [...new Set(OplataRabot._poz.map(p => p.nom_dogovor).filter(Boolean))];
        document.getElementById('infoDogovor').textContent = dogSet.length ? ('№ ' + dogSet.join(', № ')) : '—';
        const linked = OplataRabot._poz.filter(p => parseFloat(p.oplacheno) > 0).length;
        document.getElementById('infoPozCount').textContent =
            OplataRabot.selectedOperId ? `${linked} из ${OplataRabot._poz.length}` : '—';

        // ✅ T104: обязательные фильтры дублируются в форме для информации
        const selF = document.getElementById('fltFirma');
        const firmaTxt = selF.options[selF.selectedIndex] ? selF.options[selF.selectedIndex].textContent : '';
        document.getElementById('infoFirma').textContent = selF.value ? firmaTxt : '— не выбрана —';
        const zak = document.getElementById('fltZakDog').value;
        document.getElementById('infoZakDog').textContent = zak || '— не выбран —';

        // ✅ T106: НЕ РАСПРЕДЕЛЕНО — остаток платежки, который оператор ещё
        // может распределить по позициям (сумма документа без НДС минус то,
        // что уже отнесено позициям); «распределено X из Y» — рядом, для полноты
        let rasp = 0;
        OplataRabot._rasp.forEach(s => { rasp += s; });
        rasp = Math.round(rasp * 100) / 100;
        const limit = OplataRabot.oplLimitNow();
        const neRaspEl = document.getElementById('infoNeRasp');
        if (OplataRabot.mode && OplataRabot.selectedOperId) {
            const neRasp = Math.round((limit - rasp) * 100) / 100;
            neRaspEl.textContent =
                `${money(neRasp) || '0.00'} ₽ · распределено ${money(rasp) || '0.00'} из ${money(limit) || '—'} ₽ (без НДС)`;
            neRaspEl.style.color = neRasp < 0 ? '#c62828' : '';
        } else {
            neRaspEl.textContent = '—';
            neRaspEl.style.color = '';
        }
        void oper;
    },

    collectForm() {
        return {
            tip_oplaty: document.getElementById('oplTipOplaty').value,
            data_predostavleniya_dok: document.getElementById('oplDataPredDok').value || '',
            nomer_akta_upd: document.getElementById('oplNomerAktaUpd').value.trim(),
            nomer_schet_faktura: document.getElementById('oplNomerSchetFaktura').value.trim(),
            summa_k_oplate: parseFloat(String(document.getElementById('oplSumma').value).replace(',', '.')),
            primechanie: document.getElementById('oplPrimechanie').value.trim()
        };
    },

    // ✅ T104: валидация общих условий сохранения (оба режима)
    validateCommon(d) {
        if (!OplataRabot.requiredFiltersReady()) {
            toast('Платежка привязана к фирме и заказу: заполните обязательные фильтры «Фирма» и «№ зак. дог.»', 'warning');
            return false;
        }
        if (!OplataRabot.selectedOperId) {
            toast('Сначала выберите транспортную операцию', 'warning');
            return false;
        }
        if (!d.tip_oplaty) { toast('Выберите тип оплаты', 'warning'); return false; }
        if (!Number.isFinite(d.summa_k_oplate) || d.summa_k_oplate < 0) {
            toast('Укажите сумму к оплате (₽, без НДС)', 'warning');
            return false;
        }
        return true;
    },

    async save() {
        const d = OplataRabot.collectForm();
        if (!OplataRabot.validateCommon(d)) return;

        if (OplataRabot.mode === 'edit' && OplataRabot.selectedOplId) {
            const r = await api('PUT', '/api/oplata/zapisi/' + encodeURIComponent(OplataRabot.selectedOplId), d);
            if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
            toast('Оплата сохранена');
            state.tables.oplPoz.clearSelection();
            await Promise.all([OplataRabot.loadOpl(), OplataRabot.loadPoz(), OplataRabot.loadOpers()]);
            const again = OplataRabot._opl.find(o => o.id === OplataRabot.selectedOplId);
            if (again) {
                state.tables.oplZapisi.selectById(again.id);
                OplataRabot.onSelectOpl(again);
            }
            OplataRabot.updateButtons();
            return;
        }

        // ✅ T104: СОЗДАНИЕ — распределение суммы документа по отмеченным
        // позициям в модалке; оплата создаётся после подтверждения
        const pozIds = state.tables.oplPoz.getSelectedIds();
        if (!pozIds.length) {
            toast('Отметьте грузовые позиции документа — затем укажите, какая часть суммы платежки относится к каждой позиции', 'warning');
            return;
        }
        OplataRabot.openRasp(pozIds, {
            create: true,
            onOk: async (pozSum) => {
                const r = await api('POST', '/api/oplata/zapisi',
                    Object.assign({ id_oper: OplataRabot.selectedOperId, pozIds, pozSum }, d));
                if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
                OplataRabot.selectedOplId = r.id;
                toast('Оплата создана, сумма распределена по позициям');
                state.tables.oplPoz.clearSelection();
                await Promise.all([OplataRabot.loadOpl(), OplataRabot.loadPoz(), OplataRabot.loadOpers()]);
                const again = OplataRabot._opl.find(o => o.id === OplataRabot.selectedOplId);
                if (again) {
                    state.tables.oplZapisi.selectById(again.id);
                    OplataRabot.onSelectOpl(again);
                } else if (OplataRabot._opl.length === 0) {
                    OplataRabot.onHeaderOpl();
                }
                OplataRabot.updateButtons();
            }
        });
    },

    async del() {
        if (!OplataRabot.selectedOplId) return;
        if (!confirm('Удалить оплату? Привязка и распределение сумм по грузовым позициям будут сняты.')) return;

        if (EditLock.current?.id === OplataRabot.selectedOplId) EditLock.release();

        const r = await api('DELETE', '/api/oplata/zapisi/' + encodeURIComponent(OplataRabot.selectedOplId));
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
        toast('Оплата удалена');
        OplataRabot.onHeaderOpl();
        await Promise.all([OplataRabot.loadOpl(), OplataRabot.loadPoz(), OplataRabot.loadOpers()]);
    },

    // ---------- привязка позиций ----------
    // ✅ T104: «Привязать» открывает модалку распределения: по каждой
    // отмеченной позиции указывается часть суммы платежки (существующие
    // суммы подставляются и могут быть изменены); сумма документа
    // не может быть превышена.
    async privyazat() {
        if (!OplataRabot.requiredFiltersReady()) {
            toast('Платежка привязана к фирме и заказу: заполните обязательные фильтры «Фирма» и «№ зак. дог.»', 'warning');
            return;
        }
        if (!OplataRabot.selectedOperId) { toast('Сначала выберите транспортную операцию', 'warning'); return; }
        if (!OplataRabot.selectedOplId) { toast('Сначала выберите оплату в таблице «Оплаты»', 'warning'); return; }
        const pozIds = state.tables.oplPoz.getSelectedIds();
        if (!pozIds.length) { toast('Отметьте грузовые позиции для привязки', 'warning'); return; }

        OplataRabot.openRasp(pozIds, {
            create: false,
            onOk: async (pozSum) => {
                const r = await api('POST', '/api/oplata/privyazat', {
                    id_oper: OplataRabot.selectedOperId,
                    oplId: OplataRabot.selectedOplId,
                    pozIds,
                    pozSum
                });
                if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
                toast(`Привязано/обновлено позиций: ${r.count}`);
                state.tables.oplPoz.clearSelection();
                await Promise.all([OplataRabot.loadPoz(), OplataRabot.loadRasp(), OplataRabot.loadOpl(), OplataRabot.loadOpers()]);
            }
        });
    },

    // ✅ T104: снятие привязки — в контексте выбранной платежки
    // (связи других платежек позиции сохраняются)
    async otvyazat() {
        if (!OplataRabot.requiredFiltersReady()) {
            toast('Платежка привязана к фирме и заказу: заполните обязательные фильтры «Фирма» и «№ зак. дог.»', 'warning');
            return;
        }
        if (!OplataRabot.selectedOperId) { toast('Сначала выберите транспортную операцию', 'warning'); return; }
        if (!OplataRabot.selectedOplId) { toast('Сначала выберите оплату — привязка снимается в контексте конкретной платежки', 'warning'); return; }
        const pozIds = state.tables.oplPoz.getSelectedIds();
        if (!pozIds.length) { toast('Отметьте грузовые позиции для снятия привязки', 'warning'); return; }

        const r = await api('POST', '/api/oplata/otvyazat', {
            id_oper: OplataRabot.selectedOperId,
            oplId: OplataRabot.selectedOplId,
            pozIds
        });
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
        toast(`Снята привязка позиций: ${r.count}`);
        state.tables.oplPoz.clearSelection();
        await Promise.all([OplataRabot.loadPoz(), OplataRabot.loadRasp(), OplataRabot.loadOpl(), OplataRabot.loadOpers()]);
        if (OplataRabot.selectedOplId &&
            !OplataRabot._opl.find(o => o.id === OplataRabot.selectedOplId)) {
            toast('Оплата не привязана ни к одной позиции — отметьте позиции и нажмите «🔗 Привязать», либо удалите оплату «✖»', 'warning');
        }
    },

    // ============================================================
    // ✅ T104: МОДАЛКА РАСПРЕДЕЛЕНИЯ СУММЫ ПЛАТЕЖКИ ПО ПОЗИЦИЯМ
    // ============================================================
    openRasp(pozIds, opts) {
        const poz = pozIds
            .map(id => OplataRabot._poz.find(p => p.id === id))
            .filter(Boolean);
        if (!poz.length) { toast('Позиции не найдены', 'warning'); return; }

        // уже распределено этой платежкой по ДРУГИМ позициям
        let otherSum = 0;
        OplataRabot._rasp.forEach((s, id) => { if (!pozIds.includes(id)) otherSum += s; });
        otherSum = Math.round(otherSum * 100) / 100;

        const limit = OplataRabot.oplLimitNow();
        // ✅ T105: ставка НДС — только для расчётных величин рядом с лимитом
        const selOpl = OplataRabot._opl.find(o => o.id === OplataRabot.selectedOplId);
        const rate = (selOpl && selOpl.nds_rate != null) ? selOpl.nds_rate : OplataRabot.rateFromPoz();
        OplataRabot._raspCtx = { pozIds, limit, otherSum, rate, onOk: opts.onOk };

        document.getElementById('raspDocInfo').innerHTML =
            `Сумма платежки (без НДС) к распределению: <b>${money(limit)} ₽</b>` +
            (OplataRabot.mode === 'create' ? ' — новая оплата' : ' — редактирование платежки');
        document.getElementById('raspOtherInfo').textContent =
            otherSum > 0 ? `По другим позициям этой платежки уже распределено: ${money(otherSum)} ₽.` : '';

        const head = document.getElementById('raspRows');
        head.innerHTML = poz.map(p => {
            const curr = OplataRabot._rasp.get(p.id) || 0;
            const otherPoz = Math.round(((parseFloat(p.oplacheno) || 0) - curr) * 100) / 100;
            return `<div class="rasp-row" data-id="${p.id}">
                <div class="rasp-cell rasp-chert" title="${p.nomer_chertezha || ''}">${p.nomer_chertezha || ''}</div>
                <div class="rasp-cell rasp-naim" title="${p.naimenovanie || ''}">${p.naimenovanie || ''}</div>
                <div class="rasp-cell rasp-kolvo">${p.kolvo ?? ''}</div>
                <div class="rasp-cell rasp-stoim">${money(p.stoim_plan)}</div>
                <div class="rasp-cell rasp-opl">${otherPoz > 0 ? money(otherPoz) : '—'}</div>
                <div class="rasp-cell rasp-sum">
                    <input type="number" min="0" step="0.01" class="rasp-input" data-id="${p.id}"
                           value="${curr ? curr : ''}" placeholder="0.00"
                           title="Часть суммы платежки, относящаяся к этой позиции, ₽ (без НДС)">
                </div>
            </div>`;
        }).join('');

        head.querySelectorAll('.rasp-input').forEach(inp => {
            inp.addEventListener('input', () => OplataRabot.raspRecalc());
        });
        OplataRabot.raspPrefill(false); // ✅ T105: предзаполнение пустых полей
        document.getElementById('raspModal').classList.remove('hidden');
    },

    // ============================================================
    // ✅ T105: предзаполнение сумм распределения по типу платежа
    //   «аванс» → Стоимость ₽ позиции × % аванса договора
    //             (dogovor.predoplata_pr);
    //   «окончательный расчёт» → Стоимость ₽ − оплачено позиции другими
    //             платежками (аванс; равно колонке «Оплачено ₽» модалки).
    // force=true — перезаполнить ВСЕ поля (кнопка «⟳ Автозаполнение»),
    // force=false — только пустые (при открытии модалки).
    // ============================================================
    raspPrefill(force) {
        const ctx = OplataRabot._raspCtx;
        if (!ctx) return;
        const tip = document.getElementById('oplTipOplaty').value;
        document.querySelectorAll('#raspRows .rasp-input').forEach(inp => {
            if (!force && String(inp.value).trim() !== '') return;
            const p = OplataRabot._poz.find(x => x.id === inp.dataset.id);
            const v = p ? OplataRabot.pozPrefill(p) : null;
            inp.value = (v != null && v > 0) ? String(v) : '';
        });
        const info = document.getElementById('raspPrefillInfo');
        if (tip === 'avans') {
            const noPr = ctx.pozIds.some(id => {
                const p = OplataRabot._poz.find(x => x.id === id);
                const pr = p ? parseFloat(String(p.predoplata_pr ?? '').replace(',', '.')) : NaN;
                return !Number.isFinite(pr) || pr <= 0;
            });
            info.textContent = 'Автозаполнение: Стоимость ₽ × % аванса договора (predoplata_pr)' +
                (noPr ? ' — у части позиций % аванса в договоре не заполнен: суммы задайте вручную' : '');
        } else if (tip === 'okonchatelny_raschet') {
            info.textContent = 'Автозаполнение: Стоимость ₽ − оплачено по позиции другими платежками (аванс, колонка «Оплачено ₽»)';
        } else {
            info.textContent = 'Тип оплаты не выбран — суммы задайте вручную';
        }
        OplataRabot.raspRecalc();
    },

    // ✅ T105: предзаполненная сумма распределения одной позиции (null — нет)
    pozPrefill(p) {
        const num = (v) => parseFloat(String(v ?? '').replace(',', '.'));
        const stoim = num(p.stoim_plan);
        if (!Number.isFinite(stoim)) return null;
        const tip = document.getElementById('oplTipOplaty').value;
        if (tip === 'avans') {
            const pr = num(p.predoplata_pr);
            if (!Number.isFinite(pr) || pr <= 0) return null;
            return Math.round(stoim * pr) / 100;
        }
        if (tip === 'okonchatelny_raschet') {
            // оплачено позиции ДРУГИМИ платежками (текущая исключается):
            // фактически — уплаченный аванс, равен колонке «Оплачено ₽»
            const oplach = parseFloat(p.oplacheno) || 0;
            const curr = OplataRabot._rasp.get(p.id) || 0;
            const otherPoz = Math.max(0, Math.round((oplach - curr) * 100) / 100);
            return Math.max(0, Math.round((stoim - otherPoz) * 100) / 100);
        }
        return null;
    },

    raspCollected() {
        let total = 0;
        const out = [];
        document.querySelectorAll('#raspRows .rasp-input').forEach(inp => {
            const id = inp.dataset.id; // id строки gryz_poz — TEXT ('GP_...')
            const v = parseFloat(String(inp.value).replace(',', '.'));
            const s = Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0;
            total += s;
            // сохраняем существующие связи даже с суммой 0 (можно обнулить часть)
            if (s > 0 || (OplataRabot._rasp.has(id))) out.push({ id, summa: s });
        });
        return { out, total: Math.round(total * 100) / 100 };
    },

    raspRecalc() {
        const ctx = OplataRabot._raspCtx;
        if (!ctx) return;
        const { total } = OplataRabot.raspCollected();
        const grand = Math.round((ctx.otherSum + total) * 100) / 100;
        const el = document.getElementById('raspTotal');
        const okBtn = document.getElementById('raspOk');
        const over = grand > ctx.limit + 0.011;
        // ✅ T105: сравнение — по сумме без НДС; НДС и итого с НДС — расчётные
        let vat = '';
        if (ctx.rate != null) {
            const nds = Math.round(grand * ctx.rate) / 100;
            vat = ` · НДС ${ctx.rate}%: ${money(nds)} ₽ · Итого с НДС: ${money(grand + nds)} ₽ (расчётно)`;
        }
        // ✅ T106: остаток свободных средств платежки
        const neRasp = Math.round((ctx.limit - grand) * 100) / 100;
        el.innerHTML = `Распределено: <b>${money(grand)} ₽</b> из <b>${money(ctx.limit)} ₽</b> (без НДС)` +
            ` · Не распределено: <b>${money(neRasp)} ₽</b>${vat}` +
            (over ? ' — <span style="color:#c62828; font-weight:700;">ПРЕВЫШЕНИЕ СУММЫ ПЛАТЕЖКИ</span>' : '');
        el.style.color = over ? '#c62828' : '';
        okBtn.disabled = over;
    },

    async raspOk() {
        const ctx = OplataRabot._raspCtx;
        if (!ctx) return;
        const { out, total } = OplataRabot.raspCollected();
        if (!out.length || total <= 0) {
            toast('Укажите сумму хотя бы для одной позиции — сколько из платежки относится к позиции', 'warning');
            return;
        }
        document.getElementById('raspModal').classList.add('hidden');
        const cb = ctx.onOk;
        OplataRabot._raspCtx = null;
        if (cb) await cb(out);
    },

    raspClose() {
        document.getElementById('raspModal').classList.add('hidden');
        OplataRabot._raspCtx = null;
    },

    // ============================================================
    // ✅ T106: ПАНЕЛЬ ШАГОВ РАБОТЫ С ПЛАТЕЖКОЙ
    // (эталон — панель шагов страницы «Заказы по договорам»)
    //   шаг 1 — прикрепить PDF платёжного документа;
    //   шаг 2 — аванс: отправить PDF на почту из поля «Email»;
    //           окончательный расчёт: дата занесения акта в 1С;
    //   шаг 3 (окончательный) — распечатать реестр по шаблону (заглушка);
    //   шаг 4 (окончательный) — прикрепить скан подписанного реестра (PDF).
    // ============================================================
    oplStepRow() {
        return OplataRabot._opl.find(o => o.id === OplataRabot.selectedOplId) || null;
    },

    renderSteps() {
        const el = id => document.getElementById(id);
        if (!el('ostep1')) return; // страница без панели шагов
        const z = OplataRabot.oplStepRow();
        const ctrl = ['ost1Attach', 'ost1Clear', 'ost2Send', 'ost2Email', 'ost2Data1s',
                      'ost3Print', 'ost4Attach', 'ost4Clear'];

        if (!z) {
            ['ost1File', 'ost4File'].forEach(id => OplataRabot.setFileLink(id, ''));
            ['ost2Email', 'ost2Data1s'].forEach(id => { if (el(id)) el(id).value = ''; });
            for (let i = 1; i <= 4; i++) {
                const fs = el('ostep' + i);
                if (fs) { fs.classList.add('blocked'); fs.style.display = ''; }
                const b = el('obadge' + i);
                if (b) b.className = 'step-badge';
            }
            el('ost2EmailRow').style.display = '';
            el('ost2OneSRow').style.display = '';
            el('ostep2Title').textContent = 'Шаг 2';
            ctrl.forEach(id => { if (el(id)) el(id).disabled = true; });
            OplataRabot.renderStepHints(null, { 1: false, 2: false, 3: false, 4: false });
            return;
        }

        const avans = z.tip_oplaty === 'avans';
        const locker = isLocked('oplata_rabot', z.id);

        // состав шагов по типу оплаты: аванс — 1, 2 (почта);
        // окончательный расчёт — 1..4 (2 = дата занесения в 1С)
        el('ostep3').style.display = avans ? 'none' : '';
        el('ostep4').style.display = avans ? 'none' : '';
        el('ost2EmailRow').style.display = avans ? '' : 'none';
        el('ost2OneSRow').style.display = avans ? 'none' : '';
        el('ostep2Title').textContent = avans
            ? 'Отправка документа на почту'
            : 'Занесение акта в 1С';

        const done = {
            1: !!(z.ssylka_doc && String(z.ssylka_doc).trim()),
            2: avans
                ? !!(z.data_email_otpravki && String(z.data_email_otpravki).trim())
                : !!(z.data_vneseniya_1s && String(z.data_vneseniya_1s).trim()),
            3: false, // ✅ T106: заглушка печати реестра — состояния нет
            4: !!(z.ssylka_scan_reestra && String(z.ssylka_scan_reestra).trim())
        };
        const open = { 1: true, 2: done[1], 3: done[2], 4: done[2] };
        for (let i = 1; i <= 4; i++) {
            const fs = el('ostep' + i);
            const badge = el('obadge' + i);
            if (done[i]) badge.className = 'step-badge done';
            else if (open[i]) badge.className = 'step-badge active';
            else badge.className = 'step-badge';
            fs.classList.toggle('blocked', !open[i]);
        }

        OplataRabot.setFileLink('ost1File', z.ssylka_doc);
        OplataRabot.setFileLink('ost4File', z.ssylka_scan_reestra);
        el('ost2Email').value = z.email_otpravki || '';
        el('ost2Data1s').value = z.data_vneseniya_1s || '';
        el('ost1Attach').disabled = !!locker;
        el('ost1Clear').disabled = !done[1] || !!locker;
        el('ost2Email').disabled = !open[2] || !!locker;
        el('ost2Send').disabled = !open[2] || !!locker;
        el('ost2Data1s').disabled = !open[2] || !!locker;
        el('ost3Print').disabled = !open[3];
        el('ost4Attach').disabled = !open[4] || !!locker;
        el('ost4Clear').disabled = !done[4] || !!locker;
        OplataRabot.renderStepHints(z, open);
    },

    renderStepHints(z, open) {
        const hints = {
            1: 'Шаги работы с платежкой доступны после её сохранения — выберите оплату в таблице «Оплаты».',
            2: 'Шаг недоступен: сначала прикрепите PDF платёжного документа (шаг 1).',
            3: 'Шаг недоступен: сначала выполните шаг 2.',
            4: 'Шаг недоступен: сначала выполните шаг 2.'
        };
        for (let i = 1; i <= 4; i++) {
            const h = document.getElementById('ohint' + i);
            if (!h) continue;
            const blocked = z ? !open[i] : true;
            if (blocked && hints[i]) { h.textContent = hints[i]; h.style.display = 'block'; }
            else h.style.display = 'none';
        }
    },

    setFileLink(id, p) {
        const a = document.getElementById(id);
        if (!a) return;
        if (p) {
            a.href = p;
            a.textContent = '📎 ' + decodeURIComponent(String(p).split('/').pop());
            a.classList.remove('hidden');
        } else {
            a.classList.add('hidden');
            a.removeAttribute('href');
            a.textContent = '';
        }
    },

    // прикрепление файла шага 1/4: загрузка на сервер + запись в платежку
    async uploadStepFile(input, kind, field) {
        const file = input.files && input.files[0];
        input.value = '';
        const z = OplataRabot.oplStepRow();
        if (!file || !z) return;
        if (!/\.pdf$/i.test(file.name)) { toast('Прикрепить можно только файл PDF', 'warning'); return; }
        try {
            toast('Загрузка файла...', 'warning');
            const url = `/api/oplata/upload-file?name=${encodeURIComponent(file.name)}&kind=${kind}`;
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: file
            });
            const r = await resp.json();
            if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
            toast('Файл загружен', 'success');
            await OplataRabot.putStep({ [field]: r.path });
        } catch (e) {
            toast('Ошибка загрузки: ' + e.message, 'error');
        }
    },

    async clearStepField(field, what) {
        const z = OplataRabot.oplStepRow();
        if (!z) return;
        if (!confirm(`Удалить ${what}?`)) return;
        await OplataRabot.putStep({ [field]: '' });
    },

    // запись полей шагов на сервер + обновление данных платежки
    async putStep(patch) {
        const z = OplataRabot.oplStepRow();
        if (!z) return;
        try {
            const r = await api('PUT', `/api/oplata/zapisi/${encodeURIComponent(z.id)}/step`, { patch });
            if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
            await OplataRabot.loadOpl();   // внутри — renderSteps()
        } catch (e) {
            toast('Ошибка: ' + e.message, 'error');
        }
    },

    // шаг 2 (аванс): отправка PDF платежки на почту из поля «Email»
    async sendDocEmail() {
        const z = OplataRabot.oplStepRow();
        if (!z) return;
        const emailRaw = document.getElementById('ost2Email').value;
        const emailList = emailRaw.split(/[;,\s]+/).map(s => s.trim()).filter(Boolean);
        if (!emailList.length) { toast('Укажите адрес получателя в поле «Email»', 'warning'); return; }
        const bad = emailList.filter(s => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
        if (bad.length) { toast('Некорректный адрес: ' + bad.join(', '), 'error'); return; }
        if (!confirm(`Отправить платёжный документ на:
${emailList.join('\n')}
(адресов: ${emailList.length})`)) return;
        try {
            toast('Отправка письма...', 'warning');
            const r = await api('POST', '/api/oplata/send-email', { oplId: z.id, email: emailList.join(';') });
            if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
            toast('Письмо отправлено: ' + r.email, 'success');
            await OplataRabot.loadOpl();   // внутри — renderSteps()
        } catch (e) {
            toast('Ошибка: ' + e.message, 'error');
        }
    },

    updateButtons() {
        const operSel = !!OplataRabot.selectedOperId;
        const oplSel = !!OplataRabot.selectedOplId;
        const pozSel = state.tables.oplPoz ? state.tables.oplPoz.getSelectedIds().length > 0 : false;
        const reqOk = OplataRabot.requiredFiltersReady(); // ✅ T104: фирма + № зак. дог.

        // ✅ T104: «➕» — явный вход в режим СОЗДАНИЯ оплаты;
        // без обязательных фильтров заблокирована (платежка привязана
        // к фирме и заказу к договору)
        const btnAdd = document.getElementById('btnOplAdd');
        btnAdd.disabled = !reqOk;
        btnAdd.title = reqOk
            ? 'Новая оплата (режим создания)'
            : 'Сначала заполните обязательные фильтры «Фирма» и «№ зак. дог.» — платежка жестко привязана к ним';

        document.getElementById('btnOplSave').disabled = !(reqOk && operSel);
        document.getElementById('btnOplDel').disabled = !oplSel;
        document.getElementById('btnPrivyazat').disabled = !(operSel && oplSel && pozSel);
        document.getElementById('btnOtvyazat').disabled = !(operSel && oplSel && pozSel);
    }
};
