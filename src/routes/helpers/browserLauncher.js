// ============================================================
// ✅ T44: helpers/browserLauncher.js — открытие документа на сайте
// ВАЗ в БРАУЗЕРЕ ПО УМОЛЧАНИЮ (у пользователя — Яндекс Браузер).
//
// РЕФЕРЕНС: пользовательский проект nak_M_15 (переход к накладной
// М-15; ссылка https://disk.360.yandex.ru/d/aa0S4IChGjOIIw):
//   - Яндекс Браузер запускается в РЕЖИМЕ ПРИЛОЖЕНИЯ:
//       browser.exe --app=<URL> --window-size=1280,1000
//     через puppeteer-core (executablePath = browser.exe);
//   - Basic-аутентификация подставляется на уровне браузера
//     (page.authenticate + reload) — аналог VBA AuthPopup/
//     FillCredentials из frmTransportOper (SendKeys в окно
//     «Безопасность Windows» больше не нужны);
//   - окно выводится на передний план (bringToFront);
//   - для накладной М-15: номер вводится в поле A-F-SB01_NOMWB
//     (click clickCount:3 -> type) и нажимается кнопка поиска
//     _findsub.
//
// ✅ T46: УСТОЙЧИВОСТЬ — «нет связи с сайтом» НЕ роняет сервер:
//   1) СВОЙ user-data-dir на каждый запуск (aytsorsing_browser_profile-*):
//      puppeteer-core НЕ управляет чужим профилем и НЕ пытается его
//      удалить. Раньше он создавал временный puppeteer_dev_chrome_profile-*
//      и при обрыве связи сам удалял его, а Windows держала файлы
//      занятыми (EBUSY unlink first_party_sets.db-journal) —
//      необработанный отказ промиса убивал ВЕСЬ сервер (Node >= 15).
//   2) Устаревшие профили (старше 30 минут) чистятся ПЕРЕД запуском
//      «лучшими усилиями»: любые ошибки (файл занят и т.п.) игнорируются.
//   3) Всё, что ПОСЛЕ запуска браузера (авторизация, ожидание поля,
//      ввод номера), при ошибке даёт НЕ исключение, а ответ
//      { ok: true, warning: '...' }: окно браузера остаётся открытым
//      с РЕАЛЬНОЙ страницей сайта (при «нет связи» — страница ошибки
//      браузера), пользователь продолжает вручную, сервер живёт.
//   4) Исключение бросается только если окно открыть НЕ удалось:
//      не установлен puppeteer-core либо браузер не запустился
//      (маршрут вернёт 500 c понятным текстом, сервер продолжает работу).
//
// VBA-ПРОТОТИП (mod_frmTransportOper.frm.bas):
//   CommandButton9_Click          — СЗ: IE.Navigate docs.vaz.ru/
//                                   main.aspx?d_kod=<szTransportID>;
//   FillFormAndSearchInIE_Extended — М-15: tportal.vaz.ru/sipora/ou38,
//                                   заполнение полей + «Поиск».
// Создание IE заменено на запуск Яндекс Браузера (IE automation
// недоступен: браузер по умолчанию — Яндекс, он не поддерживает
// старую COM-автоматизацию; используется CDP через puppeteer-core).
//
// Браузер НЕ закрывается после открытия (пользователь продолжает
// работу в нём — как в референсе); closeAfter — только для тестов.
//
// КОНФИГ: config/browser.json (все ключи необязательны):
//   executable_path — путь к browser.exe Яндекс Браузера;
//   window_size     — размер окна (по умолчанию 1280,1000);
//   headless        — без окна (только для тестов; по умолч. false);
//   timeout_ms      — таймауты навигации/ожидания (20000).
// ============================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Путь из референса nak_M_15 (Яндекс Браузер по умолчанию)
const DEFAULT_EXECUTABLE = 'C:\\Program Files\\Yandex\\YandexBrowser\\Application\\browser.exe';

// ✅ T46: свои профили браузера (не puppeteer_dev_chrome_profile-*)
const PROFILE_PREFIX = 'aytsorsing_browser_profile-';
const PROFILE_MAX_AGE_MS = 30 * 60 * 1000; // чистить старше 30 минут

function loadBrowserConfig() {
  const cfg = {
    executable_path: DEFAULT_EXECUTABLE,
    window_size: '1280,1000',
    headless: false,
    timeout_ms: 20000
  };
  try {
    const raw = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'config', 'browser.json'), 'utf8'));
    if (raw && typeof raw === 'object') {
      if (raw.executable_path) cfg.executable_path = String(raw.executable_path);
      if (raw.window_size) cfg.window_size = String(raw.window_size);
      if (raw.headless !== undefined) cfg.headless = !!raw.headless;
      if (raw.timeout_ms) cfg.timeout_ms = Number(raw.timeout_ms) || 20000;
    }
  } catch (e) { /* файла нет — умолчания */ }
  return cfg;
}

// ✅ T46: техническую ошибку — в понятную пользователю фразу
function humanizeError(e) {
  const m = String((e && e.message) || e || '');
  if (/Target closed|Session closed|Target detached|Target crashed|page crashed/i.test(m))
    return 'окно браузера было закрыто или перезапустилось';
  if (/timeout|timed out|exceeded|Waiting failed/i.test(m))
    return 'превышено время ожидания ответа сайта';
  if (/ERR_CONNECTION|ECONNREFUSED|ENOTFOUND|ERR_NAME|ERR_INTERNET|ERR_TUNNEL|EAI_AGAIN|ERR_PROXY/i.test(m))
    return 'нет связи с сайтом';
  if (/EBUSY|EPERM|EACCES/i.test(m))
    return 'файлы браузера заняты другим процессом';
  return m.slice(0, 200);
}

// ✅ T46: чистка устаревших профилей — ЛУЧШИЕ УСИЛИЯ, никогда не бросает
// исключение и не мешает работе: занятый файл просто попробуем удалить
// при следующем запуске.
function cleanupStaleProfiles() {
  try {
    const now = Date.now();
    const names = fs.readdirSync(os.tmpdir());
    for (const name of names) {
      if (String(name).indexOf(PROFILE_PREFIX) !== 0) continue;
      const dir = path.join(os.tmpdir(), name);
      try {
        const age = now - fs.statSync(dir).mtimeMs;
        if (age < PROFILE_MAX_AGE_MS) continue; // свежий — возможно, окно ещё открыто
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch (e) { /* занят/защищён — попробуем в следующий раз */ }
    }
  } catch (e) { /* tmpdir недоступен — не критично */ }
}

// Открыть URL в браузере по умолчанию (Яндекс Браузер). opts:
//   username/password — Basic-аутентификация сайта (page.authenticate,
//                       референс: page.authenticate + reload);
//   fill               — { selector, value, searchButton }: ввести value
//                        в поле selector и нажать кнопку поиска
//                        (накладная М-15: A-F-SB01_NOMWB + _findsub);
//   closeAfter         — закрыть браузер после открытия (ТОЛЬКО тесты).
// Возвращает { ok, url, warning? }; бросает исключение ТОЛЬКО если
// окно открыть не удалось (puppeteer не установлен / браузер не стартовал).
async function openDocument(targetUrl, opts) {
  opts = opts || {};
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    throw new Error('Не установлен puppeteer-core. Выполните один раз в папке программы: npm install puppeteer-core');
  }
  const cfg = loadBrowserConfig();
  cleanupStaleProfiles(); // ✅ T46: старые профили — лучшими усилиями
  // Референс nak_M_15: args = [--app=URL, --window-size=1280,1000]
  const args = ['--app=' + targetUrl, '--window-size=' + (cfg.window_size || '1280,1000')];
  // ✅ T46: СВОЙ профиль на каждый запуск — puppeteer-core не создаёт и
  // не удаляет временные puppeteer_dev_chrome_profile-* (на Windows
  // попытка удалить занятый профиль давала EBUSY и роняла весь сервер)
  const userDataDir = path.join(os.tmpdir(), PROFILE_PREFIX +
    Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: cfg.executable_path,
      headless: !!cfg.headless,
      defaultViewport: null,
      userDataDir,
      args
    });
  } catch (e) {
    throw new Error('Не удалось запустить браузер (' +
      path.basename(String(cfg.executable_path || '')) + '): ' + humanizeError(e));
  }

  // ✅ T46: всё, что ПОСЛЕ запуска окна — только предупреждения, не
  // исключения. При «нет связи» окно остаётся открытым с реальной
  // страницей сайта (страницей ошибки браузера) — пользователь
  // продолжает вручную, сервер живёт.
  const warnings = [];
  try {
    let page = null;
    try {
      const pages = await browser.pages();
      page = pages.length > 0 ? pages[0] : await browser.newPage();
    } catch (e) {
      warnings.push('Не удалось подключиться к окну браузера (' + humanizeError(e) +
        '). Откройте документ вручную');
      return { ok: true, url: targetUrl, warning: warnings.join(' ') };
    }

    let siteUp = true;
    // Референс: page.authenticate(...) + page.reload(...) — авторизация
    // без нативного окна «Безопасность Windows» (VBA AuthPopup)
    if (opts.username) {
      try {
        await page.authenticate({
          username: String(opts.username),
          password: String(opts.password || '')
        });
        // ✅ T46: именно goto (а не reload) — на «нет связи» он БРОСАЕТ
        // net::ERR_CONNECTION_REFUSED; reload страницы ошибки может
        // «успешно» резолвнуться, и причина потерялась бы
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeout_ms });
      } catch (e) {
        siteUp = false;
        warnings.push('Сайт не открылся (' + humanizeError(e) +
          '). Окно браузера открыто — проверьте связь и войдите вручную');
      }
    }

    // Окно поверх всех и в фокусе (референс: page.bringToFront())
    try { await page.bringToFront(); } catch (e) { /* окно могли закрыть */ }

    // Накладная М-15: waitForSelector -> click clickCount:3 -> type ->
    // click #_findsub (референс /api/open-in-yandex)
    if (opts.fill && opts.fill.selector) {
      if (!siteUp) {
        warnings.push('Номер автоматически не введён (страница не загрузилась) — ' +
          'введите номер и нажмите «Поиск» вручную');
      } else {
        try {
          await page.waitForSelector(opts.fill.selector, { visible: true, timeout: cfg.timeout_ms });
          await page.click(opts.fill.selector, { clickCount: 3 });
          await page.type(opts.fill.selector, String(opts.fill.value == null ? '' : opts.fill.value));
          if (opts.fill.searchButton) {
            await page.click(opts.fill.searchButton);
          }
        } catch (e) {
          warnings.push('Номер автоматически не введён (' + humanizeError(e) +
            ') — введите номер и нажмите «Поиск» вручную');
        }
      }
    }

    const out = { ok: true, url: targetUrl };
    if (warnings.length) out.warning = warnings.join(' ');
    return out;
  } finally {
    // Браузер оставляем открытым пользователю; закрываем только в тестах.
    // ✅ T46: даже закрытие не должно ронять процесс — все ошибки глушим.
    if (opts.closeAfter) {
      try { await browser.close(); } catch (e) { /* не критично */ }
    }
  }
}

module.exports = { openDocument, loadBrowserConfig };
