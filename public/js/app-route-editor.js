// ============================================================
// ТОЧКА ВХОДА: РЕДАКТОР МАРШРУТОВ
// ============================================================
import { api, toast, esc } from './common/utils.js';
import { initCommonUI, enableTabs } from './common/ui/index.js';
import { connectWs, EditLock, setHandlers } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import { VirtualTable } from './common/virtual-table.js'; 
import { state } from './common/state.js';
import { VirtualSelect } from './common/virtual-select.js'; // ✅ T94: виртуальный селект «Позиция плана»
// ✅ Кир→Лат: поиск с буквами-двойниками (общий хелпер)
import { matches as hgMatches } from './common/homoglyph-helper.js';
import { RouteSteps, CATEGORIES } from './modules/routeSteps.js';
import { RouteOps } from './modules/routeOps.js';

// Делаем модули доступными друг для друга
window.RouteSteps = RouteSteps;
window.RouteOps = RouteOps;

let _allPlanData = [];
// ✅ T94: _filteredPlanData удалён (fltDet больше нет — VirtualSelect ищет сам)
let _footerData = null;        // текущий набор нижней таблицы (перерисовка с подсветкой)
let _missingIds = new Set();   // id позиций плана без маршрута
let vsCmbDet = null;           // VirtualSelect «Позиция плана»

// ===== Резолвер контекста для автоблокировки =====
function getCurrentEditContext() {
  const activeTab = document.querySelector('.tab.active');
  if (!activeTab) return null;

  if (activeTab.dataset.tab === 'tabShagi') {
    return {
      table: 'shagi_marshruta',
      id: RouteSteps.selectedStepId
    };
  }
  if (activeTab.dataset.tab === 'tabOps') {
    return {
      table: 'operatsii_marshruta',
      id: RouteOps.selectedOpId
    };
  }
  return null;
}

document.addEventListener('DOMContentLoaded', async () => {
  connectWs();

  // ✅ Инициализация общего UI (вкладки, автоблокировка, blur, inactivity)
  initCommonUI({
    contextResolver: getCurrentEditContext,
    onTabChange: (tabId) => {
      if (tabId === 'tabShagi') RouteSteps.updateButtonStates();
      if (tabId === 'tabOps')   RouteOps.updateButtonStates();
    }
  });

  // ✅ WebSocket обработчики
  setHandlers({
    onDataChanged: (msg) => {
      if (EditLock.current?.table === msg.table && EditLock.current?.id === msg.id) return;
      if (msg.table === 'shagi_marshruta' || msg.table === 'operatsii_marshruta') {
        if (RouteSteps.curIdDet) RouteSteps.loadRoute(RouteSteps.curIdDet);
        // ✅ T94: состав позиций без маршрута мог измениться — обновить счётчик и подсветку
        if (msg.table === 'shagi_marshruta') refreshMissingCount();
      }
    },
    updateButtons: () => {
      RouteSteps.updateButtonStates();
      RouteOps.updateButtonStates();
    }
  });

  // Инициализация модулей
  RouteSteps.init();
  RouteOps.init();

  // Инициализация ресайзеров
  initResizers();
  resetResizerStylesOnResize();

  // Загрузка справочников
  await loadPlanDetails();
  await RouteSteps.loadTransportTypes();
  RouteSteps.fillCategories('cmbKatShag');
  RouteSteps.fillOperations('cmbKatShag', 'cmbOperShag');
  RouteOps.fillCategories();
  RouteOps.fillOperations();

  // ✅ Пункт 2: типы этапов загружаются сразу при старте
  RouteSteps.fillTransportTypes();

  // ✅ T94: VirtualSelect диспатчит 'change' на контейнере (как нативный select)
  document.getElementById('cmbDet').addEventListener('change', onDetChange);

  // ✅ T94: кнопка сброса выбора позиции плана (аналог старого пустого option)
  document.getElementById('btnDetClear').addEventListener('click', resetDetSelection);

  // ✅ Фильтр нижней таблицы «Детали плана» (fltDet удалён — поиск в селекте)
  document.getElementById('fltDetFooter').addEventListener('input', applyDetFooterFilter);

  // Групповые операции
  document.getElementById('btnApplyToSelected').onclick = applyToSelected;

  // ===== МАССОВОЕ СОЗДАНИЕ СТАНДАРТНЫХ МАРШРУТОВ =====
  document.getElementById('btnBulkCreate').addEventListener('click', openBulkModal);
  document.getElementById('btnBulkCancel').addEventListener('click', closeBulkModal);
  document.getElementById('btnBulkConfirm').addEventListener('click', runBulkCreate);
  // Клик по затемнению — закрыть окно
  document.getElementById('bulkModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeBulkModal();
  });

  // Счётчик позиций без маршрута (подтягивается после загрузки плана)
  await refreshMissingCount();

  RouteSteps.updateButtonStates();
  RouteOps.updateButtonStates();
});

// ===== Загрузка позиций плана =====
async function loadPlanDetails() {
  const data = await api('GET', '/api/plan');
  _allPlanData = data;
  initDetSelect();          // ✅ T94: VirtualSelect вместо <select id="cmbDet">
  renderDetList(data);
  updateDetCount(data.length);
}

// ✅ T94: подпись счётчика позиций (всего загружено / найдено поиском)
function updateDetCount(n) {
  const lbl = document.getElementById('lblDetCount');
  if (lbl) lbl.textContent = `${n} позиций`;
}

// ✅ T94: виртуальный селект «Позиция плана» — тот же компонент, что на
// странице «Формирование плана производства» (фильтрация из коробки)
function initDetSelect() {
  vsCmbDet = new VirtualSelect({
    domId: 'cmbDet',
    apiUrl: '/api/plan',
    valueKey: 'id',
    labelKey: 'osn_naimenovanie',
    displayFormat: (p) => `${p.nomer_chertezha || ''} — ${p.osn_naimenovanie || ''}`,
    placeholder: '— выберите позицию плана —',
    // Серверный поиск ИЛИ по № чертежа / наименованию (plan.list -> search)
    searchParam: 'search',
    onSearchResult: (n) => updateDetCount(n)
  });
}

function renderDetList(data) {
  _footerData = data;  // ✅ T94: запоминаем набор для перерисовки с подсветкой
  if (!state.tables.detList) {
    state.tables.detList = new VirtualTable(
      document.getElementById('lstDet'),
      [
        { key: 'nomer_chertezha', label: '№ чертежа', width: '180px' },
        { key: 'osn_naimenovanie', label: 'Наименование', width: '250px' }
      ],
      { 
        idKey: 'id',  
        multiSelect: true,
        onSelectionChange: (ids) => updateSelectedCount(ids),  // ✅ ПРАВИЛЬНО: onSelectionChange
        // ✅ T94: подсветка позиций без маршрута (⚠-бейдж + фон строки)
        getRowHighlights: (item) => (_missingIds.has(String(item.id))
          ? [{ className: 'highlight-no-route', icon: '⚠', badgeText: 'без маршрута',
               title: 'Нет маршрута движения детали' }]
          : [])
      }
    );
  }
  state.tables.detList.setData(data);
  updateSelectedCount();  // ✅ Вызываем без параметров — внутри используем state.tables.detList
}

// ✅ T94: applyDetFilter удалён вместе с input#fltDet — VirtualSelect
// фильтрует сам (серверный поиск plan.list: ИЛИ по № чертежа / наименованию)

// ===== Пункт 6: Фильтрация деталей в подвале =====
function applyDetFooterFilter() {
  const q = document.getElementById('fltDetFooter').value.toLowerCase();
  const filtered = _allPlanData.filter(p =>
    hgMatches(p.nomer_chertezha, q) || hgMatches(p.osn_naimenovanie, q)
  );
  renderDetList(filtered);
}

// ===== Смена детали =====
async function onDetChange() {
  const detId = vsCmbDet ? vsCmbDet.getValue() : '';  // ✅ T94 (прокси .value контейнера тоже работает)
  document.getElementById('btnDetClear').disabled = !detId;  // ✅ T94
  if (!detId) {
    RouteSteps.curIdDet = null;
    RouteSteps.steps = [];
    RouteSteps.operations = [];
    state.tables.shagi.setData([]);
    RouteOps.clearForStep();
    document.getElementById('chkTO').checked = false;
    document.getElementById('chkPokr').checked = false;
    RouteSteps.updateButtonStates();
    return;
  }

  // Получаем оснастку для чекбоксов ТО/Покрытие
  const plan = _allPlanData.find(p => p.id === detId);
  if (plan) {
    document.getElementById('chkTO').checked = !!plan.zakalka;
    document.getElementById('chkPokr').checked = !!plan.pokrytie;
  }

  await RouteSteps.loadRoute(detId);
}

// ✅ T94: сброс выбора позиции плана — очищает селект и рабочие области
// (раньше для этого выбирался пустой option «— выберите позицию плана —»)
function resetDetSelection() {
  if (vsCmbDet) vsCmbDet.clear();
  onDetChange();
}

// ===== Счётчик выбранных деталей =====
function updateSelectedCount(ids) {
  // ✅ Если ids переданы (из callback onSelectionChange) — используем их
  // ✅ Иначе — получаем из state.tables.detList
  const count = ids ? ids.length : (state.tables.detList ? state.tables.detList.getSelectedCount() : 0);
  const lbl = document.getElementById('lblSelectedCount');
  if (lbl) {
    lbl.textContent = `Выбрано деталей: ${count}`;
  }
}

// ===== Групповое применение маршрута =====
async function applyToSelected() {
  // ✅ ПРАВИЛЬНО: используем RouteSteps вместо routeState
  if (!RouteSteps.curIdDet) {
    toast('Выберите деталь-источник', 'warning');
    return;
  }

  // ✅ ПРАВИЛЬНО: используем state.tables.detList вместо detListTable
  const selectedIds = state.tables.detList ? state.tables.detList.getSelectedIds() : [];
  if (selectedIds.length === 0) {
    toast('Не выбрано ни одной детали', 'warning');
    return;
  }

  if (RouteSteps.steps.length === 0) {
    if (!confirm('Текущий маршрут пуст. Скопировать пустой маршрут?')) return;
  }

  let successCount = 0;
  let skipCount = 0;

  for (const targetId of selectedIds) {
    if (targetId === RouteSteps.curIdDet) {
      skipCount++;
      continue;
    }
    
    // ✅ ПРАВИЛЬНО: используем api вместо copyRouteToDetail
    const r = await api('POST', '/api/routes/copy', {
      source_det_id: RouteSteps.curIdDet,
      target_det_id: targetId
    });
    
    if (!r.error) {
      successCount++;
    }
  }

  let msg = `Маршрут скопирован для ${successCount} деталей`;
  if (skipCount > 0) msg += ` (пропущено: ${skipCount})`;
  toast(msg);
}


// ============================================================
// МАССОВОЕ СОЗДАНИЕ СТАНДАРТНЫХ МАРШРУТОВ
// ============================================================
// Стандартный маршрут аутсорсинга (предустановленные операции из кода):
//   Шаг 1: «Контрагент» (отправка) — ПТО отправляет контрагенту заготовку,
//          операция «Механическая обработка»;
//   Шаг 2: «ПТО» (получение) — контрагент возвращает готовую деталь.

const BULK_OPERATIONS = [
  'Механическая обработка',        // стандартная категория (по умолчанию)
  ...CATEGORIES.mech,              // Универсальная фрезерная, 3D ЧПУ, Токарная, Расточная, Шлифовальная
  'Чистовая мех. обработка',
  'Окончательная обработка',
  ''                               // без операции (этап только с перевозкой)
];

let _missingPositions = [];

// ===== Обновить счётчик позиций без маршрута =====
async function refreshMissingCount() {
  try {
    _missingPositions = await api('GET', '/api/routes/missing');
    _missingIds = new Set(_missingPositions.map(p => String(p.id)));  // ✅ T94
    const n = _missingPositions.length;
    document.getElementById('lblMissingCount').textContent =
      n > 0
        ? `Позиций без маршрута: ${n} — выделены ⚠ в списке «Детали плана»`
        : 'Позиций без маршрута: 0';
    const btn = document.getElementById('btnBulkCreate');
    btn.disabled = n === 0;
    btn.textContent = n > 0
      ? `⚡ Массовое создание стандартных маршрутов (${n})`
      : '✅ Все маршруты созданы';
    // ✅ T94: перерисовать нижнюю таблицу, чтобы ⚠-подсветка применилась
    renderDetList(_footerData !== null ? _footerData : _allPlanData);
  } catch (e) {
    console.error('Не удалось получить позиции без маршрута:', e);
  }
}

// ===== Открыть модальное окно =====
function openBulkModal() {
  if (_missingPositions.length === 0) {
    toast('Все позиции плана уже имеют маршруты', 'info');
    return;
  }
  fillBulkSelects();
  fillBulkList();
  document.getElementById('bulkModal').classList.remove('hidden');
}

function closeBulkModal() {
  document.getElementById('bulkModal').classList.add('hidden');
}

// ===== Заполнить селекты параметров =====
function fillBulkSelects() {
  // Операция этапа отправки (стандартные предустановленные операции)
  const cmbOper = document.getElementById('cmbBulkOper');
  cmbOper.innerHTML = '';
  BULK_OPERATIONS.forEach(op => {
    const opt = document.createElement('option');
    opt.value = op;
    opt.textContent = op === '' ? '— без операции (только перевозка) —' : op;
    cmbOper.appendChild(opt);
  });

  // Типы перевозок: отправка (учёт в остатке = 1) и получение (-1)
  const tps = RouteSteps._transportTypes || [];
  const fillTp = (selectId, defaultId, uchet) => {
    const cmb = document.getElementById(selectId);
    cmb.innerHTML = '';
    const filtered = tps.filter(tp => String(tp.uchet_v_ostatke) === String(uchet));
    filtered.forEach(tp => {
      const opt = document.createElement('option');
      opt.value = tp.id_tipa;
      opt.textContent = `${tp.nazvanie_operatsii}`;
      cmb.appendChild(opt);
    });
    // Стандартный тип по умолчанию, если он есть в справочнике
    if (filtered.some(tp => tp.id_tipa === defaultId)) {
      cmb.value = defaultId;
    }
  };
  fillTp('cmbBulkTpOut', 'OUT_BL', 1);   // «Отправка заготовки»
  fillTp('cmbBulkTpIn', 'IN_GOOD', -1);  // «Получение готовой продукции»
}

// ===== Заполнить список позиций без маршрута =====
function fillBulkList() {
  const list = document.getElementById('bulkList');
  list.innerHTML = _missingPositions.map(p => {
    const chertezh = esc(p.nomer_chertezha || '—');
    const naim = esc(p.osn_naimenovanie || '');
    return `<div class="modal-list-row"><span class="mono">${chertezh}</span><span>${naim}</span></div>`;
  }).join('');
  document.getElementById('bulkListCount').textContent = _missingPositions.length;
}

// ===== Выполнить массовое создание =====
async function runBulkCreate() {
  const btn = document.getElementById('btnBulkConfirm');
  btn.disabled = true;
  btn.textContent = '⏳ Создание...';

  try {
    const r = await api('POST', '/api/routes/bulk-standard', {
      oper_naim: document.getElementById('cmbBulkOper').value,
      tp_out_id: document.getElementById('cmbBulkTpOut').value,
      tp_in_id:  document.getElementById('cmbBulkTpIn').value
    });

    if (r.error) {
      toast('Ошибка: ' + r.error, 'error');
      return;
    }

    if (r.created === 0) {
      toast(r.message || 'Все позиции плана уже имеют маршруты', 'info');
      closeBulkModal();
      return;
    }

    let msg = `Создано маршрутов: ${r.created} (этапов: ${r.created * 2}`;
    if (r.oper) msg += `, операция «${r.oper}»`;
    msg += ')';
    toast(msg);

    closeBulkModal();
    await refreshMissingCount();
    // Если маршрут открыт — перезагрузить его (мог создать для текущей детали)
    if (RouteSteps.curIdDet) await RouteSteps.loadRoute(RouteSteps.curIdDet);
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ Создать маршруты';
  }
}
