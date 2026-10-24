const { parseBody, send, generateId } = require('../utils');
const { sqlDate, sqlDateTime } = require('./helpers/dateHelpers');

module.exports = (db, wsManager) => ({
  // GET — список заказов
  async GET(req, res, url) {
    const god = url.searchParams.get('god');
    const idFirmy = url.searchParams.get('id_firmy');
    const idDogovora = url.searchParams.get('id_dogovora');

    let sql = `
      SELECT zd.*, f.naimenovanie as firma_nazvanie, f.id_firmy,
             d.nom_dogovor as dogovor_nom
      FROM zakaz_po_dogovoru zd
      LEFT JOIN dogovor d ON zd.id_dogovora = d.id_dogovor
      LEFT JOIN firmy f ON d.id_firmy = f.id_firmy
      WHERE 1=1
    `;
    const params = [];
    if (god) { sql += ` AND strftime('%Y', zd.data_zakaza) = ?`; params.push(god); }
    if (idFirmy) { sql += ` AND d.id_firmy = ?`; params.push(idFirmy); }
    if (idDogovora) { sql += ` AND zd.id_dogovora = ?`; params.push(idDogovora); }
    sql += ` ORDER BY zd.data_zakaza DESC`;

    send(res, 200, await db.all(sql, params));
  },

  // GET позиции заказа
  async GET_POSITIONS(req, res, url) {
    const idZakaza = url.searchParams.get('id_zakaza');
    const sql = `
      SELECT pz.id, pz.status_poz_zd, p.nomer_chertezha,
             p.naimenovanie, p.plan_god_kolvo as kolvo
      FROM poz_zakaz_dogovora pz
      LEFT JOIN plan p ON pz.id_plana = p.id
      WHERE pz.id_zakaza_po_dogovoru = ?
      ORDER BY pz.nomercikla
    `;
    send(res, 200, await db.all(sql, [idZakaza]));
  },

  // GET доступные позиции
  async GET_AVAILABLE(req, res, url) {
    const god = url.searchParams.get('god');
    const idFirmy = url.searchParams.get('id_firmy');

    const sql = `
      SELECT p.id as id_plana, p.id_kp, p.nomer_chertezha,
             p.naimenovanie, p.plan_god_kolvo, f.naimenovanie as firma_nazvanie
      FROM plan p
      LEFT JOIN kp ON p.id_kp = kp.id
      LEFT JOIN firmy f ON kp.id_firma = f.id_firmy
      WHERE p.god = ? AND kp.id_firma = ? AND kp.isklyuchenо = ''
      AND NOT EXISTS (
        SELECT 1 FROM poz_zakaz_dogovora pz
        WHERE pz.id_plana = p.id AND pz.id_kp = p.id_kp
      )
    `;
    send(res, 200, await db.all(sql, [god, idFirmy]));
  },

  // POST — создание заказа
  async POST(req, res) {
    const d = await parseBody(req);
    const id = generateId('ZD');
    await db.run(`
      INSERT INTO zakaz_po_dogovoru
      (id, id_dogovora, nomer_zakaza, data_zakaza, statys_zd)
      VALUES (?,?,?,?,?)
    `, [id, d.id_dogovora, d.nomer_zakaza, d.data_zakaza, d.statys_zd || '']);
    wsManager.notifyDataChange('zakaz_po_dogovoru', 'add', id);
    send(res, 201, { id });
  },

  // PUT — обновление заказа
  async PUT(req, res, url) {
    const id = url.pathname.split('/')[3];
    const d = await parseBody(req);
    const updates = [];
    const params = [];

    if (d.statys_zd !== undefined) { updates.push('statys_zd=?'); params.push(d.statys_zd); }
    if (d.data_email_firma !== undefined) { updates.push('data_email_firma=?'); params.push(d.data_email_firma); }
    if (d.email_otpravki !== undefined) { updates.push('email_otpravki=?'); params.push(d.email_otpravki); }
    if (d.data_otv_firma !== undefined) { updates.push('data_otv_firma=?'); params.push(d.data_otv_firma); }
    if (d.reshenie_firm !== undefined) { updates.push('reshenie_firm=?'); params.push(d.reshenie_firm); }
    if (d.data_peredano_direktor !== undefined) { updates.push('data_peredano_direktor=?'); params.push(d.data_peredano_direktor); }
    if (d.data_podpisaniya_direktor !== undefined) { updates.push('data_podpisaniya_direktor=?'); params.push(d.data_podpisaniya_direktor); }
    if (d.data_go_orig_zd !== undefined) { updates.push('data_go_orig_zd=?'); params.push(d.data_go_orig_zd); }
    if (d.data_pol_orig_zd !== undefined) { updates.push('data_pol_orig_zd=?'); params.push(d.data_pol_orig_zd); }

    if (updates.length === 0) return send(res, 400, { error: 'Нет полей для обновления' });
    params.push(id);

    await db.run(`UPDATE zakaz_po_dogovoru SET ${updates.join(',')} WHERE id=?`, params);
    wsManager.notifyDataChange('zakaz_po_dogovoru', 'update', id);
    send(res, 200, { ok: true });
  },

  // DELETE — удаление заказа
  async DELETE(req, res, url) {
    const id = url.pathname.split('/')[3];
    await db.run('DELETE FROM poz_zakaz_dogovora WHERE id_zakaza_po_dogovoru=?', [id]);
    await db.run('DELETE FROM zakaz_po_dogovoru WHERE id=?', [id]);
    wsManager.notifyDataChange('zakaz_po_dogovoru', 'delete', id);
    send(res, 200, { ok: true });
  },

  // POST_GENERATE — автогенерация
  async POST_GENERATE(req, res) {
    const { god } = await parseBody(req);
    await db.run('BEGIN TRANSACTION');
    try {
      let countZakazs = 0, countPositions = 0;

      const rows = await db.all(`
        SELECT p.id as id_plana, p.id_kp, f.id_firmy, d.id_dogovor
        FROM plan p
        LEFT JOIN kp ON p.id_kp = kp.id
        LEFT JOIN firmy f ON kp.id_firma = f.id_firmy
        LEFT JOIN dogovor d ON f.id_firmy = d.id_firmy
          AND strftime('%Y', d.data_dogovor) <= ?
        WHERE p.god = ? AND kp.isklyuchenо = ''
        AND NOT EXISTS (SELECT 1 FROM poz_zakaz_dogovora pz WHERE pz.id_plana = p.id)
      `, [god, god]);

      const groups = new Map();
      for (const r of rows) {
        if (!r.id_dogovor) continue;
        const key = `${r.id_firmy}|${r.id_dogovor}`;
        if (!groups.has(key)) groups.set(key, { id_firmy: r.id_firmy, id_dogovor: r.id_dogovor, plans: [] });
        groups.get(key).plans.push(r);
      }

      for (const [key, group] of groups) {
        const existing = await db.get(
          `SELECT id FROM zakaz_po_dogovoru WHERE id_dogovora=? AND (statys_zd='' OR statys_zd IS NULL)`,
          [group.id_dogovor]
        );

        let orderId = existing?.id;
        if (!orderId) {
          orderId = generateId('ZD');
          const last = await db.get(
            `SELECT nomer_zakaza FROM zakaz_po_dogovoru WHERE id_dogovora=? ORDER BY nomer_zakaza DESC LIMIT 1`,
            [group.id_dogovor]
          );
          let num = 1;
          if (last?.nomer_zakaza) {
            const match = last.nomer_zakaza.match(/ЗД-\d+-(\d+)/);
            if (match) num = parseInt(match[1]) + 1;
          }
          await db.run(`
            INSERT INTO zakaz_po_dogovoru (id, id_dogovora, nomer_zakaza, data_zakaza, statys_zd)
            VALUES (?,?,?,?,?)
          `, [orderId, group.id_dogovor, `ЗД-${god}-${String(num).padStart(3,'0')}`,
              sqlDate(), '']);
          countZakazs++;
        }

        for (const plan of group.plans) {
          const pozId = generateId('PZD');
          const maxCycle = await db.get(
            `SELECT MAX(CAST(nomercikla AS INTEGER)) as m FROM poz_zakaz_dogovora WHERE id_plana=?`,
            [plan.id_plana]
          );
          await db.run(`
            INSERT INTO poz_zakaz_dogovora
            (id, id_zakaza_po_dogovoru, id_plana, id_kp, nomercikla, status_poz_zd)
            VALUES (?,?,?,?,?,?)
          `, [pozId, orderId, plan.id_plana, plan.id_kp,
              String((maxCycle?.m || 0) + 1), 'формирование списка поз. заказа']);
          countPositions++;
        }
      }

      await db.run('COMMIT');
      wsManager.notifyDataChange('zakaz_po_dogovoru', 'batch_add', 'gen');
      send(res, 200, { countZakazs, countPositions });
    } catch (e) {
      await db.run('ROLLBACK').catch(() => {});
      send(res, 500, { error: e.message });
    }
  },

  // POST_POSITION — добавление позиции (стрелка ↑)
  async POST_POSITION(req, res) {
    const { id_zakaza, id_plana, id_kp } = await parseBody(req);

    const order = await db.get('SELECT statys_zd FROM zakaz_po_dogovoru WHERE id=?', [id_zakaza]);
    if (order?.statys_zd) return send(res, 400, { error: 'Нельзя менять состав: заказ имеет статус' });

    const pozId = generateId('PZD');
    const maxCycle = await db.get(
      `SELECT MAX(CAST(nomercikla AS INTEGER)) as m FROM poz_zakaz_dogovora WHERE id_plana=?`,
      [id_plana]
    );
    await db.run(`
      INSERT INTO poz_zakaz_dogovora
      (id, id_zakaza_po_dogovoru, id_plana, id_kp, nomercikla, status_poz_zd)
      VALUES (?,?,?,?,?,?)
    `, [pozId, id_zakaza, id_plana, id_kp,
        String((maxCycle?.m || 0) + 1), 'формирование списка поз. заказа']);

    wsManager.notifyDataChange('poz_zakaz_dogovora', 'add', pozId);
    send(res, 201, { id: pozId });
  },

  // PUT_POSITION — обновление статуса позиции
  async PUT_POSITION(req, res, url) {
    const pozId = url.pathname.split('/')[4];
    const { status_poz_zd } = await parseBody(req);
    await db.run('UPDATE poz_zakaz_dogovora SET status_poz_zd=? WHERE id=?', [status_poz_zd, pozId]);
    wsManager.notifyDataChange('poz_zakaz_dogovora', 'update', pozId);
    send(res, 200, { ok: true });
  },

  // DELETE_POSITION — удаление позиции (стрелка ↓)
  async DELETE_POSITION(req, res, url) {
    const pozId = url.pathname.split('/')[4];
    const poz = await db.get('SELECT id_zakaza_po_dogovoru FROM poz_zakaz_dogovora WHERE id=?', [pozId]);
    if (!poz) return send(res, 404, { error: 'Позиция не найдена' });

    const order = await db.get('SELECT statys_zd FROM zakaz_po_dogovoru WHERE id=?', [poz.id_zakaza_po_dogovoru]);
    if (order?.statys_zd) return send(res, 400, { error: 'Нельзя удалить: заказ имеет статус' });

    await db.run('DELETE FROM poz_zakaz_dogovora WHERE id=?', [pozId]);

    const remaining = await db.get(
      'SELECT COUNT(*) as c FROM poz_zakaz_dogovora WHERE id_zakaza_po_dogovoru=?',
      [poz.id_zakaza_po_dogovoru]
    );
    if (remaining.c === 0) {
      await db.run('DELETE FROM zakaz_po_dogovoru WHERE id=?', [poz.id_zakaza_po_dogovoru]);
      wsManager.notifyDataChange('zakaz_po_dogovoru', 'delete', poz.id_zakaza_po_dogovoru);
    }

    wsManager.notifyDataChange('poz_zakaz_dogovora', 'delete', pozId);
    send(res, 200, { ok: true });
  },

  // POST_SEND_CONTRACTOR — отправка контрагенту
  async POST_SEND_CONTRACTOR(req, res) {
    const { id_zakaza } = await parseBody(req);
    const now = sqlDateTime();

    await db.run(`
      UPDATE zakaz_po_dogovoru
      SET statys_zd='на согласовании контрагента', data_email_firma=?
      WHERE id=?
    `, [now, id_zakaza]);

    await db.run(`
      UPDATE poz_zakaz_dogovora
      SET status_poz_zd='на рассмотрении'
      WHERE id_zakaza_po_dogovoru=?
    `, [id_zakaza]);

    wsManager.notifyDataChange('zakaz_po_dogovoru', 'update', id_zakaza);
    send(res, 200, { ok: true });
  },

  // POST_EXPORT_EXCEL — экспорт в Excel
  async POST_EXPORT_EXCEL(req, res) {
    const { id_zakaza } = await parseBody(req);
    // TODO: интеграция с excelService.js
    send(res, 200, { filePath: `/orders/order_${id_zakaza}.xlsx` });
  }
});