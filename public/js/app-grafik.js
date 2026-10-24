// ============================================================
// ТОЧКА ВХОДА: СТРАНИЦА ГРАФИКА ИЗГОТОВЛЕНИЯ
// ============================================================
import { initCommonUI } from './common/ui/index.js';
import { connectWs, EditLock, setHandlers, isLocked } from './common/websocket.js';
import { Grafik } from './modules/grafik.js';
import { initGrafikResizer } from './grafik-resizer.js';

// Текущая редактируемая позиция плана (id_plana)
let currentEditingPlanId = null;

function getCurrentEditContext() {
  return {
    table: 'grafik',
    id: currentEditingPlanId
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  connectWs();

  initCommonUI({
    contextResolver: null,
    onTabChange: () => {}
  });

  setHandlers({
    onDataChanged: (msg) => {
      if (msg.table === 'grafik' || msg.table === 'plan') {
        // t69: подавление собственных WS-событий (grafik/plan) на время сохранения
        // делает штатный batch-update.js — websocket.js не диспатчит data_changed
        // для таблиц в batch. Grafik.load() пересоздавал rowStates и срывал
        // сохранение остальных строк (в БД писались старые значения).
        Grafik.load();
      }
    },
    updateButtons: () => {
      document.getElementById('gSave').disabled = !Object.values(Grafik.rowStates).some(s => s.dirty);
    },
    onLocksUpdate: () => {  // ← Убедитесь, что это есть
      Grafik.updateLockIndicators();
    }
  });

  await Grafik.init();
  await Grafik.load();
  // Инициализация ресайзеров колонок
  initGrafikResizer();
  // ===== ДОПОЛНИТЕЛЬНАЯ ЛОГИКА БЛОКИРОВОК ДЛЯ ГРАФИКА =====
  
  // При фокусе на поле месяца — блокируем позицию плана
     document.addEventListener('focusin', async (e) => {
        const input = e.target;
        if (!input.matches || !input.matches('.grafik-month-input')) return;

        const planId = input.dataset.planId;
        if (!planId) return;

        // Если уже заблокирована нами — просто сбрасываем таймер неактивности
        if (EditLock.current && EditLock.current.id === planId) {
            EditLock.resetInactivity();
            return;
        }

        // Проверяем, не заблокирована ли другим
        const locker = isLocked('grafik', planId);
        if (locker) {
            // Чужая блокировка — убираем класс editing со всех строк
            document.querySelectorAll('.grafik-row.editing').forEach(r => r.classList.remove('editing'));
            return; // input остаётся disabled (установлен в renderBody/updateLockIndicators)
        }

        // Снимаем предыдущую свою блокировку (если была на другой строке)
        if (EditLock.current) {
            EditLock.release();
            document.querySelectorAll('.grafik-row.editing').forEach(r => r.classList.remove('editing'));
        }

        // Запрашиваем новую блокировку
        const ok = await EditLock.acquire('grafik', planId);
        if (!ok) return;

        // Успех — помечаем строку как редактируемую
        input.closest('.grafik-row')?.classList.add('editing');
        Grafik.updateSaveButton();
    });

    // При потере фокуса — снимаем блокировку только если ушли за пределы графика
    document.addEventListener('focusout', (e) => {
        const input = e.target;
        if (!input.matches || !input.matches('.grafik-month-input')) return;

        setTimeout(() => {
            // Если фокус перешёл на другое поле графика — НЕ снимаем (переключится в focusin)
            if (document.activeElement?.matches('.grafik-month-input')) return;

            // Фокус ушёл за пределы графика — снимаем блокировку
            EditLock.release();
            document.querySelectorAll('.grafik-row.editing').forEach(r => r.classList.remove('editing'));
        }, 150);
    });
});