// ============================================================
// МОДУЛЬ: ШАГИ МАРШРУТА
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { VirtualTable } from '../common/virtual-table.js';
import { EditLock, isLocked } from '../common/websocket.js';

// Категории операций
const CATEGORIES = {
  mech:    ['Универсальная фрезерная', '3D ЧПУ', 'Токарная', 'Расточная', 'Шлифовальная'],
  clean:   ['Чистовая универсальная фрезерная', 'Чистовая 3D ЧПУ', 'Чистовая токарная'],
  thermo:  ['Объемная закалка', 'Цементация', 'Азотирование'],
  coating: ['Хромирование', 'Оксидирование', 'Цинкование'],
  final:   ['Окончательная обработка']
};

export const RouteSteps = {
  steps: [],
  operations: [],
  curIdDet: null,
  selectedStepId: null,
  _transportTypes: [],
  _isSendingMode: true,

  init() {
    const cols = [
      { key: 'nom_shag',      label: '№',            width: '40px'  },
      { key: 'exec_shag',     label: 'Исполнитель',  width: '110px' },
      { key: '_operations',   label: 'Операции',     width: '200px' },
      { key: '_transport',    label: 'Тип перевозки', width: '180px' },
      { key: 'comm_shag',     label: 'Комментарий',  width: '200px' }
    ];

    state.tables.shagi = new VirtualTable(
      document.getElementById('shagiTable'), cols,
      {
        idKey: 'id_shag',
        onSelect: r => RouteSteps.onSelect(r),
        onHeaderClick: () => RouteSteps.onHeaderClick(),
        getLockInfo: (item) => isLocked('shagi_marshruta', item.id_shag)
      }
    );

    // Кнопки CRUD
    document.getElementById('btnShagAdd').onclick  = () => RouteSteps.add();
    document.getElementById('btnShagSave').onclick = () => RouteSteps.save();
    document.getElementById('btnShagDel').onclick  = () => RouteSteps.del();
    document.getElementById('btnUpShag').onclick   = () => RouteSteps.move('up');
    document.getElementById('btnDownShag').onclick = () => RouteSteps.move('down');

    // Смена исполнителя → перезагрузка типов перевозок
    document.querySelectorAll('input[name="execShag"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        RouteSteps._isSendingMode = e.target.value === 'Контрагент';
        RouteSteps.fillTransportTypes();
        RouteSteps.updateButtonStates();
      });
    });

    // Смена категории → обновление списка операций
    document.getElementById('cmbKatShag').addEventListener('change', () => {
      RouteSteps.fillOperations('cmbKatShag', 'cmbOperShag');
    });

    // Валидация обязательных полей
    ['cmbOperShag'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => RouteSteps.updateButtonStates());
    });

    // ✅ Инициализация: вкладка "Операции" заблокирована, блок скрыт
    RouteSteps.updateOpsTabState();
    RouteSteps.updateFirstOpBlockVisibility();
  },

  // ===== Управление блокировкой вкладки "Операции маршрута" =====
  updateOpsTabState() {
    const tabBtn = document.getElementById('tabOpsBtn');
    if (!tabBtn) return;

    if (RouteSteps.selectedStepId) {
      tabBtn.disabled = false;
      tabBtn.title = 'Редактирование операций этапа';
    } else {
      tabBtn.disabled = true;
      tabBtn.title = 'Выберите этап маршрута';
    }
  },

  // ===== Управление видимостью блока "Первая операция этапа" =====
  updateFirstOpBlockVisibility() {
    const block = document.getElementById('firstOpBlock');
    if (!block) return;

    if (RouteSteps.selectedStepId) {
      // Режим редактирования — скрываем блок
      block.classList.add('hidden');
    } else {
      // Режим создания — показываем блок
      block.classList.remove('hidden');
    }
  },

  // ===== Загрузка типов перевозок =====
  async loadTransportTypes() {
    const data = await api('GET', '/api/transport_types');
    RouteSteps._transportTypes = data;
    RouteSteps.fillTransportTypes();
  },

  fillTransportTypes() {
    const cmb = document.getElementById('cmbTransportType');
    if (!cmb) return;
    cmb.innerHTML = '<option value="">— выберите тип —</option>';

    const targetUchet = RouteSteps._isSendingMode ? '1' : '-1';
    const filtered = RouteSteps._transportTypes.filter(
      tp => String(tp.uchet_v_ostatke) === targetUchet
    );

    filtered.forEach(tp => {
      const opt = document.createElement('option');
      opt.value = tp.id_tipa;
      opt.textContent = tp.nazvanie_operatsii;
      cmb.appendChild(opt);
    });
  },

  // ===== Загрузка маршрута детали =====
  async loadRoute(detId) {
    RouteSteps.curIdDet = detId;
    if (!detId) {
      RouteSteps.steps = [];
      RouteSteps.operations = [];
      state.tables.shagi.setData([]);
      RouteSteps.clearForm();
      RouteSteps.updateButtonStates();
      return;
    }

    const data = await api('GET', `/api/routes?detId=${detId}`);
    RouteSteps.steps = data.steps || [];
    RouteSteps.operations = data.operations || [];

    // Вычисляемые поля
    RouteSteps.steps.forEach(s => {
      s._operations = RouteSteps.getOperationsStr(s.id_shag);
      s._transport = RouteSteps.getTransportName(s.id_tipa_perevozki);
    });

    state.tables.shagi.setData(RouteSteps.steps);

    // ✅ Пункт 3: исполнитель по умолчанию — противоположен последнему этапу
    RouteSteps.setDefaultExecutor();

    RouteSteps.clearForm();
    RouteSteps.updateButtonStates();
  },

  // ✅ Пункт 3: установить исполнителя противоположно последнему шагу
  setDefaultExecutor() {
    let defaultExec = 'Контрагент';
    if (RouteSteps.steps.length > 0) {
      const lastStep = RouteSteps.steps[RouteSteps.steps.length - 1];
      defaultExec = lastStep.exec_shag === 'Контрагент' ? 'ПТО' : 'Контрагент';
    }

    const radio = document.querySelector(`input[name="execShag"][value="${defaultExec}"]`);
    if (radio) {
      radio.checked = true;
      RouteSteps._isSendingMode = defaultExec === 'Контрагент';
      RouteSteps.fillTransportTypes();
    }
  },

  // Операции шага берём из дочерней таблицы operatsii_marshruta по FK id_shag
  // (строка-список ids_oper удалена из shagi_marshruta финальной схемой)
  getOperationsStr(idShag) {
    return RouteSteps.operations
      .filter(o => o.id_shag === idShag)
      .map(o => o.naim_oper)
      .join(', ');
  },

  getTransportName(idTipa) {
    if (!idTipa) return '—';
    const tp = RouteSteps._transportTypes.find(t => t.id_tipa === idTipa);
    return tp ? tp.nazvanie_operatsii : idTipa;
  },

  // ===== Категории и операции =====
  fillCategories(cmbKatId) {
    const cmbKat = document.getElementById(cmbKatId);
    if (!cmbKat) return;
    cmbKat.innerHTML = '';

    const addOpt = (name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      cmbKat.appendChild(opt);
    };

    addOpt('Механическая обработка');
    addOpt('Чистовая мех. обработка');
    const chkTO = document.getElementById('chkTO');
    const chkPokr = document.getElementById('chkPokr');
    if (chkTO?.checked) addOpt('Термическая обработка');
    if (chkPokr?.checked) addOpt('Покрытие');
    addOpt('Окончательная обработка');
  },

  fillOperations(cmbKatId, cmbOperId) {
    const category = document.getElementById(cmbKatId)?.value;
    const cmbOper = document.getElementById(cmbOperId);
    if (!cmbOper) return;
    cmbOper.innerHTML = '';

    let ops = [];
    switch (category) {
      case 'Механическая обработка':    ops = CATEGORIES.mech; break;
      case 'Чистовая мех. обработка':   ops = CATEGORIES.clean; break;
      case 'Термическая обработка':     ops = CATEGORIES.thermo; break;
      case 'Покрытие':                  ops = CATEGORIES.coating; break;
      case 'Окончательная обработка':   ops = CATEGORIES.final; break;
    }

    ops.forEach(opName => {
      const opt = document.createElement('option');
      opt.value = opName;
      opt.textContent = opName;
      cmbOper.appendChild(opt);
    });
  },

  // ===== Выбор шага =====
 onSelect(row) {
    RouteSteps.selectedStepId = row.id_shag;

    document.getElementById('txtCommShag').value = row.comm_shag || '';
    document.getElementById('cmbTransportType').value = row.id_tipa_perevozki || '';

    const execRadio = document.querySelector(`input[name="execShag"][value="${row.exec_shag}"]`);
    if (execRadio) {
      execRadio.checked = true;
      RouteSteps._isSendingMode = row.exec_shag === 'Контрагент';
      RouteSteps.fillTransportTypes();
      document.getElementById('cmbTransportType').value = row.id_tipa_perevozki || '';
    }

    document.getElementById('shagFormTitle').textContent =
      `Этап №${row.nom_shag}: ${row.exec_shag}`;

    RouteSteps.updateButtonStates();
    RouteSteps.updateOpsTabState();           // ✅ Разблокируем вкладку "Операции"
    RouteSteps.updateFirstOpBlockVisibility(); // ✅ Скрываем блок "Первая операция"

    // Обновляем список операций во вкладке "Операции"
    if (window.RouteOps) window.RouteOps.loadForStep(row);
  },

  onHeaderClick() {
    RouteSteps.selectedStepId = null;
    RouteSteps.clearForm();
    RouteSteps.setDefaultExecutor();
    RouteSteps.updateButtonStates();
    RouteSteps.updateOpsTabState();           // ✅ Блокируем вкладку "Операции"
    RouteSteps.updateFirstOpBlockVisibility(); // ✅ Показываем блок "Первая операция"

    if (window.RouteOps) window.RouteOps.clearForStep();
  },

  clearForm() {
    document.getElementById('txtCommShag').value = '';
    document.getElementById('shagFormTitle').textContent = 'Новый этап маршрута';

    RouteSteps.fillCategories('cmbKatShag');
    RouteSteps.fillOperations('cmbKatShag', 'cmbOperShag');
  },

  _buildPayload() {
    // Даты в шаблон не пишутся: план/факт сроки живут в fakt_marshruta
    // (партия × операция) и редактируются при работе с партиями
    const execRadio = document.querySelector('input[name="execShag"]:checked');
    return {
      id_det: RouteSteps.curIdDet,
      nom_shag: RouteSteps.steps.length + 1,
      exec_shag: execRadio?.value || 'Контрагент',
      comm_shag: document.getElementById('txtCommShag').value.trim(),
      id_tipa_perevozki: document.getElementById('cmbTransportType').value,
      // Первая операция опциональна: шаг только с перевозкой допустим
      // (факт по нему ведётся через transport_oper)
      naim_oper: document.getElementById('cmbOperShag').value
    };
  },

  updateButtonStates() {
    const hasStep = RouteSteps.selectedStepId !== null;
    const hasDet = RouteSteps.curIdDet !== null;

    const btnAdd  = document.getElementById('btnShagAdd');
    const btnSave = document.getElementById('btnShagSave');
    const btnDel  = document.getElementById('btnShagDel');

    const locker = hasStep ? isLocked('shagi_marshruta', RouteSteps.selectedStepId) : null;

    if (!hasStep) {
      btnAdd.disabled  = !hasDet; // операция не обязательна: шаг может быть только с перевозкой
      btnSave.disabled = true;
      btnDel.disabled  = true;
    } else {
      btnAdd.disabled  = true;
      btnSave.disabled = !!locker;
      btnDel.disabled  = !!locker;
    }

    const stepIndex = RouteSteps.steps.findIndex(s => s.id_shag === RouteSteps.selectedStepId);
    document.getElementById('btnUpShag').disabled   = stepIndex <= 0;
    document.getElementById('btnDownShag').disabled = stepIndex < 0 || stepIndex >= RouteSteps.steps.length - 1;
  },

  async add() {
    if (!RouteSteps.curIdDet) {
      toast('Выберите деталь', 'warning');
      return;
    }
    const payload = RouteSteps._buildPayload();
    // naim_oper не обязателен: шаг без операций (только перевозка) валиден
    // по финальной схеме — факт по нему ведётся через transport_oper

    const r = await api('POST', '/api/steps', payload);
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }

    toast('Этап добавлен');
    await RouteSteps.loadRoute(RouteSteps.curIdDet);
    state.tables.shagi.selectById(r.id_shag);
  },

  async save() {
    if (!RouteSteps.selectedStepId) return;
    const step = RouteSteps.steps.find(s => s.id_shag === RouteSteps.selectedStepId);
    if (!step) return;

    const execRadio = document.querySelector('input[name="execShag"]:checked');
    step.exec_shag = execRadio?.value || 'Контрагент';
    step.comm_shag = document.getElementById('txtCommShag').value.trim();
    step.id_tipa_perevozki = document.getElementById('cmbTransportType').value;
    step._transport = RouteSteps.getTransportName(step.id_tipa_perevozki);

    const r = await api('PUT', `/api/steps/${step.id_shag}`, step);
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }

    toast('Этап обновлён');
    if (EditLock.current?.id === step.id_shag) EditLock.release();
    await RouteSteps.loadRoute(RouteSteps.curIdDet);
    state.tables.shagi.selectById(step.id_shag);
  },

  async del() {
    if (!RouteSteps.selectedStepId) return;
    const step = RouteSteps.steps.find(s => s.id_shag === RouteSteps.selectedStepId);
    if (!step) return;
    if (!confirm(`Удалить этап №${step.nom_shag} и все его операции?`)) return;

    if (EditLock.current?.id === step.id_shag) EditLock.release();

    const r = await api('DELETE', `/api/steps/${step.id_shag}`);
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }

    toast('Этап удалён', 'warning');
    await RouteSteps.loadRoute(RouteSteps.curIdDet);
    RouteSteps.onHeaderClick();
  },

  async move(direction) {
    const index = RouteSteps.steps.findIndex(s => s.id_shag === RouteSteps.selectedStepId);
    if (index < 0) return;

    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= RouteSteps.steps.length) return;

    const r = await api('POST', '/api/steps/swap', {
      id_det: RouteSteps.curIdDet,
      id_shag1: RouteSteps.steps[index].id_shag,
      id_shag2: RouteSteps.steps[swapIndex].id_shag
    });
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }

    await RouteSteps.loadRoute(RouteSteps.curIdDet);
    state.tables.shagi.selectById(RouteSteps.selectedStepId);
  }
};

// Экспорт стандартных (предустановленных) категорий операций —
// используются кнопкой массового создания маршрутов в app-route-editor.js
export { CATEGORIES };
