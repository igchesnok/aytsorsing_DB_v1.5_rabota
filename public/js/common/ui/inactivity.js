// ============================================================
// МОДУЛЬ: ТРЕКЕР АКТИВНОСТИ ПОЛЬЗОВАТЕЛЯ
// ============================================================
// public/js/common/ui/inactivity.js
import { EditLock } from '../websocket.js';
import { DirtyGuard } from '../dirty-guard.js';   // ← ДОБАВИТЬ

const EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];

export function initInactivityTracker() {
  EVENTS.forEach(event => {
    document.addEventListener(event, () => {
      EditLock.resetInactivity();
    }, { passive: true });
  });
}