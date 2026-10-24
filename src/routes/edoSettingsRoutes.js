// ============================================================
// ✅ T52: НАСТРОЙКИ ЭДО — чтение/сохранение config/edo.json
// и проверка соединения с порталом.
// ✅ T52-B: подписанты (sz_transport/sz_sb/sz_soglasovanie) — если в
// config/edo.json они лежат на ВЕРХНЕМ уровне (без обёртки "podpisant",
// так бывает после правки файла руками) — при чтении они подхватываются
// в podpisant.* (см. loadEdoConfig), а при сохранении со страницы файл
// очищается от таких дублей: значения переносятся в правильный блок.
//
// Страница «Настройки ЭДО» (public/pages/edo-nastroyki.html,
// кнопка в главном меню — только для админа) редактирует ВСЕ
// поля файла настроек:
//   - подключение: url, docs_url, username, password,
//     reject_unauthorized;
//   - шаблоны СЗ: shablon.sz_transport / sz_sb / sz_soglasovanie;
//   - подписывающие: podpisant.* (PODP, PODP_KOD, O_OTV_ISP);
//   - темы СЗ (krat_sod): tema.* с подстановками
//     {дата}/{отправитель}/{получатель} (транспорт, СБ) и
//     {номер}/{дата}/{фирмы} (согласование);
//   - ✅ T55: тип присвоения номера СЗ в СБ об отгрузке — sz_nomer.sz_sb:
//     'otlozh' (отложенное, rd=2/ch_otl=2 — дефолт) | 'avto' (автосоздание,
//     rd=1/ch_otl=1).
//
// ВАЖНО: файл настроек читается при КАЖДОМ создании СЗ
// (edo.loadEdoConfig), поэтому сохранение применяется
// БЕЗ перезапуска сервера.
//
// Семантика пустых полей в блоках shablon/podpisant/tema:
// пустое значение НЕ сохраняется в файл — действует встроенный
// дефолт loadEdoConfig (как до правки).
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { parseBody, send } = require('../utils');
const edo = require('./helpers/edoPortal');

// Путь к config/edo.json — тот же файл, что читает loadEdoConfig
// (helpers/edoPortal.js: path.join(__dirname, '..','..','..','config','edo.json'))
function edoConfigPath() {
    return path.join(__dirname, '..', '..', 'config', 'edo.json');
}

// Приводим значения формы к строгой структуре файла настроек.
// Строки — String(); флаг — !!; в блоках shablon/podpisant/tema
// пустые строки УДАЛЯЮТСЯ (действует дефолт loadEdoConfig).
function normalizeConfig(d) {
    d = d && typeof d === 'object' ? d : {};
    // ✅ T52-B: легаси-блоки подписантов на верхнем уровне тела запроса
    // (если вдруг пришли) складываем в podpisant — правильный блок сильнее
    const podpShape = (o) => o && typeof o === 'object' && !Array.isArray(o) &&
        (o.PODP !== undefined || o.PODP_KOD !== undefined || o.O_OTV_ISP !== undefined);
    if (!d.podpisant || typeof d.podpisant !== 'object' || Array.isArray(d.podpisant)) d.podpisant = {};
    for (const k of ['sz_transport', 'sz_sb', 'sz_soglasovanie']) {
        if (podpShape(d[k]) && !podpShape(d.podpisant[k])) d.podpisant[k] = d[k];
    }
    const str = (v) => String(v == null ? '' : v).trim();
    const podp = (k) => {
        let src = d.podpisant && typeof d.podpisant === 'object' ? d.podpisant[k] : {};
        src = src && typeof src === 'object' ? src : {};
        const out = {
            PODP: str(src.PODP),
            PODP_KOD: str(src.PODP_KOD),
            O_OTV_ISP: str(src.O_OTV_ISP)
        };
        // пустые поля подписанта не пишем — останется дефолт
        Object.keys(out).forEach((key) => { if (out[key] === '') delete out[key]; });
        return Object.keys(out).length ? out : undefined;
    };
    const block = (name) => {
        const src = d[name] && typeof d[name] === 'object' && !Array.isArray(d[name]) ? d[name] : {};
        const out = {};
        for (const key of Object.keys(src)) {
            if (typeof src[key] === 'string' && src[key].trim() !== '') out[key] = src[key].trim();
        }
        return Object.keys(out).length ? out : undefined;
    };
    const out = {
        url: str(d.url),
        docs_url: str(d.docs_url),
        username: str(d.username),
        // пароль — без trim (пробелы в конце могут быть значимыми)
        password: String(d.password == null ? '' : d.password),
        reject_unauthorized: !!d.reject_unauthorized
    };
    const sh = block('shablon');   if (sh) out.shablon = sh;
    const pd = { sz_transport: podp('sz_transport'), sz_sb: podp('sz_sb'), sz_soglasovanie: podp('sz_soglasovanie') };
    const pdOut = {};
    for (const k of Object.keys(pd)) if (pd[k]) pdOut[k] = pd[k];
    if (Object.keys(pdOut).length) out.podpisant = pdOut;
    const tm = block('tema');      if (tm) out.tema = tm;
    // ✅ T55: блок sz_nomer — тип присвоения номера СЗ в СБ ('avto'|'otlozh').
    // Пустое/неверное значение НЕ пишется в файл — действует дефолт
    // loadEdoConfig ('otlozh' — отложенное присвоение номера).
    const snSrc = d.sz_nomer && typeof d.sz_nomer === 'object' && !Array.isArray(d.sz_nomer) ? d.sz_nomer : {};
    const snSb = String(snSrc.sz_sb == null ? '' : snSrc.sz_sb).trim();
    if (snSb === 'avto' || snSb === 'otlozh') out.sz_nomer = { sz_sb: snSb };
    return out;
}

// Читаем исходный файл (для сохранения ключей, которые страница
// не редактирует — если пользователь добавлял их вручную)
function readExistingConfig() {
    try {
        const p = edoConfigPath();
        if (fs.existsSync(p)) {
            const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        }
    } catch (e) { /* битый/нечитаемый файл — перезапишем чистым */ }
    return {};
}

module.exports = (db, wsManager) => ({

    // ====================================================================
    // GET /api/edo-settings — эффективные настройки (файл + дефолты
    // loadEdoConfig): страница заполняет поля тем, что реально действует
    // ====================================================================
    async GET_SETTINGS(req, res) {
        try {
            const cfg = edo.loadEdoConfig();
            send(res, 200, { ok: true, config: cfg });
        } catch (e) {
            console.error('[edoSettings.GET_SETTINGS] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ====================================================================
    // POST /api/edo-settings — сохранить настройки в config/edo.json.
    // Тело — объект со всеми полями формы. После записи файл
    // перечитывается (гарантия валидного JSON) и возвращается
    // эффективный конфиг.
    // ====================================================================
    async POST_SETTINGS(req, res) {
        try {
            const d = await parseBody(req);
            const cfg = normalizeConfig(d);

            // --- валидация ключевых полей ---
            if (!cfg.url) {
                return send(res, 400, { error: 'URL портала не задан' });
            }
            if (!/^https?:\/\//i.test(cfg.url)) {
                return send(res, 400, { error: 'URL портала должен начинаться с http:// или https://' });
            }
            if (cfg.docs_url && !/^https?:\/\//i.test(cfg.docs_url)) {
                return send(res, 400, { error: 'URL перехода к документу должен начинаться с http:// или https://' });
            }

            // --- сохраняем: поверх ключей, бывших в файле, кладём новые значения
            //     (отсутствующие в cfg ключи блоков shablon/podpisant/tema
            //     затираются — пустое поле формы = дефолт) ---
            const merged = Object.assign({}, readExistingConfig(), cfg);
            // ✅ T52-B: перенос легаси-блоков подписантов завершён — дубли
            // на верхнем уровне файла из записи УБИРАЕМ: их значения уже
            // учтены в podpisant.* (см. loadEdoConfig) либо заменены
            // дефолтом (пустое поле формы = дефолт). Верхнеуровневые блоки
            // sz_* без полей подписанта (не podpShape) не трогаем.
            const isPodp = (o) => o && typeof o === 'object' && !Array.isArray(o) &&
                (o.PODP !== undefined || o.PODP_KOD !== undefined || o.O_OTV_ISP !== undefined);
            for (const k of ['sz_transport', 'sz_sb', 'sz_soglasovanie']) {
                if (isPodp(merged[k])) delete merged[k];
            }
            const p = edoConfigPath();
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(merged, null, 2) + '\n', 'utf8');

            // --- контроль: записанный файл обязан читаться обратно ---
            try {
                JSON.parse(fs.readFileSync(p, 'utf8'));
            } catch (e) {
                throw new Error('Записанный файл настроек не читается: ' + e.message);
            }

            console.log('[T52] config/edo.json сохранён со страницы «Настройки ЭДО»');
            send(res, 200, { ok: true, config: edo.loadEdoConfig() });
        } catch (e) {
            console.error('[edoSettings.POST_SETTINGS] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ====================================================================
    // POST /api/edo-settings/test — проверка соединения с порталом.
    // Тело (необязательно) — значения ИЗ ФОРМЫ (можно проверить
    // несохранённые url/логин/пароль); пустое тело — сохранённые.
    // GET <url> с Basic-аутентификацией; ЛЮБОЙ ответ портала = связь есть;
    // ошибка DNS/сокета/таймаут = связи нет. Возвращаем HTTP-статус.
    // ====================================================================
    async TEST_CONNECTION(req, res) {
        try {
            const d = await parseBody(req);          // {} — если тестируем сохранённые
            const useForm = d && typeof d === 'object' && (d.url || d.username);
            const cfg = useForm ? normalizeConfig(d) : edo.loadEdoConfig();
            if (!cfg.url || !/^https?:\/\//i.test(cfg.url)) {
                return send(res, 400, { error: 'URL портала не задан или неверен' });
            }
            if (!cfg.username || !cfg.password) {
                return send(res, 400, { error: 'Не заданы логин/пароль портала (config/edo.json: username, password)' });
            }

            const base = cfg.url.replace(/\/+$/, '');
            const status = await probePortal(base, cfg.username, cfg.password, cfg.reject_unauthorized);
            send(res, 200, { ok: true, status: status });
        } catch (e) {
            // сеть/DNS/таймаут — соединения нет, но это НЕ падение сервера
            send(res, 200, { ok: false, error: e.message });
        }
    }
});

// Короткий GET-проба портала (без разбора ответа): резолвим статусом
// ЛЮБОГО ответа, отклоняем ошибками сети. Таймаут 8 секунд.
function probePortal(urlBase, username, password, rejectUnauthorized) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlBase + '/'); } catch (e) { return reject(new Error('Неверный URL: ' + urlBase)); }
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname,
            method: 'GET',
            timeout: 8000,
            rejectUnauthorized: rejectUnauthorized !== undefined ? !!rejectUnauthorized : false,
            headers: {
                'Authorization': 'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64')
            }
        }, (resp) => {
            resp.resume();                        // тело не нужно — только статус
            resolve(resp.statusCode || 0);
        });
        req.on('timeout', () => req.destroy(new Error('Таймаут соединения с порталом (8 с)')));
        req.on('error', (e) => reject(new Error('Не удалось подключиться: ' + e.message)));
        req.end();
    });
}
