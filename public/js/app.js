// ============================================================
// js/app.js ТОЧКА ВХОДА: ГЛАВНОЕ МЕНЮ С ПРОВЕРКОЙ АВТОРИЗАЦИИ
// ============================================================
import { auth } from './common/auth.js';

document.addEventListener('DOMContentLoaded', () => {
  // ✅ Проверка авторизации
  if (!auth.isAuthenticated()) {
    window.location.href = '/pages/login.html';
    return;
  }
  
  const user = auth.getUser();
  
  // ✅ Отображаем информацию о пользователе
  const userInfo = document.getElementById('userInfo');
  if (userInfo) {
    userInfo.textContent = `👤 ${user.fio} (${user.role})`;
  }
  
  // ✅ Кнопка выхода
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      if (confirm('Выйти из системы?')) {
        auth.logout();
      }
    });
  }
  
  // ✅ Фильтрация кнопок меню по роли
  document.querySelectorAll('.menu-btn').forEach(btn => {
    const page = btn.dataset.page;
    if (!page) return;
    
    // Извлекаем имя страницы (без пути и расширения)
    const pageName = page.split('/').pop().replace('.html', '');
    
    // Проверяем доступ
    if (!auth.canAccessPage(pageName)) {
      btn.style.display = 'none';
      return;
    }
    
    btn.addEventListener('click', () => {
      window.open(page, '_blank', 'width=1400,height=900,menubar=no,toolbar=no');
    });
  });
    
  // ✅ НОВОЕ: показываем кнопку "Пользователи" только для админов
  const userJson = localStorage.getItem('auth_user');
  if (userJson) {
    try {
      const user = JSON.parse(userJson);
      if (user.role === 'admin') {
        const btnUsers = document.getElementById('btnUsersMenu');
        if (btnUsers) btnUsers.style.display = '';
        // ✅ T52: кнопка «Настройки ЭДО» — тоже только для админа
        const btnEdo = document.getElementById('btnEdoSettingsMenu');
        if (btnEdo) btnEdo.style.display = '';
      }
    } catch (e) {}
  }
  
  console.log(`✅ Главное меню инициализировано для ${user.login} (${user.role})`);
});