// ============================================================
// js/app-login.js ТОЧКА ВХОДА: СТРАНИЦА ВХОДА
// ============================================================
import { auth } from './common/auth.js';

// Если уже авторизован — перенаправляем в главное меню
if (auth.isAuthenticated()) {
  window.location.href = '/index.html';
}

const form = document.getElementById('loginForm');
const loginInput = document.getElementById('loginInput');
const passwordInput = document.getElementById('passwordInput');
const loginBtn = document.getElementById('loginBtn');
const errorMsg = document.getElementById('errorMsg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const login = loginInput.value.trim();
  const password = passwordInput.value;
  
  if (!login || !password) {
    errorMsg.textContent = 'Введите логин и пароль';
    return;
  }
  
  loginBtn.disabled = true;
  loginBtn.textContent = 'Вход...';
  errorMsg.textContent = '';
  
  try {
    const user = await auth.login(login, password);
    
    // Перенаправляем в главное меню
    window.location.href = '/index.html';
  } catch (err) {
    errorMsg.textContent = err.message || 'Ошибка входа';
    loginBtn.disabled = false;
    loginBtn.textContent = 'Войти';
    passwordInput.value = '';
    passwordInput.focus();
  }
});

// Автофокус
loginInput.focus();