import { api, toast } from './common/utils.js';
import { initCommonUI } from './common/ui/index.js';
import { connectWs, EditLock, setHandlers } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import { PlanPerevozok } from './modules/planPerevozok.js';
import { state } from './common/state.js';

function getCurrentEditContext() {
  return {
    table: 'plan_perevozok',
    id: PlanPerevozok.selectedId
  };
}

// ✅ Делаем функцию доступной для вызова из обработчика направления
async function loadTransportTypes() {
  const data = await api('GET', '/api/transport_types');
  const sel = document.getElementById('ppTipPerevozki');
  const currentDirection = PlanPerevozok._direction;
  
  // Запоминаем текущий выбранный тип (если есть)
  const previousValue = sel.value;
  
  sel.innerHTML = '<option value="">— Выберите тип —</option>';
  
  // ✅ Фильтруем по ТЕКУЩЕМУ направлению
  const filtered = data.filter(tp => tp.napravlenie === currentDirection);
  filtered.forEach(tp => {
    const opt = document.createElement('option');
    opt.value = tp.id_tipa;
    opt.textContent = tp.nazvanie_operatsii;
    sel.appendChild(opt);
  });
  
  // ✅ Если ранее выбранный тип всё ещё доступен — восстанавливаем выбор
  // Если нет — сбрасываем на пустое значение
  const stillAvailable = filtered.some(tp => tp.id_tipa === previousValue);
  if (stillAvailable) {
    sel.value = previousValue;
  } else {
    sel.selectedIndex = 0;
  }
}

// ✅ Делаем функцию доступной из модуля
window.loadTransportTypes = loadTransportTypes;

document.addEventListener('DOMContentLoaded', async () => {
  connectWs();
  
  initCommonUI({
    contextResolver: getCurrentEditContext,
    onTabChange: () => PlanPerevozok.updateButtonStates()
  });
  
  setHandlers({
    onDataChanged: (msg) => {
      if (EditLock.current?.table === msg.table && EditLock.current?.id === msg.id) return;
      if (msg.table === 'plan_perevozok') {
        PlanPerevozok.loadAll();
      }
    },
    updateButtons: () => PlanPerevozok.updateButtonStates()
  });
  
  await PlanPerevozok.init();
  
  // ✅ Загружаем типы перевозок при старте
  await loadTransportTypes();
  
  initResizers();
  resetResizerStylesOnResize();
  
  await PlanPerevozok.loadAll();
  PlanPerevozok.onHeaderClick();
});