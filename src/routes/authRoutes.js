// ============================================================
// src/routes/authRoutes.js РОУТЫ: АВТОРИЗАЦИЯ И РЕГИСТРАЦИЯ
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { hashPassword, generateToken, validateToken, extractToken } = require('../authUtils');
const { logAction } = require('./userLogger');
const {  sqlDate, sqlDateTime } = require('./helpers/dateHelpers');

module.exports = (db, wsManager) => ({
  // ========================================================================
  // POST /api/auth/login — вход в систему
  // ========================================================================
  async POST_LOGIN(req, res) {
    try {
      const d = await parseBody(req);
      
      if (!d.login || !d.password) {
        return send(res, 400, { error: 'Введите логин и пароль' });
      }
      
      const user = await db.get(
        'SELECT * FROM users WHERE login = ? AND aktivnost = 1',
        [d.login]
      );
      
      if (!user) {
        await logAction(db, null, 'login_failed', null, null, 
          req.socket.remoteAddress, `Неверный логин: ${d.login}`);
        return send(res, 401, { error: 'Неверный логин или пароль' });
      }
      
      const passwordHash = hashPassword(d.password);
      if (user.password_hash !== passwordHash) {
        await logAction(db, user.id, 'login_failed', null, null,
          req.socket.remoteAddress, 'Неверный пароль');
        return send(res, 401, { error: 'Неверный логин или пароль' });
      }
      
      // Создаём сессию
      const token = generateToken();
      const sessionId = generateId('SESS');
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 часов
      
      await db.run(
        `INSERT INTO sessions (id, user_id, token, ip, user_agent, expires_at)
         VALUES (?,?,?,?,?,?)`,
        [sessionId, user.id, token, req.socket.remoteAddress, 
         req.headers['user-agent'] || '', sqlDateTime(expiresAt)]
      );
      
      // Обновляем last_login
      await db.run('UPDATE users SET last_login = ? WHERE id = ?',
        [sqlDateTime(), user.id]);
      
      await logAction(db, user.id, 'login', null, null,
        req.socket.remoteAddress);
      
      send(res, 200, {
        ok: true,
        token,
        user: {
          id: user.id,
          login: user.login,
          fio: user.fio,
          role: user.role
        },
        expiresAt: sqlDateTime(expiresAt)
      });
    } catch (e) {
      console.error('[authRoutes.POST_LOGIN] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },
  

  
  // ========================================================================
  // POST /api/auth/logout — выход
  // ========================================================================
  async POST_LOGOUT(req, res) {
    try {
      const token = extractToken(req);
      const auth = await validateToken(db, token);
      
      if (auth) {
        await db.run('DELETE FROM sessions WHERE token = ?', [token]);
        await logAction(db, auth.user.id, 'logout', null, null,
          req.socket.remoteAddress);
      }
      
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  },
  
  // ========================================================================
  // GET /api/auth/me — информация о текущем пользователе
  // ========================================================================
  async GET_ME(req, res) {
    try {
      const token = extractToken(req);
      const auth = await validateToken(db, token);
      
      if (!auth) {
        return send(res, 401, { error: 'Не авторизован' });
      }
      
      // Загружаем права роли
      const role = await db.get('SELECT * FROM roles WHERE name = ?', [auth.user.role]);
      
      send(res, 200, {
        user: auth.user,
        permissions: role ? JSON.parse(role.permissions) : {},
        session: {
          expiresAt: auth.session.expires_at
        }
      });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  },

  

  
  // ========================================================================
  // GET /api/auth/users — список пользователей (через buildSyntheticQuery)
  // ========================================================================
  async GET_USERS(req, res, url) {
      try {
          const token = extractToken(req);
          const auth = await validateToken(db, token);
          if (!auth || auth.user.role !== 'admin') {
              return send(res, 403, { error: 'Только для администратора' });
          }
          const { buildSyntheticQuery } = require('./helpers/syntheticTables');
          const { sql, params } = buildSyntheticQuery('users.list', {
              login:     url.searchParams.get('login'),
              fio:       url.searchParams.get('fio'),
              role:      url.searchParams.get('role'),
              aktivnost: url.searchParams.get('aktivnost'),
          });
          const users = await db.all(sql, params);
          // Убираем password_hash из ответа
          const safe = users.map(({ password_hash, ...rest }) => rest);
          send(res, 200, safe);
      } catch (e) {
          console.error('[authRoutes.GET_USERS] Error:', e.message);
          send(res, 500, { error: e.message });
      }
  },


// ========================================================================
// POST /api/auth/users — создание пользователя (для CrudModule)
// ========================================================================
async POST_USER(req, res) {
    try {
        const token = extractToken(req);
        const auth = await validateToken(db, token);
        if (!auth || auth.user.role !== 'admin') {
            return send(res, 403, { error: 'Только администратор может создавать пользователей' });
        }
        const d = await parseBody(req);
        if (!d.login || !d.password || !d.fio || !d.role) {
            return send(res, 400, { error: 'Заполните все обязательные поля (логин, пароль, ФИО, роль)' });
        }
        if (d.password.length < 4) {
            return send(res, 400, { error: 'Пароль должен быть не менее 4 символов' });
        }
        const existing = await db.get('SELECT id FROM users WHERE login = ?', [d.login]);
        if (existing) {
            return send(res, 400, { error: 'Пользователь с таким логином уже существует' });
        }
        const id = generateId('U');
        const passwordHash = hashPassword(d.password);
        const aktivnost = d.aktivnost !== undefined ? (d.aktivnost ? 1 : 0) : 1;
        await db.run(
            'INSERT INTO users (id, login, password_hash, fio, role, aktivnost) VALUES (?,?,?,?,?,?)',
            [id, d.login, passwordHash, d.fio, d.role, aktivnost]
        );
        await logAction(db, auth.user.id, 'user_register', 'users', id,
            req.socket.remoteAddress, `Создан пользователь: ${d.login}`);
        wsManager.notifyDataChange('users', 'add', id);
        send(res, 201, { id, login: d.login });
    } catch (e) {
        console.error('[authRoutes.POST_USER] Error:', e.message);
        send(res, 500, { error: e.message });
    }
},
  
// ========================================================================
// PUT /api/auth/users/:id — обновление (с поддержкой пароля)
// ========================================================================
async PUT_USER(req, res, url) {
    try {
        const token = extractToken(req);
        const auth = await validateToken(db, token);
        if (!auth || auth.user.role !== 'admin') {
            return send(res, 403, { error: 'Только для администратора' });
        }
        const userId = url.pathname.split('/')[4];
        if (!userId) return send(res, 400, { error: 'ID не указан' });

        const d = await parseBody(req);
        const updates = [];
        const params = [];

        if (d.fio !== undefined)    { updates.push('fio = ?');        params.push(d.fio); }
        if (d.role !== undefined)   { updates.push('role = ?');       params.push(d.role); }
        if (d.aktivnost !== undefined) {
            updates.push('aktivnost = ?');
            params.push(d.aktivnost ? 1 : 0);
        }
        // Пароль — опционально при обновлении
        if (d.password && d.password.length >= 4) {
            updates.push('password_hash = ?');
            params.push(hashPassword(d.password));
        }

        if (updates.length === 0) {
            return send(res, 400, { error: 'Нет полей для обновления' });
        }

        params.push(userId);
        await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
        await logAction(db, auth.user.id, 'user_update', 'users', userId,
            req.socket.remoteAddress, JSON.stringify(Object.keys(d)));
        wsManager.notifyDataChange('users', 'update', userId);
        send(res, 200, { ok: true });
    } catch (e) {
        console.error('[authRoutes.PUT_USER] Error:', e.message);
        send(res, 500, { error: e.message });
    }
},

// ========================================================================
// PUT /api/auth/users/:id/password — отдельная смена пароля
// ========================================================================
async PUT_PASSWORD(req, res, url) {
    try {
        const token = extractToken(req);
        const auth = await validateToken(db, token);
        if (!auth || auth.user.role !== 'admin') {
            return send(res, 403, { error: 'Только для администратора' });
        }
        const userId = url.pathname.split('/')[4];
        if (!userId) return send(res, 400, { error: 'ID не указан' });

        const d = await parseBody(req);
        if (!d.password || d.password.length < 4) {
            return send(res, 400, { error: 'Пароль должен быть не менее 4 символов' });
        }

        await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(d.password), userId]);
        await logAction(db, auth.user.id, 'password_change', 'users', userId,
            req.socket.remoteAddress, 'Смена пароля');
        wsManager.notifyDataChange('users', 'update', userId);
        send(res, 200, { ok: true });
    } catch (e) {
        send(res, 500, { error: e.message });
    }
},


// ========================================================================
// GET /api/auth/logs — логи (через buildSyntheticQuery)
// ========================================================================
async GET_LOGS(req, res, url) {
    try {
        const token = extractToken(req);
        const auth = await validateToken(db, token);
        if (!auth || auth.user.role !== 'admin') {
            return send(res, 403, { error: 'Только для администратора' });
        }

        const limit     = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
        const action    = url.searchParams.get('action');
        const userLogin = url.searchParams.get('user_login');

        const where  = [];
        const params = [];
        if (action)    { where.push('action LIKE ?');     params.push(`%${action}%`); }
        if (userLogin) { where.push('user_login LIKE ?'); params.push(`%${userLogin}%`); }

        const sql = `
            SELECT id, created_at, user_id, user_login, action,
                   target_table, target_id, ip, details
            FROM user_logs
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY id DESC
            LIMIT ${limit}`;
        send(res, 200, await db.all(sql, params));
    } catch (e) {
        console.error('[authRoutes.GET_LOGS] Error:', e);  // ← полный объект, не только message
        send(res, 500, { error: e.message });
    }
},
// ========================================================================
// DELETE /api/auth/users/:id — удаление
// ========================================================================
async DELETE_USER(req, res, url) {
    try {
        const token = extractToken(req);
        const auth = await validateToken(db, token);
        if (!auth || auth.user.role !== 'admin') {
            return send(res, 403, { error: 'Только для администратора' });
        }
        const userId = url.pathname.split('/')[4];
        if (!userId) return send(res, 400, { error: 'ID не указан' });

        // Нельзя удалить себя
        if (userId === auth.user.id) {
            return send(res, 400, { error: 'Нельзя удалить свою учётную запись' });
        }

        // Защита от удаления последнего админа
        const target = await db.get('SELECT role, aktivnost FROM users WHERE id = ?', [userId]);
        if (target && target.role === 'admin' && target.aktivnost === 1) {
            const adminCount = await db.get(
                "SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND aktivnost = 1"
            );
            if (adminCount.cnt <= 1) {
                return send(res, 400, { error: 'Нельзя удалить единственного активного администратора' });
            }
        }

        await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
        await db.run('DELETE FROM users WHERE id = ?', [userId]);
        await logAction(db, auth.user.id, 'user_delete', 'users', userId,
            req.socket.remoteAddress, `Удалён пользователь: ${userId}`);
        wsManager.notifyDataChange('users', 'delete', userId);
        send(res, 200, { ok: true });
    } catch (e) {
        console.error('[authRoutes.DELETE_USER] Error:', e.message);
        send(res, 500, { error: e.message });
    }
},

      
    // ========================================================================
    // GET_ROLES — список ролей (для селекта)
    // ========================================================================
    async GET_ROLES(req, res) {
        try {
            const token = extractToken(req);
            const auth = await validateToken(db, token);
            
            if (!auth) return send(res, 401, { error: 'Требуется авторизация' });
            
            const roles = await db.all('SELECT name, description FROM roles ORDER BY name');
            send(res, 200, roles);
        } catch (e) {
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // PUT_PASSWORD — смена пароля (admin может сменить любому, пользователь — себе)
    // ========================================================================
    async PUT_PASSWORD(req, res, url) {
        try {
            const token = extractToken(req);
            const auth = await validateToken(db, token);
            
            if (!auth) return send(res, 401, { error: 'Требуется авторизация' });
            
            const userId = url.pathname.split('/')[4];
            const d = await parseBody(req);
            
            // Админ может менять любому, пользователь — только себе
            if (auth.user.role !== 'admin' && auth.user.id !== userId) {
                return send(res, 403, { error: 'Недостаточно прав' });
            }
            
            if (!d.password || d.password.length < 4) {
                return send(res, 400, { error: 'Пароль должен быть не менее 4 символов' });
            }
            
            await db.run('UPDATE users SET password_hash = ? WHERE id = ?',
                [hashPassword(d.password), userId]);
            
            await logAction(db, auth.user.id, 'password_change', 'users', userId,
                req.socket.remoteAddress);
            wsManager.notifyDataChange('users', 'update', userId);
            send(res, 200, { ok: true });
        } catch (e) {
            send(res, 500, { error: e.message });
        }
    }
});