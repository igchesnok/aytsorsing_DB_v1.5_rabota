// ============================================================
// МОДУЛЬ: АВТОСНЯТИЕ БЛОКИРОВКИ ПРИ ПОТЕРЕ ФОКУСА ОКНА
// ============================================================
import { EditLock, getWs } from '../websocket.js';
import { DirtyGuard } from '../dirty-guard.js';

const BLUR_RELEASE_DELAY = 20000;
let blurReleaseTimer = null;

function scheduleBlurRelease() {
  if (!EditLock.current || blurReleaseTimer) return;
 // silentRelease(); //решаю как лучше пока 
  blurReleaseTimer = setTimeout(async() => {
  await DirtyGuard.handleExit();

  }, BLUR_RELEASE_DELAY);
}
function silentRelease() {

    EditLock.release();
    // ✅ ОСТАЁТСЯ ТОЛЬКО ВИЗУАЛЬНАЯ ОЧИСТКА UI (о которой EditLock не знает)
    document.querySelectorAll('.form-panel.editing')
        .forEach(p => p.classList.remove('editing'));
    // Мягкое уведомление (чтобы пользователь понимал, почему форма стала read-only)
    toast('⏸ Блокировка снята из-за неактивности', 'info');
}
function cancelBlurRelease() {
  if (blurReleaseTimer) {
    clearTimeout(blurReleaseTimer);
    blurReleaseTimer = null;
  }
}

export function initBlurRelease() {
  // Потеря фокуса окна (Alt+Tab)
  window.addEventListener('blur', scheduleBlurRelease);

  // Возврат фокуса
  window.addEventListener('focus', () => {
    cancelBlurRelease();
    if (EditLock.current) {
      EditLock._startRenew();
      EditLock._startInactivityTimer();
    }
  });

  // Скрытие/показ вкладки
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      scheduleBlurRelease();
      if (EditLock.renewInterval) {
        clearInterval(EditLock.renewInterval);
        EditLock.renewInterval = null;
      }
    } else {
      cancelBlurRelease();
      if (EditLock.current) {
        EditLock._startRenew();
        EditLock._startInactivityTimer();
      }
    }
  });

  // Закрытие/перезагрузка страницы
  window.addEventListener('beforeunload', () => {
    const ws = getWs();  // ✅ FIX: require недоступен в браузерном ES-модуле
    if (EditLock.current && ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'unlock',
          table: EditLock.current.table,
          id: EditLock.current.id
        }));
      } catch (e) {}
    }
  });
}