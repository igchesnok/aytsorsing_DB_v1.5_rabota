// ============================================================
// modules/orders.js МОДУЛЬ: ЗАКАЗЫ ПО ДОГОВОРАМ (эталон: 5 шагов)
// Серверная фильтрация через FilterableTable +
// последовательные шаги + статус каждой позиции
// ============================================================

import { api, toast, esc } from '../common/utils.js';   // ✅ T98: esc — экранирование HTML в предпросмотре письма
import { state } from '../common/state.js';
import { FilterableTable } from '../common/filterable-table.js';
import { EditLock, isLocked } from '../common/websocket.js';
import { batchManager } from '../common/batch-update.js';
import { showExcelPreview, buildEmailPreviewHtml as buildEmailDocHtml } from '../common/excel-preview.js';   // ✅ T100: + общий рендер письма (с редактированием текста)

// 5 статусов позиции из эталона
const POZ_STATUSES = [
  'формирование списка поз. заказа',
  'на рассмотрении',
  'согласовано',
  'отказ фирмы',
  'отказ УЭБ'
];

export const Orders = {
  _selectedZakazId: null,
  _selectedPozId: null,
  _allDogovory: [],
  _allFirmy: [],
  _zakazRow: null,   // полная строка выбранного заказа (все поля шагов)
  _pozRow: null,     // полная строка выбранной позиции


  async init() {
    // ===== ТАБЛИЦА ЗАКАЗОВ — FilterableTable =====
    const zakazCols = [
      { key: 'nomer_zakaza', label: '№ заказа', width: '130px' },
      { key: 'data_zakaza', label: 'Дата', width: '100px' },
      { key: 'nom_dogovor', label: '№ договора', width: '100px' },
      { key: 'firma_nazvanie', label: 'Фирма', width: '200px' },
      { key: 'statys_zd', label: 'Статус', width: '180px' }
    ];

    state.tables.zakaz = new FilterableTable(
      document.getElementById('zakazTable'), zakazCols,
      {
        idKey: 'id',
        apiUrl: '/api/orders',
        filterFields: {
          fltGod: { dbField: 'god', type: 'text' },
          fltNomerZakaz: { dbField: 'nomer_zakaza', type: 'text' },
          fltFirma: { dbField: 'id_firma', type: 'text' },
          fltDogovor: { dbField: 'id_dogovora', type: 'text' },
          fltStatys: { dbField: 'statys_zd', type: 'text' },
          fltNomerZaprosa: { dbField: 'n_zaprosa', type: 'text' }  // ✅ T93: фильтр № запроса
        },
        debounceMs: 300,
        onSelect: r => Orders.onSelectZakaz(r),
        onHeaderClick: () => Orders.onHeaderClick(),
        getLockInfo: (item) => isLocked('zakaz_po_dogovoru', item.id)
      }
    );

    // ===== ТАБЛИЦА ПОЗИЦИЙ ЗАКАЗА — FilterableTable =====
    const pozCols = [
      { key: 'nomer_chertezha', label: '№ чертежа', width: '130px' },
      { key: 'n_zaprosa', label: '№ запроса', width: '90px' },  // ✅ T93
      { key: 'osn_naimenovanie', label: 'Наименование', width: '200px' },
      { key: 'plan_god_kolvo', label: 'Кол-во', width: '80px' },
      { key: 'firma_nazvanie', label: 'Фирма', width: '150px' },
      { key: 'status_poz_zd', label: 'Статус', width: '160px' }
    ];

    state.tables.pozicii = new FilterableTable(
      document.getElementById('poziciiTable'), pozCols,
      {
        idKey: 'id',
        apiUrl: '/api/orders/positions',
        filterFields: {
          fltZakazId: { dbField: 'zakazId', type: 'text' }
        },
        debounceMs: 300,
        onSelect: r => Orders.onSelectPozicia(r),
        onHeaderClick: () => Orders.onHeaderClickPozicii(),
        getLockInfo: (item) => isLocked('poz_zakaz_dogovora', item.id)
      }
    );

    // ===== ТАБЛИЦА ДОСТУПНЫХ ПОЗИЦИЙ — FilterableTable =====
    const availCols = [
      { key: 'nomer_chertezha', label: '№ чертежа', width: '120px' },
      { key: 'n_zaprosa', label: '№ запроса', width: '90px' },  // ✅ T93
      { key: 'naimenovanie', label: 'Наименование', width: '200px' },
      { key: 'plan_god_kolvo', label: 'Кол-во', width: '80px' },
      { key: 'firma_nazvanie', label: 'Фирма', width: '120px' }
    ];

    state.tables.available = new FilterableTable(
      document.getElementById('availableTable'), availCols,
      {
        idKey: 'id',
        apiUrl: '/api/orders/available',
        filterFields: {
          fltGod: { dbField: 'god', type: 'text' },
          fltFirma: { dbField: 'id_firma', type: 'text' },
          fltDogovor: { dbField: 'id_dogovora', type: 'text' },
          fltNomerChertezha: { dbField: 'nomer_chertezha', type: 'text' },
          fltNaimenovanie: { dbField: 'naimenovanie', type: 'text' }
        },
        debounceMs: 300,
        multiSelect: true,
        onSelectionChange: () => Orders.updateAddButton()
      }
    );

    // ===== Кнопки CRUD =====
    document.getElementById('btnZakazAdd').onclick = () => Orders.add();
    document.getElementById('btnZakazSave').onclick = () => Orders.save();
    document.getElementById('btnZakazDel').onclick = () => Orders.del();
    document.getElementById('btnAddPosition').onclick = () => Orders.addPosition();
    document.getElementById('btnDelPosition').onclick = () => Orders.delPosition();
    document.getElementById('btnPrintExcel').onclick = () => Orders.printExcel();
    document.getElementById('btnGenerateOrders').onclick = () => Orders.generateOrders();

    // ===== Обработчики фильтров =====
    // ✅ T99: fltFirma/fltDogovor — связанные селекты (у договора одна фирма,
    // у фирмы — несколько договоров) и обрабатываются отдельными хендлерами:
    // выбор договора подставляет фирму, выбор фирмы фильтрует список договоров.
    ['fltGod', 'fltNomerZakaz', 'fltNomerZaprosa', 'fltStatys'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => Orders.applyZakazFilters());
        el.addEventListener('change', () => Orders.applyZakazFilters());
      }
    });
    const elFltFirma = document.getElementById('fltFirma');
    if (elFltFirma) {
      elFltFirma.addEventListener('input', () => Orders.onFltFirmaChange());
      elFltFirma.addEventListener('change', () => Orders.onFltFirmaChange());
    }
    const elFltDogovor = document.getElementById('fltDogovor');
    if (elFltDogovor) {
      elFltDogovor.addEventListener('input', () => Orders.onFltDogovorChange());
      elFltDogovor.addEventListener('change', () => Orders.onFltDogovorChange());
    }

    ['fltNomerChertezha', 'fltNaimenovanie'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => Orders.applyAvailableFilters());
    });

    // Кнопки очистки
    document.getElementById('btnClearAllZakazFilters').onclick = () => {
      ['fltGod', 'fltNomerZakaz', 'fltNomerZaprosa', 'fltFirma', 'fltDogovor', 'fltStatys'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      // ✅ T99: вернуть в «Договор» полный список (мог быть сужен выбором фирмы)
      Orders._fltDogovorRender('', '');
      Orders.applyZakazFilters();
    };

    document.getElementById('btnClearAllAvailFilters').onclick = () => {
      ['fltNomerChertezha', 'fltNaimenovanie'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      Orders.applyAvailableFilters();
    };

    // Обработчики ввода формы заказа
    ['zNomer', 'zData'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => Orders.updateButtonStates());
    });

    // ===== ШАГИ: события полей (change — сохранение по завершении ввода) =====
    // Шаг 1
    document.getElementById('st1Send').onclick = () => Orders.sendEmail();
    document.getElementById('st1Clear').onclick = () => Orders.clearStep1();
    Orders.initEmailCombo();   // ✅ T20: множественный выбор адресов через «;»
    // Шаг 2
    document.getElementById('st2Reshenie').addEventListener('change', () =>
      Orders.putStep(2, { reshenie_firm: document.getElementById('st2Reshenie').value }));
    document.getElementById('st2DataOtv').addEventListener('change', () =>
      Orders.putStep(2, { data_otv_firma: document.getElementById('st2DataOtv').value }));
    document.getElementById('st2Print').onclick = () => Orders.printExcel();
    document.getElementById('st2Attach').onclick = () => document.getElementById('fileReshenie').click();
    document.getElementById('st2Clear').onclick = () => Orders.clearStep2();   // ✅ T21: откат шага 2
    document.getElementById('fileReshenie').addEventListener('change', e =>
      Orders.uploadAndAttach(e.target, 2, 'ssylka_reshenie', 'reshenie'));
    // ✅ T51: шаг 3 «Согл. структур. подр. АВТОВАЗ» перенесён на страницу
    // «Внесение коммерческих предложений» (там он — шаг 2); шаги здесь
    // перенумерованы: бывший 4 → 3, бывший 5 → 4 (id DOM сохранены).
    // Шаг 4
    document.getElementById('st4Peredano').addEventListener('change', () =>
      Orders.putStep(4, { data_peredano_direktor: document.getElementById('st4Peredano').value }));
    document.getElementById('st4Podpis').addEventListener('change', () =>
      Orders.putStep(4, { data_podpisaniya_direktor: document.getElementById('st4Podpis').value }));
    document.getElementById('st4Print').onclick = () => Orders.printExcel();
    document.getElementById('st4Attach').onclick = () => document.getElementById('fileScan').click();
    document.getElementById('fileScan').addEventListener('change', e =>
      Orders.uploadAndAttach(e.target, 4, 'ssylka_scan_podpisannogo', 'scan'));
    // Шаг 5
    document.getElementById('st5Go').addEventListener('change', () =>
      Orders.putStep(5, { data_go_orig_zd: document.getElementById('st5Go').value }));
    document.getElementById('st5Pol').addEventListener('change', () =>
      Orders.putStep(5, { data_pol_orig_zd: document.getElementById('st5Pol').value }));

    // ===== Статус позиции (только одна выбранная) =====
    document.getElementById('pozStatus').addEventListener('change', () => Orders.savePozStatus());

    // ===== Ред. договора =====
    document.getElementById('btnEditDogovor').onclick = () => Orders.openDogovorModal();
    document.getElementById('dgClose').onclick = () => Orders.closeDogovorModal();
    document.getElementById('dgSave').onclick = () => Orders.saveDogovor();
    document.getElementById('dogovorModal').addEventListener('click', e => {
      if (e.target === e.currentTarget) Orders.closeDogovorModal();
    });

    // Загрузка справочников
    await Orders.loadReferences();
  },

  async loadReferences() {
  // Фирмы
  Orders._allFirmy = await api('GET', '/api/firmy');
  const fltFirma = document.getElementById('fltFirma');
  fltFirma.innerHTML = '<option value="">Все фирмы</option>';
  Orders._allFirmy.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id_firmy;
    opt.textContent = f.naimenovanie;
    fltFirma.appendChild(opt);
  });

  // Договоры — заполняем ОБА комбокса: фильтр И форму
 Orders._allDogovory = await api('GET', '/api/dogovor');


  // Фильтр
  const fltDogovor = document.getElementById('fltDogovor');
  fltDogovor.innerHTML = '<option value="">Все договоры</option>';
  Orders._allDogovory.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id_dogovor;
    opt.textContent = `${d.nom_dogovor} от ${d.data_dogovor}`;
    fltDogovor.appendChild(opt);
  });

  // Форма заказа (zDogovor)
  // ✅ T36: заполнение через единый хелпер (ничего не выбрано -> полный список)
  Orders._fillZDogovor(null, '');
},

  // ===== Применение фильтров заказов =====
  applyZakazFilters() {
    const filters = {
      fltGod: document.getElementById('fltGod').value,
      fltNomerZakaz: document.getElementById('fltNomerZakaz').value,
      fltNomerZaprosa: document.getElementById('fltNomerZaprosa').value,  // ✅ T93-b
      fltFirma: document.getElementById('fltFirma').value,
      fltDogovor: document.getElementById('fltDogovor').value,
      fltStatys: document.getElementById('fltStatys').value
    };
    state.tables.zakaz.applyFilters(filters);
  },

  // ===== Применение фильтров доступных позиций =====
  applyAvailableFilters() {
    const filters = {
      fltGod: document.getElementById('fltGod').value,
      fltFirma: document.getElementById('fltFirma').value,
      fltDogovor: document.getElementById('fltDogovor').value,
      fltNomerChertezha: document.getElementById('fltNomerChertezha').value,
      fltNaimenovanie: document.getElementById('fltNaimenovanie').value
    };
    state.tables.available.applyFilters(filters);
  },

  // ============================================================
  // ✅ T99: СВЯЗАННЫЕ СЕЛЕКТЫ ФИЛЬТРА «Фирма» ↔ «Договор».
  // У договора ровно одна фирма (dogovor.id_firmy), у фирмы может быть
  // несколько договоров: выбор договора подставляет его фирму, выбор
  // фирмы сужает список договоров, «Все …» сбрасывает оба селекта.
  // ============================================================
  _fltDogovorRender(idFirmy, currentValue) {
    const fltDogovor = document.getElementById('fltDogovor');
    if (!fltDogovor) return;
    const key = String(idFirmy || '');
    const all = Orders._allDogovory || [];
    const list = key ? all.filter(d => String(d.id_firmy) === key) : all;
    fltDogovor.innerHTML = '<option value="">Все договоры</option>';
    list.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id_dogovor;
      opt.textContent = `${d.nom_dogovor} от ${d.data_dogovor}`;
      fltDogovor.appendChild(opt);
    });
    // Защита: если текущее значение не попало в отфильтрованный список
    // (рассинхрон кэша / WS) — опция всё равно добавляется, фильтр не теряется
    if (currentValue && !list.some(d => String(d.id_dogovor) === String(currentValue))) {
      const d = all.find(x => String(x.id_dogovor) === String(currentValue));
      if (d) {
        const opt = document.createElement('option');
        opt.value = d.id_dogovor;
        opt.textContent = `${d.nom_dogovor} от ${d.data_dogovor}`;
        fltDogovor.appendChild(opt);
      }
    }
    fltDogovor.value = currentValue || '';
  },

  // Выбор ФИРМЫ в фильтре: «Все фирмы» сбрасывает оба селекта,
  // конкретная фирма сужает селект договоров до её договоров
  onFltFirmaChange() {
    const fltFirma = document.getElementById('fltFirma');
    const fltDogovor = document.getElementById('fltDogovor');
    if (!fltFirma) return;
    const firmId = String(fltFirma.value || '');
    const curDog = fltDogovor ? String(fltDogovor.value || '') : '';
    if (!firmId) {
      // «Все фирмы» — полный сброс связки
      Orders._fltDogovorRender('', '');
    } else {
      // Текущий договор остаётся только если он принадлежит этой фирме
      const keep = curDog && (Orders._allDogovory || []).some(d =>
        String(d.id_dogovor) === curDog && String(d.id_firmy) === firmId);
      Orders._fltDogovorRender(firmId, keep ? curDog : '');
    }
    Orders.applyZakazFilters();
  },

  // Выбор ДОГОВОРА в фильтре: «Все договоры» сбрасывает оба селекта,
  // конкретный договор подставляет в «Фирму» его фирму
  onFltDogovorChange() {
    const fltFirma = document.getElementById('fltFirma');
    const fltDogovor = document.getElementById('fltDogovor');
    if (!fltDogovor) return;
    const dogId = String(fltDogovor.value || '');
    if (!dogId) {
      // «Все договоры» — полный сброс связки
      if (fltFirma) fltFirma.value = '';
      Orders._fltDogovorRender('', '');
    } else {
      const d = (Orders._allDogovory || []).find(x => String(x.id_dogovor) === dogId);
      if (fltFirma) fltFirma.value = d ? String(d.id_firmy) : '';
      // Список договоров сужаем до фирмы выбранного договора
      Orders._fltDogovorRender(d ? d.id_firmy : '', dogId);
    }
    Orders.applyZakazFilters();
  },

  // ===== Загрузка списка заказов =====
  async load() {
    await state.tables.zakaz.loadImmediate({});
    // Обновляем кэш выбранной строки (статус мог измениться сервером)
    if (Orders._selectedZakazId) {
      const row = state.tables.zakaz.data.find(z => z.id === Orders._selectedZakazId);
      if (row) {
        Orders._zakazRow = row;
        Orders.renderSteps();
        Orders.updatePozStatusBlock();
      }
    }
  },

  // ===== Загрузка позиций заказа =====
  async loadPositions(zakazId) {
    if (!zakazId) {
      state.tables.pozicii.setData([]);
      return;
    }
    await state.tables.pozicii.loadImmediate({ fltZakazId: zakazId });
  },

  // ===== Загрузка доступных позиций =====
async loadAvailablePositions(zakazId, zakazRow = null) {
  const god = document.getElementById('fltGod').value || new Date().getFullYear();
  const filterFirmaId = document.getElementById('fltFirma').value;
  const filterDogovorId = document.getElementById('fltDogovor').value;

  let targetDogovorId = filterDogovorId;
  let targetFirmaId = filterFirmaId;

  //  используем переданную строку заказа
  if (zakazId && zakazRow) {
    if (zakazRow.id_dogovora) {
      targetDogovorId = zakazRow.id_dogovora;
      targetFirmaId = '';  // Фирма будет определена на сервере по договору
    }
  }

  const filters = {
    fltGod: god,
    fltFirma: targetFirmaId,
    fltDogovor: targetDogovorId,
    fltNomerChertezha: document.getElementById('fltNomerChertezha').value,
    fltNaimenovanie: document.getElementById('fltNaimenovanie').value
  };

  await state.tables.available.loadImmediate(filters);
},
// ===== Публичный метод для обновления доступных позиций (для synthetic-sync) =====
async refreshAvailablePositions() {
  const zakazRow = Orders._selectedZakazId
    ? state.tables.zakaz.data.find(z => z.id === Orders._selectedZakazId)
    : null;
  await Orders.loadAvailablePositions(Orders._selectedZakazId, zakazRow);
},

  async refreshCurrentPositions() {
    if (Orders._selectedZakazId) {
      await Orders.loadPositions(Orders._selectedZakazId);
      // держим кэш выбранной позиции актуальным
      if (Orders._selectedPozId) {
        Orders._pozRow = state.tables.pozicii.data.find(p => p.id === Orders._selectedPozId) || null;
        Orders.updatePozStatusBlock();
      }
    }
  },

  // ========================================================================
  // ПАНЕЛЬ 5 ШАГОВ: рендер, гейты, бейджи
  // ========================================================================
  _stepDone(z) {
    return {
      1: !!(z.data_email_firma && String(z.data_email_firma).trim()),
      2: !!(z.data_otv_firma || z.reshenie_firm || z.ssylka_reshenie),
      // ✅ T51: ключа 3 больше нет — шаг перенесён на «Внесение КП»
      4: !!(z.data_podpisaniya_direktor || z.ssylka_scan_podpisannogo),
      5: !!(z.data_go_orig_zd || z.data_pol_orig_zd)
    };
  },

  // Шаг открыт, если выполнены предыдущие (гейты как в эталоне)
  _stepOpen(z) {
    const sent = !!(z.data_email_firma && String(z.data_email_firma).trim());
    const answered = !!(z.data_otv_firma && String(z.data_otv_firma).trim());
    const signed = !!(z.data_podpisaniya_direktor && String(z.data_podpisaniya_direktor).trim());
    return { 1: true, 2: sent, 4: answered, 5: signed };   // ✅ T51: без шага 3
  },

  renderSteps() {
    const z = Orders._zakazRow;
    const el = id => document.getElementById(id);

    if (!z) {
      // сброс панели
      ['st1Data', 'st2Reshenie', 'st2DataOtv', 'st4Peredano', 'st4Podpis', 'st5Go', 'st5Pol'].forEach(id => { if (el(id)) el(id).value = ''; });
      ['st2File', 'st4File'].forEach(id => { const a = el(id); if (a) { a.classList.add('hidden'); a.removeAttribute('href'); a.textContent = ''; } });
      // ✅ T32: сброс индикации «неактуальна»
      const sw0 = el('st1StaleWord'); if (sw0) sw0.style.display = 'none';
      const b10 = el('badge1'); if (b10) b10.classList.remove('stale');
      for (let i = 1; i <= 5; i++) {
        const fs = el('step' + i); if (fs) fs.classList.add('blocked');
        const b = el('badge' + i); if (b) b.className = 'step-badge';
      }
      // ✅ T21: +st1EmailToggle/st2Clear
      ['st1Send', 'st1Clear', 'st1EmailToggle', 'st2Reshenie', 'st2DataOtv', 'st2Attach', 'st2Clear', 'st4Peredano', 'st4Podpis', 'st4Attach', 'st5Go', 'st5Pol'].forEach(id => { if (el(id)) el(id).disabled = true; });
      Orders.renderStepHints(null);
      return;
    }

    // Синхронизация полей формы заказа с актуальным состоянием (авто-статус)
    el('zStatys').value = z.statys_zd || '';
    el('zDataEmail').textContent = z.data_email_firma || 'не отправлялось';
    el('zDataOtv').textContent = z.data_otv_firma || 'не согласовано';
    el('zEmail').textContent = z.email_otpravki || 'не отправлено';

    const done = Orders._stepDone(z);
    const open = Orders._stepOpen(z);
    const locker = isLocked('zakaz_po_dogovoru', z.id);

    // ✅ T51: физические шаги 1,2,4,5 (экранные номера 1,2,3,4 — бейджи в HTML)
    for (const i of [1, 2, 4, 5]) {
      const fs = el('step' + i);
      const badge = el('badge' + i);
      if (done[i]) badge.className = 'step-badge done';
      else if (open[i]) badge.className = 'step-badge active';
      else badge.className = 'step-badge';
      fs.classList.toggle('blocked', !open[i]);
    }

    // ✅ T32: состав заказа менялся ПОСЛЕ отправки (отказ фирмы/УЭБ, правка позиций) —
    // номер шага 1 становится красным кружком, к лейблу добавляется «неактуальна»:
    // направленный фирме заказ устарел, после правок нужно отправить обновлённый.
    // Статусы заказа и позиций при этом НЕ сбрасываются (это обновление отправки).
    const stale1 = !!done[1] && !!(z.aktualnost_email_firma && String(z.aktualnost_email_firma).trim());
    const sw = el('st1StaleWord');
    if (sw) sw.style.display = stale1 ? 'inline' : 'none';
    const b1 = el('badge1'); if (b1) b1.classList.toggle('stale', stale1);

    // Шаг 1
    el('st1Data').value = z.data_email_firma || '';
    el('st1Send').disabled = !open[1] || !!locker || done[2] === true && !!(z.data_otv_firma && String(z.data_otv_firma).trim());
    el('st1Clear').disabled = !done[1] || !open[2] || !!locker;
    // Шаг 2
    el('st2Reshenie').value = z.reshenie_firm || '';
    el('st2Reshenie').disabled = !open[2] || !!locker;
    el('st2DataOtv').disabled = !open[2] || !!locker;
    el('st2DataOtv').value = Orders.toDatetimeLocal(z.data_otv_firma);
    el('st2Attach').disabled = !open[2] || !!locker;
    el('st2Clear').disabled = !open[2] || !!locker || !done[2];   // ✅ T21: «Очистить» активна, когда шаг 2 заполнен
    el('st1EmailToggle').disabled = !!locker;                     // ✅ T21: стрелка списка email
    Orders.setFileLink('st2File', z.ssylka_reshenie);
    // Шаг 4 (✅ T51: шаг 3 перенесён на «Внесение КП»)
    el('st4Peredano').value = z.data_peredano_direktor || '';
    el('st4Peredano').disabled = !open[4] || !!locker;
    el('st4Podpis').value = z.data_podpisaniya_direktor || '';
    el('st4Podpis').disabled = !open[4] || !!locker;
    el('st4Attach').disabled = !open[4] || !!locker;
    Orders.setFileLink('st4File', z.ssylka_scan_podpisannogo);
    // Шаг 5
    el('st5Go').value = z.data_go_orig_zd || '';
    el('st5Go').disabled = !open[5] || !!locker;
    el('st5Pol').value = z.data_pol_orig_zd || '';
    el('st5Pol').disabled = !open[5] || !!locker;

    Orders.renderStepHints(z);
  },

  renderStepHints(z) {
    // ✅ T51: экранные номера шагов — 3 (бывший 4) и 4 (бывший 5);
    // hint3 больше не существует на странице (шаг перенесён)
    const hints = {
      2: !z || 'Шаг недоступен: сначала отправьте заказ контрагенту (шаг 1).',
      4: !z || 'Шаг недоступен: нет даты ответа контрагента (шаг 2).',
      5: !z || 'Шаг недоступен: заказ не подписан директором (шаг 3).'
    };
    for (let i = 2; i <= 5; i++) {
      const h = document.getElementById('hint' + i);
      if (!h) continue;
      const open = z ? Orders._stepOpen(z)[i] : false;
      if (z && !open) { h.textContent = hints[i]; h.style.display = 'block'; }
      else h.style.display = 'none';
    }
  },

  toDatetimeLocal(v) {
    if (!v) return '';
    // '27.09.2026 10:07' | '2026-09-27 10:07' | ISO
    const s = String(v).trim();
    let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00`;
    return '';
  },

  setFileLink(id, path) {
    const a = document.getElementById(id);
    if (!a) return;
    if (path) {
      a.href = path;
      a.textContent = '📎 ' + decodeURIComponent(String(path).split('/').pop());
      a.classList.remove('hidden');
    } else {
      a.classList.add('hidden');
      a.removeAttribute('href');
      a.textContent = '';
    }
  },

  // Запись полей шага на сервер + авто-статус
  async putStep(step, patch) {
    if (!Orders._zakazRow) return;
    try {
      const r = await api('PUT', `/api/orders/${Orders._zakazRow.id}/step`, { step, patch });
      if (r.error) {
        // ✅ T21: сначала reload (его служебные тосты уйдут раньше), ПОТОМ ошибка —
        // иначе тост «Автообновление формы» затирает сообщение, и пользователь не
        // видит, почему шаг не сброшен (напр. «более поздние шаги уже заполнены»)
        await Orders.reloadCurrentZakaz();
        toast('Ошибка: ' + r.error, 'error');
        return;
      }
      // ✅ T30: откат шага 1 мог удалить пустой заказ (все позиции были отказные)
      if (r.deleted) {
        toast('Заказ удалён: после отката шага 1 в нём не осталось позиций', 'warning');
        Orders._zakazRow = null;
        Orders._selectedZakazId = null;
        Orders.updatePozStatusBlock();
        await Orders.load();
        await Orders.loadPositions(null);
        return;
      }
      Orders._zakazRow = r.row;
      Orders.renderSteps();
      Orders.updatePozStatusBlock();
      await Orders.load();                 // обновить колонку «Статус» в списке
      state.tables.zakaz.selectById(Orders._zakazRow.id);
      // ✅ T30: шаг 1 — статусы позиций могли сброситься (откат «не отправляли»)
      if (step === 1) await Orders.loadPositions(Orders._selectedZakazId);
      toast('Шаг ' + step + ' сохранён', 'success');
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  },

  async reloadCurrentZakaz() {
    await Orders.load();
    Orders._zakazRow = state.tables.zakaz.data.find(z => z.id === Orders._selectedZakazId) || null;
    Orders.renderSteps();
    Orders.updatePozStatusBlock();
  },

  async clearStep1() {
    if (!Orders._zakazRow) return;
    if (!confirm('Сбросить дату отправки заказа контрагенту?')) return;
    await Orders.putStep(1, { data_email_firma: '', email_otpravki: '' });
  },

  // ✅ T21: откат шага 2 «Решение контрагента по заказу» — удалить
  // прикреплённый файл решения (ssylka_reshenie), текст решения и дату ответа;
  // сервер пересчитает статус заказа (вернётся к «На согласовании контрагента»)
  async clearStep2() {
    if (!Orders._zakazRow) return;
    if (!confirm('Откатить шаг 2 «Решение контрагента по заказу»?\n\nБудут удалены: прикреплённый файл решения, текст решения и дата ответа. Статус заказа вернётся к «На согласовании контрагента».')) return;
    await Orders.putStep(2, { reshenie_firm: '', data_otv_firma: '', ssylka_reshenie: '' });
  },

  // Загрузка файла на сервер + привязка к шагу
  async uploadAndAttach(input, step, field, kind) {
    const file = input.files && input.files[0];
    input.value = ''; // сброс, чтобы можно было выбрать тот же файл повторно
    if (!file || !Orders._zakazRow) return;
    try {
      toast('Загрузка файла...', 'warning');
      const url = `/api/orders/upload-file?name=${encodeURIComponent(file.name)}&kind=${kind}&zakazId=${encodeURIComponent(Orders._zakazRow.id)}`;
      const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const r = await resp.json();
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      toast('Файл загружен', 'success');
      const patch = { [field]: r.path };
      // ✅ T21: шаг 2 — дата ответа заполняется автоматически после
      // прикрепления решения (только если ещё не заполнена вручную)
      if (step === 2 && field === 'ssylka_reshenie' &&
          !(Orders._zakazRow.data_otv_firma && String(Orders._zakazRow.data_otv_firma).trim())) {
        const d = new Date();
        const p2 = n => String(n).padStart(2, '0');
        patch.data_otv_firma = `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      }
      await Orders.putStep(step, patch);
    } catch (e) {
      toast('Ошибка загрузки: ' + e.message, 'error');
    }
  },

  // Кнопка «Перейти в ЭДО» (адрес запоминается в браузере)
  openEdo() {
    let url = localStorage.getItem('ordersEdoUrl');
    if (!url) {
      url = prompt('Введите адрес системы ЭДО (сохранится в браузере):', '');
      if (!url) return;
      localStorage.setItem('ordersEdoUrl', url);
    }
    window.open(url, '_blank');
  },

  // ========================================================================
  // СТАТУС ВЫБРАННОЙ ПОЗИЦИИ (только одна, как в эталоне)
  // ========================================================================
  updatePozStatusBlock() {
    const info = document.getElementById('pozInfo');
    const sel = document.getElementById('pozStatus');
    // ✅ T35: чекбокс «для всех позиций» — доступен вместе с выбором статуса
    const chkAll = document.getElementById('pozStatusAll');
    const r = Orders._pozRow;
    if (!r) {
      info.value = '';
      sel.value = '';
      sel.disabled = true;
      if (chkAll) chkAll.disabled = true;
      return;
    }
    info.value = `${r.nomer_chertezha || ''} ${r.osn_naimenovanie || ''}`.trim();
    const cur = POZ_STATUSES.includes(r.status_poz_zd) ? r.status_poz_zd : POZ_STATUSES[0];
    sel.value = cur;
    // статус позиции доступен только после отправки заказа (шаг 1)
    const sent = !!(Orders._zakazRow && Orders._zakazRow.data_email_firma && String(Orders._zakazRow.data_email_firma).trim());
    sel.disabled = !sent;
    // ✅ T35: массовое применение доступно тогда же, когда и одиночное
    if (chkAll) chkAll.disabled = !sent;
  },

  async savePozStatus() {
    if (!Orders._pozRow) return;
    const sel = document.getElementById('pozStatus');
    const status = sel.value;
    if (!status) return;
    // ✅ T35: чекбокс «для всех позиций» — статус применяется ко ВСЕМ
    // позициям заказа из таблицы «Позиции заказа к договору»
    const chkAll = document.getElementById('pozStatusAll');
    const applyAll = !!(chkAll && chkAll.checked && Orders._zakazRow);
    // ✅ T31: «отказ фирмы»/«отказ УЭБ» — позиция УДАЛЯЕТСЯ из заказа
    // (позиция плана должна существовать только в одном заказе)
    if (status === 'отказ фирмы' || status === 'отказ УЭБ') {
      // ✅ T35: при массовом отказе предупреждение про ВСЕ позиции
      const confirmMsg = applyAll
        ? 'Установить статус «' + status + '» ДЛЯ ВСЕХ позиций заказа?\n\nКП ВСЕХ позиций будет исключено из расчётов, позиции плана освободятся, статусы запросов откатятся.\n\nВСЕ позиции будут УДАЛЕНЫ из заказа — заказ будет удалён ЦЕЛИКОМ.'
        : 'Установить статус «' + status + '»?\n\nКП ЭТОЙ позиции будет исключено из расчётов, позиция плана освободится для перерасчёта лучших КП, статус запроса откатится.\n\nПозиция будет УДАЛЕНА из заказа. Если это была последняя позиция — заказ будет удалён целиком.';
      if (!confirm(confirmMsg)) {
        Orders.updatePozStatusBlock();
        return;
      }
    }
    // ✅ T35: массовое применение — ОДИН запрос, сервер применяет статус
    // ко всем позициям заказа (единая семантика с одиночной сменой)
    if (applyAll) {
      try {
        const r = await api('PUT', '/api/orders/positions-status-all', { id_zakaza: Orders._zakazRow.id, status_poz_zd: status });
        if (r.error) {
          toast('Ошибка: ' + r.error, 'error');
          Orders.updatePozStatusBlock();
          return;
        }
        if (r.deleted) {
          // массовый отказ: позиций не осталось — заказ удалён ЦЕЛИКОМ
          Orders._pozRow = null;
          Orders._zakazRow = null;
          Orders._selectedZakazId = null;
          Orders._selectedPozId = null;
          Orders.updatePozStatusBlock();
          await Orders.load();
          await Orders.loadPositions(null);
          // ✅ T21: тост ПОСЛЕ reload — иначе его затирает «Автообновление формы»
          toast(r.message || 'Позиций в заказе не осталось — заказ удалён', 'warning');
          return;
        }
        if (r.otkaz) {
          // защитная ветка: часть позиций осталась — выбранная позиция удалена
          Orders._pozRow = null;
          // ✅ T32: состав отправленного заказа изменился — показать «неактуальна»
          if (r.aktualnost && Orders._zakazRow) {
            Orders._zakazRow.aktualnost_email_firma = r.aktualnost;
            Orders.renderSteps();
          }
          if (r.statys_zd != null && Orders._zakazRow && r.statys_zd !== Orders._zakazRow.statys_zd) {
            Orders._zakazRow.statys_zd = r.statys_zd;
            Orders.renderSteps();
          }
          Orders.updatePozStatusBlock();
          await Orders.load();
          await Orders.loadPositions(Orders._selectedZakazId);
          toast(r.message || 'Статус применён ко всем позициям заказа', 'warning');
          return;
        }
        toast('Статус всех позиций (' + (r.updated != null ? r.updated : 'все') + '): ' + status, 'success');
        // ✅ Статус заказа мог измениться: согласованы ВСЕ позиции -> «Согласовано»
        if (r.statysChanged && Orders._zakazRow && r.statys_zd !== Orders._zakazRow.statys_zd) {
          Orders._zakazRow.statys_zd = r.statys_zd;
          Orders.renderSteps();            // синхронизирует поле «Статус заказа» и бейджи
          await Orders.load();             // колонка «Статус» в списке заказов
          state.tables.zakaz.selectById(Orders._zakazRow.id);
          toast('Статус заказа: ' + r.statys_zd, 'warning');
        }
        await Orders.loadPositions(Orders._selectedZakazId);
        // ✅ T34: кэш выбранной позиции перечитывается из свежих данных
        if (Orders._selectedPozId != null) {
          Orders._pozRow = state.tables.pozicii.data.find(p => p.id === Orders._selectedPozId) || null;
        }
        if (Orders._pozRow) {
          state.tables.pozicii.selectById(Orders._pozRow.id);
          Orders.updatePozStatusBlock();
        }
      } catch (e) {
        toast('Ошибка: ' + e.message, 'error');
      }
      return;
    }
    try {
      const r = await api('PUT', '/api/orders/position-status', { id: Orders._pozRow.id, status_poz_zd: status });
      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        Orders.updatePozStatusBlock();
        return;
      }
      // ✅ T31: отказ («отказ фирмы»/«отказ УЭБ») — позиция УДАЛЕНА из заказа;
      // если она была последней — заказ удалён целиком (r.deleted)
      if (r.otkaz) {
        if (r.deleted) {
          Orders._pozRow = null;
          Orders._zakazRow = null;
          Orders._selectedZakazId = null;
          Orders.updatePozStatusBlock();
          await Orders.load();
          await Orders.loadPositions(null);
          // ✅ T21: тост ПОСЛЕ reload — иначе его затирает «Автообновление формы»
          toast(r.message || 'Позиций в заказе не осталось — заказ удалён', 'warning');
          return;
        }
        Orders._pozRow = null;        // позиция удалена — форма статуса гасится
        // ✅ T32: состав отправленного заказа изменился — сразу показать «неактуальна»
        if (r.aktualnost && Orders._zakazRow) {
          Orders._zakazRow.aktualnost_email_firma = r.aktualnost;
          Orders.renderSteps();
        }
        if (r.statys_zd != null && Orders._zakazRow && r.statys_zd !== Orders._zakazRow.statys_zd) {
          Orders._zakazRow.statys_zd = r.statys_zd;
          Orders.renderSteps();       // синхронизация поля «Статус заказа»
        }
        Orders.updatePozStatusBlock();
        await Orders.load();          // статус/состав заказа могли измениться
        await Orders.loadPositions(Orders._selectedZakazId);
        // ✅ T21: тост ПОСЛЕ reload — иначе его затирает «Автообновление формы»
        toast(r.message || 'Позиция удалена из заказа, КП исключено, позиция плана освобождена', 'warning');
        return;
      }
      // ✅ T34: за время PUT позиция могла быть «сброшена» параллельным
      // автообновлением формы — сначала пробуем восстановить кэш по
      // _selectedPozId, и только если строки нет вовсе — тихо выходим.
      if (!Orders._pozRow && Orders._selectedPozId != null) {
        Orders._pozRow = state.tables.pozicii.data.find(p => p.id === Orders._selectedPozId) || null;
      }
      if (!Orders._pozRow) {
        Orders.updatePozStatusBlock();
        toast('Статус позиции: ' + status, 'success');
        return;
      }
      Orders._pozRow.status_poz_zd = status;
      toast('Статус позиции: ' + status, 'success');
      // ✅ Статус заказа мог измениться: согласованы ВСЕ позиции -> «Согласовано»
      // (или откат, если позиция ушла из «согласовано»)
      if (r.statysChanged && Orders._zakazRow && r.statys_zd !== Orders._zakazRow.statys_zd) {
        Orders._zakazRow.statys_zd = r.statys_zd;
        Orders.renderSteps();            // синхронизирует поле «Статус заказа» и бейджи
        await Orders.load();             // колонка «Статус» в списке заказов
        state.tables.zakaz.selectById(Orders._zakazRow.id);
        toast('Статус заказа: ' + r.statys_zd, 'warning');
      }
      await Orders.loadPositions(Orders._selectedZakazId);
      // ✅ T34: кэш выбранной позиции мог быть сброшен/обновлён параллельным
      // автообновлением (WS -> _autoRefreshForm -> onSelectPozicia) —
      // восстанавливаем по свежим данным; подсветка только при наличии строки.
      if (Orders._selectedPozId != null) {
        Orders._pozRow = state.tables.pozicii.data.find(p => p.id === Orders._selectedPozId) || null;
      }
      if (Orders._pozRow) {
        state.tables.pozicii.selectById(Orders._pozRow.id);
        Orders.updatePozStatusBlock();
      }
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  },

  // ========================================================================
  // РЕД. ДОГОВОРА (модальное окно, PUT /api/dogovor полными данными)
  // ========================================================================
  openDogovorModal() {
    if (!Orders._zakazRow || !Orders._zakazRow.id_dogovora) {
      toast('Выберите заказ с договором', 'warning');
      return;
    }
    const d = Orders._allDogovory.find(x => x.id_dogovor === Orders._zakazRow.id_dogovora);
    if (!d) { toast('Договор не найден в справочнике', 'error'); return; }
    Orders._editDogovorRow = d;
    document.getElementById('dgNom').value = d.nom_dogovor || '';
    document.getElementById('dgData').value = Orders.toDateOnly(d.data_dogovor);
    document.getElementById('dogovorModal').classList.remove('hidden');
  },

  closeDogovorModal() {
    document.getElementById('dogovorModal').classList.add('hidden');
    Orders._editDogovorRow = null;
  },

  toDateOnly(v) {
    if (!v) return '';
    const s = String(v).trim();
    let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    return '';
  },

  async saveDogovor() {
    const d = Orders._editDogovorRow;
    if (!d) return;
    const payload = Object.assign({}, d, {
      nom_dogovor: document.getElementById('dgNom').value.trim(),
      data_dogovor: document.getElementById('dgData').value
    });
    try {
      const r = await api('PUT', `/api/dogovor/${d.id_dogovor}`, payload);
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      toast('Договор сохранён', 'success');
      Orders.closeDogovorModal();
      await Orders.reloadDogovory();
      await Orders.reloadCurrentZakaz();
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  },

  // ===== Выбор заказа =====
  async onSelectZakaz(row) {
    // ✅ T34: перезаполнение формы для УЖЕ выбранного заказа — это
    // автообновление данных (_autoRefreshForm после setData / WS-синхронизация),
    // а НЕ выбор пользователя. Раньше здесь безусловно сбрасывались
    // _selectedPozId/_pozRow: при смене статуса ПОСЛЕДНЕЙ позиции заказа
    // (statysChanged -> Orders.load() -> setData -> rAF -> onSelectZakaz)
    // это обнуляло _pozRow между await'ами savePozStatus, и завершающая
    // state.tables.pozicii.selectById(Orders._pozRow.id) падала
    // «Cannot read properties of null (reading 'id')» (тост «Ошибка»,
    // консоль браузера чистая — исключение перехвачено).
    if (Orders._selectedZakazId != null && Orders._zakazRow && row && row.id === Orders._selectedZakazId) {
      Orders._zakazRow = row;          // свежая строка (статус/даты шагов)
      document.getElementById('zNomer').value = row.nomer_zakaza || '';
      document.getElementById('zData').value = row.data_zakaza || '';
      // ✅ T36: договоры только фирмы этого заказа
      Orders._fillZDogovor(row.id_firmy, row.id_dogovora || '');
      document.getElementById('zStatys').value = row.statys_zd || '';
      document.getElementById('zDataEmail').textContent = row.data_email_firma || 'не отправлялось';
      document.getElementById('zDataOtv').textContent = row.data_otv_firma || 'не согласовано';
      document.getElementById('zEmail').textContent = row.email_otpravki || 'не отправлено';
      Orders.renderSteps();
      Orders.updatePozStatusBlock();   // выбранная позиция СОХРАНЕНА
      Orders.updateButtonStates();
      return;
    }
    Orders._selectedZakazId = row.id;
    Orders._selectedPozId = null;
    Orders._zakazRow = row;
    Orders._pozRow = null;

    // Заполняем форму
    document.getElementById('zNomer').value = row.nomer_zakaza || '';
    document.getElementById('zData').value = row.data_zakaza || '';
    // ✅ T36: договоры только фирмы этого заказа
    Orders._fillZDogovor(row.id_firmy, row.id_dogovora || '');
    document.getElementById('zStatys').value = row.statys_zd || '';
    document.getElementById('zDataEmail').textContent = row.data_email_firma || 'не отправлялось';
    document.getElementById('zDataOtv').textContent = row.data_otv_firma || 'не согласовано';
    document.getElementById('zEmail').textContent = row.email_otpravki || 'не отправлено';

    // Загружаем позиции, доступные позиции, контакты и рендерим шаги
    await Orders.loadPositions(row.id);
    await Orders.loadAvailablePositions(row.id, row);
    await Orders.loadKontList(row);
    Orders.renderSteps();
    Orders.updatePozStatusBlock();

    Orders.updateButtonStates();
  },

  // ✅ T20 Список email для шага 1: СВОЙ адрес жёстко (метка «себе»)
  // + активные контакты контрагента; значение поля = список через «;»
  OWN_EMAIL: 'Igor.chesnokov@vaz.ru',
  _emailOptions: [],
  _renderEmailList: null,

  async loadKontList(zakazRow) {
    const input = document.getElementById('st1Email');
    input.value = '';
    // ✅ T21: при инициализации/обновлении селекта список ВСЕГДА свёрнут —
    // раскрывается только кликом по полю или по кнопке ▾
    const lst = document.getElementById('st1EmailList');
    if (lst) lst.hidden = true;
    Orders._emailOptions = [{ email: Orders.OWN_EMAIL, extra: 'себе' }];
    if (!zakazRow || !zakazRow.id_firmy) return;
    try {
      const konts = await api('GET', `/api/kont?id_firmy=${encodeURIComponent(zakazRow.id_firmy)}&aktivnost=1&withEmail=1`);
      (konts || []).forEach(k => {
        const em = String(k.email || '').trim();
        if (!em) return;
        if (em.toLowerCase() === Orders.OWN_EMAIL.toLowerCase()) return;   // свой адрес уже в списке
        if (Orders._emailOptions.some(o => o.email.toLowerCase() === em.toLowerCase())) return;
        Orders._emailOptions.push({ email: em, extra: '' });
      });
      if (zakazRow.email_otpravki) input.value = zakazRow.email_otpravki;   // ранее отправленный список через «;»
    } catch (e) {
      console.warn('[Orders] kont list:', e.message);
    }
  },


  // ✅ T20 Комбобокс «Email» шага 1: МНОЖЕСТВЕННЫЙ выбор — клик по пункту
  // добавляет адрес через «;», повторный клик по добавленному убирает его;
  // свободный ввод любых адресов через «;»; фильтр списка — по вводимому
  // фрагменту (текст после последней «;»); Esc/Enter/клик мимо — закрыть.
  initEmailCombo() {
    const input = document.getElementById('st1Email');
    const list = document.getElementById('st1EmailList');
    const toggle = document.getElementById('st1EmailToggle');
    if (!input || !list) return;
    // ✅ T21: кнопка развернуть/свернуть — как у стандартного селекта;
    // список скрыт по умолчанию, открывается кликом по полю или по ▾
    const setArrow = () => { if (toggle) toggle.textContent = list.hidden ? '▾' : '▴'; };
    const close = () => { list.hidden = true; setArrow(); };
    if (toggle) {
      toggle.addEventListener('mousedown', e => e.preventDefault());
      toggle.addEventListener('click', () => {
        if (list.hidden) { Orders._renderEmailList(); if (!list.hidden) input.focus(); }
        else close();
      });
    }
    Orders._renderEmailList = () => {
      if (!Orders._emailOptions.length) { close(); return; }
      // ✅ T20FIX: фильтр по вводимому фрагменту (текст после последней «;»);
      // если фрагмент — УЖЕ ГОТОВЫЙ адрес из списка (только что выбрали кликом
      // или ввели целиком), фильтр сбрасывается — иначе выбранный адрес
      // фильтрует сам себя и остальные пункты списка исчезают
      const frag = String(input.value || '').split(';').pop().trim();
      const isExact = Orders._emailOptions.some(o => o.email.toLowerCase() === frag.toLowerCase());
      const typed = isExact ? '' : frag.toLowerCase();
      const chosen = Orders._emailTokens(input);
      const items = Orders._emailOptions.filter(o =>
        !typed || o.email.toLowerCase().includes(typed) || String(o.extra || '').toLowerCase().includes(typed));
      if (!items.length) {
        list.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'combo-empty';
        div.textContent = 'адрес не найден — он будет введён вручную';
        list.appendChild(div);
        list.hidden = false; setArrow();
        return;
      }
      list.innerHTML = '';
      items.forEach(o => {
        const isSel = chosen.some(c => c === o.email.toLowerCase());
        const div = document.createElement('div');
        div.className = 'combo-item' + (isSel ? ' selected' : '');
        const mark = document.createElement('span');
        mark.className = 'em-mark';
        mark.textContent = isSel ? '✓' : '';
        const em = document.createElement('span');
        em.textContent = o.email;
        div.appendChild(mark); div.appendChild(em);
        if (o.extra) {
          const ex = document.createElement('span');
          ex.className = 'em-extra';
          ex.textContent = o.extra;
          div.appendChild(ex);
        }
        div.addEventListener('mousedown', (e) => {
          e.preventDefault();                 // раньше blur — фокус остаётся в поле
          Orders._toggleEmailToken(o.email);
        });
        list.appendChild(div);
      });
      list.hidden = false; setArrow();
    };
    input.addEventListener('focus', Orders._renderEmailList);
    input.addEventListener('input', Orders._renderEmailList);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { close(); if (e.key === 'Enter') e.preventDefault(); }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#st1EmailCombo')) close();
    });
  },

  // ✅ T20 Текущие адреса поля (нижний регистр, без пустых)
  _emailTokens(input) {
    return String(input.value || '').split(';')
      .map(s => s.trim().toLowerCase()).filter(Boolean);
  },

  // ✅ T20 Клик по пункту: адрес есть — убрать, нет — дописать через «;»
  _toggleEmailToken(email) {
    const input = document.getElementById('st1Email');
    const key = String(email).toLowerCase();
    const parts = String(input.value || '').split(';').map(s => s.trim()).filter(Boolean);
    const kept = [];
    let removed = false;
    for (const p of parts) {
      if (p.toLowerCase() === key) { removed = true; continue; }
      kept.push(p);
    }
    if (!removed) kept.push(String(email).trim());
    input.value = kept.join(';');
    if (Orders._renderEmailList) Orders._renderEmailList();
  },
  // ===== Выбор позиции =====
  onSelectPozicia(row) {
    Orders._selectedPozId = row ? row.id : null;
    Orders._pozRow = row || null;
    Orders.updatePozStatusBlock();
    Orders.updateButtonStates();
  },

  // ===== Клик по заголовку таблицы заказов =====
  onHeaderClick() {
    Orders._selectedZakazId = null;
    Orders._selectedPozId = null;
    Orders._zakazRow = null;
    Orders._pozRow = null;
    Orders.clearForm();
    state.tables.pozicii.setData([]);
    state.tables.available.setData([]);
    Orders.updateButtonStates();
    Orders.updatePozStatusBlock();
    // ✅ T36: заказ снят — возвращаем полный список договоров
    Orders._fillZDogovor(null, '');
    Orders.renderSteps();
    // Перезагружаем доступные позиции с учётом текущих фильтров
    Orders.loadAvailablePositions(null);
  },

  // ===== Клик по заголовку таблицы позиций =====
  onHeaderClickPozicii() {
    Orders._selectedPozId = null;
    Orders._pozRow = null;
    Orders.updatePozStatusBlock();
    Orders.updateButtonStates();
  },

  // ✅ T36: селект «Договор» в форме заказа показывает договоры ТОЛЬКО фирмы
  // выбранного заказа (row.id_firmy приходит из orders.zakazy: JOIN dogovor->firmy).
  // Без фирмы (ничего не выбрано) — полный список, как раньше.
  // Защита: если текущий договор заказа не попал в отфильтрованный список
  // (рассинхрон кэша) — опция всё равно добавляется, значение не теряется.
  // Список перестраивается только при СМЕНЕ фирмы (_zDogovorFirmKey),
  // поэтому WS-автообновления заказа не дёргают DOM лишний раз (урок T34).
  _fillZDogovor(idFirmy, currentValue) {
    const zDogovor = document.getElementById('zDogovor');
    if (!zDogovor) return;
    const key = String(idFirmy || '');
    const all = Orders._allDogovory || [];
    const curKey = Orders._zDogovorFirmKey;
    const hasValue = !currentValue ||
      Array.from(zDogovor.options).some(o => o.value === String(currentValue));
    if (curKey !== key || !hasValue) {
      const list = idFirmy ? all.filter(d => String(d.id_firmy) === key) : all;
      zDogovor.innerHTML = '<option value="">— Выберите договор —</option>';
      list.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id_dogovor;
        opt.textContent = `${d.nom_dogovor} от ${d.data_dogovor}`;
        zDogovor.appendChild(opt);
      });
      if (currentValue && !list.some(d => String(d.id_dogovor) === String(currentValue))) {
        const d = all.find(x => String(x.id_dogovor) === String(currentValue));
        if (d) {
          const opt = document.createElement('option');
          opt.value = d.id_dogovor;
          opt.textContent = `${d.nom_dogovor} от ${d.data_dogovor}`;
          zDogovor.appendChild(opt);
        }
      }
      Orders._zDogovorFirmKey = key;
    }
    zDogovor.value = currentValue || '';
  },

// ===== Перезагрузка списка договоров (для комбоксов) =====
async reloadDogovory() {
  Orders._allDogovory = await api('GET', '/api/dogovor');

  const fltDogovor = document.getElementById('fltDogovor');
  if (fltDogovor) {
    // ✅ T99: список договоров фильтра учитывает выбранную фирму
    const fltFirma = document.getElementById('fltFirma');
    Orders._fltDogovorRender(fltFirma ? fltFirma.value : '', fltDogovor.value);
  }

  const zDogovor = document.getElementById('zDogovor');
  if (zDogovor) {
    const currentZValue = zDogovor.value;
    // ✅ T36: свежие данные + фирма выбранного заказа (сбрасываем кэш фирмы,
    // чтобы список гарантированно перестроился с новыми номерами/датами)
    Orders._zDogovorFirmKey = null;
    Orders._fillZDogovor(Orders._zakazRow ? (Orders._zakazRow.id_firmy || null) : null, currentZValue);
  }

  console.log('[Orders] Комбоксы договоров обновлены');
},
  // ===== Очистка формы =====
  clearForm() {
    ['zNomer', 'zData', 'zDogovor', 'zStatys'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('zDataEmail').textContent = 'не отправлялось';
    document.getElementById('zDataOtv').textContent = 'не согласовано';
    document.getElementById('zEmail').textContent = 'не отправлено';
  },

  // ===== Обновление кнопки добавления позиции =====
  updateAddButton() {
    const count = state.tables.available.getSelectedCount();
    const btn = document.getElementById('btnAddPosition');
    btn.disabled = count === 0;
    btn.textContent = count > 0 ? `➕ Добавить (${count})` : '➕ Добавить';
  },

  // ===== Обновление состояния кнопок =====
  updateButtonStates() {
    const hasSelection = Orders._selectedZakazId !== null;
    const hasPozSelection = Orders._selectedPozId !== null;
    const locker = hasSelection ? isLocked('zakaz_po_dogovoru', Orders._selectedZakazId) : null;
    const statys = document.getElementById('zStatys').value;

    // Кнопки заказа
    document.getElementById('btnZakazAdd').disabled = true;
    document.getElementById('btnZakazSave').disabled = !hasSelection || !!locker;
    document.getElementById('btnZakazDel').disabled = !hasSelection || !!locker || statys !== '';

    document.getElementById('btnPrintExcel').disabled = !hasSelection;

    // Кнопки позиций
    const btnAddPosition = document.getElementById('btnAddPosition');
    const btnDelPosition = document.getElementById('btnDelPosition');

    if (btnAddPosition) {
      const availCount = state.tables.available.getSelectedCount();
      btnAddPosition.disabled = !hasSelection || availCount === 0 || statys !== '';
    }

    if (btnDelPosition) {
      btnDelPosition.disabled = !hasSelection || !hasPozSelection || statys !== '';
    }
  },

  // ===== Создание заказа =====
  async add() {
    const payload = {
      id_dogovora: document.getElementById('zDogovor').value,
      nomer_zakaza: document.getElementById('zNomer').value,
      data_zakaza: document.getElementById('zData').value,
      statys_zd: ''
    };

    if (!payload.id_dogovora || !payload.nomer_zakaza) {
      toast('Заполните обязательные поля: договор, номер заказа', 'warning');
      return;
    }

    await batchManager.withBatch('zakaz_po_dogovoru', async () => {
      const r = await api('POST', '/api/orders', payload);
      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        return;
      }

      toast('Заказ создан');
      await Orders.load();
      state.tables.zakaz.selectById(r.id);
      const row = state.tables.zakaz.data.find(z => z.id === r.id);
      if (row) Orders.onSelectZakaz(row);
    });
  },

  // ===== Сохранение заказа =====
  async save() {
    if (!Orders._selectedZakazId) return;

    const payload = {
      nomer_zakaza: document.getElementById('zNomer').value,
      data_zakaza: document.getElementById('zData').value
      // ✅ T51: n_sogl_avtovaz больше не поле заказа (перенесено в zapros_kp)
      // statys_zd НЕ шлём — статус заказа устанавливается автоматически по шагам
    };

    await batchManager.withBatch('zakaz_po_dogovoru', async () => {
      const r = await api('PUT', `/api/orders/${Orders._selectedZakazId}`, payload);
      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        return;
      }

      toast('Заказ сохранён');
      if (EditLock.current && EditLock.current.id === Orders._selectedZakazId) {
        EditLock.release();
      }
      await Orders.load();
      state.tables.zakaz.selectById(Orders._selectedZakazId);
    });
  },

  // ===== Удаление заказа =====
  async del() {
    if (!Orders._selectedZakazId) return;

    const row = state.tables.zakaz.data.find(z => z.id === Orders._selectedZakazId);
    if (!confirm(`Удалить заказ №${row?.nomer_zakaza}?`)) return;

    await batchManager.withBatch('zakaz_po_dogovoru', async () => {
      if (EditLock.current && EditLock.current.id === Orders._selectedZakazId) {
        EditLock.release();
      }

      const r = await api('DELETE', `/api/orders/${Orders._selectedZakazId}`);
      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        return;
      }

      toast('Заказ удалён', 'warning');
      await Orders.load();
      Orders.onHeaderClick();
    });
  },

  // ===== Добавление позиции в заказ =====
  async addPosition() {
    if (!Orders._selectedZakazId) {
      toast('Выберите заказ', 'warning');
      return;
    }

    const selectedIds = state.tables.available.getSelectedIds();
    if (selectedIds.length === 0) {
      toast('Выберите позиции для добавления', 'warning');
      return;
    }

    await batchManager.withBatch('poz_zakaz_dogovora', async () => {
      // ✅ T33: считаем РЕАЛЬНО добавленные позиции и ошибки сервера,
      // чтобы итоговый тост не показывал ложный успех и не затирал
      // предупреждение сервера (toast — единственный DOM-элемент).
      let okCount = 0;
      const errors = [];
      for (const idPlana of selectedIds) {
        const pos = state.tables.available.data.find(p => p.id === idPlana);
        if (!pos) continue;

        const r = await api('POST', '/api/orders/position', {
          id_zakaza_po_dogovoru: Orders._selectedZakazId,
          id_plana: pos.id,
          id_kp: pos.id_kp
        });

        if (r.error) {
          errors.push(r.error);
          continue;
        }
        okCount++;
      }

      // ✅ T33: честный итог — успех / частичный успех / ошибка сервера.
      if (errors.length > 0) {
        const uniq = [...new Set(errors)];
        let msg = uniq[0];
        if (uniq.length > 1) msg += ` (и ещё ошибок: ${uniq.length - 1})`;
        if (okCount === 0) toast('Ошибка: ' + msg, 'error');
        else toast(`Добавлено позиций: ${okCount}, с ошибками: ${errors.length} — ${msg}`, 'warning');
      } else {
        toast(`Добавлено позиций: ${okCount}`);
      }
      await Orders.loadPositions(Orders._selectedZakazId);
      await Orders.loadAvailablePositions(Orders._selectedZakazId);
      state.tables.available.clearSelection();
    });
  },

  // ===== Удаление позиции из заказа =====
  async delPosition() {
    const selectedIds = state.tables.pozicii.getSelectedIds();
    if (selectedIds.length === 0) {
      toast('Выберите позиции для удаления', 'warning');
      return;
    }

    if (!confirm(`Удалить ${selectedIds.length} позиций?`)) return;

    await batchManager.withBatch('poz_zakaz_dogovora', async () => {
      // ✅ T33: считаем РЕАЛЬНО удалённые позиции и ошибки сервера
      // (аналогично addPosition — итоговый тост не затирает ошибку).
      let okCount = 0;
      const errors = [];
      for (const id of selectedIds) {
        const r = await api('DELETE', `/api/orders/position/${id}`);
        if (r.error) {
          errors.push(r.error);
          continue;
        }
        okCount++;
      }

      // ✅ T33: честный итог — успех / частичный успех / ошибка сервера.
      if (errors.length > 0) {
        const uniq = [...new Set(errors)];
        let msg = uniq[0];
        if (uniq.length > 1) msg += ` (и ещё ошибок: ${uniq.length - 1})`;
        if (okCount === 0) toast('Ошибка: ' + msg, 'error');
        else toast(`Удалено позиций: ${okCount}, с ошибками: ${errors.length} — ${msg}`, 'warning');
      } else {
        toast(`Удалено позиций: ${okCount}`);
      }
      Orders._selectedPozId = null;
      Orders._pozRow = null;
      await Orders.loadPositions(Orders._selectedZakazId);
      await Orders.loadAvailablePositions(Orders._selectedZakazId);
      Orders.updatePozStatusBlock();
    });
  },

  // ===== Печать Excel =====
  // ✅ T98: сначала предпросмотр (Excel → HTML, showExcelPreview), скачивание —
  // только по подтверждению пользователя. Работает для всех кнопок печати
  // заказа: btnPrintExcel (шапка), st2Print (шаг 2), st4Print (шаг 3).
  async printExcel() {
    if (!Orders._selectedZakazId) {
      toast('Выберите заказ', 'warning');
      return;
    }

    try {
      toast('Генерация Excel...', 'warning');
      const r = await api('POST', '/api/orders/generate-excel', {
        zakazId: Orders._selectedZakazId
      });

      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        return;
      }

      // ✅ T98: предпросмотр перед скачиванием
      if (r.preview) {
        const confirmed = await showExcelPreview(
          { zakaz: r.preview },
          { zakaz: { label: `📄 Заказ ${r.fileName || ''}`.trim() } },
          {
            title: '🖨 Предпросмотр заказа перед печатью',
            confirmText: '⬇ Скачать Excel',
            cancelText: '✖ Отмена',
            downloadUrl: r.relativePath,
            downloadName: r.fileName || 'zakaz.xlsx'
          }
        );
        if (!confirmed) {
          toast('Печать отменена пользователем', 'warning');
          return;
        }
      }

      window.open(r.relativePath, '_blank');
      toast('Excel сформирован', 'success');
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  },

// ===== Шаг 1: Отправка письма контрагенту =====
// ✅ T98: вместо confirm() «вслепую» — окно предпросмотра письма: кому
// отправляем (включая копии), тема, текст письма и вложение (сам заказ).
// Текст/адреса берутся с сервера (POST /api/orders/email-preview — тот же
// конструктор, что у реальной отправки), вложение — существующий
// Excel→HTML предпросмотр (showExcelPreview). Отправка — только по явному
// подтверждению пользователя.
async sendEmail() {
    if (!Orders._selectedZakazId || !Orders._zakazRow) {
        toast('Выберите заказ', 'warning');
        return;
    }
    // Повторная отправка после получения решения блокируется на сервере,
    // здесь только мягкое предупреждение
    if (Orders._zakazRow.data_otv_firma) {
        toast('Решение контрагента уже получено — повторная отправка не требуется', 'warning');
        return;
    }
    // ✅ T20: несколько адресов через «;» (свободный ввод тоже разрешён)
    const emailRaw = document.getElementById('st1Email').value;
    const emailList = emailRaw.split(/[;,\s]+/).map(s => s.trim()).filter(Boolean);
    if (!emailList.length) {
        toast('Выберите email контрагента', 'warning');
        return;
    }
    const badEmails = emailList.filter(s => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
    if (badEmails.length) {
        toast('Некорректный адрес: ' + badEmails.join(', '), 'error');
        return;
    }
    const email = emailList.join(';');
    document.getElementById('st1Email').value = email;

    try {
        // 1. Генерация Excel + HTML-превью вложения
        toast('Генерация Excel...', 'warning');
        const excelResult = await api('POST', '/api/orders/generate-excel', {
            zakazId: Orders._selectedZakazId
        });
        if (excelResult.error) {
            toast('Ошибка генерации Excel: ' + excelResult.error, 'error');
            return;
        }

        // 2. ✅ T98: предпросмотр письма с сервера (без отправки). Если endpoint
        // недоступен (сервер без T98) — запасной путь со старым confirm().
        let emailPrev = null;
        let editedBody = null;   // ✅ T100: отредактированный в предпросмотре текст письма
        try {
            emailPrev = await api('POST', '/api/orders/email-preview', {
                zakazId: Orders._selectedZakazId,
                email: email
            });
            if (emailPrev && emailPrev.error) emailPrev = null;
        } catch (_) { /* сервер без T98 — фолбэк ниже */ }

        if (emailPrev && emailPrev.subject) {
            // Окно предпросмотра: вкладка «✉ Письмо» (кому/копии/тема/текст)
            // + вкладка «📄 Вложение» (заказ в Excel → HTML)
            const previews = {
                email: Orders.buildEmailPreviewHtml(emailPrev, excelResult.fileName || 'заказ.xlsx')
            };
            const tabs = { email: { label: '✉ Письмо' } };
            if (excelResult.preview) {
                previews.zakaz = excelResult.preview;
                tabs.zakaz = { label: `📄 Вложение — ${excelResult.fileName || 'заказ (Excel)'}` };
            }
            const confirmed = await showExcelPreview(
                previews, tabs,
                {
                    title: '✉ Отправка заказа на согласование — предпросмотр письма',
                    confirmText: '✅ Отправить письмо',
                    cancelText: '✖ Отменить отправку'
                }
            );
            if (!confirmed) {
                toast('Отправка отменена пользователем', 'warning');
                return;
            }
            // ✅ T100: (возможно отредактированный) текст письма из вкладки
            // «✉ Письмо» — модалка возвращает emailBodies, собранные ДО
            // удаления DOM; ключ вкладки письма — 'email'
            editedBody = (confirmed && confirmed.emailBodies && confirmed.emailBodies.email) || null;
        } else {
            // Запасной путь (endpoint предпросмотра недоступен) — прежнее поведение
            if (!confirm(`Отправить письмо на:\n${emailList.join('\n')}\n(адресов: ${emailList.length})`)) return;
            if (excelResult.preview) {
                const okPreview = await showExcelPreview(
                    { zakaz: excelResult.preview },
                    { zakaz: { label: '📄 Заказ к договору' } }
                );
                if (!okPreview) {
                    toast('Отправка отменена пользователем', 'warning');
                    return;
                }
            }
        }

        // 3. Отправка письма (email из селекта шага 1)
        toast('Отправка письма...', 'warning');
        const r = await api('POST', '/api/orders/send-email', Object.assign({
            zakazId: Orders._selectedZakazId,
            excelPath: excelResult.path,
            email: email
        }, editedBody ? { body: editedBody } : {}));   // ✅ T100: отредактированный текст письма
        if (r.error) {
            toast('Ошибка: ' + r.error, 'error');
            return;
        }

        toast('Письмо отправлено', 'success');
        await Orders.reloadCurrentZakaz();
        await Orders.loadPositions(Orders._selectedZakazId);
    } catch (e) {
        toast('Ошибка: ' + e.message, 'error');
    }
},

// ===== ✅ T98/T100: HTML предпросмотра письма (вкладка «✉ Письмо») =====
// ✅ T100: рендер переехал в общий модуль excel-preview.js (используется
// также requests.js — рассылка запросов ТКП) и умеет редактировать текст
// письма (кнопка «✏ Редактировать текст» в предпросмотре).
buildEmailPreviewHtml(p, attachName) {
    return buildEmailDocHtml(p, attachName);
},

  // ===== Массовое создание заказов по лучшим КП =====
  async generateOrders() {
    const god = document.getElementById('fltGod').value;

    if (!confirm(`Сформировать заказы по лучшим КП за ${god} год?`)) return;

    try {
      const r = await api('POST', '/api/orders/generate', { god });
      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        return;
      }

      toast(r.message, 'success');
      await Orders.load();
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  }
};
