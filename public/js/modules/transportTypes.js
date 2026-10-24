// ============================================================
// МОДУЛЬ: ТИПЫ ПЕРЕВОЗОК
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { VirtualTable } from '../common/virtual-table.js';
import { EditLock, isLocked } from '../common/websocket.js';
// ✅ Кир→Лат: поиск с буквами-двойниками (общий хелпер)
import { matches as hgMatches } from '../common/homoglyph-helper.js';

export const TransportTypes = {
  _allData: [],
  _filteredData: [],

  init() {
    // ✅ Убрана колонка 'uchet_v_ostatke' — она не отображается
    const cols = [
      { key: 'id_tipa',             label: 'ID типа',           width: '120px' },
      { key: 'nazvanie_operatsii',  label: 'Название операции', width: '360px' },
      { key: 'napravlenie',         label: 'Направление',       width: '140px' }
    ];

    state.tables.transport_types = new VirtualTable(
      document.getElementById('ttTable'), cols,
      {
        idKey: 'id_tipa',
        onSelect: r => TransportTypes.onSelect(r),
        onHeaderClick: () => TransportTypes.onHeaderClick(),
        getLockInfo: (item) => isLocked('transport_types', item.id_tipa)
      }
    );

    document.getElementById('btnTTAdd').onclick  = () => TransportTypes.add();
    document.getElementById('btnTTSave').onclick = () => TransportTypes.save();
    document.getElementById('btnTTDel').onclick  = () => TransportTypes.del();

    // Обработчики фильтров
    document.getElementById('fltIdTipa').addEventListener('input',      () => TransportTypes.applyFilters());
    document.getElementById('fltNazvanie').addEventListener('input',    () => TransportTypes.applyFilters());
    document.getElementById('fltNapravlenie').addEventListener('change',() => TransportTypes.applyFilters());

    // Кнопки очистки фильтров
    document.getElementById('btnClearIdTipa').onclick = () => {
      document.getElementById('fltIdTipa').value = '';
      TransportTypes.applyFilters();
    };
    document.getElementById('btnClearNazvanie').onclick = () => {
      document.getElementById('fltNazvanie').value = '';
      TransportTypes.applyFilters();
    };
    document.getElementById('btnClearNapravlenie').onclick = () => {
      document.getElementById('fltNapravlenie').value = '';
      TransportTypes.applyFilters();
    };
    document.getElementById('btnClearAllFilters').onclick = () => {
      document.getElementById('fltIdTipa').value = '';
      document.getElementById('fltNazvanie').value = '';
      document.getElementById('fltNapravlenie').value = '';
      TransportTypes.applyFilters();
    };

    // Обработчики ввода для валидации
    ['ttIdTipa', 'ttNazvanie'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => TransportTypes.updateButtonStates());
    });
    document.getElementById('ttNapravlenie').addEventListener('change', () => TransportTypes.updateButtonStates());
  },

  async load() {
    const data = await api('GET', '/api/transport_types');
    TransportTypes._allData = data;
    TransportTypes.applyFilters();
  },

  applyFilters() {
    const fId   = document.getElementById('fltIdTipa').value.toLowerCase();
    const fNazv = document.getElementById('fltNazvanie').value.toLowerCase();
    const fNapr = document.getElementById('fltNapravlenie').value;

    const filtered = TransportTypes._allData.filter(row => {
      if (fId   && !hgMatches(row.id_tipa, fId)) return false;
      if (fNazv && !hgMatches(row.nazvanie_operatsii, fNazv)) return false;
      if (fNapr && row.napravlenie !== fNapr) return false;
      return true;
    });

    const currentId = state.tables.transport_types.selectedId;
    if (currentId && !filtered.find(r => r.id_tipa === currentId)) {
      state.tables.transport_types.clearSelection();
      TransportTypes.clearForm();
    }

    TransportTypes._filteredData = filtered;
    state.tables.transport_types.setData(filtered);
  },

  onSelect(row) {
    const idInput = document.getElementById('ttIdTipa');
    idInput.value = row.id_tipa || '';
    // ⚠️ При редактировании ID заблокирован — это бизнес-ключ
    idInput.disabled = true;
    idInput.title = 'ID нельзя изменить (это первичный ключ)';

    document.getElementById('ttNazvanie').value    = row.nazvanie_operatsii || '';
    document.getElementById('ttNapravlenie').value = row.napravlenie || '';
    // ✅ Поле 'ttUchet' больше не заполняем — оно вычисляется сервером

    document.getElementById('ttFormTitle').textContent =
      `Тип перевозки: ${row.id_tipa || ''}`;
    document.getElementById('idTipaHint').textContent = '';

    TransportTypes.updateButtonStates();
  },

  onHeaderClick() {
    TransportTypes.clearForm();
    TransportTypes.updateButtonStates();
  },

  clearForm() {
    const idInput = document.getElementById('ttIdTipa');
    idInput.value = '';
    idInput.disabled = false;
    idInput.title = '';
    document.getElementById('ttNazvanie').value    = '';
    document.getElementById('ttNapravlenie').value = '';
    document.getElementById('ttFormTitle').textContent = 'Новый тип перевозки';
    document.getElementById('idTipaHint').textContent = '';
  },

  // ✅ Убрано поле uchet_v_ostatke — сервер вычислит сам
  _buildPayload() {
    return {
      id_tipa:             document.getElementById('ttIdTipa').value.trim().toUpperCase(),
      nazvanie_operatsii:  document.getElementById('ttNazvanie').value.trim(),
      napravlenie:         document.getElementById('ttNapravlenie').value
    };
  },

  _validate(payload, isNew) {
    if (isNew && !payload.id_tipa) {
      document.getElementById('idTipaHint').textContent = 'Введите ID типа (например, OUT_BL)';
      return false;
    }
    if (isNew && !/^[A-Z0-9_]+$/.test(payload.id_tipa)) {
      document.getElementById('idTipaHint').textContent = 'ID: только латиница, цифры и _';
      return false;
    }
    if (!payload.nazvanie_operatsii) {
      toast('Заполните название операции', 'warning');
      return false;
    }
    if (!payload.napravlenie) {
      toast('Выберите направление', 'warning');
      return false;
    }
    return true;
  },

  updateButtonStates() {
    const selectedId = state.tables.transport_types.selectedId;
    const locker = selectedId ? isLocked('transport_types', selectedId) : null;

    const payload = TransportTypes._buildPayload();
    const isValid = TransportTypes._validate(payload, !selectedId);

    const btnAdd  = document.getElementById('btnTTAdd');
    const btnSave = document.getElementById('btnTTSave');
    const btnDel  = document.getElementById('btnTTDel');

    if (!selectedId) {
      btnAdd.disabled  = !isValid;
      btnSave.disabled = true;
      btnDel.disabled  = true;
    } else {
      btnAdd.disabled  = true;
      btnSave.disabled = !isValid || !!locker;
      btnDel.disabled  = !!locker;
    }
  },

  async add() {
    const payload = TransportTypes._buildPayload();
    if (!TransportTypes._validate(payload, true)) return;

    const r = await api('POST', '/api/transport_types', payload);
    if (r.error) {
      toast('Ошибка: ' + r.error, 'error');
      return;
    }

    toast('Тип перевозки добавлен');
    await TransportTypes.load();
    state.tables.transport_types.selectById(r.id);
    const row = TransportTypes._allData.find(x => x.id_tipa === r.id);
    if (row) TransportTypes.onSelect(row);
  },

  async save() {
    const selectedId = state.tables.transport_types.selectedId;
    if (!selectedId) return;

    const payload = TransportTypes._buildPayload();
    if (!TransportTypes._validate(payload, false)) return;

    const r = await api('PUT', `/api/transport_types/${encodeURIComponent(selectedId)}`, payload);
    if (r.error) {
      toast('Ошибка: ' + r.error, 'error');
      return;
    }

    toast('Тип перевозки обновлён');
    if (EditLock.current && EditLock.current.id === selectedId) {
      EditLock.release();
    }
    await TransportTypes.load();
    state.tables.transport_types.selectById(selectedId);
  },

  async del() {
    const selectedId = state.tables.transport_types.selectedId;
    if (!selectedId) return;

    const row = TransportTypes._allData.find(r => r.id_tipa === selectedId);
    if (!confirm(`Удалить тип перевозки "${row?.id_tipa}" — ${row?.nazvanie_operatsii || ''}"?`)) return;

    if (EditLock.current && EditLock.current.id === selectedId) {
      EditLock.release();
    }

    const r = await api('DELETE', `/api/transport_types/${encodeURIComponent(selectedId)}`);
    if (r.error) {
      toast('Ошибка: ' + r.error, 'error');
      return;
    }

    toast('Тип перевозки удалён', 'warning');
    await TransportTypes.load();
    TransportTypes.onHeaderClick();
  }
};