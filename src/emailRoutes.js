// ============================================================
// РОУТЫ: ОТПРАВКА ПИСЕМ И ГЕНЕРАЦИЯ EXCEL
// ============================================================
const { parseBody, send, generateId } = require('../utils');
const { sendEmail, sendBulkEmails, addWorkingDays } = require('../emailService');
const { exportZaprosKP, createEquipmentTable, getNextZayavkaNumber, generatePreviewHTML } = require('../excelService');
const { sqlDate, sqlDateTime,displayDate } = require('./helpers/dateHelpers');
const { extractToken, validateToken } = require('../authUtils');
const path = require('path');

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
     * Отправка письма технологу
     * POST /api/email/send-technolog
     */
    async POST_SEND_TEHNOLOG(req, res) {
        try {
            const d = await parseBody(req);
            const { zaprosId, excelPath, dryRun } = d;
            
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
            const zapros_data = displayDate(zapros.data_form);
            const subject = `АУТСОРСИНГ запроса на КП №${zapros.n_zaprosa} от ${zapros_data}`;
            
            const body = `                        Уважаемый ${zapros.tehnolog_name}!

       Прошу рассмотреть и согласовать позиции прилагаемого во вложении запроса на коммерческое предложение №${zapros.n_zaprosa} от ${zapros_data}.

       По согласованным позициям обратным письмом ответить всем
с указанием интернет ссылки на черт. и 3D мод.

С уважением,
Чесноков Игорь Иванович`;

            const attachments = excelPath ? [excelPath] : [];
            const cc = 'igor.chesnokov@vaz.ru;Aleksandr.Tyurin@vaz.ru';
            
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

    const zapros_data = displayDate(zapros.data_form);
    const crokOtvet = addWorkingDays(zapros.srok_predostavleniya_kp);
    const cc = 'igor.chesnokov@vaz.ru;Aleksandr.Tyurin@vaz.ru';

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

С уважением,

Чесноков Игорь Иванович
Ведущий инженер
Производственно-диспетчерский отдел
Производство технологической оснастки
АО «АВТОВАЗ»
к/т 89276135046`;

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

    // ✅ ФИКС СТАТУСА «отправлено Всем/не Всем»: истина из БД.
    //    Если после обновлений у запроса не осталось КП-строк без даты
    //    отправки — все контрагенты получили запрос (в т.ч. при dry-run,
    //    когда даты проставляются без фактической отправки письма).
    //    Клиент больше не считает статус по in-memory объектам строк,
    //    которые во время цикла заменяются асинхронными перезагрузками.
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
      allSent
    });
  } catch (e) {
    console.error('[POST_SEND_FIRMS] Error:', e.message);
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

    С уважением, Чесноков Игорь Иванович`;
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