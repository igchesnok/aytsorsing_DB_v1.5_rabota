// ============================================================
// СЕРВИС ОТПРАВКИ ПИСЕМ ЧЕРЕЗ YANDEX SMTP
// ============================================================
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const emailConfig = {
    host: 'smtp.yandex.ru',
    port: 465,
    secure: true,
    auth: {
        user: 'igor.chesnokov.vaz@yandex.ru',
        pass: 'tpwkuihvupsvnvjx'
    }
};

let transporter = null;

function getTransporter() {
    if (!transporter) {
        transporter = nodemailer.createTransport(emailConfig);
    }
    return transporter;
}

/**
 * Расчёт рабочего срока (аналог AddWorkingDays в VBA)
 * @param {number} days - количество рабочих дней
 * @returns {string} дата в формате dd.mm.yyyy
 */
function addWorkingDays(days) {
    days = parseInt(days) || 0;
    if (days < 0) days = 0;
    
    let currentDate = new Date();
    let workingDaysAdded = 0;
    
    while (workingDaysAdded < days) {
        currentDate.setDate(currentDate.getDate() + 1);
        const dayOfWeek = currentDate.getDay(); // 0=вс, 6=сб
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            workingDaysAdded++;
        }
    }
    
    // Корректировка, если выпадает на выходной
    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek === 6) { // суббота
        currentDate.setDate(currentDate.getDate() + 2);
    } else if (dayOfWeek === 0) { // воскресенье
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    const dd = String(currentDate.getDate()).padStart(2, '0');
    const mm = String(currentDate.getMonth() + 1).padStart(2, '0');
    const yyyy = currentDate.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

/**
 * Отправка письма одному или нескольким получателям
 */
async function sendEmail({ to, subject, body, attachments = [], cc = '', bcc = '' }) {
    const transport = getTransporter();
    
    const mailOptions = {
        from: emailConfig.auth.user,
        to: to,
        cc: cc,
        bcc: bcc,
        subject: subject,
        text: body,
        attachments: attachments.map(filePath => ({
            filename: path.basename(filePath),
            path: filePath
        })).filter(att => fs.existsSync(att.path))
    };
    
    try {
        const info = await transport.sendMail(mailOptions);
        console.log('✅ Письмо отправлено:', info.messageId);
        return { ok: true, messageId: info.messageId };
    } catch (err) {
        console.error('❌ Ошибка отправки:', err.message);
        throw err;
    }
}

/**
 * ✅ T20 Нормализация списка адресов (шаг 1 «Отправка на согласование»):
 * разделители «;» и «,» (а также пробелы/переводы строк), трим,
 * дедупликация без учёта регистра, проверка формата адреса.
 * @returns {{list: string[], invalid: string[]}} list — корректные адреса
 * (в исходном регистре), invalid — отброшенный мусор для сообщения об ошибке
 */
function normalizeAddressList(str) {
    const raw = String(str || '').split(/[;,\s]+/).map(s => s.trim()).filter(Boolean);
    const seen = new Set();
    const list = [];
    const invalid = [];
    for (const a of raw) {
        const k = a.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) list.push(a);
        else invalid.push(a);
    }
    return { list, invalid };
}
/**
 * Массовая рассылка нескольким firmam
 * @returns {Object} { sent: [], failed: [] }
 */
async function sendBulkEmails({ recipients, subject, body, attachments = [], cc = '' }) {
    const results = { sent: [], failed: [] };
    
    for (const recipient of recipients) {
        try {
            await sendEmail({
                to: recipient.email,
                subject,
                body: recipient.body || body,
                attachments,
                cc
            });
            results.sent.push({
                firmKod: recipient.firmKod,
                firmName: recipient.firmName,
                email: recipient.email
            });
        } catch (err) {
            results.failed.push({
                firmKod: recipient.firmKod,
                firmName: recipient.firmName,
                email: recipient.email,
                error: err.message
            });
        }
    }
    
    return results;
}

/**
 * Отправка письма контрагенту для согласования заказа
 */
async function sendEmailToContractor({ to, subject, body, attachments = [], cc = '' }) {
    const transport = getTransporter();
    
    const mailOptions = {
        from: emailConfig.auth.user,
        to: to,
        cc: cc,
        subject: subject,
        text: body,
        attachments: attachments.map(filePath => ({
            filename: path.basename(filePath),
            path: filePath
        })).filter(att => fs.existsSync(att.path))
    };
    
    try {
        const info = await transport.sendMail(mailOptions);
        console.log('✅ Письмо контрагенту отправлено:', info.messageId);
        return { ok: true, messageId: info.messageId };
    } catch (err) {
        console.error(' Ошибка отправки:', err.message);
        throw err;
    }
}

module.exports = {
    sendEmail,
    sendBulkEmails,
    sendEmailToContractor,  // ← добавить
    addWorkingDays,
    getTransporter,
    normalizeAddressList    // ✅ T20: несколько адресов через «;»
};