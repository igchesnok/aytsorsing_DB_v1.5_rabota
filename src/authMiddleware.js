// ============================================================
// src/authMiddleware.js MIDDLEWARE ПРОВЕРКИ АВТОРИЗАЦИИ
// ============================================================
const { validateToken, extractToken } = require('./authUtils');

/**
 * Middleware: проверка авторизации для API
 */
function requireAuth(db) {
  return async (req, res, next) => {
    const token = extractToken(req);
    const auth = await validateToken(db, token);
    
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Требуется авторизация' }));
      return;
    }
    
    // Сохраняем пользователя в request
    req.user = auth.user;
    req.session = auth.session;
    next();
  };
}

/**
 * Middleware: проверка роли для API
 */
function requireRole(db, allowedRoles) {
  return async (req, res, next) => {
    const token = extractToken(req);
    const auth = await validateToken(db, token);
    
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Требуется авторизация' }));
      return;
    }
    
    if (!allowedRoles.includes(auth.user.role)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Недостаточно прав' }));
      return;
    }
    
    req.user = auth.user;
    req.session = auth.session;
    next();
  };
}

module.exports = { requireAuth, requireRole };