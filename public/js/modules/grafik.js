import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { EditLock, isLocked } from '../common/websocket.js';
import { batchManager } from '../common/batch-update.js'; // t69: штатный механизм пакетного обновления
import { sqlDate } from '../common/date-helpers.js';

const MONTHS = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
const COL_W = 46;
// Виртуализация вертикального скролла:
// ROW_H — высота строки (CSS .grafik-row: height 20px, box-sizing: border-box —
// граница снизу внутри 20px). При изменении высоты в CSS синхронизировать здесь.
const ROW_H = 20;
// Запас отрисованных строк сверху/снизу видимой области (плавность прокрутки)
const RENDER_BUFFER = 15;

export const Grafik = {
  baseYear: new Date().getFullYear(),
  extraMonths: 3,
  totalCols: 15,
  planRows: [],
  grafikData: {},
  rowStates: {},
  _osnastkaMap: {},
  // ===== СЕРВЕРНАЯ ФИЛЬТРАЦИЯ: наименование / номер чертежа =====
  filters: { naimenovanie: '', nomer_chertezha: '' },
  _filterTimer: null,
  // t69: подавление собственных WS-событий (grafik/plan) на время сохранения
  // делает штатный batch-update.js (batchManager) — флаг _saving больше не нужен.

  async init() {
    const osn = await api('GET', '/api/osnastka');
    osn.forEach(o => { Grafik._osnastkaMap[o.id] = o; });

    document.getElementById('gYearUp').onclick = () => Grafik.changeYear(1);
    document.getElementById('gYearDown').onclick = () => Grafik.changeYear(-1);
    document.getElementById('gExtraUp').onclick = () => Grafik.changeExtra(1);
    document.getElementById('gExtraDown').onclick = () => Grafik.changeExtra(-1);
    document.getElementById('gRefresh').onclick = () => Grafik.load();
    document.getElementById('gSave').onclick = () => Grafik.saveAll();

    // ===== ПАНЕЛЬ ФИЛЬТРОВ: наименование / номер чертежа =====
    const fNaimen = document.getElementById('gFilterName');
    const fChertezh = document.getElementById('gFilterDrawing');
    const fReset = document.getElementById('gFilterReset');

    if (fNaimen && fChertezh) {
      // Debounce: не дёргаем сервер на каждый введённый символ
      const debouncedApply = () => {
        clearTimeout(Grafik._filterTimer);
        Grafik._filterTimer = setTimeout(() => Grafik.applyFilters(), 350);
      };
      fNaimen.addEventListener('input', debouncedApply);
      fChertezh.addEventListener('input', debouncedApply);

      // Enter — мгновенный поиск
      [fNaimen, fChertezh].forEach(inp => {
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(Grafik._filterTimer);
            Grafik.applyFilters();
          }
        });
      });
    }
    if (fReset) {
      fReset.onclick = () => Grafik.resetFilters();
    }

   

    Grafik.renderHeader();
  },


  async load() {
    // ===== СЕРВЕРНАЯ ФИЛЬТРАЦИЯ =====
    // Год, наименование и номер чертежа фильтруются на сервере
    // (endpoint GET /api/grafik/plans в grafikRoutes.js)
    const params = new URLSearchParams();
    params.set('god', String(Grafik.baseYear));
    if (Grafik.filters.naimenovanie) params.set('naimenovanie', Grafik.filters.naimenovanie);
    if (Grafik.filters.nomer_chertezha) params.set('nomer_chertezha', Grafik.filters.nomer_chertezha);

    const planData = await api('GET', `/api/grafik/plans?${params.toString()}`);
    // Защитный фильтр по году сохранён на случай расхождения с сервером
    Grafik.planRows = (Array.isArray(planData) ? planData : [])
      .filter(p => p.god === String(Grafik.baseYear));

    const planIds = Grafik.planRows.map(p => p.id);
    if (planIds.length > 0) {
      const bulk = await api('POST', '/api/grafik/bulk', { planIds });
      Grafik.grafikData = bulk.data || {};
    } else {
      Grafik.grafikData = {};
    }

    Grafik.rowStates = {};
    Grafik.planRows.forEach(p => {
      const stages = Grafik.grafikData[p.id] || [];
      
      if (stages.length === 0 && parseFloat(p.plan_god_kolvo) > 0 && p.plan_izgot) {
        Grafik.autoCreateFromPlan(p);
      } else {
        Grafik.rowStates[p.id] = {
          values: new Array(Grafik.totalCols).fill(0),
          dirty: false,
          trudoemkost: Grafik.getTrudoemkost(p.id_osnastka)
        };

        stages.forEach(s => {
          const m = parseInt(s.etap_nomer);
          if (m >= 1 && m <= Grafik.totalCols) {
            Grafik.rowStates[p.id].values[m - 1] = parseFloat(s.plan_kolvo) || 0;
          }
        });
      }
    });

    Grafik.renderBody();
    Grafik.recalcAll();
    Grafik.updateSaveButton();
    Grafik.updateFilterInfo();
   
  },

  autoCreateFromPlan(p) {
    const totalQty = parseFloat(p.plan_god_kolvo);
    const planIzgot = p.plan_izgot;
    
    const st = {
      values: new Array(Grafik.totalCols).fill(0),
      dirty: true,
      trudoemkost: Grafik.getTrudoemkost(p.id_osnastka)
    };

    if (planIzgot) {
      const date = new Date(planIzgot);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      
      let monthNum = month;
      if (year > Grafik.baseYear) {
        monthNum = 12 + month;
      }
      
      if (monthNum >= 1 && monthNum <= Grafik.totalCols) {
        st.values[monthNum - 1] = totalQty;
      }
    }

    Grafik.rowStates[p.id] = st;
  },

  getTrudoemkost(idOsnastka) {
    const osn = Grafik._osnastkaMap[idOsnastka];
    if (!osn || osn.trudoemkost_pto === null || osn.trudoemkost_pto === undefined) return 0;
    // Исправление: приводим к строке перед replace, чтобы не падало на числах
    const v = parseFloat(String(osn.trudoemkost_pto).replace(',', '.'));
    return isNaN(v) ? 0 : v;
  },

  changeYear(delta) {
    Grafik.baseYear += delta;
    document.getElementById('gBaseYear').textContent = Grafik.baseYear;
    Grafik.renderHeader();
    Grafik._resetScroll = true; // новый год — показываем список с начала
    Grafik.load();
  },

  changeExtra(delta) {
    const newVal = Grafik.extraMonths + delta;
    if (newVal < 0 || newVal > 6) return;
    Grafik.extraMonths = newVal;
    Grafik.totalCols = 12 + Grafik.extraMonths;
    document.getElementById('gExtraMonths').textContent = Grafik.extraMonths;
    Grafik.renderHeader();
    Grafik.load();
  },

  // ===== СЕРВЕРНАЯ ФИЛЬТРАЦИЯ: применение фильтров =====
  applyFilters() {
    const fNaimen = document.getElementById('gFilterName');
    const fChertezh = document.getElementById('gFilterDrawing');
    Grafik.filters.naimenovanie = fNaimen ? fNaimen.value.trim() : '';
    Grafik.filters.nomer_chertezha = fChertezh ? fChertezh.value.trim() : '';
    Grafik._resetScroll = true; // новый результат — с начала списка
    Grafik.load();
  },

  // Сброс фильтров и загрузка полного списка
  resetFilters() {
    const fNaimen = document.getElementById('gFilterName');
    const fChertezh = document.getElementById('gFilterDrawing');
    if (fNaimen) fNaimen.value = '';
    if (fChertezh) fChertezh.value = '';
    Grafik.filters = { naimenovanie: '', nomer_chertezha: '' };
    Grafik._resetScroll = true;
    Grafik.load();
  },

  // Счётчик позиций под панелью фильтров
  updateFilterInfo() {
    const info = document.getElementById('gFilterInfo');
    if (!info) return;
    const hasFilter = !!(Grafik.filters.naimenovanie || Grafik.filters.nomer_chertezha);
    info.textContent = hasFilter
      ? `Найдено позиций: ${Grafik.planRows.length}`
      : `Позиций: ${Grafik.planRows.length}`;
  },

  renderHeader() {
    const monthsHeader = document.getElementById('gMonthsHeader');
    const chartBars = document.getElementById('gChartBars');

    // Ширина месячной части в CSS-переменной: от неё зависит min-width
    // контейнера горизонтального скролла (см. grafik.css .grafik-scroll-content)
    const scrollContent = document.querySelector('.grafik-scroll-content');
    if (scrollContent) {
      scrollContent.style.setProperty('--gc-months', `${Grafik.totalCols * COL_W}px`);
    }

    monthsHeader.innerHTML = '';
    chartBars.innerHTML = '';

    const yearsContainer = document.createElement('div');
    yearsContainer.style.display = 'flex';
    // Ряд годов не должен растягиваться на всю ширину контейнера —
    // иначе его граница вылезает правее данных (рассинхронизация с строками)
    yearsContainer.style.width = (Grafik.totalCols * COL_W) + 'px';

    const baseYearDiv = document.createElement('div');
    baseYearDiv.className = 'grafik-year-header base';
    baseYearDiv.style.flex = `0 0 ${12 * COL_W}px`;
    baseYearDiv.textContent = Grafik.baseYear + ' год';
    yearsContainer.appendChild(baseYearDiv);

    if (Grafik.extraMonths > 0) {
      const nextYearDiv = document.createElement('div');
      nextYearDiv.className = 'grafik-year-header next';
      nextYearDiv.style.flex = `0 0 ${Grafik.extraMonths * COL_W}px`;
      nextYearDiv.textContent = (Grafik.baseYear + 1) + ' год';
      yearsContainer.appendChild(nextYearDiv);
    }

    monthsHeader.appendChild(yearsContainer);

    const monthsRow = document.createElement('div');
    monthsRow.className = 'grafik-months-row';
    monthsRow.style.display = 'flex';
    // Ширина строго равна сумме колонок месяцев — как у строк (grafik-row-months)
    monthsRow.style.width = (Grafik.totalCols * COL_W) + 'px';
    for (let i = 0; i < Grafik.totalCols; i++) {
      const m = document.createElement('div');
      m.className = 'grafik-month-cell ' + (i >= 12 ? 'next' : 'base');
      m.style.flex = `0 0 ${COL_W}px`;
      m.textContent = MONTHS[i % 12];
      monthsRow.appendChild(m);
    }
    monthsHeader.appendChild(monthsRow);

    chartBars.style.display = 'flex';
    chartBars.style.width = `${Grafik.totalCols * COL_W}px`;
    for (let i = 0; i < Grafik.totalCols; i++) {
      const bar = document.createElement('div');
      bar.className = 'grafik-bar ' + (i >= 12 ? 'next' : 'base');
      bar.style.flex = `0 0 ${COL_W}px`;
      bar.style.height = '34px';
      bar.style.position = 'relative';
      bar.dataset.month = i;
      
      const innerBar = document.createElement('div');
      innerBar.className = 'grafik-bar-inner';
      innerBar.style.position = 'absolute';
      innerBar.style.bottom = '0';
      innerBar.style.left = `${(COL_W - 18) / 2}px`;
      innerBar.style.width = '18px';
      innerBar.style.height = '2px';
      innerBar.style.background = '#4a90d9';
      bar.appendChild(innerBar);
      
      chartBars.appendChild(bar);
    }
  },

  // ===== ВИРТУАЛЬНЫЙ ВЕРТИКАЛЬНЫЙ СКРОЛЛИНГ ====================
  // В DOM живут только видимые строки + буфер: при 5000 позиций
  // это ~60-80 строк вместо 5000*20 DOM-узлов. Полная высота данных
  // задаётся спейсером (высота = планки * ROW_H), окно строк
  // позиционируется на scrollTop и перерисовывается по мере прокрутки.
  _virt: null,          // { spacer, win, start, end }
  _scrollBound: false,  // обработчик scroll вешается один раз
  _resetScroll: false,  // true → после перерисовки прокрутить к началу

  renderBody() {
    const body = document.getElementById('gBody');

    // Позиция прокрутки сохраняется между перерисовками (Обновить,
    // WebSocket-события), если её не потребовали сбросить фильтры/год
    const prevTop = body.scrollTop;
    const maxTop = Math.max(0, Grafik.planRows.length * ROW_H - body.clientHeight);

    body.innerHTML = '';

    const spacer = document.createElement('div');
    spacer.className = 'grafik-body-spacer';
    spacer.style.height = (Grafik.planRows.length * ROW_H) + 'px';

    const win = document.createElement('div');
    win.className = 'grafik-body-window';
    spacer.appendChild(win);
    body.appendChild(spacer);

    Grafik._virt = { spacer, win, start: -1, end: -1 };

    if (Grafik.planRows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'grafik-empty';
      empty.textContent = 'Нет позиций по заданным условиям';
      body.appendChild(empty);
    }

    if (Grafik._resetScroll) {
      body.scrollTop = 0;
      Grafik._resetScroll = false;
    } else {
      body.scrollTop = Math.min(prevTop, maxTop);
    }

    if (!Grafik._scrollBound) {
      Grafik._scrollBound = true;
      let raf = 0;
      body.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          Grafik.renderWindow();
        });
      }, { passive: true });
    }

    Grafik.renderWindow();
  },

  // Рендерит только строки, попадающие в видимую область (+буфер)
  renderWindow() {
    const v = Grafik._virt;
    if (!v || !v.spacer.isConnected) return;

    const body = document.getElementById('gBody');
    const total = Grafik.planRows.length;

    if (total === 0) {
      v.win.innerHTML = '';
      v.start = 0;
      v.end = 0;
      return;
    }

    const viewH = body.clientHeight || 300;
    const start = Math.max(0, Math.floor(body.scrollTop / ROW_H) - RENDER_BUFFER);
    const end = Math.min(total, Math.ceil((body.scrollTop + viewH) / ROW_H) + RENDER_BUFFER);

    if (start === v.start && end === v.end) return; // окно не сдвинулось
    v.start = start;
    v.end = end;
    v.win.style.top = (start * ROW_H) + 'px';

    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      frag.appendChild(Grafik.buildRow(Grafik.planRows[i]));
    }
    v.win.replaceChildren(frag);
  },

  // Сборка ОДНОЙ строки (вынесена из прежнего renderBody).
  // Сумма и состояние блокировки вычисляются на месте — строка может
  // быть отрисована в любой момент прокрутки.
  buildRow(p) {
    const row = document.createElement('div');
    row.className = 'grafik-row';
    row.dataset.planId = p.id;

    const st = Grafik.rowStates[p.id] || { values: new Array(Grafik.totalCols).fill(0), trudoemkost: 0 };
    const locker = isLocked('grafik', p.id);
    const isEditing = !!(EditLock.current && EditLock.current.table === 'grafik' && EditLock.current.id === p.id);

    if (locker && !isEditing) {
      row.classList.add('locked');
      row.title = `🔒 Редактирует: ${locker}`;
    } else if (isEditing) {
      row.classList.add('editing');
    }

    const fixed = document.createElement('div');
    fixed.className = 'grafik-row-fixed';

    const name = document.createElement('div');
    name.className = 'grafik-cell-name';
    const chertezh = p.nomer_chertezha || '';
    const naimen = p.osn_naimenovanie || '';
    const full = `${chertezh} - ${naimen}`;
    name.textContent = full;
    name.title = full;
    fixed.appendChild(name);

    // t66: колонка «Фирма» — фирма лучшего КП позиции (как в «Плоской таблице»)
    const firma = document.createElement('div');
    firma.className = 'grafik-cell-firma';
    const firmaName = p.firma_name || '';
    firma.textContent = firmaName;
    firma.title = firmaName; // длинные названия видны при наведении
    fixed.appendChild(firma);

    const zak = document.createElement('div');
    zak.className = 'grafik-cell-zak';
    zak.textContent = p.zak_pto || '';
    zak.title = p.zak_pto || ''; // t66: тултип — полная строка при наведении
    fixed.appendChild(zak);

    const sum = document.createElement('div');
    sum.className = 'grafik-cell-sum';
    sum.id = `sum_${p.id}`;
    sum.textContent = (st.values.reduce((s, q) => s + q, 0)).toLocaleString('ru-RU');
    fixed.appendChild(sum);

    const trud = document.createElement('div');
    trud.className = 'grafik-cell-trud';
    trud.textContent = st.trudoemkost || 0;
    fixed.appendChild(trud);

    row.appendChild(fixed);

    const months = document.createElement('div');
    months.className = 'grafik-row-months';
    months.style.width = (Grafik.totalCols * COL_W) + 'px';

    const inputsDisabled = locker && !isEditing;
    for (let i = 0; i < Grafik.totalCols; i++) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'grafik-month-input ' + (i >= 12 ? 'next' : 'base');
      input.style.width = COL_W + 'px';
      input.value = st.values[i] > 0 ? st.values[i] : '';
      input.dataset.planId = p.id;
      input.dataset.month = i;

      if (inputsDisabled) {
        input.disabled = true;
      } else {
        input.addEventListener('input', Grafik.onMonthInput);
        input.addEventListener('blur', Grafik.onMonthBlur);
      }

      months.appendChild(input);
    }

    row.appendChild(months);
    return row;
  },

  onMonthInput(e) {
    const planId = e.target.dataset.planId;
    const month = parseInt(e.target.dataset.month);
    const raw = e.target.value.trim();

    if (raw === '') {
      Grafik.rowStates[planId].values[month] = 0;
    } else if (/^\d+$/.test(raw)) {
      Grafik.rowStates[planId].values[month] = parseInt(raw);
    } else {
      e.target.value = '';
      Grafik.rowStates[planId].values[month] = 0;
    }
    Grafik.rowStates[planId].dirty = true;
    Grafik.recalcAll();
    Grafik.updateSaveButton();
  },

  onMonthBlur(e) {
    const planId = e.target.dataset.planId;
    const month = parseInt(e.target.dataset.month);
    const v = Grafik.rowStates[planId].values[month];
    e.target.value = v > 0 ? v : '';
  },

  recalcAll() {
    const totals = new Array(Grafik.totalCols).fill(0);
    let totBase = 0, totNext = 0;

    Grafik.planRows.forEach(p => {
      const st = Grafik.rowStates[p.id];
      if (!st) return;
      const trud = st.trudoemkost;
      let rowSum = 0;

      for (let i = 0; i < Grafik.totalCols; i++) {
        const qty = st.values[i];
        rowSum += qty;
        if (trud > 0) totals[i] += qty * trud;
      }

      const sumEl = document.getElementById(`sum_${p.id}`);
      if (sumEl) sumEl.textContent = rowSum.toLocaleString('ru-RU');
    });

    for (let i = 0; i < 12; i++) totBase += totals[i];
    for (let i = 12; i < Grafik.totalCols; i++) totNext += totals[i];
    const totAll = totBase + totNext;

    document.getElementById('gTotalBase').textContent = totBase.toFixed(2);
    document.getElementById('gTotalNext').textContent = totNext.toFixed(2);
    document.getElementById('gTotalAll').textContent = totAll.toFixed(2);
    document.getElementById('gTotalBaseCap').textContent = Grafik.baseYear + ' год:';
    document.getElementById('gTotalNextCap').textContent = (Grafik.baseYear + 1) + ' год:';
    document.getElementById('gTotalNextBlock').style.display =
      Grafik.extraMonths > 0 ? 'flex' : 'none';

    const maxV = Math.max(...totals, 1);
    const bars = document.querySelectorAll('.grafik-bar');
    bars.forEach((bar, i) => {
      const v = totals[i] || 0;
      const h = Math.round((v / maxV) * 30);
      const innerBar = bar.querySelector('.grafik-bar-inner');
      if (innerBar) {
        innerBar.style.height = (v > 0 ? Math.max(2, h) : 2) + 'px';
        innerBar.title = `${MONTHS[i % 12]}: ${v.toFixed(2)} н/ч`;
      }
    });
  },

  updateLockIndicators() {
    document.querySelectorAll('.grafik-row').forEach(row => {
      const planId = row.dataset.planId;
      if (!planId) return;

      const locker = isLocked('grafik', planId);
      const isEditing = EditLock.current && EditLock.current.id === planId;

      if (locker && !isEditing) {
        row.classList.add('locked');
        row.classList.remove('editing');
        row.title = `🔒 Редактирует: ${locker}`;
        row.querySelectorAll('.grafik-month-input').forEach(input => {
          input.disabled = true;
        });
      } else if (isEditing) {
        row.classList.remove('locked');
        row.classList.add('editing');
        row.title = '';
        row.querySelectorAll('.grafik-month-input').forEach(input => {
          input.disabled = false;
        });
      } else {
        row.classList.remove('locked', 'editing');
        row.title = '';
        row.querySelectorAll('.grafik-month-input').forEach(input => {
          input.disabled = false;
        });
      }
    });
  },

  updateSaveButton() {
    const hasDirty = Object.values(Grafik.rowStates).some(s => s.dirty);
    document.getElementById('gSave').disabled = !hasDirty;
  },

  // t68: сохранение всех изменённых строк. Данные строк снимаются СНИМКОМ до
  // цикла: WS-перезагрузка от собственных POST/PUT пересоздаёт rowStates, и
  // прежний цикл записывал в БД старые значения (правки строк 3+ терялись).
  async saveAll() {
    if (batchManager.isProcessing('grafik')) return;   // t69: повторный клик во время сохранения игнорируем
    const dirtyPlans = Grafik.planRows.filter(p => Grafik.rowStates[p.id]?.dirty);
    if (dirtyPlans.length === 0) {
      toast('Нет изменений для сохранения', 'warning');
      return;
    }

    // СНИМОК заданий: этапы/итоги каждого плана фиксируются до первого запроса
    const jobs = dirtyPlans.map(p => {
      const st = Grafik.rowStates[p.id];
      const stages = [];
      let totalQty = 0;
      let lastMonthNum = 0;

      for (let i = 0; i < Grafik.totalCols; i++) {
        if (st.values[i] > 0) {
          stages.push({
            etap_nomer: String(i + 1),
            plan_kolvo: String(st.values[i]),
            fact_kolvo: '',
            status_etapa: '',
            primechanie: ''
          });
          totalQty += st.values[i];
          lastMonthNum = i + 1;
        }
      }

      let planIzgot = '';
      if (lastMonthNum > 0) {
        const baseYear = Grafik.baseYear;
        const year = baseYear + Math.floor((lastMonthNum - 1) / 12);
        const month = ((lastMonthNum - 1) % 12) + 1;
        const lastDay = new Date(year, month, 0).getDate();
        planIzgot = sqlDate(new Date(year, month - 1, lastDay));
      }

      return { p, st, stages, totalQty, planIzgot };
    });

    // t69: ШТАТНЫЙ механизм пакетного обновления (batch-update.js): websocket.js
    // не диспатчит data_changed для таблиц в batch. Гасим ОБЕ таблицы цикла —
    // 'grafik' (POST /api/grafik/save -> notifyDataChange('grafik')) и
    // 'plan' (PUT /api/plan/:id -> notifyDataChange('plan')).
    batchManager.begin('grafik');
    batchManager.begin('plan');
    let savedCount = 0;
    const errors = [];
    try {
      for (const job of jobs) {
        const label = job.p.nomer_chertezha || job.p.id;
        try {
          const r = await api('POST', '/api/grafik/save', {
            id_plana: job.p.id,
            god: String(Grafik.baseYear),
            stages: job.stages
          });
          if (r.error) {
            errors.push(`${label}: ${r.error}`);
            continue;   // t68: ошибка одной строки не останавливает остальные
          }

          // Берём актуальную запись плана, меняем только 2 поля
          const planUpdate = {
            ...job.p,                        // вся актуальная запись из Grafik.planRows
            plan_god_kolvo: String(job.totalQty),  // меняем только общее количество
            plan_izgot: job.planIzgot              // и крайний срок
          };
          const r2 = await api('PUT', `/api/plan/${job.p.id}`, planUpdate);
          if (r2.error) {
            errors.push(`${label}: ${r2.error}`);
            continue;
          }

          job.st.dirty = false;
          savedCount++;
        } catch (e) {
          errors.push(`${label}: ${e.message}`);
        }
      }
    } finally {
      batchManager.end('grafik');
      batchManager.end('plan');
    }

    if (errors.length) {
      console.error('[Grafik.saveAll] ошибки сохранения:', errors);
      toast(`Сохранено позиций: ${savedCount}, с ошибками: ${errors.length} (подробности в консоли)`, 'error');
    } else {
      toast(`Сохранено позиций: ${savedCount}`, 'success');
    }
    Grafik.updateSaveButton();
  }
};