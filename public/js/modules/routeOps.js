// ============================================================
// МОДУЛЬ: ОПЕРАЦИИ МАРШРУТА
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { VirtualTable } from '../common/virtual-table.js';
import { EditLock, isLocked } from '../common/websocket.js';

const CATEGORIES = {
  mech:    ['Универсальная фрезерная', '3D ЧПУ', 'Токарная', 'Расточная', 'Шлифовальная'],
  clean:   ['Чистовая универсальная фрезерная', 'Чистовая 3D ЧПУ', 'Чистовая токарная'],
  thermo:  ['Объемная закалка', 'Цементация', 'Азотирование'],
  coating: ['Хромирование', 'Оксидирование', 'Цинкование'],
  final:   ['Окончательная обработка']
};

export const RouteOps = {
  currentStepId: null,
  selectedOpId: null,
  stepOperations: [],

  init() {
    // Статус/даты операции — это факт (fakt_marshruta, партия × операция),
    // в шаблоне operatsii_marshruta остаётся только наименование
    const cols = [
      { key: '_nn',       label: '№',        width: '50px'  },
      { key: 'naim_oper', label: 'Операция', width: '320px' }
    ];

    state.tables.ops = new VirtualTable(
      document.getElementById('opsTable'), cols,
      {
        idKey: 'id_oper',
        onSelect: r => RouteOps.onSelect(r),
        onHeaderClick: () => RouteOps.onHeaderClick(),
        getLockInfo: (item) => isLocked('operatsii_marshruta', item.id_oper)
      }
    );

    document.getElementById('btnOpAdd').onclick  = () => RouteOps.add();
    document.getElementById('btnOpSave').onclick = () => RouteOps.save();
    document.getElementById('btnOpDel').onclick  = () => RouteOps.del();

    document.getElementById('cmbKatOp').addEventListener('change', () => {
      RouteOps.fillOperations();
    });

    document.getElementById('cmbOperOp').addEventListener('change', () => {
      RouteOps.updateButtonStates();
    });
  },

  // Загрузка операций для выбранного шага
  loadForStep(step) {
    RouteOps.currentStepId = step.id_shag;
    document.getElementById('opsStepTitle').textContent =
      `№${step.nom_shag} — ${step.exec_shag}`;
    document.getElementById('opsEmptyHint').style.display = 'none';

    // Операции шага — из дочерней таблицы по FK id_shag
    RouteOps.stepOperations = (window.RouteSteps?.operations || [])
      .filter(o => o.id_shag === step.id_shag)
      .map((o, i) => ({ ...o, _nn: i + 1 }));

    state.tables.ops.setData(RouteOps.stepOperations);
    RouteOps.clearForm();
    RouteOps.updateButtonStates();
  },

  clearForStep() {
    RouteOps.currentStepId = null;
    RouteOps.stepOperations = [];
    state.tables.ops.setData([]);
    document.getElementById('opsStepTitle').textContent = '—';
    document.getElementById('opsEmptyHint').style.display = 'block';
    RouteOps.clearForm();
    RouteOps.updateButtonStates();
  },

  fillCategories() {
    const cmbKat = document.getElementById('cmbKatOp');
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

  fillOperations() {
    const category = document.getElementById('cmbKatOp')?.value;
    const cmbOper = document.getElementById('cmbOperOp');
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

  onSelect(row) {
    RouteOps.selectedOpId = row.id_oper;
    const op = RouteOps.stepOperations.find(o => o.id_oper === row.id_oper);
    if (!op) return;

    // Определяем категорию
    const category = RouteOps._getCategory(op.naim_oper);
    document.getElementById('cmbKatOp').value = category;
    RouteOps.fillOperations();
    document.getElementById('cmbOperOp').value = op.naim_oper || '';

    document.getElementById('opFormTitle').textContent =
      `Операция: ${op.naim_oper || ''}`;

    RouteOps.updateButtonStates();
  },

  onHeaderClick() {
    RouteOps.selectedOpId = null;
    RouteOps.clearForm();
    RouteOps.updateButtonStates();
  },

  clearForm() {
    RouteOps.fillCategories();
    RouteOps.fillOperations();
    document.getElementById('opFormTitle').textContent = 'Новая операция';
  },

  _getCategory(opName) {
    for (const [cat, ops] of Object.entries(CATEGORIES)) {
      if (ops.includes(opName)) {
        const map = {
          mech: 'Механическая обработка',
          clean: 'Чистовая мех. обработка',
          thermo: 'Термическая обработка',
          coating: 'Покрытие',
          final: 'Окончательная обработка'
        };
        return map[cat];
      }
    }
    return 'Механическая обработка';
  },

  _buildPayload() {
    // Только наименование: статус/даты принадлежат fakt_marshruta
    return {
      naim_oper: document.getElementById('cmbOperOp').value
    };
  },

  updateButtonStates() {
    const hasStep = RouteOps.currentStepId !== null;
    const hasOp = RouteOps.selectedOpId !== null;
    const hasOperName = !!document.getElementById('cmbOperOp')?.value;

    const locker = hasOp ? isLocked('operatsii_marshruta', RouteOps.selectedOpId) : null;

    const btnAdd  = document.getElementById('btnOpAdd');
    const btnSave = document.getElementById('btnOpSave');
    const btnDel  = document.getElementById('btnOpDel');

    if (!hasStep) {
      btnAdd.disabled = btnSave.disabled = btnDel.disabled = true;
      return;
    }

    if (!hasOp) {
      btnAdd.disabled  = !hasOperName;
      btnSave.disabled = true;
      btnDel.disabled  = true;
    } else {
      btnAdd.disabled  = true;
      btnSave.disabled = !hasOperName || !!locker;
      btnDel.disabled  = !!locker;
    }
  },

  async add() {
    if (!RouteOps.currentStepId) {
      toast('Выберите этап', 'warning');
      return;
    }
    const payload = RouteOps._buildPayload();
    if (!payload.naim_oper) {
      toast('Выберите операцию', 'warning');
      return;
    }

    const r = await api('POST', '/api/operations', {
      id_shag: RouteOps.currentStepId,
      ...payload
    });
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }

    toast('Операция добавлена');
    await window.RouteSteps.loadRoute(window.RouteSteps.curIdDet);
    const step = window.RouteSteps.steps.find(s => s.id_shag === RouteOps.currentStepId);
    if (step) RouteOps.loadForStep(step);
  },

  async save() {
    if (!RouteOps.selectedOpId) return;
    const op = RouteOps.stepOperations.find(o => o.id_oper === RouteOps.selectedOpId);
    if (!op) return;

    const payload = RouteOps._buildPayload();
    if (!payload.naim_oper) {
      toast('Выберите операцию', 'warning');
      return;
    }

    const r = await api('PUT', `/api/operations/${op.id_oper}`, {
      ...op,
      ...payload
    });
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }

    toast('Операция обновлена');
    if (EditLock.current?.id === op.id_oper) EditLock.release();
    await window.RouteSteps.loadRoute(window.RouteSteps.curIdDet);
    const step = window.RouteSteps.steps.find(s => s.id_shag === RouteOps.currentStepId);
    if (step) RouteOps.loadForStep(step);
    state.tables.ops.selectById(op.id_oper);
  },

  async del() {
    if (!RouteOps.selectedOpId) return;
    const op = RouteOps.stepOperations.find(o => o.id_oper === RouteOps.selectedOpId);
    if (!op) return;
    if (!confirm(`Удалить операцию "${op.naim_oper}"?`)) return;

    if (EditLock.current?.id === op.id_oper) EditLock.release();

    const r = await api('DELETE', `/api/operations/${op.id_oper}`);
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }

    toast('Операция удалена', 'warning');
    await window.RouteSteps.loadRoute(window.RouteSteps.curIdDet);
    const step = window.RouteSteps.steps.find(s => s.id_shag === RouteOps.currentStepId);
    if (step) RouteOps.loadForStep(step);
    else RouteOps.clearForStep();
  }
};