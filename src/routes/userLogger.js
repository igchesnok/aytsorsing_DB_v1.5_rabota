// ============================================================
// src/routes/userLogger.js ЛОГИРОВАНИЕ ДЕЙСТВИЙ ПОЛЬЗОВАТЕЛЕЙ
// ============================================================

/**
 * Записать действие в лог
 */
async function logAction(db, userId, action, targetTable, targetId, ip, details) {
  try {
    let userLogin = null;
    if (userId) {
      const user = await db.get('SELECT login FROM users WHERE id = ?', [userId]);
      userLogin = user?.login || null;
    }
    
    await db.run(
      `INSERT INTO user_logs 
       (user_id, user_login, action, target_table, target_id, ip, details)
       VALUES (?,?,?,?,?,?,?)`,
      [userId, userLogin, action, targetTable, targetId, ip, details || '']
    );
  } catch (e) {
    console.error('[userLogger] Error:', e.message);
  }
}

/**
 * Middleware для автоматического логирования CRUD операций
 */
function createLogMiddleware(db) {
  return (table, action) => {
    return async (req, res, next) => {
      // Сохраняем оригинальный res.end
      const originalEnd = res.end.bind(res);
      
      res.end = function(data) {
        try {
          if (data) {
            const parsed = JSON.parse(data);
            // Логируем только успешные операции
            if (!parsed.error && res.statusCode < 400) {
              const targetId = parsed.id || req.url.split('/').pop();
              logAction(
                db,
                req.user?.id,
                `${action}_${table}`,
                table,
                targetId,
                req.socket.remoteAddress,
                JSON.stringify(req.body || {})
              );
            }
          }
        } catch (e) {
          // Игнорируем ошибки логирования
        }
        originalEnd(data);
      };
      
      next();
    };
  };
}

module.exports = { logAction, createLogMiddleware };