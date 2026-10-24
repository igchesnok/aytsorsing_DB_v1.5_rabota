// ============================================================
// helpers/orderExcel.js — ✅ T42
// Генерация Excel-файла ЗАКАЗА для вложения в СЗ в СБ об отгрузке.
// Логика — точная копия POST_GENERATE_EXCEL (orderRoutes.js):
// zakaz -> позиции (orders.positions) -> обогащение plan/osnastka ->
// grafiks -> dogovor/firma/вид работ -> exportZakazToExcel.
// Вынесено отдельным хелпером, чтобы НЕ трогать orderRoutes.js
// (маршрут /api/orders/generate-excel работает как раньше).
// Результат: { path, relativePath, fileName } — как у exportZakazToExcel.
// ============================================================
const { buildSyntheticQuery } = require('./syntheticTables');
const { exportZakazToExcel } = require('../../excelService');

async function generateOrderExcelFile(db, zakazId) {
  const zakaz = await db.get('SELECT * FROM zakaz_po_dogovoru WHERE id = ?', [zakazId]);
  if (!zakaz) throw new Error('Заказ не найден: ' + zakazId);

  const { sql, params } = buildSyntheticQuery('orders.positions', { zakazId });
  const positions = await db.all(sql, params);

  // ============================================================
  // Дополнительная подгрузка полей из plan + osnastka (копия
  // POST_GENERATE_EXCEL): buildSyntheticQuery не JOIN-ит osnastka,
  // поэтому nomer_chertezha/osn_naimenovanie/zak_pto восстанавливаем.
  // ============================================================
  for (const pos of positions) {
    const planId = pos.id_plana || pos.id;
    if (!planId) continue;

    const enriched = await db.get(
      `SELECT
          p.zak_pto,
          p.plan_god_kolvo,
          p.cena_pto,
          o.nomer_chertezha,
          o.naimenovanie AS osn_naimenovanie
       FROM plan p
       LEFT JOIN osnastka o ON p.id_osnastka = o.id
       WHERE p.id = ?`,
      [planId]
    );

    if (enriched) {
      if (pos.zak_pto === undefined) pos.zak_pto = enriched.zak_pto || '';
      if (pos.nomer_chertezha === undefined) pos.nomer_chertezha = enriched.nomer_chertezha || '';
      if (pos.osn_naimenovanie === undefined) pos.osn_naimenovanie = enriched.osn_naimenovanie || '';
      if (pos.plan_god_kolvo === undefined) pos.plan_god_kolvo = enriched.plan_god_kolvo || 0;
      if (pos.cena_postavshika === undefined && enriched.cena_pto) {
        pos.cena_postavshika = enriched.cena_pto;
      }
    }

    // Графики по месяцам (копия POST_GENERATE_EXCEL)
    const grafiks = await db.all(
      'SELECT * FROM grafik WHERE id_plana = ? ORDER BY CAST(etap_nomer AS INTEGER)',
      [planId]
    );
    pos.grafiks = grafiks;
  }

  const dogovor = await db.get('SELECT * FROM dogovor WHERE id_dogovor = ?', [zakaz.id_dogovora]);
  if (!dogovor) throw new Error('Договор заказа не найден: ' + zakaz.id_dogovora);

  const firma = await db.get('SELECT * FROM firmy WHERE id_firmy = ?', [dogovor.id_firmy]);
  if (!firma) throw new Error('Фирма договора не найдена: ' + dogovor.id_firmy);

  // «Вид работ (по договору в целом)» — из базы (копия POST_GENERATE_EXCEL)
  let vidRabotName = '';
  if (dogovor.id_vid_rabot) {
    const vr = await db.get('SELECT soderzhanie FROM sprav_uslov WHERE id_usloviya = ?', [dogovor.id_vid_rabot]);
    vidRabotName = vr && vr.soderzhanie ? String(vr.soderzhanie).trim() : '';
  }

  const baseYear = new Date(zakaz.data_zakaza).getFullYear();

  return exportZakazToExcel({ zakaz, dogovor, firma, positions, baseYear, vidRabotName });
}

module.exports = { generateOrderExcelFile };
