// ============================================================
// ГЛОБАЛЬНОЕ СОСТОЯНИЕ
// ============================================================
export const state = {
  selectedFirmaId: null,
  tables: {},
  clientId: 'client_' + Math.random().toString(36).substr(2, 9),
  userName: 'Загрузка...',  // ← Временно, будет заменено после подключения
  locks: new Map()
};

localStorage.setItem('userName', state.userName);