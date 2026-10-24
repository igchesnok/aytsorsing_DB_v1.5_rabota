// ============================================================
// js/modules/transportOpsCustomer.js ВКЛАДКА: ЗАКАЗЧИК (ПТО)
// С АВТООБНОВЛЕНИЕМ через WebSocket
// ============================================================
import { api } from '../common/utils.js';

export const TransportOpsCustomer = {
  _allPTOKontakty: [],
  
  async init() {
    // Обработчики выбора контактов ПТО — автозаполнение телефонов
    document.getElementById('toOtvPTOFIO').addEventListener('change', () => {
      TransportOpsCustomer._fillPhone('toOtvPTOFIO', 'toOtvPTOTel');
    });
    
    document.getElementById('toOtvPogPTOFIO').addEventListener('change', () => {
      TransportOpsCustomer._fillPhone('toOtvPogPTOFIO', 'toOtvPogPTOTel');
    });
    
    // ✅ ПЕРВИЧНАЯ ЗАГРУЗКА
    await TransportOpsCustomer.loadPTOContacts();
  },
  
  // ===== ✅ НОВОЕ: Публичный метод загрузки контактов ПТО =====
    // ===== Загрузка контактов ПТО (код фирмы 1F964) =====
  async loadPTOContacts() {
    try {
      const contacts = await api('GET', '/api/kont?firma_kod=1F964');
      TransportOpsCustomer._allPTOKontakty = Array.isArray(contacts) ? contacts : [];
      
      const selOtvPTO = document.getElementById('toOtvPTOFIO');
      const selOtvPogPTO = document.getElementById('toOtvPogPTOFIO');
      
      // ✅ 1. Сохраняем текущие выбранные значения ПЕРЕД очисткой
      const currentOtvPTO = selOtvPTO.value;
      const currentOtvPogPTO = selOtvPogPTO.value;
      
      selOtvPTO.innerHTML = '<option value="">— Выберите —</option>';
      selOtvPogPTO.innerHTML = '<option value="">— Выберите —</option>';
      
      TransportOpsCustomer._allPTOKontakty.forEach(k => {
        const opt1 = document.createElement('option');
        opt1.value = k.id_kont;
        opt1.textContent = k.fio;
        selOtvPTO.appendChild(opt1);
        
        const opt2 = document.createElement('option');
        opt2.value = k.id_kont;
        opt2.textContent = k.fio;
        selOtvPogPTO.appendChild(opt2);
      });
      
      // ✅ 2. Восстанавливаем значения, если они всё ещё существуют в новом списке
      if (currentOtvPTO && Array.from(selOtvPTO.options).some(opt => opt.value === currentOtvPTO)) {
        selOtvPTO.value = currentOtvPTO;
      }
      if (currentOtvPogPTO && Array.from(selOtvPogPTO.options).some(opt => opt.value === currentOtvPogPTO)) {
        selOtvPogPTO.value = currentOtvPogPTO;
      }
      
      console.log('[TransportOpsCustomer] 🔄 Контакты ПТО обновлены:', TransportOpsCustomer._allPTOKontakty.length);
    } catch (e) {
      console.error('[TransportOpsCustomer.loadPTOContacts] Error:', e);
    }
  },
  
  // ===== ✅ НОВОЕ: Публичный метод перезагрузки (для WS) =====
  async reloadPTOContacts() {
    console.log('[TransportOpsCustomer] 📡 WS: перезагрузка контактов ПТО');
    await TransportOpsCustomer.loadPTOContacts();
  },
  
  // ===== Автозаполнение телефона =====
  _fillPhone(selectId, phoneId) {
    const id = document.getElementById(selectId).value;
    const c = TransportOpsCustomer._allPTOKontakty.find(x => x.id_kont === id);
    document.getElementById(phoneId).value = c?.tel || '';
  },
  
  // ===== Заполнение формы из строки =====
  fillFromRow(row) {
    document.getElementById('toOtvPTOFIO').value = row.otv_pto_fio || '';
    document.getElementById('toOtvPogPTOFIO').value = row.otv_pog_pto_fio || '';
    
    // Автозаполнение телефонов
    TransportOpsCustomer._fillPhone('toOtvPTOFIO', 'toOtvPTOTel');
    TransportOpsCustomer._fillPhone('toOtvPogPTOFIO', 'toOtvPogPTOTel');
  },
  
  // ===== Очистка формы =====
  clearForm() {
    document.getElementById('toOtvPTOFIO').value = '';
    document.getElementById('toOtvPogPTOFIO').value = '';
    document.getElementById('toOtvPTOTel').value = '';
    document.getElementById('toOtvPogPTOTel').value = '';
  },
  
  // ===== Получение данных для payload =====
  getPayload() {
    return {
      otv_pto_fio: document.getElementById('toOtvPTOFIO').value,
      otv_pog_pto_fio: document.getElementById('toOtvPogPTOFIO').value
    };
  }
};