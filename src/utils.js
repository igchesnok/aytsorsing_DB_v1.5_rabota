const fs = require('fs');
const path = require('path');

// ==================== MIME-ТИПЫ ====================
// Для ES-модулей КРИТИЧНО правильный Content-Type
const MIME_TYPES = {
  '.html':   'text/html; charset=utf-8',
  '.css':    'text/css; charset=utf-8',
  '.js':     'application/javascript; charset=utf-8',  // ← обязательно для ES-модулей!
  '.mjs':    'application/javascript; charset=utf-8',
  '.json':   'application/json; charset=utf-8',
  '.png':    'image/png',
  '.jpg':    'image/jpeg',
  '.jpeg':   'image/jpeg',
  '.gif':    'image/gif',
  '.svg':    'image/svg+xml',
  '.ico':    'image/x-icon',
  '.woff':   'font/woff',
  '.woff2':  'font/woff2',
  '.ttf':    'font/ttf',
  // T22: офисные файлы (Заказ/Заявка открываются из статики в новой вкладке)
  '.xlsx':   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls':    'application/vnd.ms-excel',
  '.docx':   'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf':    'application/pdf',
  '.txt':    'text/plain; charset=utf-8'
};

// ==================== ОБСЛУЖИВАНИЕ СТАТИКИ ====================
function serveStatic(req, res, PUBLIC_DIR) {
  // Декодируем URL
  let decodedUrl;
  try {
    decodedUrl = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // Защита от path traversal
  const safePath = path.normalize(decodedUrl).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);

  // Проверяем что путь внутри PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Если это директория — ищем index.html
      if (stats && stats.isDirectory()) {
        const indexPath = path.join(filePath, 'index.html');
        fs.readFile(indexPath, (err2, content) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
            res.end(content);
          }
        });
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end('Server Error');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'  // важно при разработке
      });
      res.end(content);
    });
  });
}

// ==================== ПАРСИНГ ТЕЛА ЗАПРОСА ====================
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ==================== ОТПРАВКА JSON ====================
function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

// ==================== ГЕНЕРАЦИЯ ID ====================
function generateId(prefix) {
  const now = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const ts = now.getFullYear().toString() +
    pad(now.getMonth() + 1) + pad(now.getDate()) +
    pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
  const rnd = Math.floor(Math.random() * 100000);
  return `${prefix}_${ts}_${rnd}`;
}

module.exports = { parseBody, send, generateId, serveStatic, MIME_TYPES };