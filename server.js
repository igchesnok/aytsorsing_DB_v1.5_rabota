// ============================================================
// server.js (фрагмент)
// ============================================================
const http = require('http');
const path = require('path');
const fs = require('fs');

const Database = require('./src/Database');
const WebSocketManager = require('./src/WebSocketManager');
const createRouter = require('./src/router');
const { serveStatic } = require('./src/utils');

const createMockRoutes = require('./src/mock/mockRoutes');
const mockRoutes = createMockRoutes();
const USE_MOCK = false;

const PORT = 3110;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ✅ T46: сервер НЕ должен падать ЦЕЛИКОМ из-за фоновой ошибки в промисе
// (например, puppeteer не смог удалить временный профиль браузера —
// EBUSY на Windows, или обрыв связи с сайтом ВАЗ). Логируем и продолжаем
// работу: падает только конкретная операция, а не вся программа.
process.on('unhandledRejection', (err) => {
  console.error('[T46] Необработанный отказ промиса (сервер продолжает работу):',
    err && err.stack ? err.stack : err);
});
process.on('uncaughtException', (err) => {
  console.error('[T46] Необработанное исключение (сервер продолжает работу):',
    err && err.stack ? err.stack : err);
});

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

(async () => {
  try {
    const db = new Database('firmy.db');
    await db.connect();

    const server = http.createServer();

    // ✅ ИСПРАВЛЕНО: передаём db как второй аргумент
    const wsManager = new WebSocketManager(server, db);

    const routes = {
      auth: require('./src/routes/authRoutes')(db, wsManager),
      firma:   require('./src/routes/firmaRoutes')(db, wsManager),
      adres:   require('./src/routes/adresRoutes')(db, wsManager),
      kont:    require('./src/routes/kontRoutes')(db, wsManager),
      dogovor: require('./src/routes/dogovorRoutes')(db, wsManager),
      uslov:   require('./src/routes/uslovRoutes')(db, wsManager),
      vidyRabot: require('./src/routes/vidyRabotRoutes')(db, wsManager),
      osnastka: require('./src/routes/osnastkaRoutes')(db, wsManager),
      plan: require('./src/routes/planRoutes')(db, wsManager),
      cex:  require('./src/routes/cexRoutes')(db, wsManager),
      grafik: require('./src/routes/grafikRoutes')(db, wsManager),
      perevozchik: require('./src/routes/perevozchikRoutes')(db, wsManager),
      tech: require('./src/routes/techRoutes')(db, wsManager),
      transportTypes: require('./src/routes/transportTypesRoutes')(db, wsManager),
      marshrut: require('./src/routes/marshrutRoutes')(db, wsManager),
      planPerevozok: require('./src/routes/planPerevozokRoutes')(db, wsManager),
      zaprosKp: require('./src/routes/zaprosKpRoutes')(db, wsManager),
      email: require('./src/routes/emailRoutes')(db, wsManager),
      detalStatus: require('./src/routes/detalStatusRoutes')(db, wsManager),
      transportOper: require('./src/routes/transportOperRoutes')(db, wsManager),
      orders: require('./src/routes/orderRoutes')(db, wsManager),
      meeting: require('./src/routes/meetingRoutes')(db, wsManager),
      synthetic: require('./src/routes/syntheticRoutes')(db, wsManager), // ← здесь запрос мапинга автобновления таблиц
      testVS: require('./src/routes/testVirtualSelectRoutes')(),
      // ✅ T52: настройки ЭДО (config/edo.json) — страница «Настройки ЭДО»
      edoSettings: require('./src/routes/edoSettingsRoutes')(db, wsManager),
      // ✅ ОТЧЁТЫ: «Плоская таблица» (блок «Отчеты» главной страницы)
      reports: require('./src/routes/reportRoutes')(db, wsManager),
      // ✅ T102: оплата работ (страница «Оплата работ»)
      oplata:    require('./src/routes/oplataRabotRoutes')(db, wsManager),

    };

    const router = createRouter(PUBLIC_DIR, routes, serveStatic);

    server.on('request', async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      const url = new URL(req.url, `http://${req.headers.host}`);

      if (USE_MOCK) {
        try {
          const mockResult = await mockRoutes(req, res, url, req.method);
          if (mockResult !== null) return;
        } catch (err) {
          console.error('⚠️ Ошибка в mock-роутах:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error (mock)');
          }
          return;
        }
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        await router(req, res);
      } catch (err) {
        console.error('🛑 Ошибка в роутере:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    });

    server.listen(PORT, () => {
      console.log(`🚀 Server: http://localhost:${PORT}`);
      console.log(`📁 Static: ${PUBLIC_DIR}`);
    });

    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down...');
      try {
        await db.close();
      } catch (err) {
        console.error('⚠️ Ошибка закрытия БД:', err);
      }
      process.exit(0);
    });

  } catch (err) {
    console.error('❌ Критическая ошибка при старте сервера:', err);
    process.exit(1);
  }
})();