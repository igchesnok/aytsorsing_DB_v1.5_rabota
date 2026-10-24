// ============================================================
// js/modules/transportOpsReceiver.js ВКЛАДКА: ПОЛУЧАТЕЛЬ/ОТПРАВИТЕЛЬ
// С АВТООБНОВЛЕНИЕМ через WebSocket
// ============================================================
import { api } from '../common/utils.js';

export const TransportOpsReceiver = {
  _allFirmKontakty: [],
  _allAdresa: [],
  _currentFirmaId: null,
  
  async init() {

    
    // Обработчик выбора контакта фирмы
    document.getElementById('toOtvPogFirmFIO').addEventListener('change', () => {
      const id = document.getElementById('toOtvPogFirmFIO').value;
      const c = TransportOpsReceiver._allFirmKontakty.find(x => x.id_kont == id);
      if (c) {
        document.getElementById('toOtvPogFirmTel').value = c.tel || '';
        document.getElementById('toOtvPogFirmEmail').value = c.email || '';
      }
    });
    
    // Кнопка редактирования фирмы
    document.getElementById('btnEditFirma').onclick = () => {
      const firmId = document.getElementById('toFirma').value;
      const url = firmId
        ? `../pages/firms.html?editId=${encodeURIComponent(firmId)}`
        : `../pages/firms.html`;
      window.open(url, '_blank', 'width=1400,height=900');
    };
  },
  
  // ===== ✅ НОВОЕ: Публичный метод заполнения селекта фирм =====
  // ===== Заполнение селекта фирм =====
async fillFirmaSelect(firmy) {
  const selFirma = document.getElementById('toFirma');
  if (!selFirma) return;
  
  // 1. Сохраняем текущее значение
  const currentValue = selFirma.value;
  
  selFirma.innerHTML = '<option value="">— Выберите фирму —</option>';
  firmy.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id_firmy;
    opt.textContent = f.naimenovanie;
    selFirma.appendChild(opt);
  });
  
  // 3. Восстанавливаем, если фирма всё ещё есть в списке
  if (currentValue && Array.from(selFirma.options).some(opt => opt.value === currentValue)) {
    selFirma.value = currentValue;
  } else {
    selFirma.value = ''; // Сброс, если фирма была удалена
  }
},
  
  // ===== ✅ НОВОЕ: Публичный метод перезагрузки фирм (для WS) =====
  async reloadFirmy(firmy) {
    console.log('[TransportOpsReceiver]  WS: перезагрузка фирм');
    await TransportOpsReceiver.fillFirmaSelect(firmy);
  },
  
  // ===== Заполнение формы из строки =====
  async fillFromRow(row) {
    document.getElementById('toFirma').value = row.id_firma || '';
    
    if (row.id_firma) {
      await TransportOpsReceiver.onFirmaChange(row.id_firma);
      
      document.getElementById('toOtvPogFirmFIO').value = row.otv_pog_firm_fio || '';
      document.getElementById('toAdresPogFirm').value = row.adres_pog_firm || '';
      
      const c = TransportOpsReceiver._allFirmKontakty.find(x => x.id_kont === row.otv_pog_firm_fio);
      if (c) {
        document.getElementById('toOtvPogFirmTel').value = c.tel || '';
        document.getElementById('toOtvPogFirmEmail').value = c.email || '';
      }
    }
  },
  
  // ===== Очистка формы =====
  clearForm() {
    document.getElementById('toFirma').value = '';
    document.getElementById('toFirmaKod').value = '';
    document.getElementById('toFirmaINN').value = '';
    document.getElementById('toFirmaUrAdres').value = '';
    document.getElementById('toOtvPogFirmFIO').innerHTML = '<option value="">— Выберите —</option>';
    document.getElementById('toOtvPogFirmTel').value = '';
    document.getElementById('toOtvPogFirmEmail').value = '';
    document.getElementById('toAdresPogFirm').innerHTML = '<option value="">— Выберите адрес —</option>';
    document.getElementById('toFirmaSpr').value = '';
    TransportOpsReceiver._currentFirmaId = null;
  },
  
  // ===== Получение данных для payload =====
  getPayload() {
    return {
      id_firma: document.getElementById('toFirma').value,
      otv_pog_firm_fio: document.getElementById('toOtvPogFirmFIO').value,
      adres_pog_firm: document.getElementById('toAdresPogFirm').value
    };
  },
  
  // ===== Обработка выбора фирмы =====
  async onFirmaChange(firmId = null) {
    const id = firmId || document.getElementById('toFirma').value;
    
    if (!id) {
      TransportOpsReceiver.clearForm();
      return;
    }
    
    TransportOpsReceiver._currentFirmaId = id;
    
    // Найти фирму
    const firmy = await api('GET', '/api/firmy');
    const firma = firmy.find(f => f.id_firmy === id);
    
    if (firma) {
      document.getElementById('toFirmaKod').value = firma.kod || '';
      document.getElementById('toFirmaINN').value = firma.inn || '';
      document.getElementById('toFirmaUrAdres').value = firma.ur_adres || '';
      document.getElementById('toFirmaSpr').value = firma.naimenovanie || '';
    }
    
    // Загрузить контакты и адреса
    await TransportOpsReceiver.loadFirmContacts(id);
    await TransportOpsReceiver.loadFirmAddresses(id);
  },
  
  // ===== ✅ НОВОЕ: Публичный метод перезагрузки контактов фирмы (для WS) =====
  async reloadFirmContacts() {
    if (TransportOpsReceiver._currentFirmaId) {
      console.log('[TransportOpsReceiver] 📡 WS: перезагрузка контактов фирмы');
      await TransportOpsReceiver.loadFirmContacts(TransportOpsReceiver._currentFirmaId);
    }
  },
  
  // ===== ✅ НОВОЕ: Публичный метод перезагрузки адресов фирмы (для WS) =====
  async reloadFirmAddresses() {
    if (TransportOpsReceiver._currentFirmaId) {
      console.log('[TransportOpsReceiver] 📡 WS: перезагрузка адресов фирмы');
      await TransportOpsReceiver.loadFirmAddresses(TransportOpsReceiver._currentFirmaId);
    }
  },
  

// ===== Загрузка контактов фирмы =====
async loadFirmContacts(firmId) {
  try {
    const contacts = await api('GET', `/api/kont?id_firmy=${firmId}`);
    TransportOpsReceiver._allFirmKontakty = contacts;
    const selContact = document.getElementById('toOtvPogFirmFIO');
    if (!selContact) return;

    // 1. Сохраняем
    const currentValue = selContact.value;
    
    selContact.innerHTML = '<option value="">— Выберите —</option>';
    contacts.forEach(k => {
      const opt = document.createElement('option');
      opt.value = k.id_kont;
      opt.textContent = k.fio;
      selContact.appendChild(opt);
    });
    
    // 3. Восстанавливаем
    if (currentValue && Array.from(selContact.options).some(opt => opt.value === currentValue)) {
      selContact.value = currentValue;
    }
  } catch (e) {
    console.error('[loadFirmContacts] Error:', e);
  }
},
  
 // ===== Загрузка адресов фирмы =====
async loadFirmAddresses(firmId) {
  try {
    const addresses = await api('GET', `/api/adres?id_firmy=${firmId}`);
    const selAddress = document.getElementById('toAdresPogFirm');
    if (!selAddress) return;

    // 1. Сохраняем
    const currentValue = selAddress.value;
    
    selAddress.innerHTML = '<option value="">— Выберите адрес —</option>';
    addresses.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.fakt_adres;
      opt.textContent = a.fakt_adres;
      selAddress.appendChild(opt);
    });
    
    // 3. Восстанавливаем
    if (currentValue && Array.from(selAddress.options).some(opt => opt.value === currentValue)) {
      selAddress.value = currentValue;
    }
  } catch (e) {
    console.error('[loadFirmAddresses] Error:', e);
  }
}
};