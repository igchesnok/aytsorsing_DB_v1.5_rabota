// public/js/test-virtual-select.js
import { VirtualSelect } from './common/virtual-select.js';



// Счётчики
let totalLoaded = 0;
let requestCount = 0;

// Логгер
function log(msg) {
  const logEl = document.getElementById('log');
  const time = new Date().toLocaleTimeString('ru-RU');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-msg">${msg}</span>`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

// Перехватываем fetch, чтобы считать запросы и объём
const originalFetch = window.fetch;
window.fetch = async function(url, opts) {
  if (typeof url === 'string' && url.includes('/api/test-virtual-select')) {
    requestCount++;
    document.getElementById('statRequests').textContent = requestCount;
    log(`📡 Запрос #${requestCount}: ${url}`);
    const t0 = performance.now();
    const res = await originalFetch(url, opts);
    const clone = res.clone();
    const data = await clone.json();
    totalLoaded += Array.isArray(data) ? data.length : 0;
    document.getElementById('statLoaded').textContent = totalLoaded;
    const dt = (performance.now() - t0).toFixed(1);
    log(`✅ Получено ${data.length} записей за ${dt} мс`);
    return res;
  }
  return originalFetch(url, opts);
};

// Инициализация VirtualSelect
const vs = new VirtualSelect({
  domId: 'testSelect',
  name: 'testOsnastka',
  apiUrl: '/api/test-virtual-select',
  valueKey: 'id',
  labelKey: 'nomer_chertezha',
  displayFormat: (row) => `${row.nomer_chertezha} — ${row.naimenovanie}`,
  placeholder: '— Начните вводить для поиска —',
  pageSize: 50,
  bufferSize: 10,
  onChange: (value, item) => {
    document.getElementById('statSelected').textContent =
      `${item.nomer_chertezha} (${item.id})`;
    log(`🎯 Выбрано: ${item.nomer_chertezha} — ${item.naimenovanie}`);
  }
});

// Периодически обновляем счётчик отрисованных DOM-элементов
setInterval(() => {
  const rendered = document.querySelectorAll('.virtual-select-option').length;
  document.getElementById('statRendered').textContent = rendered;
}, 200);

log('🚀 Тест инициализирован. Ожидание взаимодействия...');
log('💡 Подсказка: откройте DevTools → Network, чтобы видеть запросы');