// ============================================================
// js/modules/transportOps.js 
// ОСНОВНОЙ МОДУЛЬ (координатор)
// ✅ ИЗМЕНЕНО: Добавлена FilterableTable и улучшена синхронизация
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { FilterableTable } from '../common/filterable-table.js'; // ✅ ЗАМЕНА: VirtualTable -> FilterableTable
import { EditLock, isLocked } from '../common/websocket.js';
import { batchManager } from '../common/batch-update.js';
import { enableTabs } from '../common/ui/tabs.js';  // ← ДОБАВИТЬ
// Импортируем модули вкладок
import { TransportOpsCustomer } from './transportOpsCustomer.js';
import { TransportOpsReceiver } from './transportOpsReceiver.js';
import { TransportOpsCargo } from './transportOpsCargo.js';
import { TransportOpsParams } from './transportOpsParams.js';
import { TransportOpsDocs } from './transportOpsDocs.js';
import { TransportOpsDriver } from './transportOpsDriver.js';
import { TransportOpsTarn } from './transportOpsTarn.js'; // ✅ T57

export const TransportOps = {
  _allFirmy: [],
  _allPerevozchiki: [],
  _allCex: [],
  _selectedOperId: null,
  _direction: 'Исходящая',

  async init() {
    // Таблица операций (слева)
    const operCols = [
      { key: 'otgruzka_data', label: 'Дата отгр.', width: '90px' },
      { key: 'firma_nazvanie', label: 'Фирма', width: '150px' },
      { key: 'fio_vodit', label: 'Водитель', width: '150px' },
      { key: 'gos_n', label: 'Гос. номер', width: '100px' },
      { key: 'status', 
          label: 'Статус', 
          width: '180px',
          formatter: (value, row) => {
            const color = TransportOps._getStatusColor(value);
            return {
              text: value || '',
              style: {
                backgroundColor: color,
                fontWeight: '600',
                textAlign: 'center',
                color: '#000'
              }
            };
          }
        }
    ];

    // ✅ ИЗМЕНЕНО: Используем FilterableTable для серверной фильтрации
    state.tables.transport_oper = new FilterableTable(
      document.getElementById('operTable'), operCols,
      {
        idKey: 'id',
        apiUrl: '/api/transport-oper',
        filterFields: {
          fltDirection: { dbField: 'napravlenie', type: 'text' },
          fltStatus: { dbField: 'status', type: 'text' },
          fltFirma: { dbField: 'id_firma', type: 'text' }
        },
        debounceMs: 300,
        onSelect: r => TransportOps.onSelect(r),
        onHeaderClick: () => TransportOps.onHeaderClick(),
        getLockInfo: (item) => isLocked('transport_oper', item.id),
        rowClassName: (row) => TransportOps._getStatusClass(row.status)
      }
    );

    // Инициализация модулей вкладок
    await TransportOpsCustomer.init();
    await TransportOpsReceiver.init();
    await TransportOpsCargo.init();
    await TransportOpsParams.init();
    await TransportOpsDocs.init();
    await TransportOpsDriver.init();
    
    document.getElementById('toFirma').addEventListener('change', async () => {
      const selectedFirma = document.getElementById('toFirma').value;
      // ✅ skipReceiver: не очищаем Receiver, чтобы не потерять выбранную фирму
      TransportOps._resetSelection({ skipReceiver: true });
      // ✅ T87: смена фильтра по фирме обновляет список транспортных
      // операций (applyFilters читает toFirma -> SQL id_firma; как у fltStatus)
      TransportOps.applyFilters();
      // ✅ FIX (task15): выбрана фирма -> все вкладки активны;
      // выбор сброшен («— Выберите фирму —») -> вкладки снова неактивны
      enableTabs(!!selectedFirma);
      await TransportOpsReceiver.onFirmaChange(selectedFirma);
      await TransportOpsCargo.loadAvailablePositions();
      TransportOps.updateButtonStates();
    });

    // ✅ НОВОЕ: Устанавливаем себя как координатор для модуля Cargo
    TransportOpsCargo.setCoordinator(TransportOps);
    TransportOpsParams.setCoordinator(TransportOps); // ✅ автозаполнению нужно направление
    // ✅ T57: модалка «Расчёт тарных мест» — доступ к pending/координатору
    TransportOpsTarn.setHost({ cargo: TransportOpsCargo, params: TransportOpsParams, coordinator: TransportOps });
    TransportOpsTarn.init();


    // ✅ ИЗМЕНЕНО: Обработчик фильтра по статусу теперь вызывает applyFilters
    document.getElementById('fltStatus').addEventListener('change', () => {
      TransportOps.applyFilters();
    });

    // Смена направления
    document.querySelectorAll('input[name="direction"]').forEach(radio => {
      radio.addEventListener('change', async (e) => {
        TransportOps._direction = e.target.value;
        TransportOps._resetSelection();          // ✅ вместо 9 строк
        enableTabs(false);                       // ✅ FIX (task15): фирма сброшена — вкладки неактивны
        TransportOps.updateDirectionUI();
        TransportOps.updateStatusFilter();
        await TransportOps.loadFirms();
        await TransportOps.load();
        await TransportOpsCargo.loadAvailablePositions();
        TransportOps.updateButtonStates();
      });
    });

    // Кнопки CRUD
    document.getElementById('btnAdd').onclick = () => TransportOps.add();
    document.getElementById('btnEdit').onclick = () => TransportOps.save();
    document.getElementById('btnDelete').onclick = () => TransportOps.del();

    // Загрузка справочников
    await TransportOps.loadReferences();
    
    // Инициализация полей выбора года
    TransportOps._initYearField('contractYearOt');
    TransportOps._initYearField('contractYearDo');

    // Начальное состояние
    TransportOps.updateDirectionUI();
    TransportOps.updateStatusFilter();
    
    // ✅ Первичная загрузка данных через новый механизм
    await TransportOps.load();
    enableTabs(false);
     // ✅ НОВОЕ: Слушатели событий для новых фильтров фирм
    ['chkFirmaWithCargo', 'contractYearOt', 'contractYearDo'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', async () => {
          // ✅ T87: фирма ДО перезагрузки списка — чтобы заметить её исчезновение
          const prevFirma = document.getElementById('toFirma')?.value || '';
          // 1. Перезагружаем список фирм (без loadAvailablePositions внутри)
          await TransportOps.loadFirms();
          // ✅ T87: fillFirmaSelect() сбрасывает исчезнувшую фирму в '' БЕЗ
          // события change (старый блок «если исчезла» был мёртвым кодом:
          // '' всегда совпадает с placeholder-опцией) — чистим зависимые
          // формы и синхронизируем таблицу операций с фильтром
          const selFirma = document.getElementById('toFirma');
          if (prevFirma && !selFirma?.value) {
            TransportOpsReceiver.clearForm();
            TransportOpsCargo.clearForm();
            TransportOps.applyFilters();
          }
          // 3. Единственный вызов перезагрузки доступных позиций
          await TransportOpsCargo.loadAvailablePositions();
          TransportOps.updateButtonStates();
        });
      }
    });
  },
 
  /** Сбрасывает выбранную операцию и очищает все формы вкладок.
   * @param {Object} [options]
   * @param {boolean} [options.skipReceiver=false] — не очищать форму получателя
   *        (используется при смене фирмы, чтобы не потерять выбранный id_firma)
   */
  _resetSelection({ skipReceiver = false } = {}) {
    TransportOps._selectedOperId = null;
    state.tables.transport_oper.clearSelection();
    document.getElementById('toStatusBlok').style.display = 'none';
    TransportOpsCustomer.clearForm();
    if (!skipReceiver) TransportOpsReceiver.clearForm();
    TransportOpsParams.clearForm();
    TransportOpsDocs.clearForm();
    TransportOpsDriver.clearForm();
    TransportOpsCargo.clearForm();
  },
  // ============================================================
  // ✅ ИСПРАВЛЕНО: loadFirms теперь передаёт направление
  // ============================================================
  async loadFirms() {
    const yearOt = document.getElementById('contractYearOt')?.value || '1900';
    const yearDo = document.getElementById('contractYearDo')?.value || '2100';
    const hasCargo = document.getElementById('chkFirmaWithCargo')?.checked ? '1' : '0';
    
    // ✅ НОВОЕ: берём текущее направление
    const napravlenie = TransportOps._direction;

    const params = new URLSearchParams({
      yearFrom: yearOt,
      yearTo: yearDo,
      hasCargo: hasCargo,
      napravlenie: napravlenie  // ← ДОБАВЛЕНО
    });

    // Сохраняем текущее выбранное значение ДО перезагрузки
    const selFirma = document.getElementById('toFirma');
    const currentValue = selFirma?.value || '';

    TransportOps._allFirmy = await api('GET', `/api/firmy?${params.toString()}`);
    await TransportOpsReceiver.fillFirmaSelect(TransportOps._allFirmy);

    // ✅ Если выбранная фирма исчезла из списка — сбрасываем выбор
    if (currentValue && !TransportOps._allFirmy.find(f => f.id_firmy === currentValue)) {
      if (selFirma) selFirma.value = '';
      TransportOpsReceiver.clearForm();
    }
  },
  // ============================================================
  // ВСПОМОГАТЕЛЬНЫЙ МЕТОД ДЛЯ ПОЛЕЙ ГОДА
  // ============================================================
  _initYearField(id) {
      const el = document.getElementById(id);
      if (!el) return;
      const now = new Date().getFullYear();
      el.min = now - 100;
      el.max = now;
      el.value = now;
      el.addEventListener('wheel', function(e) {
          e.preventDefault();
          const delta = e.deltaY > 0 ? 1 : -1;
          let val = parseInt(this.value) + delta;
          const min = parseInt(this.min);
          const max = parseInt(this.max);
          if (val < min) val = min;
          if (val > max) val = max;
          this.value = val;
      });
      el.addEventListener('keydown', (e) => {
        const allowed = ['ArrowUp', 'ArrowDown', 'Tab', 'Enter'];
        if (!allowed.includes(e.key)) {
            e.preventDefault();
        }
      });
  },
  // ============================================================
  // МЕТОДЫ ДЛЯ СИНХРОНИЗАЦИИ (WebSocket)
  // ============================================================
  
  async refreshAvailablePositions() {
    await TransportOpsCargo.loadAvailablePositions();
  },

  async refreshCurrentPositions() {
    if (TransportOps._selectedOperId) {
      await TransportOpsCargo.loadPositions();
    }
  },

  async reloadPerevozchiki() {
    console.log('[TransportOps] 🔄 Перезагрузка перевозчиков (WS)');
    TransportOps._allPerevozchiki = await api('GET', '/api/perevozchik');
    await TransportOpsDriver.fillPerevozchikSelects(TransportOps._allPerevozchiki);
  },

  async reloadFirmy() {
    console.log('[TransportOps] 🔄 Перезагрузка фирм (WS)');
    TransportOps._allFirmy = await api('GET', '/api/firmy');
    await TransportOpsReceiver.fillFirmaSelect(TransportOps._allFirmy);
  },

  async reloadCex() {
    console.log('[TransportOps] 🔄 Перезагрузка цехов (WS)');
    TransportOps._allCex = await api('GET', '/api/cex');
    await TransportOpsParams.fillCexSelects(TransportOps._allCex);
  },

  async reloadPTOContacts() {
    console.log('[TransportOps] 🔄 Перезагрузка контактов ПТО (WS)');
    await TransportOpsCustomer.loadPTOContacts();
  },

  // ============================================================
  // ОСНОВНАЯ ЛОГИКА
  // ============================================================

  // ✅ НОВОЕ: Централизованное применение фильтров
  applyFilters() {
    state.tables.transport_oper.applyFilters({
      fltDirection: TransportOps._direction,
      fltStatus: document.getElementById('fltStatus')?.value || '',
      fltFirma: document.getElementById('toFirma')?.value || ''
    });
  },

  // ✅ Переход на метод FilterableTable для первичной загрузки
  async load() {
    await state.tables.transport_oper.loadImmediate({
      fltDirection: TransportOps._direction,
      fltStatus: document.getElementById('fltStatus')?.value || '',
      fltFirma: document.getElementById('toFirma')?.value || ''
    });
  },

  updateStatusFilter() {
    const sel = document.getElementById('fltStatus');
    if (!sel) return;
    
    const isSending = TransportOps._direction === 'Исходящая';
    const currentValue = sel.value;
    
    sel.innerHTML = '<option value="">Все статусы</option>';
    
    if (isSending) {
      sel.innerHTML += `
        <option value="Ожидает отправки">🟠 Ожидает отправки</option>
        <option value="Подготовка к отгрузке">🟠 Подготовка к отгрузке</option>
        <option value="В пути">🟡 В пути</option>
        <option value="Выполнена">🟢 Выполнена</option>
      `;
    } else {
      sel.innerHTML += `
        <option value="Ожидает прибытия">🟠 Ожидает прибытия</option>
        <option value="Подготовка к прибытию">🟠 Подготовка к прибытию</option>
        <option value="В пути">🟡 В пути</option>
        <option value="Выполнена">🟢 Выполнена</option>
      `;
    }
    
    const validOptions = Array.from(sel.options).map(o => o.value);
    sel.value = validOptions.includes(currentValue) ? currentValue : '';
  },


  // ✅ ОБНОВЛЕННАЯ ФУНКЦИЯ: Используем loadFirms вместо прямого вызова api
  async loadReferences() {
    await TransportOps.loadFirms(); // <-- Заменяем прямую загрузку на нашу новую функцию

    TransportOps._allPerevozchiki = await api('GET', '/api/perevozchik');
    await TransportOpsDriver.fillPerevozchikSelects(TransportOps._allPerevozchiki);

    TransportOps._allCex = await api('GET', '/api/cex');
    await TransportOpsParams.fillCexSelects(TransportOps._allCex);

    await TransportOpsCustomer.loadPTOContacts();
    await TransportOpsCargo.loadAvailablePositions();
  },


  updateDirectionUI() {
    const isSending = TransportOps._direction === 'Исходящая';
    const tabFirma = document.getElementById('tabFirmaBtn');
    
    if (isSending) {
      tabFirma.textContent = 'ПОЛУЧАТЕЛЬ';
      document.getElementById('lblFirmaTitle').textContent = 'Данные о грузополучателе';
      document.getElementById('lblOtruzkaPrib').textContent = 'ОТГРУЗКА';
      document.getElementById('lblPribOtruz').textContent = 'ПРИБЫТИЕ';
      document.getElementById('lblKontaktnoeLicoPTO').textContent = 'Контактное лицо ПТО на отгрузке';
      document.getElementById('lblPozTitle').textContent = 'Список позиций на отправку';
      document.getElementById('lblAvailTitle').textContent = 'Список позиций доступных из плана перевозок к отправке';
    } else {
      tabFirma.textContent = 'ОТПРАВИТЕЛЬ';
      document.getElementById('lblFirmaTitle').textContent = 'Данные о грузоотправителе';
      document.getElementById('lblOtruzkaPrib').textContent = 'ПРИБЫТИЕ';
      document.getElementById('lblPribOtruz').textContent = 'ОТГРУЗКА';
      document.getElementById('lblKontaktnoeLicoPTO').textContent = 'Контактное лицо ПТО на приёмке';
      document.getElementById('lblPozTitle').textContent = 'Список позиций на приёмку';
      document.getElementById('lblAvailTitle').textContent = 'Список позиций доступных из плана перевозок к приёмке';
    }
  },

  _getStatusColor(status) {
    switch (status) {
      case 'Ожидает отправки':
      case 'Ожидает прибытия':
      case 'Подготовка к отгрузке':
      case 'Подготовка к прибытию':
        return '#ffcdd2';
      case 'В пути':
        return '#fff9c4';
      case 'Выполнена':
        return '#c8e6c9';
      default:
        return '#f5f5f5';
    }
  },

  _getStatusClass(status) {
    switch (status) {
      case 'Ожидает отправки':
      case 'Ожидает прибытия':
      case 'Подготовка к отгрузке':
      case 'Подготовка к прибытию':
        return 'status-waiting';
      case 'В пути':
        return 'status-transit';
      case 'Выполнена':
        return 'status-completed';
      default:
        return '';
    }
  },

  async onSelect(row) {
    TransportOps._selectedOperId = row.id;
    
    document.getElementById('toStatusBlok').style.display = '';
    const statusEl = document.getElementById('toStatus');
    if (statusEl) {
      statusEl.textContent = row.status || '';
      statusEl.style.backgroundColor = TransportOps._getStatusColor(row.status);
      statusEl.style.color = '#000';
    }

    await TransportOpsCustomer.fillFromRow(row);
    await TransportOpsReceiver.fillFromRow(row);
    await TransportOpsParams.fillFromRow(row);
    await TransportOpsDocs.fillFromRow(row);
    await TransportOpsDriver.fillFromRow(row, TransportOps._allPerevozchiki);

    await TransportOpsCargo.loadPositions();
    await TransportOpsCargo.loadAvailablePositions();

    TransportOps.updateButtonStates();
    enableTabs(true);
  },

  async onHeaderClick() {
    TransportOps._resetSelection();
    enableTabs(false); // ✅ FIX (task15): полный сброс — вкладки снова неактивны
    // ✅ T87: _resetSelection -> Receiver.clearForm() сбросил #toFirma
    // («— Выберите фирму —») — синхронизируем таблицу операций с фильтром
    TransportOps.applyFilters();
    await TransportOpsCargo.loadAvailablePositions();
    TransportOps.updateButtonStates();
  },

  updateButtonStates() {
    const hasSelection = TransportOps._selectedOperId !== null;
    const locker = hasSelection ? isLocked('transport_oper', TransportOps._selectedOperId) : null;
    const hasPendingPositions = TransportOpsCargo.hasPendingPositions();

    const btnAdd = document.getElementById('btnAdd');
    const btnEdit = document.getElementById('btnEdit');
    const btnDelete = document.getElementById('btnDelete');

    if (!hasSelection) {
      btnAdd.disabled = !hasPendingPositions;
      btnEdit.disabled = true;
      btnDelete.disabled = true;
    } else {
      btnAdd.disabled = true;
      btnEdit.disabled = !!locker;
      btnDelete.disabled = !!locker;
    }
  },

  _buildPayload() {
    return {
      napravlenie: TransportOps._direction,
      ...TransportOpsCustomer.getPayload(),
      ...TransportOpsReceiver.getPayload(),
      ...TransportOpsParams.getPayload(),
      ...TransportOpsDocs.getPayload(),
      ...TransportOpsDriver.getPayload(),
      // ✅ T57-f: тарные места — pending-буфер ТОЛЬКО для новой операции
      // (режим создания). При редактировании — сохранённый JSON вкладки,
      // иначе «Редактировать» затирал tarn_mesta пустой строкой и тарные
      // места сбрасывались в «не рассчитаны»
      tarn_mesta: TransportOpsCargo.getPendingTarnMesta() ||
                  TransportOpsParams._currentTarnMesta || ''
    };
  },

  async add() {
    const payload = TransportOps._buildPayload();
    // ✅ СТАТУС НЕ ОТПРАВЛЯЕМ: status — вычисляемое поле по датам
    // отправки/прибытия от текущей даты (TRANSPORT_STATUS_SQL на сервере,
    // syntheticTables.js). Прежняя строка payload.status = "Ожидает
    // отправки" не нужна — сервер инициализирует хранимую колонку сам.
    
    if (!payload.id_firma || !payload.otgruzka_data) {
      toast('Заполните обязательные поля: Фирма, Дата отгрузки', 'warning');
      return;
    }

    const positions = TransportOpsCargo.getPendingPositions();
    if (positions.length === 0) {
      toast('Добавьте хотя бы одну позицию для создания операции', 'warning');
      return;
    }

    await batchManager.withBatch('transport_oper', async () => {
      try {
        const r = await api('POST', '/api/transport-oper', { ...payload, positions });

        if (r.error) {
          toast(`❌ ${r.error}`, 'error');
          TransportOpsCargo.clearForm();
          TransportOps.updateButtonStates();
          return;
        }

        toast(r.message || `Операция создана. Позиций: ${r.positionsCount}`, 'success');
        TransportOpsCargo.clearForm();

        await TransportOps.load();
        state.tables.transport_oper.selectById(r.id);
        const row = state.tables.transport_oper.data.find(x => x.id === r.id);
        if (row) await TransportOps.onSelect(row);
      } catch (networkErr) {
        toast('Сетевая ошибка: ' + networkErr.message, 'error');
      }
    });
  },

  async save() {
    if (!TransportOps._selectedOperId) return;

    const payload = TransportOps._buildPayload();

    await batchManager.withBatch('transport_oper', async () => {
      const r = await api('PUT', `/api/transport-oper/${TransportOps._selectedOperId}`, payload);
      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        return;
      }
      toast('Транспортная операция обновлена');
      await TransportOps.load();
    });
  },

  async del() {
    if (!TransportOps._selectedOperId) return;
    if (!confirm('Удалить транспортную операцию?')) return;

    batchManager.begin('transport_oper');
    batchManager.begin('gryz_poz');
    
    try {
      const r = await api('DELETE', `/api/transport-oper/${TransportOps._selectedOperId}`);
      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        return;
      }
      toast('Транспортная операция удалена', 'warning');
      await TransportOps.load();
      TransportOps.onHeaderClick();
    } finally {
      batchManager.end('gryz_poz');
      batchManager.end('transport_oper');
    }
  },
};