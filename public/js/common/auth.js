// ============================================================
// js/common/auth.js МОДУЛЬ АВТОРИЗАЦИИ НА КЛИЕНТЕ
// ============================================================
import { api } from './utils.js';
import { state } from './state.js';

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';
const EXPIRES_KEY = 'auth_expires';

export const auth = {
  /**
   * Проверка авторизации
   */
  isAuthenticated() {
    const token = localStorage.getItem(TOKEN_KEY);
    const expires = localStorage.getItem(EXPIRES_KEY);
    
    if (!token || !expires) return false;
    
    // Проверяем срок действия
    if (new Date(expires) < new Date()) {
      this.logout();
      return false;
    }
    
    return true;
  },
  
  /**
   * Получить токен
   */
  getToken() {
    return localStorage.getItem(TOKEN_KEY);
  },
  
  /**
   * Получить текущего пользователя
   */
  getUser() {
    const userJson = localStorage.getItem(USER_KEY);
    return userJson ? JSON.parse(userJson) : null;
  },
  
  /**
   * Получить роль
   */
  getRole() {
    const user = this.getUser();
    return user?.role || null;
  },
  
  /**
   * Проверка доступа к странице
   */
  canAccessPage(pageName) {
    const user = this.getUser();
    if (!user) return false;
    
    // Admin имеет доступ ко всему
    if (user.role === 'admin') return true;
    
    // Проверяем через API
    // (права загружаются при входе)
    const permissions = JSON.parse(localStorage.getItem('auth_permissions') || '{}');
    
    if (permissions.pages && permissions.pages.includes('*')) return true;
    if (permissions.pages && permissions.pages.includes(pageName)) return true;
    
    return false;
  },
  
  /**
   * Вход в систему
   */
  async login(login, password) {
    const result = await api('POST', '/api/auth/login', { login, password });
    
    if (result.error) {
      throw new Error(result.error);
    }
    
    // Сохраняем данные
    localStorage.setItem(TOKEN_KEY, result.token);
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
    localStorage.setItem(EXPIRES_KEY, result.expiresAt);
    
    // Загружаем права
    await this.loadPermissions();
    
    // Обновляем state
    state.currentUser = result.user;
    
    return result.user;
  },
  
  /**
   * Загрузка прав роли
   */
  async loadPermissions() {
    const result = await api('GET', '/api/auth/me');
    
    if (result.permissions) {
      localStorage.setItem('auth_permissions', JSON.stringify(result.permissions));
    }
  },
  
  /**
   * Выход из системы
   */
  async logout() {
    try {
      await api('POST', '/api/auth/logout');
    } catch (e) {
      // Игнорируем ошибки
    }
    
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(EXPIRES_KEY);
    localStorage.removeItem('auth_permissions');
    
    state.currentUser = null;
    
    // Перенаправляем на страницу входа
    window.location.href = '/pages/login.html';
  },
  
  /**
   * Проверка и автоматический выход при истечении сессии
   */
  checkSession() {
    if (!this.isAuthenticated()) {
      this.logout();
      return false;
    }
    return true;
  }
};

// Расширяем state
state.currentUser = auth.getUser();