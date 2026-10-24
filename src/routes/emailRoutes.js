// ============================================================
// РОУТЫ: ОТПРАВКА ПИСЕМ И ГЕНЕРАЦИЯ EXCEL
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { sendEmail, sendBulkEmails, addWorkingDays, normalizeAddressList } = require('../emailService');   // ✅ T26: + normalizeAddressList
const { exportZaprosKP, createEquipmentTable, getNextZayavkaNumber, generatePreviewHTML } = require('../excelService');
const { sqlDate, sqlDateTime,displayDate } = require('./helpers/dateHelpers');
// ✅ T26: письмо на согласование ЗАКАЗА перенесено сюда из orderRoutes.js
// (вся работа с email — в одном модуле); URL прежний: POST /api/orders/send-email
const { getDependencies } = require('./helpers/syntheticTables');
// ✅ T32: + deriveOrderStatus/allPositionsApproved — повторная отправка
// обновлённого заказа не сбрасывает проделанную работу по согласованию
const { POZ_STATUS_INITIAL, POZ_STATUS_SENT, deriveOrderStatus, allPositionsApproved } = require('./helpers/orderStatuses');
const { SIGNATURE } = require('./helpers/emailSignature');   // ✅ T27: общий блок подписи всех писем
const { extractToken, validateToken } = require('../authUtils');
const path = require('path');
const fs = require('fs');   // ✅ T88: проверка существования сохранённого файла запроса

/** «Ломакин Александр Николаевич» → «А.Н.Ломакин»; «Ломакин А.Н.» → «А.Н.Ломакин» */
function formatFioShort(fio) {
    const parts = (fio || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 3) {
        return `${parts[1].charAt(0).toUpperCase()}.${parts[2].charAt(0).toUpperCase()}.${parts[0]}`;
    }
    if (parts.length === 2) {
        if (parts[1].includes('.')) return `${parts[1]}${parts[0]}`;
        return `${parts[1].charAt(0).toUpperCase()}.${parts[0]}`;
    }
    return fio || '';
}

// ============================================================
// ✅ T98: ЕДИНЫЙ КОНСТРУКТОР ПИСЬМА на согласование заказа.
// Используется и реальной отправкой (POST_SEND_EMAIL), и
// предпросмотром (POST_EMAIL_PREVIEW) — предпросмотр всегда
// показывает ровно то, что уйдёт контрагенту.
// ============================================================
function buildOrderApprovalEmail(zakaz, emailList) {
    const subject = `Согласование заказа №${zakaz.nomer_zakaza} к договору №${zakaz.nom_dogovor}`;
    // ✅ T26: текст письма приведён к VBA-макету (макрос согласования заказа)
    const body = [
        'Уважаемые коллеги!',
        '',
        `Направляем Вам на согласование заказ №${zakaz.nomer_zakaza} к договору №${zakaz.nom_dogovor}.`,
        '',
        'Прошу рассмотреть прилагаемый заказ к договору  и подтвердить согласование печатью.',
        '',
        'Скан заказ и замечаниями при их наличии  или обоснованный отказ направить обратным письмом всем.',
        '',
        ...SIGNATURE.split('\n')   // ✅ T27: подпись из общего шаблона
    ].join('\n');
    const cc = 'igor.chesnokov@vaz.ru;Aleksandr.Tyurin@vaz.ru';
    return { subject, body, cc };
}

// ============================================================
// ✅ T100: ЕДИНЫЙ КОНСТРУКТОР ПИСЬМА контрагенту по запросу ТКП.
// Используется и реальной отправкой (POST_SEND_FIRMS), и предпросмотром
// (POST_FIRMS_EMAIL_PREVIEW) — предпросмотр показывает ровно то письмо,
// которое уйдёт контрагенту. Шаблон перенесён из POST_SEND_FIRMS
// байт-в-байт (zapros_data/crokOtvet/cc/dogovorInfo теперь здесь).
// ============================================================
function buildZaprosFirmaEmail(zapros, firm, dog, url3D, tehnologContact) {
    const zapros_data = displayDate(zapros.data_form);
    const crokOtvet = addWorkingDays(zapros.srok_predostavleniya_kp);
    const cc = 'igor.chesnokov@vaz.ru;Aleksandr.Tyurin@vaz.ru';
        const dogovorInfo = dog
          ? `В рамках договора ${firm.firmName} с АВТОВАЗ (ПТО) № ${dog.n_dog || 'б/н'} от ${dog.data ? displayDate(dog.data) : '___'}`
          : ' ';

        const subject = `Запрос ТКП  ${firm.firmName} №${zapros.n_zaprosa} от ${zapros_data}`;
        const body = `                             Уважаемые коллеги  ${firm.firmName} !
${dogovorInfo}, направляю Вам запрос, на предоставление коммерческого предложения выполнения
механической обработки деталей (далее ТКП) по прилагаемой заявке № ${zapros.n_zaprosa} от ${zapros_data}.
ТКП  предоставить в срок до ${crokOtvet} г. 
В ТКП включить заполненную  обменную форму с данными необходимыми для
оценки сответсвия условиям договора  и выбора лучшего предложения.

Посмотреть или скачать папку c документацией к заявке можно по ссылке:
${url3D}
Важно: 1. Обязательно при ответе в рассылку включать адресатов
кому был направлен данный запрос (ответить всем).
2. Повторно обращаю Ваше внимание, что для единообразной оценки предложений контрагентов,
прошу заполнить прилагаемый к запросу обменную форму с включением
в официальное ТКП  и визированием руководителем ${firm.firmName}.

По вопросам, касающимся конструкторской документации обращаться:
${tehnologContact || ''}
Надеемся на плодотворное сотрудничество!
Ждем Ваших предложений.
Отсутвие ответа будет расцениваться как отказ.

${SIGNATURE}`;
    return { subject, body, cc };
}

// ============================================================
// ✅ T101: ЕДИНЫЙ КОНСТРУКТОР ПИСЬМА ТЕХНОЛОГУ (шаг 1 — согласование
// запроса технологом). Используется и реальной отправкой
// (POST_SEND_TEHNOLOG), и предпросмотром (POST_TEHNOLOG_EMAIL_PREVIEW) —
// предпросмотр показывает ровно то письмо, которое уйдёт технологу.
// Шаблон перенесён из POST_SEND_TEHNOLOG байт-в-байт.
// ============================================================
function buildTehnologEmail(zapros) {
    const zapros_data = displayDate(zapros.data_form);
    const subject = `АУТСОРСИНГ запроса на КП №${zapros.n_zaprosa} от ${zapros_data}`;

    const body = `                        Уважаемый ${zapros.tehnolog_name}!

       Прошу рассмотреть и согласовать позиции прилагаемого во вложении запроса на коммерческое предложение №${zapros.n_zaprosa} от ${zapros_data}.

       По согласованным позициям обратным письмом ответить всем
с указанием интернет ссылки на черт. и 3D мод.

${SIGNATURE}`;   // ✅ T27: подпись из общего шаблона
    const cc = 'igor.chesnokov@vaz.ru;Aleksandr.Tyurin@vaz.ru';
    return { subject, body, cc };
}

module.exports = (db, wsManager) => ({
    /**
     * Расчёт рабочего срока
     * POST /api/email/working-days
     */
    async POST_WORKING_DAYS(req, res) {
        try {
            const d = await parseBody(req);
            const days = parseInt(d.days) || 0;
            const result = addWorkingDays(days);
            send(res, 200, { date: result });
        } catch (e) {
            send(res, 400, { error: e.message });
        }
    },

    /**
     * Генерация Excel-файлов для запроса КП
     * POST /api/email/generate-excel
     */
/**
 * Генерация Excel-файлов для запроса КП
 * ✅ ИСПРАВЛЕНО: генерирует обменный файл для КАЖДОЙ выделенной фирмы
 * POST /api/email/generate-excel
 */

/**
 * Генерация Excel-файлов для запроса КП
 * ✅ ИСПРАВЛЕНО: передаём id_firma в createEquipmentTable
 * POST /api/email/generate-excel
 */
async POST_GENERATE_EXCEL(req, res) {
    try {
        const d = await parseBody(req);
        const { zaprosId, planIds, zaprosKPNumber, equipmentList, selectedFirmIds } = d;

        if (!zaprosId || !planIds || planIds.length === 0) {
            return send(res, 400, { error: 'Не указаны позиции плана' });
        }

        const zapros = await db.get('SELECT * FROM zapros_kp WHERE id = ?', [zaprosId]);
        if (!zapros) {
            return send(res, 400, { error: 'Запрос не найден' });
        }

        let signerName = '';
        try {
            const token = extractToken(req);
            const auth = await validateToken(db, token);
            if (auth?.user?.fio) signerName = formatFioShort(auth.user.fio);
        } catch (e) { /* подпись останется из шаблона */ }

        const zaprosKPNum = zaprosKPNumber || getNextZayavkaNumber();
        const firstPlan = await db.get('SELECT god FROM plan WHERE id = ?', [planIds[0]]);
        const baseYear = firstPlan ? parseInt(firstPlan.god) || new Date().getFullYear() : new Date().getFullYear();

        // 1. Заявка — одна на всех
        const zaprosKPResult = await exportZaprosKP({
            planIds,
            zaprosKPNumber: zaprosKPNum,
            baseYear,
            zaprosDate: zapros.data_form,
            signerName
        });

        // 2. Получаем фирмы: только выделенные ИЛИ все из КП
        let firmsToProcess = [];
        if (selectedFirmIds && selectedFirmIds.length > 0) {
            const placeholders = selectedFirmIds.map(() => '?').join(',');
            firmsToProcess = await db.all(
                `SELECT DISTINCT k.id_firma, f.naimenovanie
                 FROM kp k
                 JOIN firmy f ON k.id_firma = f.id_firmy
                 WHERE k.id_zaprosa_kp = ? AND k.id_firma IN (${placeholders})`,
                [zaprosId, ...selectedFirmIds]
            );
        } else {
            firmsToProcess = await db.all(
                `SELECT DISTINCT k.id_firma, f.naimenovanie
                 FROM kp k
                 JOIN firmy f ON k.id_firma = f.id_firmy
                 WHERE k.id_zaprosa_kp = ? AND k.id_firma IS NOT NULL AND k.id_firma != ''`,
                [zaprosId]
            );
        }

        // 3. ✅ Генерируем обменную форму для КАЖДОЙ выделенной фирмы
        const obmenByFirma = {};
        for (const firm of firmsToProcess) {
            try {
                const firmEquipment = await db.all(`
                    SELECT kp.id, kp.id_plana, kp.tip_izgotovleniya, kp.srok_vipolneniya,
                           kp.moshchnost_kolvo, kp.trudoemkost_postavshika, kp.id_dogovor,
                           o.nomer_chertezha, o.naimenovanie as osn_name, p.plan_god_kolvo
                    FROM kp
                    JOIN plan p ON kp.id_plana = p.id
                    JOIN osnastka o ON p.id_osnastka = o.id
                    WHERE kp.id_zaprosa_kp = ? AND kp.id_firma = ?
                `, [zaprosId, firm.id_firma]);

                if (firmEquipment.length === 0) {
                    console.warn(`[POST_GENERATE_EXCEL] Нет позиций для фирмы ${firm.naimenovanie}`);
                    continue;
                }

                const tableName = `Обменная форма к ТКП  запрос № ${zapros.n_zaprosa}`;

                // ✅ КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: передаём id_firma
                const obmenResult = await createEquipmentTable({
                    equipmentList: firmEquipment,
                    tableName,
                    zaprosId,
                    firmaName: firm.naimenovanie,
                    id_firma: firm.id_firma       // ← ДОБАВЛЕНО
                });

                const preview = await generatePreviewHTML(obmenResult.path);
                obmenByFirma[firm.id_firma] = {
                    path: obmenResult.path,
                    fileName: obmenResult.fileName,
                    relativePath: obmenResult.relativePath,
                    firmaName: firm.naimenovanie,
                    preview
                };
            } catch (e) {
                console.error(`[POST_GENERATE_EXCEL] Ошибка для фирмы ${firm.naimenovanie}:`, e.message);
            }
        }

        // 4. Превью заявки
        let zaprosKPPreview = null;
        if (zaprosKPResult && zaprosKPResult.path) {
            zaprosKPPreview = await generatePreviewHTML(zaprosKPResult.path);
        }

        send(res, 200, {
            zaprosKP: zaprosKPResult,
            obmenByFirma,
            zaprosKPNumber: zaprosKPNum,
            previews: {
                zaprosKP: zaprosKPPreview,
                obmen: obmenByFirma
            }
        });
    } catch (e) {
        console.error('[POST_GENERATE_EXCEL] Error:', e.message);
        send(res, 500, { error: e.message });
    }
},

    /**
     * ✅ T88: Просмотр СОХРАНЁННОГО файла запроса «Заявка № <№>.xlsx»
     * (public/Заявки/<год>/) — тот же HTML-просмотрщик, что при отправке,
     * но файл НЕ пересоздаётся и письма НЕ отправляются.
     * POST /api/email/preview-zayavka { zaprosId }
     */
    async POST_PREVIEW_ZAYAVKA(req, res) {
        try {
            const d = await parseBody(req);
            const zaprosId = d && d.zaprosId;
            if (!zaprosId) return send(res, 400, { error: 'Не указан запрос' });

            const zapros = await db.get('SELECT * FROM zapros_kp WHERE id = ?', [zaprosId]);
            if (!zapros) return send(res, 400, { error: 'Запрос не найден' });

            // Годы-кандидаты — как в szSoglasCollectAttachments (T51-b):
            // год плана запроса (через КП), год из даты запроса, текущий год
            const years = [];
            const pushYear = (v) => {
                const m = String(v == null ? '' : v).match(/(19|20)\d{2}/);
                if (m && years.indexOf(m[0]) < 0) years.push(m[0]);
            };
            try {
                const pl = await db.get(
                    'SELECT god FROM plan WHERE id IN (SELECT id_plana FROM kp WHERE id_zaprosa_kp = ?) LIMIT 1',
                    [zapros.id]);
                if (pl) pushYear(pl.god);
            } catch (e) { /* некритично — есть другие кандидаты */ }
            pushYear(zapros.data_form);
            pushYear(new Date().getFullYear());

            // Стандартное имя excelService.exportZaprosKP
            const fileName = 'Заявка № ' + String(zapros.n_zaprosa == null ? '' : zapros.n_zaprosa) + '.xlsx';
            const pubDir = path.join(__dirname, '..', '..', 'public');
            let filePath = null;
            let fileYear = null;
            for (const y of years) {
                const p = path.join(pubDir, 'Заявки', y, fileName);
                if (fs.existsSync(p)) { filePath = p; fileYear = y; break; }
            }
            if (!filePath) {
                // ✅ T88: 200 + { error } (НЕ HTTP 404) — отсутствие файла
                // это ожидаемый бизнес-случай, браузер не должен получать
                // 404 и писать console-error
                return send(res, 200, { error: 'Файл «' + fileName + '» не найден в public/Заявки (годы: ' + (years.join(', ') || '—') + '). Файл создаётся при отправке запроса фирмам' });
            }

            const html = await generatePreviewHTML(filePath);
            send(res, 200, { html, fileName, year: fileYear, path: filePath });
        } catch (e) {
            console.error('[POST_PREVIEW_ZAYAVKA] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    /**
     * Отправка письма технологу
     * POST /api/email/send-technolog
     */
    async POST_SEND_TEHNOLOG(req, res) {
        try {
            const d = await parseBody(req);
            const { zaprosId, excelPath, dryRun, body: bodyOverride } = d;   // ✅ T101: bodyOverride — отредактированный текст письма
            
            // Получаем запрос с email технолога через JOIN
            const zapros = await db.get(`
                SELECT z.*, t.email as tehnolog_email, t.fio as tehnolog_name
                FROM zapros_kp z
                LEFT JOIN tech t ON z.id_tehnologa = t.id
                WHERE z.id = ?
            `, [zaprosId]);
            
            if (!zapros) {
                return send(res, 400, { error: 'Запрос не найден технолог из zapros_kp в tech' });
            }
            
            if (!zapros.tehnolog_email) {
                return send(res, 400, { error: 'У технолога не указан email' });
            }
            // ✅ T101: письмо строится ЕДИНЫМ конструктором buildTehnologEmail
            // (тот же, что у предпросмотра POST_TEHNOLOG_EMAIL_PREVIEW);
            // если клиент передал отредактированный текст (bodyOverride) —
            // уходит он; пустой/отсутствующий — шаблон конструктора
            const built = buildTehnologEmail(zapros);
            const subject = built.subject;
            const body = (typeof bodyOverride === 'string' && bodyOverride.trim()) ? bodyOverride : built.body;

            const attachments = excelPath ? [excelPath] : [];
            const cc = built.cc;
            
            // Особый режим: без фактической отправки письма (dryRun —
            // письма нет, но дата и статус проставляются как при отправке)
            const result = dryRun
                ? { ok: true, messageId: 'DRY-RUN (письмо не отправлялось)' }
                : await sendEmail({
                    to: zapros.tehnolog_email, 
                    subject,
                    body,
                    attachments,
                    cc
                });
            if (dryRun) {
                console.log(`[DRY-RUN] send-technolog: письмо не отправлялось (запрос ${zaprosId}), дата и статус проставлены`);
            }
            
            // Обновляем дату передачи технологу
            const now = new Date();
            const dateStr = sqlDate();
            
            await db.run(
                'UPDATE zapros_kp SET data_peredach_tehnologu=?, statys=? WHERE id=?',
                [dateStr, 'отправлено технологу', zaprosId]
            );
            
            wsManager.notifyDataChange('zapros_kp', 'update', zaprosId);
            
            send(res, 200, {
                ok: true,
                date: dateStr,
                messageId: result.messageId
            });
        } catch (e) {
            console.error('[POST_SEND_TEHNOLOG] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ T101: ПРЕДПРОСМОТР письма технологу (БЕЗ отправки и без изменения
    // данных). POST /api/email/technolog-email-preview { zaprosId }
    // Тот же конструктор buildTehnologEmail и тот же запрос zapros+tech,
    // что у реальной отправки POST_SEND_TEHNOLOG — предпросмотр = то, что
    // уйдёт технологу. Возвращает { ok, preview: { to, cc, subject, body } }.
    // ========================================================================
    async POST_TEHNOLOG_EMAIL_PREVIEW(req, res) {
        try {
            const { zaprosId } = await parseBody(req);
            if (!zaprosId) return send(res, 400, { error: 'Не указан zaprosId' });

            const zapros = await db.get(`
                SELECT z.*, t.email as tehnolog_email, t.fio as tehnolog_name
                FROM zapros_kp z
                LEFT JOIN tech t ON z.id_tehnologa = t.id
                WHERE z.id = ?
            `, [zaprosId]);

            if (!zapros) {
                return send(res, 400, { error: 'Запрос не найден технолог из zapros_kp в tech' });
            }

            if (!zapros.tehnolog_email) {
                return send(res, 400, { error: 'У технолога не указан email' });
            }

            const built = buildTehnologEmail(zapros);
            send(res, 200, {
                ok: true,
                preview: {
                    to: zapros.tehnolog_email,
                    cc: built.cc,
                    subject: built.subject,
                    body: built.body
                }
            });
        } catch (e) {
            console.error('[emailRoutes.POST_TEHNOLOG_EMAIL_PREVIEW] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ T90: ПИСЬМО ТЕХНОЛОГУ — «ПО ССЫЛКЕ НЕ УДАЕТСЯ СКАЧАТЬ ФАЙЛЫ»
    // POST /api/email/send-url-problem { zaprosId, url, failedFiles, dryRun }
    // Реализация — аналог POST_SEND_TEHNOLOG: адресат — технолог запроса
    // (select zTech → zapros_kp.id_tehnologa → tech), обращение по имени-
    // отчеству, подпись Чеснокова (общий шаблон SIGNATURE), dryRun.
    // Отличия: письмо БЕЗ вложения; даты и статусы запроса НЕ меняются —
    // сервисное письмо, шаги согласования не двигает.
    // ========================================================================
    async POST_SEND_URL_PROBLEM(req, res) {
        try {
            const d = await parseBody(req);
            const { zaprosId, url, failedFiles, dryRun } = d;

            if (!zaprosId) return send(res, 400, { error: 'Не указан zaprosId' });
            const link = String(url || '').trim();
            if (!link) return send(res, 400, { error: 'Не указана ссылка' });

            const zapros = await db.get(`
                SELECT z.*, t.email as tehnolog_email, t.fio as tehnolog_name
                FROM zapros_kp z
                LEFT JOIN tech t ON z.id_tehnologa = t.id
                WHERE z.id = ?
            `, [zaprosId]);

            if (!zapros) {
                return send(res, 400, { error: 'Запрос не найден (zapros_kp → tech)' });
            }
            if (!zapros.tehnolog_email) {
                return send(res, 400, { error: 'У технолога не указан email' });
            }

            // «Бакунин Владимир Юрьевич» → «Владимир Юрьевич» (имя отчество);
            // если в справочнике меньше трёх слов — используем fio как есть
            const fioParts = String(zapros.tehnolog_name || '').trim().split(/\s+/).filter(Boolean);
            const imyaOtchestvo = fioParts.length >= 3
                ? fioParts.slice(1).join(' ')
                : String(zapros.tehnolog_name || '');

            const zapros_data = displayDate(zapros.data_form);
            const subject = `АУТСОРСИНГ запроса на КП №${zapros.n_zaprosa} от ${zapros_data} — не удается скачать файлы по ссылке`;

            // Перечень непрогрузившихся файлов (имена — из отчёта проверки)
            const files = Array.isArray(failedFiles)
                ? failedFiles.map(f => (typeof f === 'string' ? f : (f && f.name) || '')).filter(Boolean)
                : [];

            const lines = [
                `                        Уважаемый ${imyaOtchestvo}!`,
                '',
                `       По запросу на коммерческое предложение №${zapros.n_zaprosa} от ${zapros_data} не удается скачать файлы по ссылке:`,
                `       ${link}`,
                ''
            ];
            if (files.length) {
                lines.push('       Не прогружаются следующие файлы:');
                files.forEach(n => lines.push(`       ${n}`));
                lines.push('');
            }
            lines.push('       Просим перезаложить данные файлы или предоставить новую ссылку на черт. и 3D мод.');
            lines.push('');
            lines.push(SIGNATURE);   // ✅ T27: подпись из общего шаблона
            const body = lines.join('\n');

            const cc = 'igor.chesnokov@vaz.ru;Aleksandr.Tyurin@vaz.ru';

            // Особый режим: без фактической отправки письма
            const result = dryRun
                ? { ok: true, messageId: 'DRY-RUN (письмо не отправлялось)' }
                : await sendEmail({
                    to: zapros.tehnolog_email,
                    subject,
                    body,
                    attachments: [],
                    cc
                });
            if (dryRun) {
                console.log(`[DRY-RUN] send-url-problem: письмо не отправлялось (запрос ${zaprosId})`);
            }

            // Даты и статусы запроса намеренно НЕ меняются и WS-уведомление
            // не требуется — никаких изменений данных это письмо не вносит.
            // preview (to/subject/body) — для самопроверки в тестах; клиент
            // поле не использует
            send(res, 200, {
                ok: true,
                messageId: result.messageId,
                preview: { to: zapros.tehnolog_email, subject, body }
            });
        } catch (e) {
            console.error('[POST_SEND_URL_PROBLEM] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

        // ========================================================================
    // ✅ T26: ОТПРАВКА ПИСЬМА КОНТРАГЕНТУ НА СОГЛАСОВАНИЕ ЗАКАЗА
    // (перенесено из orderRoutes.js; URL прежний: POST /api/orders/send-email).
    // Текст письма — по VBA-макету (emailBody макроса согласования заказа).
    // ========================================================================
    async POST_SEND_EMAIL(req, res) {
        try {
            const { zakazId, excelPath, email, body: bodyOverride } = await parseBody(req);   // ✅ T100: bodyOverride — отредактированный текст письма
            if (!zakazId) return send(res, 400, { error: 'Не указан zakazId' });

            const zakaz = await db.get(`
              SELECT z.*, d.nom_dogovor, f.naimenovanie as firma_nazvanie
              FROM zakaz_po_dogovoru z
              LEFT JOIN dogovor d ON z.id_dogovora = d.id_dogovor
              LEFT JOIN firmy f ON d.id_firmy = f.id_firmy
              WHERE z.id = ?`, [zakazId]);
            if (!zakaz) return send(res, 404, { error: 'Заказ не найден' });

            // Гейт: после получения решения контрагента повторная отправка не требуется
            if (zakaz.data_otv_firma) {
                return send(res, 400, { error: 'Решение контрагента уже получено (' + zakaz.data_otv_firma + ') — повторная отправка не требуется' });
            }

            const contacts = await db.all(`
              SELECT k.email FROM kont k
              WHERE k.id_firmy = (SELECT id_firmy FROM dogovor WHERE id_dogovor = ?)
                AND k.aktivnost = 1 AND k.email != ''`, [zakaz.id_dogovora]);
            // ✅ T20: список адресов — из комбобокса шага 1 (через «;») или
            // fallback все активные контакты; нормализация: «;»/«,»/пробелы,
            // трим, дедуп, проверка формата (до попытки SMTP)
            const { list: emailList, invalid: badEmails } = normalizeAddressList(
                (email && String(email).trim()) ? String(email).trim() : contacts.map(c => c.email).join(';'));
            if (badEmails.length) return send(res, 400, { error: 'Некорректный адрес: ' + badEmails.join(', ') });
            if (!emailList.length) return send(res, 400, { error: 'Нет активных email у контрагента' });
            const emails = emailList.join(';');          // так хранится в БД (email_otpravki)
            const toAddrs = emailList.join(',');         // nodemailer понимает запятые

            // ✅ T98: subject/body/cc — общий конструктор buildOrderApprovalEmail:
            // предпросмотр (POST_EMAIL_PREVIEW) показывает ровно то же письмо,
            // которое реально уйдёт контрагенту строкой ниже.
            // ✅ T100: текст можно отредактировать в предпросмотре — клиент
            // передаёт финальный текст (bodyOverride); пустой/отсутствующий —
            // конструктор, как раньше
            const built = buildOrderApprovalEmail(zakaz, emailList);
            const subject = built.subject;
            const cc = built.cc;
            const body = (typeof bodyOverride === 'string' && bodyOverride.trim()) ? bodyOverride : built.body;

            // ✅ РЕАЛЬНАЯ отправка через nodemailer
            const result = await sendEmail({
                to: toAddrs,   // ✅ T20: несколько адресов через запятую
                subject,
                body,
                attachments: excelPath ? [excelPath] : [],
                cc
            });

            const now = sqlDateTime();
            // ✅ T32: статус вычисляется, а не прописывается жёстко:
            // повторная отправка (состав изменился после «отказ фирмы»/«отказ УЭБ»)
            // — это обновление ранее направленного заказа, проделанная работа
            // по согласованию сохраняется: если все позиции уже «согласовано»,
            // заказ остаётся «Согласовано»; иначе — «На согласовании контрагента».
            // Статусы позиций «согласовано» не трогаются (UPDATE ниже только
            // переводит исходные/«на рассмотрении» в «на рассмотрении»).
            // Флаг актуальности сбрасывается — состав после отказа уже учтён,
            // фирме уходит актуальный заказ.
            const allApproved = await allPositionsApproved(db, zakazId);
            const sendStatys = deriveOrderStatus(Object.assign({}, zakaz, { data_email_firma: now }), allApproved);
            await db.run(`
              UPDATE zakaz_po_dogovoru
              SET data_email_firma = ?, statys_zd = ?, email_otpravki = ?, aktualnost_email_firma = ''
              WHERE id = ?`,
                [now, sendStatys, emails, zakazId]);

            // Самолечение легаси-опечатки 'на расмотрении' + статусы только для неотработанных позиций
            await db.run(`UPDATE poz_zakaz_dogovora SET status_poz_zd = ? WHERE status_poz_zd = 'на расмотрении'`, [POZ_STATUS_SENT]);
            await db.run(`UPDATE poz_zakaz_dogovora
                          SET status_poz_zd = ?
                          WHERE id_zakaza_po_dogovoru = ?
                            AND status_poz_zd IN (?, ?)`, [POZ_STATUS_SENT, zakazId, POZ_STATUS_INITIAL, POZ_STATUS_SENT]);

            wsManager.notifyWithDependencies(getDependencies('orders.zakazy'), 'update', zakazId);

            // ✅ Возвращаем то, что ждёт клиент
            send(res, 200, {
                ok: true,
                date: now,
                messageId: result.messageId
            });
        } catch (e) {
            console.error('[emailRoutes.POST_SEND_EMAIL] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // ✅ T98: ПРЕДПРОСМОТР ПИСЬМА на согласование заказа (БЕЗ отправки).
    // POST /api/orders/email-preview { zakazId, email }
    // Тот же конструктор (buildOrderApprovalEmail) и та же нормализация
    // адресов, что у реальной отправки — предпросмотр = то, что уйдёт.
    // Возвращает { ok, to, cc, subject, body, firma, nomer_zakaza }.
    // ========================================================================
    async POST_EMAIL_PREVIEW(req, res) {
        try {
            const { zakazId, email } = await parseBody(req);
            if (!zakazId) return send(res, 400, { error: 'Не указан zakazId' });

            const zakaz = await db.get(`
              SELECT z.*, d.nom_dogovor, f.naimenovanie as firma_nazvanie
              FROM zakaz_po_dogovoru z
              LEFT JOIN dogovor d ON z.id_dogovora = d.id_dogovor
              LEFT JOIN firmy f ON d.id_firmy = f.id_firmy
              WHERE z.id = ?`, [zakazId]);
            if (!zakaz) return send(res, 404, { error: 'Заказ не найден' });

            // Гейт как у отправки: после решения контрагента письмо не требуется
            if (zakaz.data_otv_firma) {
                return send(res, 400, { error: 'Решение контрагента уже получено (' + zakaz.data_otv_firma + ') — повторная отправка не требуется' });
            }

            const contacts = await db.all(`
              SELECT k.email FROM kont k
              WHERE k.id_firmy = (SELECT id_firmy FROM dogovor WHERE id_dogovor = ?)
                AND k.aktivnost = 1 AND k.email != ''`, [zakaz.id_dogovora]);
            // ✅ T20: нормализация адресов — как у POST_SEND_EMAIL
            const { list: emailList, invalid: badEmails } = normalizeAddressList(
                (email && String(email).trim()) ? String(email).trim() : contacts.map(c => c.email).join(';'));
            if (badEmails.length) return send(res, 400, { error: 'Некорректный адрес: ' + badEmails.join(', ') });
            if (!emailList.length) return send(res, 400, { error: 'Нет активных email у контрагента' });

            const { subject, body, cc } = buildOrderApprovalEmail(zakaz, emailList);
            send(res, 200, {
                ok: true,
                to: emailList.join(';'),
                cc,
                subject,
                body,
                firma: zakaz.firma_nazvanie || '',
                nomer_zakaza: zakaz.nomer_zakaza || ''
            });
        } catch (e) {
            console.error('[emailRoutes.POST_EMAIL_PREVIEW] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },


/**
     * Отправка писем контрагентам (массовая рассылка)
     * POST /api/email/send-firms
     */
/**
 * Отправка писем контрагентам
 * ✅ ИСПРАВЛЕНО: каждой фирме прикрепляется ЕЁ обменный файл
 * POST /api/email/send-firms
 */
/**
 * Отправка писем контрагентам
 * ✅ ИСПРАВЛЕНО: каждой фирме прикрепляется ЕЁ обменный файл
 * POST /api/email/send-firms
 */
async POST_SEND_FIRMS(req, res) {
  try {
    const d = await parseBody(req);
    const { zaprosId, firms, url3D, zaprosKPPath, obmenByFirma, dryRun } = d;

    if (!zaprosId || !firms || firms.length === 0) {
      return send(res, 400, { error: 'Не указаны фирмы для рассылки' });
    }
    if (!url3D) {
      return send(res, 400, { error: 'Не заполнена ссылка на документацию' });
    }

    const zapros = await db.get(`
      SELECT z.*, t.email as tehnolog_email, t.fio as tehnolog_name,
             t.telefon as tehnolog_telefon
      FROM zapros_kp z
      LEFT JOIN tech t ON z.id_tehnologa = t.id
      WHERE z.id = ?
    `, [zaprosId]);
    if (!zapros) {
      return send(res, 400, { error: 'Запрос не найден' });
    }

    const tehnologContact = zapros.tehnolog_name
      ? `${zapros.tehnolog_name} (${zapros.tehnolog_email || 'email не указан'}, тел. ${zapros.tehnolog_telefon || 'не указан'})`
      : (zapros.tehnolog_email || 'технолог не назначен');

    // ✅ T100: отредактированный в предпросмотре текст письма (клиент шлёт
    // одну фирму за вызов — оверрайд d.body применяется к письмам вызова;
    // без правки текст строит единый конструктор buildZaprosFirmaEmail)
    const bodyOverride = (typeof d.body === 'string' && d.body.trim()) ? d.body : null;

    const results = { sent: [], failed: [] };
    const sendDate = sqlDateTime();

    for (const firm of firms) {
      if (!firm.email) continue;

      try {
        // Получаем договор фирмы
        const dog = await db.get(
          'SELECT nom_dogovor as n_dog, data_dogovor as data FROM dogovor WHERE id_firmy = ? ORDER BY data_dogovor DESC LIMIT 1',
          [firm.firmKod]
        );
        // ✅ T100: письмо строится ЕДИНЫМ конструктором (buildZaprosFirmaEmail —
        // тот же, что у предпросмотра POST_FIRMS_EMAIL_PREVIEW); если клиент
        // передал отредактированный текст (body) — используется он
        const built = buildZaprosFirmaEmail(zapros, firm, dog, url3D, tehnologContact);
        const subject = built.subject;
        const body = bodyOverride !== null ? bodyOverride : built.body;
        const cc = built.cc;

        // ✅ Вложения: заявка + обменная форма ЭТОЙ фирмы
        const attachments = [];
        if (zaprosKPPath) attachments.push(zaprosKPPath);

        // Берём обменный файл именно для этой фирмы
        const firmObmen = obmenByFirma && obmenByFirma[firm.firmKod];
        if (firmObmen && firmObmen.path) {
          attachments.push(firmObmen.path);
        }

        // ✅ Особый режим: без фактической отправки письма —
        // КП всё равно помечается как отправленное (дата, email)
        let result = null;
        if (dryRun) {
          console.log(`[DRY-RUN] send-firms: письмо фирме ${firm.firmName} не отправлялось, КП помечено как отправленное`);
        } else {
          result = await sendEmail({
            to: firm.email,
            subject,
            body,
            attachments,
            cc
          });
        }

        // Обновляем данные в КП
        await db.run(
          'UPDATE kp SET email_otpravki=?, date_otpravki=? WHERE id_zaprosa_kp=? AND id_firma=?',
          [firm.email, sendDate, zaprosId, firm.firmKod]
        );

        results.sent.push({
          firmKod: firm.firmKod,
          firmName: firm.firmName,
          email: firm.email,
          messageId: dryRun ? 'DRY-RUN (письмо не отправлялось)' : result.messageId
        });
      } catch (err) {
        results.failed.push({
          firmKod: firm.firmKod,
          firmName: firm.firmName,
          email: firm.email,
          error: err.message
        });
      }
    }

    wsManager.notifyDataChange('zapros_kp', 'update', zaprosId);
    wsManager.notifyDataChange('kp', 'update', zaprosId);

    // ✅ T27 (порт из легаси src/emailRoutes.js): ФИКС СТАТУСА «отправлено Всем/не Всем» — истина из БД.
    //    Если после обновлений у запроса не осталось КП-строк без даты
    //    отправки — все контрагенты получили запрос (в т.ч. при dry-run,
    //    когда даты проставляются без фактической отправки письма).
    //    Клиент (requests.js sendToFirms) уже ждёт это поле: приоритет — ответ сервера,
    //    снапшот по строкам остаётся только fallback-ом.
    let allSent = false;
    try {
      const remaining = await db.get(
        `SELECT COUNT(*) AS cnt FROM kp WHERE id_zaprosa_kp=? AND (date_otpravki IS NULL OR date_otpravki='')`,
        [zaprosId]
      );
      allSent = !remaining || Number(remaining.cnt) === 0;
    } catch (eAll) {
      console.error('[POST_SEND_FIRMS] allSent check failed:', eAll.message);
    }

    send(res, 200, {
      ok: true,
      sent: results.sent,
      failed: results.failed,
      sendDate,
      allSent   // ✅ T27: истина из БД для статуса «отправлено Всем/не Всем»
    });
  } catch (e) {
    console.error('[POST_SEND_FIRMS] Error:', e.message);
    send(res, 500, { error: e.message });
  }
},
    // ========================================================================
    // ✅ T100: ПРЕДПРОСМОТР писем контрагентам по запросу ТКП (БЕЗ отправки
    // и без изменения данных). POST /api/email/firms-email-preview
    // { zaprosId, url3D, firms: [{ firmKod, firmName, email }] }
    // Тот же конструктор buildZaprosFirmaEmail и тот же запрос договора,
    // что у реальной отправки POST_SEND_FIRMS — предпросмотр = то, что уйдёт.
    // Возвращает { ok, previews: [{ firmKod, firmName, to, cc, subject, body }] }.
    // ========================================================================
    async POST_FIRMS_EMAIL_PREVIEW(req, res) {
        try {
            const { zaprosId, firms, url3D } = await parseBody(req);
            if (!zaprosId) return send(res, 400, { error: 'Не указан zaprosId' });
            if (!firms || !firms.length) return send(res, 400, { error: 'Не указаны фирмы для рассылки' });
            if (!url3D) return send(res, 400, { error: 'Не заполнена ссылка на документацию' });

            const zapros = await db.get(`
              SELECT z.*, t.email as tehnolog_email, t.fio as tehnolog_name,
                     t.telefon as tehnolog_telefon
              FROM zapros_kp z
              LEFT JOIN tech t ON z.id_tehnologa = t.id
              WHERE z.id = ?
            `, [zaprosId]);
            if (!zapros) return send(res, 400, { error: 'Запрос не найден' });

            const tehnologContact = zapros.tehnolog_name
              ? `${zapros.tehnolog_name} (${zapros.tehnolog_email || 'email не указан'}, тел. ${zapros.tehnolog_telefon || 'не указан'})`
              : (zapros.tehnolog_email || 'технолог не назначен');

            const previews = [];
            for (const firm of firms) {
                // Получаем договор фирмы — тот же запрос, что у реальной отправки
                const dog = await db.get(
                  'SELECT nom_dogovor as n_dog, data_dogovor as data FROM dogovor WHERE id_firmy = ? ORDER BY data_dogovor DESC LIMIT 1',
                  [firm.firmKod]
                );
                const built = buildZaprosFirmaEmail(zapros, firm, dog, url3D, tehnologContact);
                previews.push({
                    firmKod: firm.firmKod,
                    firmName: firm.firmName || '',
                    to: firm.email || '',
                    cc: built.cc,
                    subject: built.subject,
                    body: built.body
                });
            }

            send(res, 200, { ok: true, previews });
        } catch (e) {
            console.error('[emailRoutes.POST_FIRMS_EMAIL_PREVIEW] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ===== ФИНАЛЬНОЕ ОБНОВЛЕНИЕ СТАТУСА ПОСЛЕ ВСЕЙ РАССЫЛКИ =====
    async POST_FINALIZE_STATUS(req, res) {
        try {
            const d = await parseBody(req);
            const { zaprosId, status } = d;
            if (!zaprosId || !status) {
                return send(res, 400, { error: 'Не указаны zaprosId или status' });
            }
            
            const validStatuses = [
                'отправлено Всем контрагентам',
                'отправлено не Всем контрагентам'
            ];
            if (!validStatuses.includes(status)) {
                return send(res, 400, { error: 'Недопустимый статус' });
            }
            
            await db.run(
                'UPDATE zapros_kp SET statys=? WHERE id=?',
                [status, zaprosId]
            );
            wsManager.notifyDataChange('zapros_kp', 'update', zaprosId);
            send(res, 200, { ok: true });
        } catch (e) {
            console.error('[POST_FINALIZE_STATUS] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    /**
     * Обновление URL — уведомление фирм (по одной фирме за раз)
     * POST /api/email/update-url
     */
    
    async POST_UPDATE_URL(req, res) {
        try {
            const d = await parseBody(req);
            const { zaprosId, newUrl, firms, dryRun } = d;
            if (!zaprosId || !newUrl) {
                return send(res, 400, { error: 'Не указан URL' });
            }
            if (!newUrl.startsWith('https://disk.360.yandex.ru/')) {
                return send(res, 400, { error: 'Некорректный URL. Должен начинаться с https://disk.360.yandex.ru/' });
            }
            const zapros = await db.get('SELECT * FROM zapros_kp WHERE id = ?', [zaprosId]);
            if (!zapros) {
                return send(res, 400, { error: 'Запрос не найден' });
            }
            const zapros_data = displayDate(zapros.data_form);
            const subject = `ОБНОВЛЕНИЕ ССЫЛКИ: Запрос КП №${zapros.n_zaprosa} от ${zapros_data}`;
            const body = `Уважаемые коллеги!

    ВНИМАНИЕ: Обновлена ссылка на документацию по заявке № ${zapros.n_zaprosa} от ${zapros_data}.

    Актуальная ссылка:
    ${newUrl}

${SIGNATURE}`;   // ✅ T27: подпись из общего шаблона
            const cc = 'igor.chesnokov@vaz.ru;Aleksandr.Tyurin@vaz.ru';

            // Обновляем URL в запросе (один раз, идемпотентно)
            const dateStr = sqlDateTime();
            await db.run(
                'UPDATE zapros_kp SET ssylka_na_chertezh=?, date_url_update=? WHERE id=?',
                [newUrl, dateStr, zaprosId]
            );

            // Отправляем письма и обновляем link_dok для каждой фирмы
            let sentCount = 0;
            let failCount = 0;
            const sent = [];
            const failed = [];

            if (firms && firms.length > 0) {
                const recipients = firms.map(f => ({
                    firmKod: f.firmKod,
                    firmName: f.firmName,
                    email: f.email,
                    body
                }));
                // ✅ Особый режим: без фактической отправки писем —
                // все фирмы считаются успешно "отправленными"
                const results = dryRun
                    ? {
                        sent: recipients.map(r => ({
                            firmKod: r.firmKod,
                            firmName: r.firmName,
                            email: r.email
                        })),
                        failed: []
                    }
                    : await sendBulkEmails({
                        recipients,
                        subject,
                        attachments: [],
                        cc
                    });
                if (dryRun) {
                    console.log(`[DRY-RUN] update-url: уведомления ${recipients.length} фирм(ам) не отправлялись, link_dok проставлен`);
                }
                sentCount = results.sent.length;
                failCount = results.failed.length;

                // ✅ Записываем link_dok = текущее время для успешно отправленных фирм
                const sendDate = sqlDateTime();
                for (const s of results.sent) {
                    await db.run(
                        'UPDATE kp SET link_dok=? WHERE id_zaprosa_kp=? AND id_firma=?',
                        [sendDate, zaprosId, s.firmKod]
                    );
                    sent.push({ firmKod: s.firmKod, firmName: s.firmName, email: s.email });
                }
                for (const f of results.failed) {
                    failed.push({ firmKod: f.firmKod, firmName: f.firmName, error: f.error });
                }
            }

            wsManager.notifyDataChange('zapros_kp', 'update', zaprosId);
            wsManager.notifyDataChange('kp', 'update', zaprosId);

            send(res, 200, {
                ok: true,
                sent,
                failed,
                sentCount,
                failCount,
                date: dateStr,
                sendDate: sqlDateTime()
            });
        } catch (e) {
            console.error('[POST_UPDATE_URL] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    /**
     * Получить активные email контакты фирмы
     * GET /api/email/firm-contacts?id_firmy=XXX
     */
    async GET_FIRM_CONTACTS(req, res, url) {
        try {
            const firmaId = url.searchParams.get('id_firmy');
            if (!firmaId) {
                return send(res, 400, { error: 'Не указан id_firmy' });
            }
            
            const contacts = await db.all(
                'SELECT email FROM kont WHERE id_firmy=? AND aktivnost=1 AND email IS NOT NULL AND email != ""',
                [firmaId]
            );
            
            const emails = contacts.map(c => c.email).filter(e => e);
            const emailString = emails.join(';');
            
            send(res, 200, { emails, emailString });
        } catch (e) {
            send(res, 500, { error: e.message });
        }
    }
});