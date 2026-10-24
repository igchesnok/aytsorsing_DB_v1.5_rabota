
// ============================================================
// ✅ T26: СТАТУСЫ ПОЗИЦИЙ ЗАКАЗА — общий модуль.
// Раньше константы жили в orderRoutes.js; при переносе
// POST_SEND_EMAIL в emailRoutes.js (вся работа с письмами в одном
// месте) вынесены сюда — единый источник истины для обоих модулей.
// ============================================================
const POZ_STATUS_INITIAL = 'формирование списка поз. заказа';
const POZ_STATUS_SENT = 'на рассмотрении';
const POZ_STATUS_APPROVED = 'согласовано';
const POZ_STATUSES = [POZ_STATUS_INITIAL, POZ_STATUS_SENT, POZ_STATUS_APPROVED, 'отказ фирмы', 'отказ УЭБ'];


// ============================================================
// ✅ T32: производный статус заказа и проверка «все позиции
// согласованы» вынесены из orderRoutes.js сюда — единый источник
// истины для orderRoutes.js и emailRoutes.js (повторная отправка
// заказа не должна сбрасывать проделанную работу по согласованию).
// ============================================================
// z — строка zakaz_po_dogovoru (с уже новыми значениями полей),
// allApproved — все позиции заказа имеют статус «согласовано».
// (даты шагов старше: «Оригинал отправлен/получен» не перезаписываются,
// подпись директора даёт тот же статус — конфликтов нет)
function deriveOrderStatus(z, allApproved = false) {
  if (z.data_pol_orig_zd) return 'Оригинал получен';
  if (z.data_go_orig_zd) return 'Оригинал отправлен';
  if (z.data_podpisaniya_direktor || allApproved) return 'Согласовано';
  if (z.data_email_firma) return 'На согласовании контрагента';
  return '';
}

// Согласованы ли ВСЕ позиции заказа (>=1 позиции, каждая = «согласовано»)
async function allPositionsApproved(db, zakazId) {
  const agg = await db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status_poz_zd = ? THEN 1 ELSE 0 END) AS approved
     FROM poz_zakaz_dogovora WHERE id_zakaza_po_dogovoru = ?`,
    [POZ_STATUS_APPROVED, zakazId]);
  return !!(agg && agg.total > 0 && agg.total === agg.approved);
}

module.exports = { POZ_STATUS_INITIAL, POZ_STATUS_SENT, POZ_STATUS_APPROVED, POZ_STATUSES, deriveOrderStatus, allPositionsApproved };
