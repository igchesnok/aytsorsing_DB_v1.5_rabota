// ============================================================
// js/modules/transportOpsParams.js ВКЛАДКА: ПАРАМЕТРЫ ПЕРЕВОЗКИ
// С АВТООБНОВЛЕНИЕМ через WebSocket
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
// ✅ T57: модальный диалог «Расчёт тарных мест»
import { TransportOpsTarn } from './transportOpsTarn.js';
// ✅ T57-d: виртуальная таблица «Тарные места перевозки» (общий класс проекта)
import { VirtualTable } from '../common/virtual-table.js';

export const TransportOpsParams = {
  _allCex: [],
  _coordinator: null,

  setCoordinator(coordinator) {
    this._coordinator = coordinator;
  },
  async init() {
    // ✅ T57: общие габариты/объём/кол-во мест из вкладки УДАЛЕНЫ —
    // тарные места живут в модальном диалоге и таблице «Тарные места перевозки»
    // Кнопки
    document.getElementById('btnAutoFill').onclick = () => TransportOpsParams.autoFill();
    document.getElementById('btnCalcPallets').onclick = () => TransportOpsTarn.open();

    // ✅ ЗАТРАТЫ (VBA cbShPZ_Change): Сч/Б — параллельный список к ШПЗ,
    // назначается по индексу выбранного ШПЗ
    document.getElementById('toShPZ').addEventListener('change', () => {
      const i = document.getElementById('toShPZ').selectedIndex;
      const sb = document.getElementById('toSB');
      if (i === -1) sb.value = ''; else sb.selectedIndex = i;
    });

    // ✅ ЗАТРАТЫ (VBA txtCexIzgot_Change): Передел автоназначается по цеху
    document.getElementById('toCexIzgot').addEventListener('input', () => {
      TransportOpsParams.autoPeredel();
    });

    // ✅ ПЕРВИЧНАЯ ЗАГРУЗКА СПРАВОЧНИКОВ ЗАТРАТ (ШПЗ/СБ/Передел/Цех)
    await TransportOpsParams.loadCex();

    // ✅ ТИПЫ ГРУЗА: комбо «Наименование» (история + фильтр по содержимому)
    TransportOpsParams.initGruzNameCombo();
    await TransportOpsParams.loadGruzNames();

    // ✅ T18 ПАРАМЕТРЫ: комбобоксы «Тип транспорта»/«Способ загрузки»/
    // «Требование» (VBA cbTransportTip/cbZagruzkaSposob/cbListKomment)
    // + конструктор комментария (кнопки Добавить/Удалить выбранное)
    TransportOpsParams.initSelectCombo('toTransportTip', 'toTransportTipList', 'toTransportTipCombo', () => TransportOpsParams._mergedTips);
    TransportOpsParams.initSelectCombo('toZagruzkaSposob', 'toZagruzkaSposobList', 'toZagruzkaSposobCombo', () => TransportOpsParams._mergedSposoby);
    TransportOpsParams.initSelectCombo('toListKomment', 'toListKommentList', 'toListKommentCombo', () => TransportOpsParams._mergedKomments);
    document.getElementById('btnAddTreb').onclick = () => TransportOpsParams.addTreb();
    document.getElementById('btnDelTreb').onclick = () => TransportOpsParams.delTreb();
    await TransportOpsParams.loadSelectLists();
  },
  
  // ===== ✅ Загрузка справочников затрат (ШПЗ/СБ/Передел/Цех) =====
  async loadCex() {
    try {
      const z = await api('GET', '/api/transport-oper/zatrat-lists');
      TransportOpsParams._allCex = Array.isArray(z.ceh) ? z.ceh : [];
      TransportOpsParams._shpzSb = Array.isArray(z.shpz_sb) ? z.shpz_sb : [];
      TransportOpsParams._peredel = Array.isArray(z.peredel) ? z.peredel : [];
      TransportOpsParams.fillCexSelects();
      console.log('[TransportOpsParams] 🔄 Справочники затрат обновлены: цехов', TransportOpsParams._allCex.length);
    } catch (e) {
      console.error('[TransportOpsParams.loadCex] Error:', e);
    }
  },
  
  // ===== ✅ НОВОЕ: Публичный метод перезагрузки (для WS) =====
  async reloadCex() {
    console.log('[TransportOpsParams]  WS: перезагрузка цехов');
    await TransportOpsParams.loadCex();
  },
  
  // ===== Заполнение селектов затрат (VBA: ШПЗ и СБ — параллельные списки) =====
  fillCexSelects() {
    const selShPZ = document.getElementById('toShPZ');
    const selPeredel = document.getElementById('toPeredel');
    const selSB = document.getElementById('toSB');

    selShPZ.innerHTML = '<option value="">—</option>';
    selPeredel.innerHTML = '<option value="">—</option>';
    selSB.innerHTML = '<option value="">—</option>';

    TransportOpsParams._shpzSb.forEach(x => {
      const o1 = document.createElement('option');
      o1.value = x.shpz; o1.textContent = x.shpz;
      selShPZ.appendChild(o1);
      const o2 = document.createElement('option');
      o2.value = x.sb; o2.textContent = x.sb;
      selSB.appendChild(o2);
    });

    TransportOpsParams._peredel.forEach(p => {
      const o = document.createElement('option');
      o.value = p; o.textContent = p;
      selPeredel.appendChild(o);
    });
  },

  // ===== ✅ Передел по цеху-изготовителю (VBA txtCexIzgot_Change) =====
  // Основной источник — таблица cex_zatrat (ceh -> peredel); при её
  // неполноте — запасная карта соответствий из VBA-кода формы.
  autoPeredel() {
    const ceh = document.getElementById('toCexIzgot').value.trim().toUpperCase();
    const map = {
      '1F110': '1F01Z', '1F120': '1F06Z',
      '1F210': '1F02Z', '1F220': '1F02Z',
      '1F310': '1F03Z', '1F311': '1F03Z', '1F312': '1F03Z', '1F313': '1F03Z', '1F314': '1F03Z',
      '1F320': '1F04Z', '1F321': '1F04Z', '1F322': '1F04Z', '1F323': '1F04Z', '1F324': '1F04Z'
    };
    const fromTable = TransportOpsParams._allCex.find(c => String(c.ceh || '').toUpperCase() === ceh);
    const peredel = (fromTable && fromTable.peredel) || map[ceh] || '';
    document.getElementById('toPeredel').value = peredel;
  },
  
  // ===== Заполнение формы из строки =====
  fillFromRow(row) {
    document.getElementById('toOtruzkaData').value = row.otgruzka_data || '';
    document.getElementById('toOtruzkaVremya').value = row.otgruzka_vremya || '';
    document.getElementById('toPribytieData').value = row.pribytie_data || '';
    document.getElementById('toPribytieVremya').value = row.pribytie_vremya || '';
    document.getElementById('toGruzName').value = row.gruz_name || '';
    document.getElementById('toOpasnostClass').value = row.opasnost_class || '';
    // ✅ T57: тарные места перевозки (группы из модального расчёта)
    TransportOpsParams._currentTarnMesta = row.tarn_mesta || '';
    TransportOpsParams.renderTarnTable(row.tarn_mesta);
    document.getElementById('toNomerReisa').value = row.nomer_reisa || '';
    document.getElementById('toTransportTip').value = row.transport_tip || '';
    document.getElementById('toZagruzkaSposob').value = row.zagruzka_sposob || '';
    document.getElementById('toTempRezhim').value = row.temp_rezhim || '';
    document.getElementById('toTnOformlenie').value = row.tn_oformlenie || '';
    document.getElementById('toKommentariy').value = row.kommentariy || '';
    document.getElementById('toPlatelshchik').value = row.platelshchik || '';
    document.getElementById('toStoimostPerovozki').value = row.stoimost_perovozki || '';
    document.getElementById('toCexIzgot').value = row.cex_izgot || '';
    // ✅ ЗАТРАТЫ (VBA): обратная сборка zatrataPrisvoenie = ШПЗ;Передел;СБ
    const zParts = String(row.zatrata_prisvoenie || '').split(';');
    const setSel = (id, v) => {
      const sel = document.getElementById(id);
      const val = String(v || '').trim();
      sel.value = Array.from(sel.options).some(o => o.value === val) ? val : '';
    };
    setSel('toShPZ', zParts[0]);
    setSel('toPeredel', zParts[1]);
    setSel('toSB', zParts[2]);
  },
  
  // ===== Очистка формы =====
  clearForm() {
    TransportOpsParams._currentTarnMesta = '';
    TransportOpsParams.renderTarnTable('');
    [
      'toOtruzkaData', 'toOtruzkaVremya', 'toPribytieData', 'toPribytieVremya',
      'toGruzName', 'toOpasnostClass',
      'toNomerReisa', 'toTransportTip', 'toZagruzkaSposob', 'toTempRezhim',
      'toTnOformlenie', 'toKommentariy', 'toListKomment', 'toPlatelshchik', 'toStoimostPerovozki',
      'toCexIzgot'
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    
    ['toShPZ', 'toPeredel', 'toSB', 'toTnOformlenie', 'toVidGruza']
      .forEach(id => {
        const el = document.getElementById(id);
        if (el) el.selectedIndex = 0;
      });
  },
  
  // ===== Получение данных для payload =====
  getPayload() {
    return {
      otgruzka_data: document.getElementById('toOtruzkaData').value,
      otgruzka_vremya: document.getElementById('toOtruzkaVremya').value,
      pribytie_data: document.getElementById('toPribytieData').value,
      pribytie_vremya: document.getElementById('toPribytieVremya').value,
      gruz_name: document.getElementById('toGruzName').value,
      opasnost_class: document.getElementById('toOpasnostClass').value,
      // ✅ T57: тарные места перевозки (JSON из модального расчёта);
      // общие поля (места/вес/габариты/объём) сервер выводит сам из групп
      tarn_mesta: TransportOpsParams._currentTarnMesta || '',
      nomer_reisa: document.getElementById('toNomerReisa').value,
      transport_tip: document.getElementById('toTransportTip').value,
      zagruzka_sposob: document.getElementById('toZagruzkaSposob').value,
      temp_rezhim: document.getElementById('toTempRezhim').value,
      tn_oformlenie: document.getElementById('toTnOformlenie').value,
      kommentariy: document.getElementById('toKommentariy').value,
      platelshchik: document.getElementById('toPlatelshchik').value,
      stoimost_perovozki: document.getElementById('toStoimostPerovozki').value,
      cex_izgot: document.getElementById('toCexIzgot').value,
      // ✅ ЗАТРАТЫ (VBA): zatrataPrisvoenie = ШПЗ;Передел;СБ
      shpz: document.getElementById('toShPZ').value,
      peredel: document.getElementById('toPeredel').value,
      sb: document.getElementById('toSB').value,
      zatrata_prisvoenie: [
        document.getElementById('toShPZ').value,
        document.getElementById('toPeredel').value,
        document.getElementById('toSB').value
      ].map(v => String(v || '').trim()).join(';')
    };
  },
  
  // ===== Автозаполнение параметров (VBA cmdAvtozapPar_Click) =====
  // Сервер считает сводку по позициям (GetTransportSummary): доминирующие
  // ШПЗ/Передел/Цех по массе, тип веса по типу перевозки первой позиции,
  // общие масса/объём + дефолты VBA (FLEX, АВТОВАЗ, Тентованный...).
  // ОБЪЁМ из позиций НЕ пересчитывается по габаритам (как в VBA —
  // RashV3 срабатывает только при ручном изменении габаритов/тарных мест).
  async autoFill() {
    const positions = state.tables.poz?.data || [];
    
    if (positions.length === 0) {
      toast('Добавьте позиции для автозаполнения', 'warning');
      return;
    }
    
    const result = await api('POST', '/api/transport-oper/auto-fill', {
      positions: positions,
      napravlenie: this._coordinator?._direction || 'Исходящая'
    });
    
    if (result.error) {
      toast('Ошибка: ' + result.error, 'error');
      return;
    }
    
    // ✅ T57: префикс наименования — по ТИПАМ ГРУЗА позиций (3 типа);
    // общий вес/объём в поля не пишем — их выводят тарные места
    let gName = result.gruz_name || '';
    const pozs = state.tables.poz?.data || [];
    const has = t => pozs.some(p => String(p.tip_gruza || '') === t);
    const GRUZ_PREFIX = {
      tara: 'Детали на деревянной таре: ',
      listy: 'Заготовки в листах: ',
      prutki: 'Заготовки в прутках: ',
      smesh: 'Смешанный груз: '
    };
    let prefixKey = 'tara';
    if (has('listy') && (has('prutki') || has('zagotovki'))) prefixKey = 'smesh';
    else if (has('listy')) prefixKey = 'listy';
    else if (has('prutki')) prefixKey = 'prutki';
    // ✅ T64 (баг 4): «Детали на поддонах» -> «Детали на деревянной таре»
    // (старое имя из сохранённых операций тоже заменяется)
    const TARA_OLD = 'Детали на поддонах: ';
    if (gName.startsWith(TARA_OLD)) {
      gName = GRUZ_PREFIX.tara + gName.slice(TARA_OLD.length);
    }
    if (gName.startsWith(GRUZ_PREFIX.tara) && prefixKey !== 'tara') {
      gName = GRUZ_PREFIX[prefixKey] + gName.slice(GRUZ_PREFIX.tara.length);
    }
    // ✅ T57-d БАГФИКС (TypeError: Cannot set properties of null): поля,
    // удалённые из вкладки T57 («Штабел. груза» и др.), не должны ронять
    // автозаполнение — установка только существующих элементов.
    const setV = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v == null ? '' : v;
    };
    setV('toGruzName', gName);
    setV('toCexIzgot', result.cex_izgot);
    setV('toNomerReisa', result.nomer_reisa);
    setV('toOpasnostClass', result.opasnost_class);
    // toShtabilGryz удалён (T57): штабелируемость — признак каждого тарного места
    setV('toTempRezhim', result.temp_rezhim);
    setV('toPlatelshchik', result.platelshchik);
    setV('toTnOformlenie', result.tn_oformlenie);
    setV('toTransportTip', result.transport_tip);
    setV('toZagruzkaSposob', result.zagruzka_sposob);

    // ✅ ЗАТРАТЫ: ШПЗ + параллельный СБ + Передел (автоназначение)
    const setSel = (id, v) => {
      const sel = document.getElementById(id);
      const val = String(v || '').trim();
      sel.value = Array.from(sel.options).some(o => o.value === val) ? val : '';
    };
    setSel('toShPZ', result.shpz);
    setSel('toPeredel', result.peredel);
    setSel('toSB', result.sb);

    setV('toKommentariy', result.kommentariy);

    if (result.no_data) {
      toast('Нет данных для автозаполнения (у позиций не определён ШПЗ)', 'warning');
    } else {
      toast('Автозаполнение выполнено (тип веса: ' + (result.ves_type || 'Деталь') + ')');
    }
  },
  
  // ===== ✅ ТИПЫ ГРУЗА: «Наименование» — редактируемый комбобокс =====
  // VBA cbGruzName: fmStyleDropDownCombo — свободный ввод НЕ заблокирован;
  // список = ранее введённые значения (из сохранённых операций); при вводе
  // список фильтруется ПО СОДЕРЖИМОМУ (подстрока, регистр не важен).
  _gruzNames: [],

  async loadGruzNames() {
    try {
      const r = await api('GET', '/api/transport-oper/gruz-names');
      TransportOpsParams._gruzNames = Array.isArray(r.names) ? r.names : [];
      console.log('[TransportOpsParams] 🔄 История «Наименование»:', TransportOpsParams._gruzNames.length);
    } catch (e) {
      console.error('[TransportOpsParams.loadGruzNames] Error:', e);
    }
  },

  initGruzNameCombo() {
    // ✅ T57-d: «Наименование» убрано с вкладки (имя тарного места — колонка
    // «Тип места» таблицы тарных мест); скрытое поле toGruzName остаётся для БД.
    if (!document.getElementById('toGruzName')) return;
    // ✅ T18: делегирование общему комбобоксу (единая логика фильтра/выбора)
    TransportOpsParams.initSelectCombo('toGruzName', 'toGruzNameList', 'toGruzNameCombo', () => TransportOpsParams._gruzNames);
  },

  // ===== ✅ T18 ПАРАМЕТРЫ ПЕРЕВОЗКИ: селекты «как VBA» =====
  // VBA cbTransportTip / cbZagruzkaSposob / cbListKomment — комбобоксы
  // (fmStyleDropDownCombo по умолчанию): свободный ввод НЕ заблокирован;
  // списки дизайнера формы невосстановимы, поэтому источник два:
  // БАЗОВЫЕ значения из кода VBA + ИСТОРИЯ сохранённых операций
  // (GET /api/transport-oper/select-lists); фильтр по содержимому.
  BASE_TRANSPORT_TIPS: [
    'Тентованный', 'Рефрижератор', 'Изотермический', 'Контейнеровоз',
    'Бортовой', 'Фургон'
  ],
  BASE_ZAGRUZKA_SPOSOBY: [
    'Задняя/Боковая', 'Задняя', 'Боковая', 'Верхняя', 'Верхняя/Боковая'
  ],
  BASE_KOMMENTS: [
    // значения из VBA cmdAvtozapPar_Click (txtKommentariy, через «;»)
    'Наличие перетяжки для креплений ТМЦ.',
    'Перевозчику предоставить: ТН.',
    'Перевозчику предоставить: доверенность,ТН.'
  ],
  _histTips: [], _histSposoby: [], _histKomments: [],
  _mergedTips: [], _mergedSposoby: [], _mergedKomments: [],

  _mergeList(base, hist) {
    const seen = new Set(); const out = [];
    [...(base || []), ...(hist || [])].forEach(v => {
      const tr = String(v || '').trim();
      if (!tr) return;
      const k = tr.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k); out.push(tr);
    });
    return out;
  },

  async loadSelectLists() {
    try {
      const r = await api('GET', '/api/transport-oper/select-lists');
      TransportOpsParams._histTips = Array.isArray(r.transport_tips) ? r.transport_tips : [];
      TransportOpsParams._histSposoby = Array.isArray(r.zagruzka_sposoby) ? r.zagruzka_sposoby : [];
      TransportOpsParams._histKomments = Array.isArray(r.komments) ? r.komments : [];
    } catch (e) {
      console.error('[TransportOpsParams.loadSelectLists] Error:', e);
    }
    TransportOpsParams._mergedTips = TransportOpsParams._mergeList(TransportOpsParams.BASE_TRANSPORT_TIPS, TransportOpsParams._histTips);
    TransportOpsParams._mergedSposoby = TransportOpsParams._mergeList(TransportOpsParams.BASE_ZAGRUZKA_SPOSOBY, TransportOpsParams._histSposoby);
    TransportOpsParams._mergedKomments = TransportOpsParams._mergeList(TransportOpsParams.BASE_KOMMENTS, TransportOpsParams._histKomments);
  },

  // Общий комбобокс: подсказки при фокусе/вводе, фильтр ПО СОДЕРЖИМОМУ
  // (подстрока, регистр не важен), выбор mousedown (раньше blur), Esc/Enter
  initSelectCombo(inputId, listId, containerId, getItems) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!input || !list) return;
    // ✅ T21: у всех самописных селектов — кнопка развернуть/свернуть (как у
    // стандартного селекта); список по умолчанию скрыт и при инициализации/
    // обновлении сам не раскрывается (только клик по полю или по кнопке ▾)
    const cont = document.getElementById(containerId);
    let toggle = cont ? cont.querySelector('.combo-toggle') : null;
    if (cont && !toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'combo-toggle';
      toggle.tabIndex = -1;
      toggle.title = 'Развернуть/свернуть список';
      toggle.textContent = '▾';
      cont.appendChild(toggle);
    }
    const setArrow = () => { if (toggle) toggle.textContent = list.hidden ? '▾' : '▴'; };
    const close = () => { list.hidden = true; setArrow(); };
    if (toggle) {
      toggle.addEventListener('mousedown', e => e.preventDefault());
      toggle.addEventListener('click', () => {
        if (list.hidden) { render(); if (!list.hidden) input.focus(); }
        else close();
      });
    }
    const render = () => {
      const q = String(input.value || '').trim().toLowerCase();
      const items = getItems()
        .filter(n => !q || String(n).toLowerCase().includes(q))
        .slice(0, 50);
      if (items.length === 0) { close(); return; }
      list.innerHTML = '';
      items.forEach(n => {
        const div = document.createElement('div');
        div.className = 'combo-item';
        div.textContent = n;
        // mousedown — срабатывает раньше blur: значение успевает встать
        div.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = n;
          close();
        });
        list.appendChild(div);
      });
      list.hidden = false; setArrow();
    };
    input.addEventListener('focus', render);
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        const first = list.querySelector('.combo-item');
        if (first && !list.hidden) {
          e.preventDefault();
          input.value = first.textContent;
          close();
        }
      }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#' + containerId)) close();
    });
  },

  // ===== ✅ T18 VBA cmdAddTreb_Click: добавление требования из
  // cbListKomment в txtKommentariy; комбинация собирается через «;»,
  // дубли исключаются (InStr vbTextCompare — регистр не важен)
  addTreb() {
    const selectedReq = document.getElementById('toListKomment').value.trim();
    if (!selectedReq) {
      toast('Выберите требование из списка!', 'warning');
      return;
    }
    const ta = document.getElementById('toKommentariy');
    const currentComments = ta.value;
    if (!currentComments.trim()) {
      ta.value = selectedReq;
    } else if (!currentComments.toLowerCase().includes(selectedReq.toLowerCase())) {
      ta.value = currentComments + ';' + selectedReq;
    } else {
      toast('Это требование уже добавлено!', 'warning');
    }
  },

  // ===== ✅ T18 VBA cmdDelTreb_Click: удаление выбранного требования
  // из txtKommentariy (Split по «;», пропуск выбранного, обратная сборка)
  delTreb() {
    const selectedReq = document.getElementById('toListKomment').value.trim();
    if (!selectedReq) {
      toast('Выберите требование для удаления!', 'warning');
      return;
    }
    const ta = document.getElementById('toKommentariy');
    const parts = ta.value.split(';').map(s => s.trim()).filter(p => p !== selectedReq);
    ta.value = parts.join(';');
  },

  // ============================================================
  // ✅ T57: ТАБЛИЦА «ТАРНЫЕ МЕСТА ПЕРЕВОЗКИ» (по типам) во вкладке
  // «Параметры перевозки» — результат модального диалога.
  // Строка на каждый тип места: тип, габарит Д×Ш×В, штабелируемость,
  // кол-во, вес. KPI: итого мест / вес / типов. Источник — tarn_mesta (JSON).
  // ============================================================
  renderTarnTable(tm) {
    const box = document.getElementById('tarnTableBox');
    if (!box) return;
    let groups = [];
    try { groups = JSON.parse(tm || '[]') || []; } catch { groups = []; }
    TransportOpsParams._tarnGroups = groups;
    // KPI (итого) — строка над таблицей
    const mest = groups.reduce((s, g) => s + (parseFloat(g.kolvo) || 0), 0);
    const ves = groups.reduce((s, g) => s + (parseFloat(g.ves_kg) || 0), 0);
    let kpi = box.querySelector('.tarn-kpi');
    if (!kpi) {
      kpi = document.createElement('div');
      kpi.className = 'tarn-kpi';
      box.insertBefore(kpi, box.firstChild);
    }
    kpi.innerHTML = groups.length
      ? 'Итого: <b>' + Math.round(mest) + ' мест</b> · ' + (Math.round(ves * 100) / 100) + ' кг · ' +
        groups.length + ' типа(ов) · <span class="tarn-hint">двойной клик по строке — редактирование в «Расчёте тарных мест»</span>'
      : 'Тарные места не рассчитаны — откройте «Расчёт тарных мест».';
    // ✅ T57-d: ВИРТУАЛЬНАЯ ТАБЛИЦА (общий класс проекта) вместо самописной
    let tbl = box.querySelector('.vtable-container');
    if (!tbl) {
      tbl = document.createElement('div');
      tbl.className = 'vtable-container tarn-vt';
      box.appendChild(tbl);
    }
    tbl.style.height = groups.length
      ? Math.min(210, 26 + (groups.length + 1) * 24) + 'px'
      : '0px';
    tbl.style.display = groups.length ? '' : 'none';
    const rows = groups.map((g, i) => ({
      rowId: 'tg' + i,
      name: g.name || '',
      dims: `${g.dlina_m || '—'}×${g.shirina_m || '—'}×${g.vysota_m || '—'}`,
      shtabil: g.shtabil || '',
      kolvo: g.kolvo != null ? g.kolvo : '',
      ves_kg: g.ves_kg != null ? g.ves_kg : '',
      ukladka: g.ukladka || '',
      pozcii: Array.isArray(g.pozcii) ? g.pozcii.length : 0
    }));
    if (!TransportOpsParams._tarnVT) {
      TransportOpsParams._tarnVT = new VirtualTable(tbl, [
        { key: 'name', label: 'Тип места', width: 240 },
        { key: 'dims', label: 'Габарит Д×Ш×В, м', width: 150 },
        { key: 'shtabil', label: 'Штабел.', width: 70 },
        { key: 'kolvo', label: 'Кол-во мест', width: 85 },
        { key: 'ves_kg', label: 'Вес, кг', width: 90 },
        { key: 'ukladka', label: 'Укладка', width: 110 },
        { key: 'pozcii', label: 'Позиций', width: 70 }
      ], {
        idKey: 'rowId',
        rowHeight: 24,
        autoRefreshForm: false,
        onDblClick: () => TransportOpsTarn.open()
      });
    }
    TransportOpsParams._tarnVT.setData(rows);
  }

};
