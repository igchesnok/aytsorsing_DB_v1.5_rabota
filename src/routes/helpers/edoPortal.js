// ============================================================
// ✅ T37-B: helpers/edoPortal.js — ПОЛНЫЙ ПОРТ VBA modEDO
// (mod_modEDO.bas) + сетевые вызовы CommandButton12_Click /
// CommandButton9_Click (frmTransportOper).
//
// «Система» = внутренняя сеть АВТОВАЗа: ЭДО на tportal.vaz.ru
// (создание документа), docs.vaz.ru (переход в ИДО).
//
// АЛГОРИТМ 1:1 КАК В VBA. Изменён только транспорт:
// WinHttp.WinHttpRequest.5.1 -> Node http/https, ADODB.Stream
// -> собственное кодирование windows-1251, HTMLFile COM
// -> токенайзер HTML (✅ T37-C).
//
// Настройки (в VBA — лист «настройки», ячейки E4/E5) читаются
// из config/edo.json в корне проекта:
//   { "url": "https://tportal.vaz.ru",
//     "docs_url": "https://docs.vaz.ru/main.aspx?d_kod=",
//     "username": "Y153434", "password": "...",
//     "reject_unauthorized": false }
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// --- Настройки портала (аналог листа «настройки» VBA) ------------------
// ✅ T51: в настройки, кроме учётных данных, вынесены ИДЕНТИФИКАТОРЫ
// ШАБЛОНОВ всех трёх СЗ и ПАРАМЕТРЫ ПОДПИСЫВАЮЩЕГО каждого СЗ
// (config/edo.json в корне проекта; значения ниже — дефолты, применяются
// когда поле отсутствует в файле):
//   "shablon": {
//     "sz_transport":     "65555751",  — СЗ на транспорт (T37)
//     "sz_sb":            "65133697",  — СЗ в СБ об отгрузке (T42)
//     "sz_soglasovanie":  "65133697"   — СЗ «Согласование заказа по запросу ТКП»
//   }                                    (дефолт = шаблон СЗ в СБ; поменяйте
//                                         на реальный шаблон согласования)
//   "podpisant": {
//     "sz_transport":    { "PODP": "Ломакин А.Н.",  "PODP_KOD": "4663",  "O_OTV_ISP": "Начальник отдела" },
//     "sz_sb":           { "PODP": "Савченко В.М.", "PODP_KOD": "16385", "O_OTV_ISP": "Заместитель директора по производству" },
//     "sz_soglasovanie": { "PODP": "Савченко В.М.", "PODP_KOD": "16385", "O_OTV_ISP": "Заместитель директора по производству" }
//   }
//
// ✅ T52: ТЕМЫ СЛУЖЕБНЫХ ЗАПИСОК (krat_sod, раньше были захардкожены в
// transportOperRoutes.js / zaprosKpRoutes.js) — вынесены в настройки:
//   "tema": {
//     "sz_transport":     "Срочная заявка на {дата} {отправитель} - {получатель}",
//     "sz_sb":            "об отгрузке {дата} {отправитель} - {получатель}",
//     "sz_soglasovanie":  "Согласование заказа по запросу ТКП № {номер}"
//   }
// Подстановки (applyTema, значения подставляются в момент создания СЗ):
//   sz_transport/sz_sb: {дата} — дата отгрузки ДД.ММ.ГГГГ,
//                       {отправитель} — наименование фирмы-отправителя,
//                       {получатель}  — наименование фирмы-получателя;
//   sz_soglasovanie:    {номер} — номер запроса КП,
//                       {дата} — дата запроса ДД.ММ.ГГГГ,
//                       {фирмы} — наименования фирм лучших КП через запятую.
// Редактируются на странице «Настройки ЭДО» (API GET/POST /api/edo-settings).
// ✅ T52: подстановка значений в шаблон темы СЗ (krat_sod).
// Плейсхолдеры — {ключ} (русские ключи: дата/отправитель/получатель/номер/фирмы).
// Значения берутся из контекста создания СЗ (см. комментарий к loadEdoConfig);
// неизвестный/отсутствующий ключ заменяется ПУСТОЙ строкой — чтобы мусор
// вида "{ххх}" не ушёл на портал в кратком содержании документа.
function applyTema(tpl, values) {
  return String(tpl == null ? '' : tpl)
    .replace(/\{([a-zA-Zа-яА-ЯёЁ0-9_]+)\}/g, (m, key) => {
      const v = values && values[key];
      return v == null ? '' : String(v);
    });
}

// --- ✅ T53: ИМЯ-ОТЧЕСТВО адресата из строки «Уважаемый …!» ------------
// Портал кладёт в LETTER нового документа (страница ViewShablon.aspx)
// приветствие с адресатом КОНКРЕТНОГО письма: «Уважаемый Иван Иванович!».
// СЗ адресуются разным людям, а автосборка текста писала одно и то же
// имя-отчество. Отсюда берём ПРАВИЛЬНОЕ: строка всегда начинается
// «Уважаемый/Уважаемая» и заканчивается «!», между ними — имя и отчество.
// Текст без тегов/сущностей либо null (строки приветствия нет).
function extractGreetingName(letterHtml) {
  // приветствие — первая строка письма: ищем только в её начале
  const text = String(letterHtml == null ? '' : letterHtml)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const m = /Уважаем(?:ый|ая)\s+([^!]+?)\s*!/.exec(text);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim();
  // защита от ложных срабатываний: имя-отчество — короткая строка без
  // знаков препинания (иначе «уважаемый» из прозы письма захватит текст
  // до далёкой «!»)
  if (!name || name.length > 80 || /[.,;]/.test(name) || name.split(' ').length > 5) return null;
  return name;
}

// --- ✅ T53: подставить имя-отчество из шаблона в текст письма ----------
// Заменяет ПЕРВОЕ приветствие «Уважаем(ый|ая) …!» в HTML письма
// (автосборка либо правка пользователя из модалки) на персональное.
// Приветствия в письме нет — текст остаётся как есть (удалено сознательно).
function applyGreetingName(letterHtml, name) {
  const s = String(letterHtml == null ? '' : letterHtml);
  if (!s || !name) return s;
  const esc = String(name)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return s.replace(
    /(Уважаем(?:ый|ая))((?:\s|&nbsp;)+)(?:[^!<]+?)((?:\s|&nbsp;)*!)/i,
    (m, w) => w + ' ' + esc + '!');
}

function loadEdoConfig() {
  const defaults = {
    url: 'https://tportal.vaz.ru',
    docs_url: 'https://docs.vaz.ru/main.aspx?d_kod=',
    username: '',
    password: '',
    reject_unauthorized: false,
    // ✅ T51: идентификаторы шаблонов всех трёх СЗ (см. комментарий выше)
    shablon: {
      sz_transport: '65555751',
      sz_sb: '65133697',
      sz_soglasovanie: '65133697'
    },
    // ✅ T51: параметры подписывающего каждого СЗ (были захардкожены:
    //   sz_transport — setDefaults T37, sz_sb — defaults T43)
    podpisant: {
      sz_transport: { PODP: 'Ломакин А.Н.', PODP_KOD: '4663', O_OTV_ISP: 'Начальник отдела' },
      sz_sb: { PODP: 'Савченко В.М.', PODP_KOD: '16385', O_OTV_ISP: 'Заместитель директора по производству' },
      sz_soglasovanie: { PODP: 'Савченко В.М.', PODP_KOD: '16385', O_OTV_ISP: 'Заместитель директора по производству' }
    },
    // ✅ T52: темы СЗ (krat_sod) — дефолты = прежние захардкоженные строки;
    // плейсхолдеры {…} подставляются applyTema в момент создания СЗ
    tema: {
      sz_transport: 'Срочная заявка на {дата} {отправитель} - {получатель}',
      sz_sb: 'об отгрузке {дата} {отправитель} - {получатель}',
      sz_soglasovanie: 'Согласование заказа по запросу ТКП № {номер}'
    },
    // ✅ T55: тип присвоения номера СЗ при создании на портале
    // (Create_doc_on_template.aspx):
    //   'avto'   — автосоздание: rd=1, ch_otl=1 (номер присваивается сразу;
    //              прежнее поведение);
    //   'otlozh' — отложенное присвоение номера: rd=2, ch_otl=2.
    // Применяется к СЗ в СБ об отгрузке (sz_sb); дефолт — «отложенное».
    sz_nomer: {
      sz_sb: 'otlozh'
    }
  };
  try {
    const p = path.join(__dirname, '..', '..', '..', 'config', 'edo.json');
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      // ✅ T52-B: ТОЛЕРАНТНОСТЬ К ПОДПИСАНТАМ НА ВЕРХНЕМ УРОВНЕ файла.
      // Конфиги, правленные руками, иногда содержат блоки вида
      //   "sz_sb": { "PODP": "...", "PODP_KOD": "...", "O_OTV_ISP": "..." }
      // БЕЗ обёртки "podpisant" — код такой блок НЕ читает, и настройки
      // подписанта «не работают». Считаем верхнеуровневые блоки
      // sz_transport/sz_sb/sz_soglasovanie (если в них есть поля подписанта)
      // легаси-синонимом podpisant.*: складываем их куда положено.
      // ПРИОРИТЕТ за правильным блоком: cfg.podpisant.k сильнее cfg[k].
      const podpShape = (o) => o && typeof o === 'object' && !Array.isArray(o) &&
        (o.PODP !== undefined || o.PODP_KOD !== undefined || o.O_OTV_ISP !== undefined);
      if (!cfg.podpisant || typeof cfg.podpisant !== 'object' || Array.isArray(cfg.podpisant)) cfg.podpisant = {};
      for (const k of ['sz_transport', 'sz_sb', 'sz_soglasovanie']) {
        if (podpShape(cfg[k]) && !podpShape(cfg.podpisant[k])) cfg.podpisant[k] = cfg[k];
      }
      // ✅ T51: глубокое слияние ТОЛЬКО для блоков shablon/podpisant — частичный
      // конфиг (например, только "sz_sb") не должен терять остальные дефолты;
      // ✅ T52: к блокам добавлен tema (темы СЗ); ✅ T55 — sz_nomer (тип
      // присвоения номера СЗ).
      // остальные ключи — как раньше (Object.assign, верхний уровень).
      const merged = Object.assign({}, defaults, cfg);
      for (const block of ['shablon', 'podpisant', 'tema', 'sz_nomer']) {
        merged[block] = Object.assign({}, defaults[block],
          cfg && typeof cfg[block] === 'object' && !Array.isArray(cfg[block]) ? cfg[block] : {});
      }
      // podpisant.* — сливаем и по полям PODP/PODP_KOD/O_OTV_ISP
      for (const key of Object.keys(merged.podpisant)) {
        merged.podpisant[key] = Object.assign({}, defaults.podpisant[key], merged.podpisant[key]);
      }
      // ✅ T52: tema.* — частичная тема не должна терять дефолтные ключи
      for (const key of Object.keys(merged.tema)) {
        if (merged.tema[key] == null) merged.tema[key] = defaults.tema[key];
      }
      return merged;
    }
  } catch (e) { /* нет файла/битый JSON — работаем на дефолтах */ }
  return defaults;
}

// --- windows-1251 (VBA ADODB.Stream Charset="windows-1251") ------------
const WIN1251_SPECIAL = {
  0x20AC: 0x88, 0x0452: 0x80, 0x0403: 0x83, 0x201A: 0x82, 0x201E: 0x84,
  0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2030: 0x89, 0x0409: 0x8A,
  0x2039: 0x8B, 0x040A: 0x8C, 0x040C: 0x8D, 0x040B: 0x8E, 0x040F: 0x8F,
  0x0452: 0x90, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94,
  0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99, 0x203A: 0x9B,
  0x0459: 0x9C, 0x045A: 0x9E, 0x045F: 0x9F, 0x00A0: 0xA0, 0x040E: 0xA1,
  0x045E: 0xA2, 0x0408: 0xA3, 0x00A4: 0xA4, 0x0490: 0xA5, 0x00A6: 0xA6,
  0x00A7: 0xA7, 0x0401: 0xA8, 0x00A9: 0xA9, 0x0404: 0xAA, 0x00AB: 0xAB,
  0x00AC: 0xAC, 0x00AD: 0xAD, 0x00AE: 0xAE, 0x0407: 0xAF, 0x00B0: 0xB0,
  0x00B1: 0xB1, 0x0406: 0xB2, 0x0456: 0xB3, 0x0491: 0xB4, 0x00B5: 0xB5,
  0x00B6: 0xB6, 0x00B7: 0xB7, 0x0451: 0xB8, 0x2116: 0xB9, 0x0454: 0xBA,
  0x00BB: 0xBB, 0x0458: 0xBC, 0x0405: 0xBD, 0x0455: 0xBE, 0x0457: 0xBF
};

function stringToWin1251Bytes(text) {
  const s = String(text || '');
  const out = Buffer.alloc(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out[i] = c;
    else if (c >= 0x0410 && c <= 0x044F) out[i] = c - 0x0410 + 0xC0;
    else if (WIN1251_SPECIAL[c] !== undefined) out[i] = WIN1251_SPECIAL[c];
    else out[i] = 0x3F; // незнакомый символ -> '?'
  }
  return out;
}

// --- VBA EncodeBytesToUrl: URL-кодирование массива байтов --------------
// (A-Z a-z 0-9 - . _ ~ как есть, пробел -> '+', остальное -> %XX)
function encodeBytesToUrl(bytes) {
  let r = '';
  for (const c of bytes) {
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 45 || c === 46 || c === 95 || c === 126) r += String.fromCharCode(c);
    else if (c === 32) r += '+';
    else r += '%' + c.toString(16).toUpperCase().padStart(2, '0');
  }
  return r;
}

// VBA UrlEncodeWin1251
function urlEncodeWin1251(text) {
  if (!text) return '';
  return encodeBytesToUrl(stringToWin1251Bytes(text));
}

// VBA UrlEncodeUTF8 (без BOM)
function urlEncodeUtf8(text) {
  if (!text) return '';
  return encodeBytesToUrl(Buffer.from(String(text), 'utf8'));
}

// --- VBA SendPostRequest (WinHttp, Basic-аутентификация) ---------------
// Возвращает responseText; не-200 -> '{"oper": "ERR", "message": "HTTP Status N"}'
// (ровно как в VBA).
function sendPostRequest(username, password, url, postData, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Неверный URL: ' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      timeout: opts.timeoutMs || 30000,
      rejectUnauthorized: opts.rejectUnauthorized !== undefined ? !!opts.rejectUnauthorized : false,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=windows-1251',
        'Authorization': 'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64'),
        'Content-Length': Buffer.byteLength(String(postData), 'utf8')
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          return resolve('{"oper": "ERR", "message": "HTTP Status ' + res.statusCode + '"}');
        }
        // Портал отдаёт windows-1251; пробуем utf8, при кракозябрах декодируем 1251
        resolve(decodePortalBody(body));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут запроса к порталу')));
    req.on('error', (e) => reject(new Error('Ошибка соединения с порталом: ' + e.message)));
    req.write(Buffer.from(String(postData), 'utf8'));
    req.end();
  });
}

// --- VBA SendGetRequest (WinHttp, Basic-аутентификация) ----------------
function sendGetRequest(username, password, url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Неверный URL: ' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      timeout: opts.timeoutMs || 30000,
      rejectUnauthorized: opts.rejectUnauthorized !== undefined ? !!opts.rejectUnauthorized : false,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64')
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          return resolve('{"oper": "ERR", "message": "HTTP Status ' + res.statusCode + '"}');
        }
        resolve(decodePortalBody(body));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут запроса к порталу')));
    req.on('error', (e) => reject(new Error('Ошибка соединения с порталом: ' + e.message)));
    req.end();
  });
}

// Портал возвращает windows-1251; если тело не валидный UTF-8 — декодируем 1251
function decodePortalBody(buf) {
  const s = buf.toString('utf8');
  // Признак перекодировки: U+FFFD (не декодировалось) — читаем как 1251
  if (s.includes('\uFFFD')) return buf.toString('latin1')
    .split('').map((ch) => {
      const b = ch.charCodeAt(0) & 0xFF;
      if (b < 0x80) return ch;
      if (b >= 0xC0) return String.fromCharCode(0x0410 + (b - 0xC0));
      for (const [uni, win] of Object.entries(WIN1251_SPECIAL)) {
        if (win === b) return String.fromCharCode(Number(uni));
      }
      return ch;
    }).join('');
  return s;
}

// --- VBA CreateCardParams: пустая карточка документа -------------------
function createCardParams() {
  return {
    D_KOD: '', D_TYPE: '',            // идентификаторы
    D_NAME: '', D_NOM: '', DATE_DOC: '', // содержание
    FIO: '', DOLGN: '', KOMY: '',     // получатель (кому)
    NA_NOM: '', OT: '',               // отправитель (входящий)
    PODP: '', PODP_KOD: '', O_OTV_ISP: '', // подписант
    D_ISPOLN: '', D_ISPOLN_KOD: '', D_ISPOLN_KOD_PODR: '', TEL_ISP: '', // исполнитель
    KOL_LIST: '', KOL_EKZ: '',        // учёт
    PRIVACY: ''                       // доступ
  };
}

// --- VBA SetDefaults: подписант СЗ НА ТРАНСПОРТ -------------------------
// ✅ T51: подписант берётся из настроек (config/edo.json → podpisant.
// sz_transport; дефолт — прежний «Ломакин А.Н.» из VBA). Сигнатура
// расширена: setDefaults(card, cfg) — cfg передаёт kartEdit.
function setDefaults(card, cfg) {
  const p = (cfg && cfg.podpisant && cfg.podpisant.sz_transport) || {};
  card.PRIVACY = 'D';
  card.PODP = p.PODP !== undefined ? p.PODP : 'Ломакин А.Н.';
  card.PODP_KOD = p.PODP_KOD !== undefined ? p.PODP_KOD : '4663';
  card.O_OTV_ISP = p.O_OTV_ISP !== undefined ? p.O_OTV_ISP : 'Начальник отдела';
}

// --- VBA FillFromHTML: значения полей карточки из HTML -----------------
// (в VBA — HTMLFile COM: getElementById, затем getElementsByName;
//  для INPUT/SELECT/TEXTAREA — .value, для прочих — Trim(innerText)).
//
// ✅ T37-C: HTMLFile — НАСТОЯЩИЙ HTML-парсер: ему безразличны незакавыченные
// атрибуты, «>» внутри значений атрибутов, имя/регистр тега, переводы строк
// внутри тега, комментарии и <script>. Прежний regex-парсер, заточенный под
// mock-портал, на реальной странице KartEdit.aspx не находил D_NOM/DATE_DOC
// -> карточка уходила в DocumentSave с пустыми D_NOM/DATE_DOC -> портал
// перезаписывал дату письма пустотой («письмо без даты»), а BB6 в Excel
// получался « от » без номера и даты. Здесь — компактный токенайзер HTML
// с теми же семантиками, что у MSHTML.

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, '\u00A0')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAWTEXT_TAGS = new Set(['script', 'style']);
const WS = ' \t\r\n\f';

// Мини-парсер HTML (в духе HTML5-токенайзера): дерево элементов и текстовых
// узлов. Устойчив к незакавыченным атрибутам, «>» внутри кавычек значений,
// многострочным тегам, комментариям, DOCTYPE/CDATA, <script>/<style>.
function parseHtmlDom(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = html.length;
  const top = () => stack[stack.length - 1];
  const addText = (t) => { if (t) top().children.push({ text: decodeEntities(t) }); };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { addText(html.slice(i)); break; }
    if (lt > i) addText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {                    // комментарий — мимо
      const e = html.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) { // DOCTYPE/CDATA/PI
      const e = html.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const mClose = /^<\/\s*([a-zA-Z][^\s>/]*)/.exec(html.slice(lt, lt + 60));
    if (html[lt + 1] === '/' && mClose) {                 // закрывающий тег
      const gt = html.indexOf('>', lt);
      i = gt < 0 ? n : gt + 1;
      const name = mClose[1].toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === name) { stack.length = s; break; }
      }
      continue;
    }
    const mTag = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(lt, lt + 60));
    if (!mTag) { addText('<'); i = lt + 1; continue; }    // «<» — не тег, текст
    const tag = mTag[1].toLowerCase();
    // --- атрибуты: до «>»; «>» внутри кавычек значения — часть значения ---
    const attrs = {};
    let p = lt + 1 + mTag[1].length;
    let selfClosing = false;
    while (p < n) {
      while (p < n && WS.includes(html[p])) p++;
      if (p >= n) break;
      if (html[p] === '>') { p++; break; }
      if (html[p] === '/') {
        if (html[p + 1] === '>') { selfClosing = true; p += 2; break; }
        p++;
        continue;
      }
      const a0 = p;
      while (p < n && !WS.includes(html[p]) && html[p] !== '=' && html[p] !== '>' && html[p] !== '/') p++;
      if (p === a0) { p++; continue; }
      const aName = html.slice(a0, p).toLowerCase();
      while (p < n && WS.includes(html[p])) p++;
      let aVal = '';
      if (html[p] === '=') {
        p++;
        while (p < n && WS.includes(html[p])) p++;
        const q = html[p];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, p + 1);
          aVal = e < 0 ? html.slice(p + 1) : html.slice(p + 1, e);
          p = e < 0 ? n : e + 1;
        } else {
          const v0 = p;
          while (p < n && !WS.includes(html[p]) && html[p] !== '>') p++;
          aVal = html.slice(v0, p);
        }
      }
      if (attrs[aName] === undefined) attrs[aName] = decodeEntities(aVal);
    }
    i = p;
    const el = { tag, attrs, children: [] };
    top().children.push(el);
    if (!selfClosing && !VOID_TAGS.has(tag)) {
      stack.push(el);
      if (RAWTEXT_TAGS.has(tag)) {                        // script/style: raw text
        const cm = new RegExp('</\\s*' + tag + '\\s*>', 'i').exec(html.slice(i));
        if (cm) {
          if (cm.index > 0) el.children.push({ text: html.slice(i, i + cm.index) });
          i += cm.index + cm[0].length;
        } else {
          el.children.push({ text: html.slice(i) });
          i = n;
        }
        stack.pop();
      }
    }
  }
  return root;
}

// innerText (как у MSHTML): текст поддерева, <br> -> \r\n, script/style не текст
function elementText(el) {
  let out = '';
  for (const ch of el.children) {
    if (ch.text !== undefined) out += ch.text;
    else if (ch.tag === 'br') out += '\r\n';
    else if (ch.tag === 'script' || ch.tag === 'style') { /* не текст */ }
    else out += elementText(ch);
  }
  return out;
}

// .value как у MSHTML: input -> value-атрибут; textarea -> текст;
// select -> value ВЫБРАННОГО option (нет selected — первый, selectedIndex=0);
// option без value -> его текст.
function elementValue(el) {
  if (el.tag === 'input') return el.attrs.value !== undefined ? el.attrs.value : '';
  if (el.tag === 'textarea') return elementText(el);
  if (el.tag === 'select') {
    let first = null, selected = null;
    (function walk(node) {
      for (const ch of node.children) {
        if (!ch.tag) continue;
        if (ch.tag === 'option') {
          const val = ch.attrs.value !== undefined ? ch.attrs.value : elementText(ch);
          if (first === null) first = val;
          if (selected === null && ch.attrs.selected !== undefined) selected = val;
        } else {
          walk(ch);
        }
      }
    })(el);
    return selected !== null ? selected : (first !== null ? first : '');
  }
  return '';
}

// VBA Trim() убирает только пробелы (Chr 32) — как в VBA для innerText
function vbaTrim(s) {
  let a = 0, b = s.length;
  while (a < b && s.charCodeAt(a) === 32) a++;
  while (b > a && s.charCodeAt(b - 1) === 32) b--;
  return s.slice(a, b);
}

// VBA FillFromHTML: по каждому ключу карточки getElementById,
// затем getElementsByName (первый элемент в порядке документа)
function fillFromHTML(card, html) {
  const root = parseHtmlDom(String(html || ''));
  const byId = new Map(), byName = new Map();
  (function walk(node) {
    for (const ch of node.children) {
      if (!ch.tag) continue;
      if (ch.attrs.id !== undefined && !byId.has(ch.attrs.id)) byId.set(ch.attrs.id, ch);
      if (ch.attrs.name !== undefined && !byName.has(ch.attrs.name)) byName.set(ch.attrs.name, ch);
      walk(ch);
    }
  })(root);
  const findByIdOrName = (key) => {
    // как в VBA (getElementById, затем getElementsByName); регистронезависимый
    // фолбэк — надмножество MSHTML, спасает при ином регистре id на странице
    let el = byId.get(key) || byName.get(key);
    if (el) return el;
    const kl = String(key).toLowerCase();
    for (const [id, e] of byId) if (id.toLowerCase() === kl) return e;
    for (const [nm, e] of byName) if (nm.toLowerCase() === kl) return e;
    return null;
  };
  for (const key of Object.keys(card)) {
    const el = findByIdOrName(key);
    if (!el) continue; // поля нет на странице — ключ остаётся прежним (как в VBA)
    if (el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea') {
      card[key] = elementValue(el);
    } else {
      card[key] = vbaTrim(elementText(el));
    }
  }
}

// --- VBA ToPostString: key=value&... (значения UTF-8) ------------------
function toPostString(card) {
  return Object.keys(card).map((k) => k + '=' + urlEncodeUtf8(card[k] == null ? '' : card[k])).join('&');
}

// --- VBA KartEdit: GET карточки -> заполнение -> SetDefaults -> POST ---
// (ошибки в VBA показывались MsgBox; здесь — исключение с тем же текстом)
//
// ✅ T37-C (замечание пользователя): на ПЕРВЫЙ запрос GET KartEdit.aspx
// портал ВАЗ отвечает ПУСТОЙ страницей (баг самого портала), правильный
// HTML приходит только на ПОВТОРНЫЙ запрос. Поэтому ответ КАЖДОГО запроса
// проверяется: пустая страница / не HTML / HTML без полей карточки —
// запрос повторяется; как только пришла правильная страница (заполнился
// D_KOD) — цикл завершается. Прежний код делал ОДИН запрос, не различая
// пустую страницу и правильный HTML: карточка уходила в DocumentSave
// с пустыми D_NOM/DATE_DOC -> портал затирал дату письма, а в Excel
// BB6 получался « от » без номера и даты.
async function kartEdit(username, password, dKod, card, opts) {
  const cfg = opts && opts.cfg ? opts.cfg : loadEdoConfig();
  const baseUrl = cfg.url + '/kisp/';
  const maxAttempts = opts && opts.kartEditAttempts ? opts.kartEditAttempts : 3;
  let filled = false;
  let htmlResponse = '';
  for (let attempt = 1; attempt <= maxAttempts && !filled; attempt++) {
    htmlResponse = await sendGetRequest(username, password, baseUrl + 'KartEdit.aspx?d_kod=' + encodeURIComponent(dKod), opts);
    if (String(htmlResponse).startsWith('{"oper": ')) {
      throw new Error('KartEdit: ' + htmlResponse); // как в VBA — ошибка портала
    }
    // пустая страница или не HTML — повторить запрос (первый GET портала всегда пуст)
    if (!String(htmlResponse).trim() || String(htmlResponse).indexOf('<') < 0) continue;
    // 3. Заполняем из HTML (универсально, по ключам)
    fillFromHTML(card, htmlResponse);
    // правильная страница карточки всегда содержит код документа (D_KOD —
    // ключ №1 карточки, VBA читает его с этой же страницы); HTML-заглушка
    // без полей — тоже повторить
    filled = String(card.D_KOD == null ? '' : card.D_KOD).trim() !== '';
  }
  // ✅ T37-C: диагностика — последний HTML карточки портала сохраняется
  // в logs/edo_kartedit_last.html (если поля снова не разберутся —
  // файл покажет реальную структуру страницы).
  try {
    const logsDir = path.join(__dirname, '..', '..', '..', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'edo_kartedit_last.html'), String(htmlResponse), 'utf8');
  } catch (e) { /* диагностика не должна ломать алгоритм */ }
  if (!filled) {
    throw new Error('KartEdit: портал вернул пустую страницу после ' + maxAttempts + ' запросов (баг портала ВАЗ). Повторите создание СЗ');
  }
  // ✅ T37-C: если номер/дата не разобрались — сигнал в консоль сервера
  if (!String(card.D_NOM || '').trim() || !String(card.DATE_DOC || '').trim()) {
    console.warn('[EDO] KartEdit: пустые D_NOM/DATE_DOC после разбора карточки — см. logs/edo_kartedit_last.html');
  }
  // 4. Устанавливаем значения по умолчанию (подписант СЗ на транспорт —
  // ✅ T51: из настроек config/edo.json → podpisant.sz_transport)
  // ✅ T42: opts.keepSignatory — подписант остаётся СО СТРАНИЦЫ карточки
  // (шаблон СЗ в СБ 65133697 подставляет «Савченко В.М.» сам; SetDefaults
  // с «Ломакиным А.Н.» к нему не применяется). T37-поток — без изменений.
  if (!(opts && opts.keepSignatory)) setDefaults(card, cfg);
  // ✅ T43: opts.defaults — жёсткая установка полей карточки ПОВЕРХ значений,
  // разобранных со страницы (порт VBA setDefaultsOtgryz: PRIVACY='D',
  // PODP='Савченко В.М.', PODP_KOD='16385', O_OTV_ISP='Заместитель директора
  // по производству'). Применяется ПОСЛЕ fillFromHTML/setDefaults и всегда
  // побеждает страницу (там мог остаться исполнитель Чесноков И.И.);
  // потоки без opts.defaults (T37/T39) работают как раньше.
  if (opts && opts.defaults) {
    for (const k of Object.keys(opts.defaults)) {
      if (opts.defaults[k] !== undefined && opts.defaults[k] !== null) card[k] = opts.defaults[k];
    }
  }
  // Формируем и отправляем POST
  const saveResponse = await sendPostRequest(username, password, baseUrl + 'ajax/DocumentSave.aspx', toPostString(card), opts);
  if (!String(saveResponse).includes('"Error":null')) {
    throw new Error('DocumentSave: ' + String(saveResponse).slice(0, 300));
  }
  return card;
}

// --- VBA-код из CommandButton12: kod = Split(Split(response, "d_kod=")(1), "'")(0)
function parseDkodFromResponse(response) {
  const s = String(response);
  const i = s.indexOf('d_kod=');
  if (i < 0) throw new Error('В ответе портала нет d_kod=: ' + s.slice(0, 200));
  const rest = s.slice(i + 6);
  const q = rest.indexOf("'");
  if (q < 0) throw new Error('В ответе портала нет d_kod=\'...: ' + s.slice(0, 200));
  return rest.slice(0, q);
}

// --- RCDATA-извлечение <textarea> ИЗ ИСХОДНОГО HTML (✅ T39-B) ----------
// Содержимое textarea дословно, как в исходнике страницы: теги НЕ
// разбираются, сущности НЕ декодируются. Тело письма (LETTER) на
// ViewShablon.aspx — HTML-разметка, портал кладёт её в <textarea> как
// есть (<div style=…>, &nbsp;, <br />) — именно в таком виде она ходит
// по кругу «страница -> POST -> портал» (эталон — захват POST
// SaveShablon.aspx). elementValue/elementText здесь НЕ годятся: они
// разбирают содержимое как DOM и выбрасывают все теги (разметка терялась
// ещё до модального окна). Поля с таким name нет -> null.
function extractTextareaRaw(html, name) {
  const s = String(html || '');
  const target = String(name || '').toLowerCase();
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<textarea', i);
    if (lt < 0) break;
    const after = s[lt + 9];
    if (after && !WS.includes(after)) { i = lt + 9; continue; } // не тег
    // --- атрибуты тега до закрывающей «>» («>» в кавычках значения — часть значения)
    let p = lt + 9, nameAttr = null, gt = -1;
    while (p < s.length) {
      while (p < s.length && WS.includes(s[p])) p++;
      if (p >= s.length) break;
      if (s[p] === '>') { gt = p; break; }
      const a0 = p;
      while (p < s.length && !WS.includes(s[p]) && s[p] !== '=' && s[p] !== '>') p++;
      if (p === a0) { p++; continue; }
      const aName = s.slice(a0, p).toLowerCase();
      let q = p;
      while (q < s.length && WS.includes(s[q])) q++;
      if (s[q] === '=') {
        q++;
        while (q < s.length && WS.includes(s[q])) q++;
        if (s[q] === '"' || s[q] === "'") {
          const e = s.indexOf(s[q], q + 1);
          if (aName === 'name') nameAttr = e < 0 ? s.slice(q + 1) : s.slice(q + 1, e);
          p = e < 0 ? s.length : e + 1;
        } else {
          const v0 = q;
          while (q < s.length && !WS.includes(s[q]) && s[q] !== '>') q++;
          if (aName === 'name') nameAttr = s.slice(v0, q);
          p = q;
        }
      } else {
        if (aName === 'name') nameAttr = '';
        p = q > p ? q : p + 1;
      }
    }
    if (gt < 0) break;
    const cm = /<\/\s*textarea\s*>/i.exec(s.slice(gt + 1));
    const contentEnd = cm ? gt + 1 + cm.index : s.length;
    if (String(nameAttr || '').toLowerCase() === target) {
      return s.slice(gt + 1, contentEnd);
    }
    i = contentEnd; // следующий <textarea> ищем после этого
  }
  return null;
}

// --- ✅ T61: HTML письма из ПОДПИСАННОГО документа (<div id="LetterDiv">) --
// Подписанный на портале документ: ViewShablon.aspx?mode=edit&d_kod= отдаёт
// страницу БЕЗ редактируемой формы (поля LETTER нет) — текст письма портал
// кладёт в <div id="LetterDiv" …>…</div> только для просмотра. Возвращаем
// ВНУТРЕННИЙ HTML div как есть (теги и сущности не трогаем — разметка идёт
// прямо в окно просмотра, как тело письма); вложенные <div> внутри письма
// учитываются подсчётом баланса тегов. LetterDiv нет (или он пуст) -> null.
function extractLetterDivHTML(html) {
  const s = String(html || '');
  const m = /<div\b[^>]*\bid\s*=\s*(?:(["'])LetterDiv\1|LetterDiv(?=[\s>]))[^>]*>/i.exec(s);
  if (!m) return null;
  const from = m.index + m[0].length;   // начало внутреннего HTML
  const re = /<\s*(\/)?\s*div\b/gi;     // открывающие/закрывающие теги div
  re.lastIndex = from;
  let depth = 1, mm;
  while ((mm = re.exec(s)) !== null) {
    depth += mm[1] ? -1 : 1;
    if (depth === 0) {
      const inner = s.slice(from, mm.index).trim();
      return inner || null;
    }
  }
  // закрывающий </div> не найден (битая разметка) — берём до конца страницы
  const tail = s.slice(from).trim();
  return tail || null;
}

// --- Сбор ВСЕХ именованных полей формы страницы ViewShablon.aspx -------
// (✅ T39-B) Семантика отправки формы браузером — эталон: захват POST
// SaveShablon.aspx (23 части в порядке DOM):
//   - только элементы с атрибутом name (d_type/d_writer/d_reg/kategor
//     name не имеют и браузером не отправляются);
//   - input -> value-атрибут; textarea -> исходное содержимое
//     (extractTextareaRaw, RCDATA — разметка тела не трогается);
//   - select multiple -> каждый option отдельной частью; ни один не
//     помечен selected -> все (реестр рассылки: DESTINATION_LIST=19049);
//   - select одиночный -> выбранный option, иначе первый; PRIVACY без
//     selected -> «D» (на странице его задаёт скрипт
//     document.getElementById('PRIVACY').value='D');
//   - поля с классом disabledElem браузер отправляет ПУСТЫМИ
//     (NA_NOM/OT/DOLGN/FIO в захвате — пустые части).
// Возвращает упорядоченный массив [name, value].
function collectShablonFormFields(html) {
  const root = parseHtmlDom(String(html || ''));
  const fields = [];
  const rawCache = {};
  const textareaRaw = (nm) => {
    if (rawCache[nm] === undefined) rawCache[nm] = extractTextareaRaw(html, nm);
    return rawCache[nm];
  };
  const optVals = (selNode, onlySelected) => {
    const vals = [];
    (function walk2(node) {
      for (const c of node.children) {
        if (!c.tag) continue;
        if (c.tag === 'option') {
          if (!onlySelected || c.attrs.selected !== undefined) {
            vals.push(c.attrs.value !== undefined ? c.attrs.value : elementText(c));
          }
        } else walk2(c);
      }
    })(selNode);
    return vals;
  };
  (function walk(node) {
    for (const ch of node.children) {
      if (!ch.tag) continue;
      const nm = ch.attrs.name;
      if ((ch.tag === 'input' || ch.tag === 'textarea' || ch.tag === 'select') && nm) {
        const cls = String(ch.attrs.class || '');
        const disabled = cls.split(/\s+/).indexOf('disabledElem') >= 0;
        if (ch.tag === 'input') {
          fields.push([nm, disabled ? '' : (ch.attrs.value !== undefined ? ch.attrs.value : '')]);
        } else if (ch.tag === 'textarea') {
          const raw = disabled ? '' : textareaRaw(nm);
          fields.push([nm, raw !== null ? raw : elementText(ch)]);
        } else { // select
          if (ch.attrs.multiple !== undefined) {
            const vals = optVals(ch, true).length ? optVals(ch, true) : optVals(ch, false);
            for (const v of vals) fields.push([nm, v]);
          } else {
            const sel = optVals(ch, true);
            if (sel.length) fields.push([nm, sel[0]]);
            else {
              const all = optVals(ch, false);
              // PRIVACY: selected ставит скриптом страницы (value='D')
              fields.push([nm, all.length ? (nm.toUpperCase() === 'PRIVACY' ? 'D' : all[0]) : '']);
            }
          }
        }
      }
      walk(ch);
    }
  })(root);
  return fields;
}

// --- Multipart-тело SaveShablon.aspx (✅ T39-B, формат браузера) -------
// ------WebKitFormBoundaryXXXXXXXXXXXX\r
// Content-Disposition: form-data; name="d_kod"\r
// \r
// 65882581\r
// ...
// ------WebKitFormBoundaryXXXXXXXXXXXX--\r
// Значения — байты windows-1251 (stringToWin1251Bytes), как у браузера
// на странице в 1251.
function buildMultipartBody(fields, boundary) {
  const chunks = [];
  for (const pair of fields) {
    const val = pair[1] === undefined || pair[1] === null ? '' : String(pair[1]);
    chunks.push(stringToWin1251Bytes(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + String(pair[0]) + '"\r\n' +
      '\r\n'));
    chunks.push(stringToWin1251Bytes(val));
    chunks.push(stringToWin1251Bytes('\r\n'));
  }
  chunks.push(stringToWin1251Bytes('--' + boundary + '--\r\n'));
  return Buffer.concat(chunks);
}

// --- SaveTemplateToPortal: сохранение тела (шаблона) документа ---------
// POST …/kisp/SaveShablon.aspx. ЭТАЛОН (✅ T39-B) — захват POST браузера
// со страницы ViewShablon.aspx?mode=edit&d_kod=:
//   multipart/form-data с разделителями ------WebKitFormBoundary…,
//   значения в windows-1251, ВСЕ именованные поля страницы (d_kod,
//   kod_proizv, kod_podr, prinadl, registrator, IS_DEST_LIST, DATE_DOC,
//   D_NOM, NA_NOM, OT, D_NAME, DESTINATION_LIST, DOLGN, KOMY, FIO,
//   LETTER, O_OTV_ISP, PODP, PODP_KOD, D_ISPOLN, D_ISPOLN_KOD, TEL_ISP,
//   PRIVACY). Значения подписанта/исполнителя/адресатов/телефона уходят
//   СО СТРАНИЦЫ — иначе портал затирает данные документа
//   (opts.fields = collectShablonFormFields(HTML), LETTER в массиве
//   заменяется отредактированным текстом).
// ⚠ ВАЖНО: вариант VBA (mod_modEDO.bas: form-urlencoded, PODP="",
// D_ISPOLN="", PODP_KOD/D_ISPOLN_KOD/TEL_ISP — Optional="") в VBA-проекте
// НИ РАЗУ не вызывался и данные документа затирал — сохранён как
// резервный путь (opts.fields не передан), поля те же + UrlEncodeWin1251.
// Заголовки «как в браузере»: Content-Type multipart/form-data;
// boundary=…, User-Agent Mozilla/5.0 (Windows NT 10.0; Win64; x64)
// AppleWebKit/537.36, Accept */*, Accept-Language ru,en;q=0.9, Referer
// …/kisp/ViewShablon.aspx?mode=edit&d_kod=<d_kod>, Origin, Connection
// keep-alive; аутентификация — Basic (VBA SetCredentials 0);
// результат: true, если портал ответил 200
// (VBA: SaveTemplateToPortal = (HttpReq.status = 200)).
function saveTemplateToPortal(dKod, letterContent, username, password, opts) {
  opts = opts || {};
  const cfg = opts.cfg || loadEdoConfig();
  const url = cfg.url + '/kisp/SaveShablon.aspx';
  const letter = String(letterContent === undefined || letterContent === null ? '' : letterContent);

  let body, contentType, referer;
  if (Object.prototype.toString.call(opts.fields) === '[object Array]' && opts.fields.length) {
    // === Эталон (браузер): multipart со значениями СО СТРАНИЦЫ ===
    const AB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let rnd = '';
    for (let i = 0; i < 16; i++) rnd += AB[Math.floor(Math.random() * AB.length)];
    const boundary = '----WebKitFormBoundary' + rnd;
    const fields = [];
    let hasLetter = false, hasDkod = false;
    for (const pair of opts.fields) {
      const nm = String(pair[0] || '');
      if (nm.toUpperCase() === 'LETTER') { hasLetter = true; fields.push([nm, letter]); }
      else fields.push([nm, pair[1]]);
      if (nm.toLowerCase() === 'd_kod') hasDkod = true;
    }
    if (!hasLetter) fields.push(['LETTER', letter]);
    if (!hasDkod) fields.unshift(['d_kod', dKod]);
    body = buildMultipartBody(fields, boundary);
    contentType = 'multipart/form-data; boundary=' + boundary;
    referer = cfg.url + '/kisp/ViewShablon.aspx?mode=edit&d_kod=' + encodeURIComponent(dKod);
  } else {
    // === Резерв: ПОЛНЫЙ ПОРТ VBA modEDO.SaveTemplateToPortal 1:1 ===
    // form-urlencoded, ВСЕ значения через UrlEncodeWin1251 (кириллица
    // корректна, пробел -> «+»); состав полей VBA: d_kod, kod_proizv
    // (по умолч. «1F000»), kod_podr («1F010»), prinadl («0»),
    // registrator (""), IS_DEST_LIST («1»), DATE_DOC, D_NOM, NA_NOM
    // («OT»), D_NAME, DESTINATION_LIST, DOLGN («KOMY»), FIO (""),
    // LETTER (тело письма), O_OTV_ISP (""), PODP (""), PODP_KOD,
    // D_ISPOLN (""), D_ISPOLN_KOD, TEL_ISP, PRIVACY (по умолч. «D»);
    // Optional-параметры VBA — в opts (те же умолчания).
    const kodProizv = opts.kod_proizv !== undefined ? opts.kod_proizv : '1F000';
    const kodPodr = opts.kod_podr !== undefined ? opts.kod_podr : '1F010';
    const dateDoc = opts.DATE_DOC !== undefined ? opts.DATE_DOC : '';
    const dNom = opts.D_NOM !== undefined ? opts.D_NOM : '';
    const dName = opts.D_NAME !== undefined ? opts.D_NAME : '';
    const destinationList = opts.DESTINATION_LIST !== undefined ? opts.DESTINATION_LIST : '';
    const podpKod = opts.PODP_KOD !== undefined ? opts.PODP_KOD : '';
    const dIspolnKod = opts.D_ISPOLN_KOD !== undefined ? opts.D_ISPOLN_KOD : '';
    const telIsp = opts.TEL_ISP !== undefined ? opts.TEL_ISP : '';
    const privacy = opts.PRIVACY !== undefined ? opts.PRIVACY : 'D';
    const postData =
      'd_kod=' + urlEncodeWin1251(dKod) +
      '&kod_proizv=' + urlEncodeWin1251(kodProizv) +
      '&kod_podr=' + urlEncodeWin1251(kodPodr) +
      '&prinadl=' + urlEncodeWin1251('0') +
      '&registrator=' + urlEncodeWin1251('') +
      '&IS_DEST_LIST=' + urlEncodeWin1251('1') +
      '&DATE_DOC=' + urlEncodeWin1251(dateDoc) +
      '&D_NOM=' + urlEncodeWin1251(dNom) +
      '&NA_NOM=' + urlEncodeWin1251('OT') +
      '&D_NAME=' + urlEncodeWin1251(dName) +
      '&DESTINATION_LIST=' + urlEncodeWin1251(destinationList) +
      '&DOLGN=' + urlEncodeWin1251('KOMY') +
      '&FIO=' + urlEncodeWin1251('') +
      '&LETTER=' + urlEncodeWin1251(letter) +
      '&O_OTV_ISP=' + urlEncodeWin1251('') +
      '&PODP=' + urlEncodeWin1251('') +
      '&PODP_KOD=' + urlEncodeWin1251(podpKod) +
      '&D_ISPOLN=' + urlEncodeWin1251('') +
      '&D_ISPOLN_KOD=' + urlEncodeWin1251(dIspolnKod) +
      '&TEL_ISP=' + urlEncodeWin1251(telIsp) +
      '&PRIVACY=' + urlEncodeWin1251(privacy);
    body = Buffer.from(postData, 'latin1'); // postData — чистый ASCII (%XX)
    contentType = 'application/x-www-form-urlencoded; charset=windows-1251';
    referer = cfg.url + '/kisp/ViewShablon.aspx?doc_id=' + encodeURIComponent(dKod);
  }

  // === 3/4. Настройка HTTP-запроса и отправка (WinHttp -> Node http/https) ===
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Неверный URL: ' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      timeout: opts.timeoutMs || 30000,
      rejectUnauthorized: opts.rejectUnauthorized !== undefined ? !!opts.rejectUnauthorized : false,
      headers: {
        // Заголовки (как в браузере)
        'Content-Type': contentType,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Language': 'ru,en;q=0.9',
        'Referer': referer,
        'Origin': cfg.url,
        'Connection': 'keep-alive',
        // VBA: HttpReq.SetCredentials username, password, 0 (Basic)
        'Authorization': 'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64'),
        'Content-Length': body.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        // === 5. Логирование и результат (VBA Debug.Print) ===
        console.log('[SAVE] Status: ' + res.statusCode + ' ' + (res.statusMessage || ''));
        const respText = decodePortalBody(Buffer.concat(chunks));
        console.log('[SAVE] Response: ' + respText.slice(0, 300));
        resolve(res.statusCode === 200); // VBA: SaveTemplateToPortal = (status = 200)
      });
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут запроса к порталу')));
    req.on('error', (e) => reject(new Error('Ошибка соединения с порталом: ' + e.message)));
    req.end(body);
  });
}

// --- VBA UploadFileToPortal: multipart POST filesave.aspx?doc_id= ------
function getMimeType(filePath) {
  const ext = String(filePath).split('.').pop().toLowerCase();
  switch (ext) {
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':  return 'application/vnd.ms-excel';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc':  return 'application/msword';
    case 'pdf':  return 'application/pdf';
    case 'txt':  return 'text/plain';
    case 'csv':  return 'text/csv';
    case 'zip':  return 'application/zip';
    default:     return 'application/octet-stream';
  }
}

function uploadFileToPortal(filePath, docId, username, password, opts) {
  opts = opts || {};
  const cfg = opts.cfg || loadEdoConfig();
  return new Promise((resolve, reject) => {
    let fileBytes;
    try { fileBytes = fs.readFileSync(filePath); } // VBA ReadFileAsBytes
    catch (e) { return reject(new Error('Файл не найден: ' + filePath)); }
    const fileName = (opts && opts.fileName) || path.basename(filePath); // ✅ T51-b: opts.fileName — имя на портале (напр., исходное имя основания)
    const mimeType = getMimeType(filePath);
    // boundary = "----VBAFormBoundary" & Format(Now, "yyyymmddhhnnss") & Right("000" & Int(Rnd*1000), 3)
    const now = new Date();
    const p = (x) => String(x).padStart(2, '0');
    const ts = '' + now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
    const rnd = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const boundary = '----VBAFormBoundary' + ts + rnd;
    const url = cfg.url + '/kisp/filesave.aspx?doc_id=' + encodeURIComponent(docId);
    // VBA StringToBytes: заголовки части в windows-1251 (русское имя файла)
    const pre = '--' + boundary + '\r\n'
      + 'Content-Disposition: form-data; name="files"; filename="' + fileName + '"\r\n'
      + 'Content-Type: ' + mimeType + '\r\n\r\n';
    const post = '\r\n--' + boundary + '--\r\n';
    const preB = stringToWin1251Bytes(pre);
    const postB = stringToWin1251Bytes(post);
    const body = Buffer.concat([preB, fileBytes, postB]);

    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Неверный URL: ' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      timeout: opts.timeoutMs || 60000,
      rejectUnauthorized: opts.rejectUnauthorized !== undefined ? !!opts.rejectUnauthorized : false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*',
        'Accept-Language': 'ru,en;q=0.9',
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Origin': cfg.url,
        'Connection': 'keep-alive',
        'Authorization': 'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64'),
        'Content-Length': body.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(res.statusCode === 200)); // VBA: return status = 200
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут загрузки файла на портал')));
    req.on('error', (e) => reject(new Error('Ошибка загрузки файла на портал: ' + e.message)));
    req.write(body);
    req.end();
  });
}

module.exports = {
  loadEdoConfig,
  applyTema,
  extractGreetingName,
  applyGreetingName,
  stringToWin1251Bytes,
  urlEncodeWin1251,
  urlEncodeUtf8,
  sendPostRequest,
  sendGetRequest,
  createCardParams,
  setDefaults,
  fillFromHTML,
  toPostString,
  kartEdit,
  parseDkodFromResponse,
  extractTextareaRaw,
  extractLetterDivHTML,
  collectShablonFormFields,
  buildMultipartBody,
  saveTemplateToPortal,
  uploadFileToPortal,
  getMimeType
};
