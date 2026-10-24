// ============================================================
// МОДУЛЬ: ПЛАН ПЕРЕВОЗОК
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { VirtualTable } from '../common/virtual-table.js';
import { EditLock, isLocked } from '../common/websocket.js';
import { sqlDate } from '../common/date-helpers.js';

export const PlanPerevozok = {
  _allData: [],
  _availableData: [],
  _direction: 'Исходящая',
  selectedId: null,

  async init() {
    // Таблица текущего плана
    const cols = [
      { key: 'nomer_chertezha', label: '№ чертежа', width: '120px' },
      { key: 'osn_naimenovanie', label: 'Наименование', width: '200px' },
      { key: 'nom_shag', label: '№ этапа', width: '60px' }, // ✅ T95
      { key: 'tip_perevozki_name', label: 'Тип перевозки', width: '150px' },
      { key: 'firma_name', label: 'Фирма', width: '120px' }, // ✅ T95
      { key: 'plan_data', label: 'План дата', width: '100px' },
      { key: 'kolvo_no_br', label: 'Годные', width: '70px' },
      { key: 'kolvo_yes_br', label: 'Брак', width: '70px' },
      { key: 'statys', label: 'Статус', width: '120px' },
      { key: 'nom_dogovor', label: 'Основание', width: '120px' }
    ];

    state.tables.plan_perevozok = new VirtualTable(
      document.getElementById('ppTable'), cols,
      {
        idKey: 'id',
        onSelect: r => PlanPerevozok.onSelect(r),
        onHeaderClick: () => PlanPerevozok.onHeaderClick(),
        getLockInfo: (item) => isLocked('plan_perevozok', item.id)
      }
    );

    // Таблица доступных позиций (с множественным выбором)
    const availCols = [
      { key: 'nomer_chertezha', label: '№ чертежа', width: '120px' },
      { key: 'osn_naimenovanie', label: 'Наименование', width: '200px' },
      { key: 'nom_shag', label: '№ этапа', width: '60px' },
      { key: 'tip_perevozki', label: 'Тип перевозки', width: '150px' },
      { key: 'firma_name', label: 'Фирма', width: '120px' },
      { key: 'available_qty', label: 'Доступно', width: '80px' },
      { key: 'nom_dogovor', label: 'Договор', width: '120px' }
    ];

    state.tables.available = new VirtualTable(
      document.getElementById('availableTable'), availCols,
      {
        idKey: 'id_shag',
        multiSelect: true,
        onSelectionChange: () => PlanPerevozok.updateBulkButton()
      }
    );

    // НОВАЯ СХЕМА: селект «Тип перевозки» теперь фильтр списка доступных
    // (тип записи определяется шагом маршрута и на сервер не передаётся)
    document.getElementById('ppTipPerevozki').addEventListener('change', () => PlanPerevozok.applyTypeFilter());

    // Кнопки CRUD
    document.getElementById('btnPPAdd').onclick = () => PlanPerevozok.addFromAvailable();
    document.getElementById('btnPPSave').onclick = () => PlanPerevozok.save();
    document.getElementById('btnPPDel').onclick = () => PlanPerevozok.del();
    document.getElementById('btnBulkAdd').onclick = () => PlanPerevozok.bulkAdd();

    // Смена направления
    document.querySelectorAll('input[name="direction"]').forEach(radio => {
      radio.addEventListener('change', async (e) => {
        PlanPerevozok._direction = e.target.value;
        
        // ✅ НОВОЕ: обновляем список типов перевозок для нового направления
        if (window.loadTransportTypes) {
          await window.loadTransportTypes();
        }
        
        // ✅ Перезагружаем данные (текущий план + доступные позиции)
        await PlanPerevozok.loadAll();
        
        // ✅ Сбрасываем форму, т.к. старый тип перевозки может не подходить
        PlanPerevozok.onHeaderClick();
      });
    });

    // Валидация
    ['ppKolvoNoBr', 'ppKolvoYesBr'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => PlanPerevozok.updateButtonStates());
    });
  },

  async loadAll() {
    await Promise.all([
      PlanPerevozok.loadCurrentPlan(),
      PlanPerevozok.loadAvailablePositions()
    ]);
  },

  async loadCurrentPlan() {
    const data = await api('GET', `/api/plan_perevozok?direction=${PlanPerevozok._direction}`);
    PlanPerevozok._allData = data;
    state.tables.plan_perevozok.setData(data);
    PlanPerevozok.updateButtonStates();
  },

  async loadAvailablePositions() {
    const data = await api('GET', `/api/plan_perevozok/available?direction=${PlanPerevozok._direction}`);
    PlanPerevozok._availableData = data;
    PlanPerevozok.applyTypeFilter();
    PlanPerevozok.updateBulkButton();
  },

  // НОВАЯ СХЕМА: тип перевозки — атрибут шага маршрута; селект в форме
  // работает как фильтр списка доступных позиций
  applyTypeFilter() {
    const tip = document.getElementById('ppTipPerevozki').value;
    const rows = tip
      ? PlanPerevozok._availableData.filter(a => a.id_tipa_perevozki === tip)
      : PlanPerevozok._availableData;
    state.tables.available.setData(rows);
  },

  onSelect(row) {
    PlanPerevozok.selectedId = row.id;

    document.getElementById('ppPlanDate').value = row.plan_data || '';
    document.getElementById('ppKolvoNoBr').value = row.kolvo_no_br || 0;
    document.getElementById('ppKolvoYesBr').value = row.kolvo_yes_br || 0;
    document.getElementById('ppStatys').value = row.statys || '';
    document.getElementById('ppDogOsnov').value = row.dog_osnov || row.nom_dogovor || '';

    document.getElementById('infoNomerChertezha').textContent = row.nomer_chertezha || '—';
    document.getElementById('infoNaimenovanie').textContent = row.osn_naimenovanie || '—';
    document.getElementById('infoNomShag').textContent = row.nom_shag || '—';
    // НОВАЯ СХЕМА: тип перевозки записи теперь показываем в инфо-блоке
    // (изменить его нельзя — он определён шагом маршрута)
    document.getElementById('infoTipPerevozki').textContent = row.tip_perevozki_name || '—';

    document.getElementById('ppFormTitle').textContent = `План перевозки: ${row.nomer_chertezha || ''}`;

    PlanPerevozok.updateButtonStates();
  },

  onHeaderClick() {
    PlanPerevozok.selectedId = null;
    document.getElementById('ppPlanDate').value = sqlDate();
    document.getElementById('ppKolvoNoBr').value = 0;
    document.getElementById('ppKolvoYesBr').value = 0;
    document.getElementById('ppStatys').value = '';
    document.getElementById('ppDogOsnov').value = '';
    document.getElementById('ppFormTitle').textContent = 'Новый план перевозки';
    PlanPerevozok.updateButtonStates();
  },

  updateButtonStates() {
    const hasSelection = PlanPerevozok.selectedId !== null;
    const locker = hasSelection ? isLocked('plan_perevozok', PlanPerevozok.selectedId) : null;
    const kolvo = parseFloat(document.getElementById('ppKolvoNoBr').value) || 0;

    document.getElementById('btnPPAdd').disabled = true;
    document.getElementById('btnPPSave').disabled = !hasSelection || kolvo <= 0 || !!locker;
    document.getElementById('btnPPDel').disabled = !hasSelection || !!locker;
  },

  updateBulkButton() {
    const count = state.tables.available.getSelectedCount();
    document.getElementById('btnBulkAdd').disabled = count === 0;
    document.getElementById('btnBulkAdd').textContent = `➕ Добавить выбранные (${count})`;
  },

  async addFromAvailable() {
    const selectedIds = state.tables.available.getSelectedIds();
    if (selectedIds.length === 0) {
      toast('Выберите позиции для добавления', 'warning');
      return;
    }

    const planDate = document.getElementById('ppPlanDate').value;
    if (!planDate) {
      toast('Укажите плановую дату', 'warning');
      return;
    }

    // НОВАЯ СХЕМА: тип перевозки не выбирается в форме — он определён шагом
    // маршрута (shagi_marshruta.id_tipa_perevozki) и виден в колонке «Тип перевозки»
    const items = selectedIds.map(idShag => {
      const avail = PlanPerevozok._availableData.find(a => a.id_shag === idShag);
      return {
        id_plana: avail.plan_id,
        id_shag: idShag,
        plan_data: planDate,
        kolvo_no_br: avail.available_qty,
        kolvo_yes_br: 0,
        dog_osnov: avail.nom_dogovor || ''
      };
    });

    const r = await api('POST', '/api/plan_perevozok/bulk', { items });
    if (r.error) {
      toast('Ошибка: ' + r.error, 'error');
      return;
    }

    toast(`Добавлено ${r.count} позиций`);
    await PlanPerevozok.loadAll();
    state.tables.available.clearSelection();
  },

  async bulkAdd() {
    await PlanPerevozok.addFromAvailable();
  },

  async save() {
    if (!PlanPerevozok.selectedId) return;

    const payload = {
      id_plana: PlanPerevozok._allData.find(r => r.id === PlanPerevozok.selectedId)?.id_plana,
      id_shag: PlanPerevozok._allData.find(r => r.id === PlanPerevozok.selectedId)?.id_shag,
      plan_data: document.getElementById('ppPlanDate').value,
      kolvo_no_br: parseFloat(document.getElementById('ppKolvoNoBr').value) || 0,
      kolvo_yes_br: parseFloat(document.getElementById('ppKolvoYesBr').value) || 0,
      statys: document.getElementById('ppStatys').value,
      dog_osnov: document.getElementById('ppDogOsnov').value.trim()
    };

    const r = await api('PUT', `/api/plan_perevozok/${PlanPerevozok.selectedId}`, payload);
    if (r.error) {
      toast('Ошибка: ' + r.error, 'error');
      return;
    }

    toast('План перевозки обновлён');
    if (EditLock.current?.id === PlanPerevozok.selectedId) EditLock.release();
    await PlanPerevozok.loadCurrentPlan();
  },

  async del() {
    if (!PlanPerevozok.selectedId) return;
    if (!confirm('Удалить план перевозки?')) return;

    if (EditLock.current?.id === PlanPerevozok.selectedId) EditLock.release();

    const r = await api('DELETE', `/api/plan_perevozok/${PlanPerevozok.selectedId}`);
    if (r.error) {
      toast('Ошибка: ' + r.error, 'error');
      return;
    }

    toast('План перевозки удалён', 'warning');
    await PlanPerevozok.loadAll();
    PlanPerevozok.onHeaderClick();
  }
};