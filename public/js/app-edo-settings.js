// ============================================================
// public/js/app-edo-settings.js
// ✅ T52: ТОЧКА ВХОДА — СТРАНИЦА «НАСТРОЙКИ ЭДО»
// (config/edo.json: подключение, шаблоны, подписанты, темы СЗ)
// ============================================================
import { EdosSettings } from './modules/edoSettings.js';

document.addEventListener('DOMContentLoaded', async () => {
  // Без авторизации — на страницу входа (как в остальных страницах)
  const token = localStorage.getItem('auth_token');
  if (!token) {
    window.location.href = '/pages/login.html';
    return;
  }
  await EdosSettings.init();
});
