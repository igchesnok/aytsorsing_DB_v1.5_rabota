// ============================================================
// src/authUtils.js
// ============================================================
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Проверка токена и получение пользователя
 * @returns {Object|null} { user, session } или null
 */
async function validateToken(db, token) {
  // ✅ ЗАЩИТА: если db не передан — возвращаем null
  if (!db) {
    console.warn('[validateToken] db не передан');
    return null;
  }
  
  if (!token) return null;
  
  try {
    const session = await db.get(
      `SELECT s.*, u.id as user_id, u.login, u.fio, u.role, u.aktivnost
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > datetime('now')`,
      [token]
    );
    
    if (!session || !session.aktivnost) return null;
    
    return {
      user: {
        id: session.user_id,
        login: session.login,
        fio: session.fio,
        role: session.role
      },
      session
    };
  } catch (e) {
    console.error('[validateToken] Error:', e.message);
    return null;
  }
}

function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return url.searchParams.get('token');
  } catch (e) {
    return null;
  }
}

module.exports = {
  hashPassword,
  generateToken,
  validateToken,
  extractToken
};