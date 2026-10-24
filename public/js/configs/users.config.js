export default {
  entity: 'users',
  apiUrl: '/api/auth/users',
  idKey: 'id',
  tableTitle: 'Пользователь',
  wsSync: true,

  fields: [
    { key: 'login', label: 'Логин', domId: 'uLogin', type: 'text', required: true, table: true, tableWidth: 120, filter: true, filterId: 'fltLogin' },
    { key: 'fio', label: 'ФИО', domId: 'uFio', type: 'text', required: true, table: true, tableWidth: 220, filter: true, filterId: 'fltFio' },
    { 
      key: 'role', label: 'Роль', domId: 'uRole', type: 'select', required: true, table: true, tableWidth: 130,filter: true, filterId: 'fltRole',
      formatter: (value) => {
        const map = {
          admin: { text: '👑 Администратор', className: 'role-admin' },
          pto: { text: '📋 ПТО', className: 'role-pto' },
          teholog: { text: '👨‍🔬 Технолог', className: 'role-teholog' },
          logist: { text: '🚛 Логист', className: 'role-logist' },
          viewer: { text: '👁 Просмотр', className: 'role-viewer' }
        };
        return map[value] || { text: value || '—' };
      }
    },
    { 
    key: 'aktivnost', label: 'Активен', domId: 'uAktiv', type: 'checkbox', table: true, tableWidth: 80,
    filter: true, filterId: 'fltAktiv', filterType: 'select', // ✅ ДОБАВИТЬ ЭТО
    formatter: (value) => {
        if (value === 1 || value === '1') return { text: '✓ Да', className: 'status-active' };
        return { text: '✗ Нет', className: 'status-inactive' };
    }
    },
    { key: 'last_login', label: 'Последний вход', table: true, tableWidth: 140 },
    
    // Пароли не отправляются при обычном save, валидируются кастомно
    { key: 'password', domId: 'uPassword', type: 'text', virtual: true, skipDirty: true },
    { key: 'password2', domId: 'uPassword2', type: 'text', virtual: true, skipDirty: true },
  ],

  filterClearButtons: [
    { buttonId: 'btnClearLogin', filterId: 'fltLogin' },
    { buttonId: 'btnClearFio', filterId: 'fltFio' },
    { buttonId: 'btnClearRole', filterId: 'fltRole' }
  ],
  clearAllFiltersBtn: 'btnClearAllFilters',
};