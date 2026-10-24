// ============================================================
// УТИЛИТЫ: api, toast, esc
// ============================================================
export async function api(method, path, body, signal = null) {
  const token = localStorage.getItem('auth_token');
  
  const opts = {
    method,
    headers: { 
      'Content-Type': 'application/json'
    }
  };
  
  // ✅ ДОБАВЛЯЕМ токен в заголовок
  if (token) {
    opts.headers['Authorization'] = `Bearer ${token}`;
  }
  
  if (body) opts.body = JSON.stringify(body);
  if (signal) opts.signal = signal;
  
  const r = await fetch(path, opts);
  
  // ✅ Обработка 401 (не авторизован)
  if (r.status === 401) {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    window.location.href = '/pages/login.html';
    throw new Error('Сессия истекла');
  }
  
  return await r.json();
}
/**  Показывает всплывающее уведомление пользователю.
 *
 * Используется для предупреждений, ошибок, информационных сообщений.
 * В контексте WebSocket — для уведомления о блокировках, ошибках и отказах.
 *
 * @param {string} msg — текст уведомления
 * @param {'info'|'warning'|'error'|'success'} [type='info'] — тип уведомления
 * @returns {void}
 */
export function toast(msg, type = 'success') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.add('hidden'), 8500);
}

export function esc(s) {
  return (s == null ? '' : String(s)).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// ============================================================
// ЕДИНЫЙ ХЕЛПЕР ДЛЯ ПОЛЕЙ ДАТ
// ============================================================

/**
 * Установить дату в input[type="date"] или показать текст-заглушку.
 *
 * @param {string} inputId   — id поля input[type="date"]
 * @param {string} value     — дата YYYY-MM-DD или '' / null
 * @param {string} emptyText — текст когда даты нет ('не отправлялось')
 */
export function setDateOrText(inputId, value, emptyText = '') {
    const input = document.getElementById(inputId);
    if (!input) return;
    const textEl = document.getElementById(inputId + 'Text');

    if (value) {
        input.value = value;               // YYYY-MM-DD из БД
        input.classList.remove('hidden');
        if (textEl) textEl.classList.add('hidden');
    } else {
        input.value = '';
        input.classList.add('hidden');
        if (textEl) {
            textEl.textContent = emptyText;
            textEl.classList.remove('hidden');
        }
    }
}

/**
 * Прочитать дату из input[type="date"].
 * Возвращает YYYY-MM-DD или ''.
 */
export function getDateValue(inputId) {
    const input = document.getElementById(inputId);
    return input ? input.value : '';
}