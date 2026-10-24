// ============================================================
// js/modules/transportOpsDriver.js ВКЛАДКА: ДАННЫЕ О ВОДИТЕЛЕ
// С АВТООБНОВЛЕНИЕМ через WebSocket
// ============================================================
import { api } from '../common/utils.js';
import { state } from '../common/state.js';
import { VirtualTable } from '../common/virtual-table.js';

export const TransportOpsDriver = {
  _allPerevozchiki: [],
  
  async init() {
    // Таблица перевозчиков
    const perevozchikCols = [
      { key: 'gos_n', label: 'Гос. номер', width: '100px' },
      { key: 'fio_vodit', label: 'ФИО водителя', width: '200px' },
      { key: 'marka_tc', label: 'Марка ТС', width: '120px' },
      { key: 'kontakt', label: 'Телефон', width: '120px' }
    ];
    
    state.tables.perevozchik = new VirtualTable(
      document.getElementById('perevozchikTable'), perevozchikCols,
      {
        idKey: 'id',
        onSelect: r => TransportOpsDriver.onPerevozchikSelect(r),
        onHeaderClick: () => TransportOpsDriver.onPerevozchikHeaderClick(),
        onDblClick: r => {
          if (r && r.id) {
            window.open(
              `../pages/carriers.html?editId=${encodeURIComponent(r.id)}`,
              '_blank',
              'width=1400,height=900,menubar=no,toolbar=no'
            );
          }
        }
      }
    );
    
    // Обработчики селектов
    document.getElementById('toGosN').addEventListener('change', () => {
      TransportOpsDriver.onGosNFilterChange();
    });
    
    document.getElementById('toFIOVodit').addEventListener('change', () => {
      TransportOpsDriver.onFIOFilterChange();
    });
    
    // Кнопка редактирования перевозчика
    document.getElementById('btnEditPerevozchik').onclick = () => {
      const selectedId = document.getElementById('toGosN')?.value;
      const url = selectedId
        ? `../pages/carriers.html?editId=${encodeURIComponent(selectedId)}`
        : `../pages/carriers.html`;
      window.open(url, '_blank', 'width=1400,height=900,menubar=no,toolbar=no');
    };
    
    // ✅ ПЕРВИЧНАЯ ЗАГРУЗКА
    await TransportOpsDriver.loadPerevozchiki();
  },
  
  // ===== ✅ НОВОЕ: Публичный метод загрузки перевозчиков =====
  async loadPerevozchiki() {
    try {
      const data = await api('GET', '/api/perevozchik');
      TransportOpsDriver._allPerevozchiki = Array.isArray(data) ? data : [];
      
      // Обновляем таблицу
      if (state.tables.perevozchik) {
        state.tables.perevozchik.setData(TransportOpsDriver._allPerevozchiki);
      }
      
      // Обновляем селекты
      TransportOpsDriver.fillPerevozchikSelects(TransportOpsDriver._allPerevozchiki);
      
      console.log('[TransportOpsDriver] 🔄 Перевозчики обновлены:', TransportOpsDriver._allPerevozchiki.length);
    } catch (e) {
      console.error('[TransportOpsDriver.loadPerevozchiki] Error:', e);
    }
  },
  
  // ===== ✅ НОВОЕ: Публичный метод перезагрузки (для WS) =====
  async reloadPerevozchiki() {
    console.log('[TransportOpsDriver]  WS: перезагрузка перевозчиков');
    await TransportOpsDriver.loadPerevozchiki();
  },
  
  // ===== Заполнение селектов перевозчиков =====
  fillPerevozchikSelects(perevozchiki) {
    const selGosN = document.getElementById('toGosN');
    const selFIO = document.getElementById('toFIOVodit');
    
    if (!selGosN || !selFIO) return;
    
    // Сохраняем текущие значения
    const curGosN = selGosN.value;
    const curFIO = selFIO.value;
    
    selGosN.innerHTML = '<option value="">— Выберите гос. номер —</option>';
    selFIO.innerHTML = '<option value="">— Выберите ФИО водителя —</option>';
    
    // Сортируем перевозчиков для удобства
    const sorted = [...perevozchiki].sort((a, b) =>
      (a.gos_n || '').localeCompare(b.gos_n || '')
    );
    
    sorted.forEach(p => {
      // Селект "Гос. номер"
      if (p.gos_n) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.gos_n;
        opt.dataset.fio = p.fio_vodit || '';
        opt.dataset.marka = p.marka_tc || '';
        opt.dataset.kontakt = p.kontakt || '';
        opt.dataset.firma = p.firma || '';
        opt.dataset.voditUd = p.vodit_ud || '';
        selGosN.appendChild(opt);
      }
      
      // Селект "ФИО водителя"
      if (p.fio_vodit) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.fio_vodit;
        opt.dataset.gosN = p.gos_n || '';
        opt.dataset.marka = p.marka_tc || '';
        opt.dataset.kontakt = p.kontakt || '';
        opt.dataset.firma = p.firma || '';
        opt.dataset.voditUd = p.vodit_ud || '';
        selFIO.appendChild(opt);
      }
    });
    
    // Восстанавливаем значения, если они были
    if (curGosN) selGosN.value = curGosN;
    if (curFIO) selFIO.value = curFIO;
  },
  
  // ===== Заполнение формы из строки =====
  fillFromRow(row, perevozchiki) {
    if (row.id_perevozchik) {
      const selGosN = document.getElementById('toGosN');
      const selFIO = document.getElementById('toFIOVodit');
      
      if (selGosN) selGosN.value = row.id_perevozchik;
      if (selFIO) selFIO.value = row.id_perevozchik;
      
      const pervoz = (perevozchiki || TransportOpsDriver._allPerevozchiki)
        .find(p => p.id === row.id_perevozchik);
      
      if (pervoz) {
        document.getElementById('toMarkaTC').value = pervoz.marka_tc || '';
        document.getElementById('toVoditUD').value = pervoz.vodit_ud || '';
        document.getElementById('toKontakt').value = pervoz.kontakt || '';
        document.getElementById('toPerevozchikFirma').value = pervoz.firma || '';
      } else {
        document.getElementById('toMarkaTC').value = '';
        document.getElementById('toVoditUD').value = '';
        document.getElementById('toKontakt').value = '';
        document.getElementById('toPerevozchikFirma').value = '';
      }
    } else {
      TransportOpsDriver.clearForm();
    }
  },
  
  // ===== Очистка формы =====
  clearForm() {
    const selGosN = document.getElementById('toGosN');
    const selFIO = document.getElementById('toFIOVodit');
    
    if (selGosN) selGosN.value = '';
    if (selFIO) selFIO.value = '';
    
    ['toMarkaTC', 'toVoditUD', 'toKontakt', 'toPerevozchikFirma'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    
    if (state.tables.perevozchik) {
      state.tables.perevozchik.setData(TransportOpsDriver._allPerevozchiki);
    }
  },
  
  // ===== Получение данных для payload =====
  getPayload() {
    return {
      id_perevozchik: document.getElementById('toGosN').value
    };
  },
  
  // ===== Обработчик выбора перевозчика в таблице =====
  onPerevozchikSelect(row) {
    if (!row) return;
    
    document.getElementById('toMarkaTC').value = row.marka_tc || '';
    document.getElementById('toVoditUD').value = row.vodit_ud || '';
    document.getElementById('toKontakt').value = row.kontakt || '';
    document.getElementById('toPerevozchikFirma').value = row.firma || '';
    
    const selGosN = document.getElementById('toGosN');
    const selFIO = document.getElementById('toFIOVodit');
    
    if (selGosN) selGosN.value = row.id || '';
    if (selFIO) selFIO.value = row.id || '';
  },
  
  // ===== Клик по заголовку таблицы перевозчиков =====
  onPerevozchikHeaderClick() {
    const selGosN = document.getElementById('toGosN');
    const selFIO = document.getElementById('toFIOVodit');
    
    if (selGosN) selGosN.value = '';
    if (selFIO) selFIO.value = '';
    
    ['toMarkaTC', 'toVoditUD', 'toKontakt', 'toPerevozchikFirma'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    
    if (state.tables.perevozchik) {
      state.tables.perevozchik.setData(TransportOpsDriver._allPerevozchiki);
    }
  },
  
  // ===== Обработчик выбора "Гос. номер" — фильтрация таблицы =====
  onGosNFilterChange() {
    const selGosN = document.getElementById('toGosN');
    const selFIO = document.getElementById('toFIOVodit');
    
    if (!selGosN) return;
    
    const selectedId = selGosN.value;
    
    if (!selectedId) {
      state.tables.perevozchik.setData(TransportOpsDriver._allPerevozchiki);
      document.getElementById('toMarkaTC').value = '';
      document.getElementById('toVoditUD').value = '';
      document.getElementById('toKontakt').value = '';
      document.getElementById('toPerevozchikFirma').value = '';
      if (selFIO) selFIO.value = '';
      return;
    }
    
    const pervoz = TransportOpsDriver._allPerevozchiki.find(p => p.id === selectedId);
    
    if (!pervoz) return;
    
    document.getElementById('toMarkaTC').value = pervoz.marka_tc || '';
    document.getElementById('toVoditUD').value = pervoz.vodit_ud || '';
    document.getElementById('toKontakt').value = pervoz.kontakt || '';
    document.getElementById('toPerevozchikFirma').value = pervoz.firma || '';
    
    if (selFIO) selFIO.value = selectedId;
    
    state.tables.perevozchik.setData([pervoz]);
    state.tables.perevozchik.selectById(selectedId);
  },
  
  // ===== Обработчик выбора "ФИО водителя" — фильтрация таблицы =====
  onFIOFilterChange() {
    const selGosN = document.getElementById('toGosN');
    const selFIO = document.getElementById('toFIOVodit');
    
    if (!selFIO) return;
    
    const selectedId = selFIO.value;
    
    if (!selectedId) {
      state.tables.perevozchik.setData(TransportOpsDriver._allPerevozchiki);
      document.getElementById('toMarkaTC').value = '';
      document.getElementById('toVoditUD').value = '';
      document.getElementById('toKontakt').value = '';
      document.getElementById('toPerevozchikFirma').value = '';
      if (selGosN) selGosN.value = '';
      return;
    }
    
    const pervoz = TransportOpsDriver._allPerevozchiki.find(p => p.id === selectedId);
    
    if (!pervoz) return;
    
    document.getElementById('toMarkaTC').value = pervoz.marka_tc || '';
    document.getElementById('toVoditUD').value = pervoz.vodit_ud || '';
    document.getElementById('toKontakt').value = pervoz.kontakt || '';
    document.getElementById('toPerevozchikFirma').value = pervoz.firma || '';
    
    if (selGosN) selGosN.value = selectedId;
    
    state.tables.perevozchik.setData([pervoz]);
    state.tables.perevozchik.selectById(selectedId);
  }
};