// ============================================================
// МОДУЛЬ: ВКЛАДКИ
// ============================================================
import { state } from '../state.js';
import { DirtyGuard } from '../dirty-guard.js';


export function initTabs({ onTabChange } = {}) {
  document.querySelectorAll('.tab').forEach(t => {
    // ✅ ДОБАВЛЕНО async
    t.addEventListener('click', async () => {
      if (t.disabled) return;

      // ✅ Теперь await работает корректно
      const canProceed = await DirtyGuard.handleExit();
      if (!canProceed) return;   // пользователь выбрал «Остаться»

      document.querySelectorAll('.form-panel.editing')
        .forEach(p => p.classList.remove('editing'));

      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById(t.dataset.tab).classList.add('active');

      if (onTabChange) onTabChange(t.dataset.tab);

      setTimeout(() => {
        Object.values(state.tables).forEach(tb => tb && tb.refresh());
      }, 50);
    });
  });
}

// ✅ ДОБАВИТЬ эту функцию
export function enableTabs(enabled) {
  document.querySelectorAll('.tab').forEach((t, i) => {
    if (i > 0) t.disabled = !enabled;
  });
}

