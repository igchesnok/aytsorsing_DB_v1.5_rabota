// ============================================================
// public/js/app-users.js
// ТОЧКА ВХОДА: УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ
// Архитектура: CrudModule + FilterableTable (логи)
// + initSyntheticSync + хуки для нестандартных функций
// ============================================================

import { initCommonUI } from './common/ui/index.js';
import { connectWs } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import { CrudModule } from './common/crud-module.js';
import { FilterableTable } from './common/filterable-table.js';
import { state } from './common/state.js';
import { api, toast } from './common/utils.js';
import { EditLock, isLocked } from './common/websocket.js';
import { batchManager } from './common/batch-update.js';
import { DirtyGuard } from './common/dirty-guard.js';
import { initSyntheticSync, loadSubscriptions } from './common/synthetic-sync.js';
import usersConfig from './configs/users.config.js';

// ============================================================
// 1. Создание CrudModule с хуками
// ============================================================
const Users = new CrudModule(usersConfig, {
  tableContainerId: 'usersTable',
  formTitleId: 'userFormTitle',
  buttons: {
    add:  'btnUserAdd',
    save: 'btnUserSave',
    del:  'btnUserDel',
  },
  
  // ✅ КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: syntheticHandlers передаются СЮДА
  // CrudModule сам вызовет loadSubscriptions() + initSyntheticSync()
  // и НЕ будет вызывать setHandlers() повторно
  syntheticHandlers: {
      'users.list': () => Users.load(),
      'users.logs': () => _loadLogs(),
  },

  hooks: {
    // ──────────────────────────────────────────────────────
    // onInit: нестандартная логика инициализации
    // ──────────────────────────────────────────────────────
    onInit: (module) => {

      // Кнопка смены пароля
      const btnChangePwd = document.getElementById('btnChangePassword');
      if (btnChangePwd) {
        btnChangePwd.onclick = () => _changePassword();
      }

      // Поля пароля влияют на состояние кнопок
      const pwdField   = document.getElementById('uPassword');
      const pwdConfirm = document.getElementById('uPassword2');
      if (pwdField)   pwdField.addEventListener('input',   () => _onPasswordInput());
      if (pwdConfirm) pwdConfirm.addEventListener('input',  () => _onPasswordInput());

      // Валидация логина с хинтом
      const loginInput = document.getElementById('uLogin');
      if (loginInput) {
        loginInput.addEventListener('input', () => {
          const hint = document.getElementById('loginHint');
          const val  = loginInput.value.trim();
          if (!val)                              { hint.textContent = ''; }
          else if (!/^[a-z0-9._-]+$/i.test(val)) { hint.textContent = 'Только латиница, цифры, . _ -'; hint.style.color = ''; }
          else                                   { hint.textContent = ''; }
          module.updateButtonStates();
        });
      }



      // Расширение DirtyGuard: учитывать поля пароля
      DirtyGuard.register(
        module.form,
        () => module.save(),
        () => module._onHeaderClick(),
        () => {
          // customDirtyCheck: форма грязная ИЛИ заполнены поля пароля
          return module.form.isDirty()
            || !!(document.getElementById('uPassword')?.value)
            || !!(document.getElementById('uPassword2')?.value);
        }
      );
    },

    // ──────────────────────────────────────────────────────
    // onSelect: выбор строки — логин readonly, очистка паролей
    // ──────────────────────────────────────────────────────
    onSelect: (row) => {
      // Логин нельзя менять при редактировании
      const loginInput = document.getElementById('uLogin');
      if (loginInput) {
        loginInput.disabled = true;
        loginInput.title    = 'Логин нельзя изменить при редактировании';
      }

      // Информационные поля
      const infoCreated   = document.getElementById('infoCreated');
      const infoLastLogin = document.getElementById('infoLastLogin');
      if (infoCreated)   infoCreated.textContent   = row.created_at  || '—';
      if (infoLastLogin) infoLastLogin.textContent = row.last_login  || 'никогда';

      // Очистка паролей
      _clearPasswordFields();

      // Кнопка смены пароля
      const btnChangePwd = document.getElementById('btnChangePassword');
      if (btnChangePwd) btnChangePwd.disabled = false;
    },

    // ──────────────────────────────────────────────────────
    // onHeaderClick: клик по заголовку (новая запись)
    // ──────────────────────────────────────────────────────
    onHeaderClick: () => {
      // Логин доступен для новой записи
      const loginInput = document.getElementById('uLogin');
      if (loginInput) {
        loginInput.disabled = false;
        loginInput.title    = '';
      }

      const loginHint = document.getElementById('loginHint');
      if (loginHint) loginHint.textContent = '';

      // Очистка паролей
      _clearPasswordFields();

      // Информационные поля
      const infoCreated   = document.getElementById('infoCreated');
      const infoLastLogin = document.getElementById('infoLastLogin');
      if (infoCreated)   infoCreated.textContent   = '—';
      if (infoLastLogin) infoLastLogin.textContent = '—';

      // Кнопка смены пароля
      const btnChangePwd = document.getElementById('btnChangePassword');
      if (btnChangePwd) btnChangePwd.disabled = true;
    },
  },
});

// ============================================================
// 2. Переопределение add() — пароль обязателен при создании
// ============================================================
Users.add = async function () {
  // Стандартная валидация формы
  const v = Users.form.validate();
  if (!v.ok) {
    toast(`Заполните: ${v.missing.join(', ')}`, 'warning');
    return;
  }

  // Валидация логина
  const login = document.getElementById('uLogin')?.value.trim() || '';
  if (!/^[a-z0-9._-]+$/i.test(login)) {
    toast('Некорректный формат логина', 'warning');
    return;
  }

  // Пароль обязателен при создании
  const pwdResult = _validatePassword(true);
  if (!pwdResult.ok) {
    toast(pwdResult.error, 'warning');
    return;
  }

  let payload = Users.form.buildPayload();
  payload.password = pwdResult.password;

  if (Users.opts.hooks?.beforeSave) {
    const transformed = Users.opts.hooks.beforeSave(payload);
    if (transformed === null) return;
    payload = transformed || payload;
  }

  await batchManager.withBatch(Users.config.entity, async () => {
    const r = await api('POST', Users.config.apiUrl, payload);
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
    toast('Пользователь создан');
    _clearPasswordFields();
    await Users.load();
    Users.table.selectById(r.id);
    const row = Users.table.data.find(x => x[Users.config.idKey] === r.id);
    if (row) Users._onSelect(row);
    Users._dispatchCrudCompleted('add', r.id);
  });
};

// ============================================================
// 3. Переопределение save() — пароль опционален при редактировании
// ============================================================
Users.save = async function () {
  const selectedId = Users._lastSelectedId || Users.table.selectedId;
  if (!selectedId) {
    toast('Не выбрана запись для сохранения', 'warning');
    return;
  }

  const v = Users.form.validate();
  if (!v.ok) {
    toast(`Заполните: ${v.missing.join(', ')}`, 'warning');
    return;
  }

  // Пароль опционален — проверяем только если заполнен
  const pwd = document.getElementById('uPassword')?.value || '';
  if (pwd) {
    const pwdResult = _validatePassword(false);
    if (!pwdResult.ok) {
      toast(pwdResult.error, 'warning');
      return;
    }
  }

  let payload = Users.form.buildPayload();
  if (pwd) payload.password = pwd;

  if (Users.opts.hooks?.beforeSave) {
    const transformed = Users.opts.hooks.beforeSave(payload);
    if (transformed === null) return;
    payload = transformed || payload;
  }

  await batchManager.withBatch(Users.config.entity, async () => {
    const r = await api('PUT', `${Users.config.apiUrl}/${selectedId}`, payload);
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
    toast('Пользователь обновлён');
    _clearPasswordFields();
    if (EditLock.current?.id === selectedId) EditLock.release();
    await Users.load();
    Users.table.selectById(selectedId);
    const row = Users.table.data.find(x => x[Users.config.idKey] === selectedId);
    if (row) Users._onSelect(row);
    Users._dispatchCrudCompleted('save', selectedId);
  });
};

// ============================================================
// 4. Расширение updateButtonStates() — учёт пароля и логина
// ============================================================
const _origUpdateButtonStates = Users.updateButtonStates.bind(Users);

Users.updateButtonStates = function () {
  _origUpdateButtonStates();

  const selectedId = Users.table?.selectedId;

  // Кнопка смены пароля: активна только при выбранной записи
  const btnChangePwd = document.getElementById('btnChangePassword');
  if (btnChangePwd) btnChangePwd.disabled = !selectedId;

  // При новой записи — доп. проверка логина
  if (!selectedId && Users.btns.add && !Users.btns.add.disabled) {
    const login = document.getElementById('uLogin')?.value.trim() || '';
    if (login && !/^[a-z0-9._-]+$/i.test(login)) {
      Users.btns.add.disabled = true;
    }
  }
};

// ============================================================
// 5. Вспомогательные функции: пароль
// ============================================================

/**
 * Валидация пароля
 * @param {boolean} required — true = пароль обязателен (создание)
 * @returns {{ ok: boolean, password?: string, error?: string }}
 */
function _validatePassword(required) {
  const pwd     = document.getElementById('uPassword')?.value  || '';
  const confirm = document.getElementById('uPassword2')?.value || '';

  if (required && !pwd)             return { ok: false, error: 'Введите пароль' };
  if (pwd && pwd.length < 4)        return { ok: false, error: 'Пароль: минимум 4 символа' };
  if (pwd && pwd !== confirm)       return { ok: false, error: 'Пароли не совпадают' };
  return { ok: true, password: pwd };
}

function _clearPasswordFields() {
  const pwd     = document.getElementById('uPassword');
  const confirm = document.getElementById('uPassword2');
  const hint    = document.getElementById('passwordHint');
  if (pwd)     pwd.value     = '';
  if (confirm) confirm.value = '';
  if (hint)    { hint.textContent = ''; hint.style.color = ''; }
}

function _onPasswordInput() {
  const p1   = document.getElementById('uPassword')?.value  || '';
  const p2   = document.getElementById('uPassword2')?.value || '';
  const hint = document.getElementById('passwordHint');
  if (!hint) return;

  if (!p1 && !p2)                { hint.textContent = ''; hint.style.color = ''; return; }
  if (p1.length < 4)             { hint.textContent = 'Минимум 4 символа'; hint.style.color = ''; return; }
  if (p1 !== p2)                 { hint.textContent = 'Пароли не совпадают'; hint.style.color = ''; return; }
  hint.textContent = '✓ Пароли совпадают';
  hint.style.color = 'var(--success, #1a7f37)';
  Users.updateButtonStates();
}

/**
 * Отдельная операция смены пароля
 */
async function _changePassword() {
  const selectedId = Users._lastSelectedId || Users.table?.selectedId;
  if (!selectedId) {
    toast('Выберите пользователя', 'warning');
    return;
  }

  const pwdResult = _validatePassword(true);
  if (!pwdResult.ok) {
    toast(pwdResult.error, 'warning');
    return;
  }

  if (!confirm('Сменить пароль пользователю?')) return;

  await batchManager.withBatch('users', async () => {
    const r = await api('PUT', `/api/auth/users/${selectedId}/password`, {
      password: pwdResult.password,
    });
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
    toast('Пароль изменён');
    _clearPasswordFields();
  });
}

// ============================================================
// 7. Вкладка логов — просто FilterableTable, без формы
// ============================================================
let _logsTable = null;
let _logsLoaded = false;

const LOGS_COLUMNS = [
    { key: 'created_at',   label: 'Время',        width: '140px' },
    { key: 'user_login',   label: 'Пользователь', width: '120px' },
    {
        key: 'action', label: 'Действие', width: '160px',
        formatter: (value) => {
            const map = {
                login:           { text: '🔓 Вход',          className: 'log-login' },
                logout:          { text: '🔒 Выход',         className: 'log-logout' },
                user_register:   { text: '➕ Регистрация',   className: 'log-register' },
                user_update:     { text: '✏️ Редактирование', className: 'log-update' },
                user_delete:     { text: '🗑 Удаление',      className: 'log-delete' },
                password_change: { text: '🔑 Смена пароля',  className: 'log-password' },
            };
            return map[value] || { text: value || '—' };
        },
    },
    { key: 'target_table', label: 'Таблица',   width: '120px' },
    { key: 'target_id',    label: 'ID записи', width: '100px' },
    { key: 'ip',           label: 'IP',        width: '120px' },
    { key: 'details',      label: 'Детали',    width: '280px' },
];

// Вызывается один раз — при первом переключении на вкладку
function _ensureLogsTable() {
    if (_logsTable) return;
    const container = document.getElementById('logsTable');
    if (!container) return;

    _logsTable = new FilterableTable(container, LOGS_COLUMNS, {
        idKey: 'id',
        apiUrl: '/api/auth/logs',
        filterFields: {
            fltLogAction: { dbField: 'action', type: 'text' },
        },
        debounceMs: 300,
        autoRefreshForm: false,
    });
    state.tables.users_logs = _logsTable;

    // Единственный фильтр — select
    const sel = document.getElementById('fltLogAction');
    if (sel) {
        sel.addEventListener('change', () => {
            _logsTable.applyFilters({ fltLogAction: sel.value });
        });
    }
}

// Загрузка логов (первичная + по WS)
async function _loadLogs() {
    _ensureLogsTable();
    if (!_logsTable) return;
    const sel = document.getElementById('fltLogAction');
    await _logsTable.loadImmediate({ fltLogAction: sel?.value || '' });
    _logsLoaded = true;
}



// ============================================================
// 8. Резолвер контекста для автоблокировки
// ============================================================
function getCurrentEditContext() {
  return {
    table: 'users',
    id: Users.table?.selectedId || null,
  };
}

// ============================================================
// 9. Инициализация страницы
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  connectWs();

initCommonUI({
    contextResolver: getCurrentEditContext,
    onTabChange: (tabId) => {
        if (tabId === 'tabLogs' && !_logsLoaded) {
            _loadLogs();
        }
        Users.updateButtonStates();
    },
});



  // Инициализация модуля
  await Users.init();

  initResizers();
  resetResizerStylesOnResize();

  // Первичная загрузка
  await Users.load();
  Users._onHeaderClick();
});

// ============================================================
// 10. Экспорт
// ============================================================
export { Users };