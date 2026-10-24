// ============================================================
// src/routes/orderRoutes.js
// API: ЗАКАЗЫ ПО ДОГОВОРАМ
// ВСЕ методы используют buildSyntheticQuery — единый источник истины
// ============================================================

const { parseBody, send, generateId } = require('../utils');
const { buildQuery, join, field } = require('./helpers/queryBuilder');
const { buildSyntheticQuery, getDependencies } = require('./helpers/syntheticTables');
const {  sqlDate, sqlDateTime } = require('./helpers/dateHelpers');
const { exportZakazToExcel, generatePreviewHTML } = require('../excelService');
const path = require('path');
const fs = require('fs');


// ========================================================================
// СТАТУСЫ ПОЗИЦИЙ И АВТО-СТАТУС ЗАКАЗА (эталон: 5 последовательных шагов)
// ========================================================================
// ✅ T26: статусы позиций заказа вынесены в общий модуль
// (нужны и emailRoutes.js — обработчик письма заказу живёт там)
// ✅ T32: deriveOrderStatus/allPositionsApproved вынесены в общий модуль
// (нужны и emailRoutes.js — повторная отправка без сброса согласования)
const { POZ_STATUS_INITIAL, POZ_STATUS_SENT, POZ_STATUS_APPROVED, POZ_STATUSES, deriveOrderStatus, allPositionsApproved } = require('./helpers/orderStatuses');
const normalizePozStatus = (s) => (s === 'на расмотрении' ? POZ_STATUS_SENT : s);
module.exports = (db, wsManager) => ({


  // ========================================================================
  // GET — список заказов с фильтрацией
  // ========================================================================
    async GET(req, res, url) {
    try {
        const god = url.searchParams.get('god') || new Date().getFullYear();
        const idFirma = url.searchParams.get('id_firma') || undefined;
        const idDogovora = url.searchParams.get('id_dogovora') || undefined;
        const nomerZakaza = url.searchParams.get('nomer_zakaza') || undefined;
        const statysZd = url.searchParams.get('statys_zd') || undefined;  // ✅ null → undefined
        const nZaprosa = url.searchParams.get('n_zaprosa') || undefined;  // ✅ T93: фильтр «№ запроса»

        const { sql, params } = buildSyntheticQuery('orders.zakazy', {
        god, idFirma, idDogovora, nomerZakaza, statysZd, nZaprosa
        });

        const rows = await db.all(sql, params);
        send(res, 200, rows);
    } catch (e) {
        console.error('[orderRoutes.GET] Error:', e.message);
        send(res, 500, { error: e.message });
    }
    },

  // ========================================================================
  // GET_POSITIONS — позиции конкретного заказа
  // ========================================================================
  async GET_POSITIONS(req, res, url) {
    try {
      const zakazId = url.searchParams.get('zakazId');
      if (!zakazId) {
        return send(res, 400, { error: 'Не указан zakazId' });
      }

      const { sql, params } = buildSyntheticQuery('orders.positions', { zakazId });
      const rows = await db.all(sql, params);
      send(res, 200, rows);
    } catch (e) {
      console.error('[orderRoutes.GET_POSITIONS] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // GET_AVAILABLE_POSITIONS — доступные позиции для добавления
  // ========================================================================
  async GET_AVAILABLE_POSITIONS(req, res, url) {
    try {
      const god = url.searchParams.get('god');
      const idDogovora = url.searchParams.get('id_dogovora');
      const idFirma = url.searchParams.get('id_firma');
      const nomerChertezha = url.searchParams.get('nomer_chertezha');
      const naimenovanie = url.searchParams.get('naimenovanie');

      if (!god) {
        return send(res, 400, { error: 'Не указан год' });
      }

      // Определяем фирму из договора (если передан договор)
      let firmaId = idFirma || '';
      if (idDogovora && !firmaId) {
        const dog = await db.get('SELECT id_firmy FROM dogovor WHERE id_dogovor = ?', [idDogovora]);
        if (dog) firmaId = dog.id_firmy;
      }

      const { sql, params } = buildSyntheticQuery('orders.available', {
        god, firmaId, nomerChertezha, naimenovanie
      });

      const rows = await db.all(sql, params);
      send(res, 200, rows);
    } catch (e) {
      console.error('[orderRoutes.GET_AVAILABLE_POSITIONS] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // POST — создание заказа
  // ========================================================================
  async POST(req, res) {
    try {
      const d = await parseBody(req);

      if (!d.id_dogovora || !d.nomer_zakaza) {
        return send(res, 400, { error: 'Заполните обязательные поля: договор, номер заказа' });
      }

      const id = generateId('ZD');

      await db.run(`
        INSERT INTO zakaz_po_dogovoru (
          id, id_dogovora, nomer_zakaza, data_zakaza, statys_zd
        ) VALUES (?,?,?,?,?)
      `, [id, d.id_dogovora, d.nomer_zakaza, d.data_zakaza || sqlDate(), d.statys_zd || '']);

      // ✅ Авто-уведомление по всем зависимостям таблицы zakaz_po_dogovoru
      const deps = getDependencies('orders.zakazy');
      wsManager.notifyWithDependencies(deps, 'add', id);

      send(res, 201, { id });
    } catch (e) {
      console.error('[orderRoutes.POST] Error:', e.message);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // PUT — обновление заказа
  // ========================================================================
  async PUT(req, res, url) {
    try {
      const id = url.pathname.split('/')[3];
      if (!id) return send(res, 400, { error: 'ID не указан' });
      // ✅ Самодиагностика установки: этот обработчик не должен видеть такие id.
      // Если видит — значит в работающем router.js нет нового маршрута
      // (файл не заменён или сервер не перезапущен после замены).
      if (id === 'position-status') {
        return send(res, 400, { error: 'Маршрут position-status не зарегистрирован: замените router.js из поставки и ПЕРЕЗАПУСТИТЕ сервер' });
      }

      const d = await parseBody(req);

      // Динамический UPDATE: обновляются ТОЛЬКО переданные поля —
      // поля шагов (даты, решения, файлы) не затираются при частичном сохранении
      // ✅ T51: n_sogl_avtovaz/statys_sogl_avtovaz/id_doc_edo перенесены в zapros_kp
      const WRITABLE = ['nomer_zakaza', 'data_zakaza', 'data_podpisaniya_direktor',
        'data_peredano_direktor', 'ssylka_scan_podpisannogo', 'data_go_orig_zd',
        'data_pol_orig_zd', 'statys_zd',
        'ssylka_reshenie', 'reshenie_firm', 'data_otv_firma',
        'data_email_firma', 'email_otpravki'];
      const sets = [];
      const params = [];
      for (const f of WRITABLE) {
        if (f in d) { sets.push(f + ' = ?'); params.push(d[f] === undefined ? '' : d[f]); }
      }
      if (!sets.length) return send(res, 400, { error: 'Нет полей для обновления' });
      params.push(id);
      await db.run('UPDATE zakaz_po_dogovoru SET ' + sets.join(', ') + ' WHERE id = ?', params);

      const deps = getDependencies('orders.zakazy');
      wsManager.notifyWithDependencies(deps, 'update', id);

      send(res, 200, { ok: true });
    } catch (e) {
      console.error('[orderRoutes.PUT] Error:', e.message);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // DELETE — удаление заказа
  // ========================================================================
  async DELETE(req, res, url) {
    try {
      const id = url.pathname.split('/')[3];
      if (!id) return send(res, 400, { error: 'ID не указан' });

      const zakaz = await db.get('SELECT statys_zd FROM zakaz_po_dogovoru WHERE id = ?', [id]);
      if (zakaz && zakaz.statys_zd !== '') {
        return send(res, 400, {
          error: 'Нельзя удалить заказ со статусом: ' + zakaz.statys_zd
        });
      }

      await db.run('DELETE FROM zakaz_po_dogovoru WHERE id = ?', [id]);

      const deps = getDependencies('orders.zakazy');
      wsManager.notifyWithDependencies(deps, 'delete', id);

      send(res, 200, { ok: true });
    } catch (e) {
      console.error('[orderRoutes.DELETE] Error:', e.message);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // POST_ADD_POSITION — добавление позиции в заказ
  // ========================================================================
  async POST_ADD_POSITION(req, res) {
    try {
      const d = await parseBody(req);

      if (!d.id_zakaza_po_dogovoru || !d.id_plana) {
        return send(res, 400, { error: 'id_zakaza_po_dogovoru и id_plana обязательны' });
      }

      // Проверка: нельзя добавить если статус заказа установлен
      const zakaz = await db.get('SELECT statys_zd FROM zakaz_po_dogovoru WHERE id = ?', [d.id_zakaza_po_dogovoru]);
      if (zakaz && zakaz.statys_zd !== '') {
        return send(res, 400, {
          error: 'Нельзя изменить состав: заказ имеет статус (' + zakaz.statys_zd + ')'
        });
      }

      // ✅ БИЗНЕС-ПРАВИЛО (механизм «лучших КП»): в заказ попадают ТОЛЬКО позиции с КП.
      // Раньше это неявно обеспечивал FK-контроль (непонятная ошибка
      // «FOREIGN KEY constraint failed»), теперь — явная проверка с понятным сообщением.
      // UI всегда шлёт id_kp из «Доступные позиции плана», где id_kp
      // гарантирован INNER JOIN kp и условием p.id_kp != ''.
      if (!d.id_kp || !String(d.id_kp).trim()) {
        return send(res, 400, { error: 'Позиция без КП не может быть добавлена в заказ' });
      }
      const kpExists = await db.get('SELECT id FROM kp WHERE id = ?', [d.id_kp]);
      if (!kpExists) {
        return send(res, 400, { error: 'КП не найдено: ' + d.id_kp });
      }

      const id = generateId('PZD');
      await db.run(`
        INSERT INTO poz_zakaz_dogovora (
          id, id_zakaza_po_dogovoru, id_plana, id_kp, status_poz_zd
        ) VALUES (?,?,?,?,?)
      `, [
        id, d.id_zakaza_po_dogovoru, d.id_plana,
        (d.id_kp && String(d.id_kp).trim()) ? d.id_kp : null,
        d.status_poz_zd || 'формирование списка поз. заказа'
      ]);

      // ✅ T32: добавление позиции в отправленный заказ — отправка «неактуальна»
      // (защитно: гейт выше обычно не пускает правку состава после отправки)
      await this._markStaleIfSent(d.id_zakaza_po_dogovoru);

      // ✅ Авто-уведомление по всем зависимостям позиции заказа
      const deps = getDependencies('orders.positions');
      wsManager.notifyWithDependencies(deps, 'add', id);

      send(res, 201, { id });
    } catch (e) {
      console.error('[orderRoutes.POST_ADD_POSITION] Error:', e.message);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // DELETE_POSITION — удаление позиции из заказа
  // ========================================================================
  async DELETE_POSITION(req, res, url) {
    try {
      const pozId = url.pathname.split('/')[4];
      if (!pozId) return send(res, 400, { error: 'ID позиции не указан' });

      const poz = await db.get(`
        SELECT pz.*, z.statys_zd, pz.id_kp
        FROM poz_zakaz_dogovora pz
        LEFT JOIN zakaz_po_dogovoru z ON pz.id_zakaza_po_dogovoru = z.id
        WHERE pz.id = ?
      `, [pozId]);

      if (!poz) return send(res, 404, { error: 'Позиция не найдена' });

      if (poz.statys_zd !== '') {
        return send(res, 400, {
          error: 'Нельзя удалить позицию: заказ имеет статус (' + poz.statys_zd + ')'
        });
      }

      await db.run('DELETE FROM poz_zakaz_dogovora WHERE id = ?', [pozId]);

      // Проверяем, не стал ли заказ пустым
      const remainingPositions = await db.get(
        'SELECT COUNT(*) as cnt FROM poz_zakaz_dogovora WHERE id_zakaza_po_dogovoru = ?',
        [poz.id_zakaza_po_dogovoru]
      );

      if (remainingPositions.cnt === 0) {
        await db.run('DELETE FROM zakaz_po_dogovoru WHERE id = ?', [poz.id_zakaza_po_dogovoru]);
      }

      // ✅ T32: состав отправленного заказа изменился — отправка «неактуальна»
      // (пустой заказ удалён выше — помечать нечего)
      if (remainingPositions.cnt > 0) await this._markStaleIfSent(poz.id_zakaza_po_dogovoru);

      // ✅ Авто-уведомление по всем зависимостям
      const deps = getDependencies('orders.positions');
      wsManager.notifyWithDependencies(deps, 'delete', pozId);

      send(res, 200, { ok: true });
    } catch (e) {
      console.error('[orderRoutes.DELETE_POSITION] Error:', e.message);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // POST_GENERATE_EXCEL — генерация Excel для заказа
  // ========================================================================
 async POST_GENERATE_EXCEL(req, res) {
    try {
        const { zakazId } = await parseBody(req);
        if (!zakazId) return send(res, 400, { error: 'Не указан zakazId' });

        const zakaz = await db.get('SELECT * FROM zakaz_po_dogovoru WHERE id = ?', [zakazId]);
        if (!zakaz) return send(res, 404, { error: 'Заказ не найден' });

        const { sql, params } = buildSyntheticQuery('orders.positions', { zakazId });
        const positions = await db.all(sql, params);

        // ============================================================
        // ✅ ДОПОЛНИТЕЛЬНАЯ ПОДГРУЗКА ПОЛЕЙ ИЗ plan + osnastka
        // buildSyntheticQuery не JOIN-ит osnastka, поэтому nomer_chertezha,
        // osn_naimenovanie и zak_pto отсутствуют в positions. Восстанавливаем.
        // ============================================================
        for (const pos of positions) {
            // id_plana — это ключ к plan.id; если в pos нет id_plana, берём id
            const planId = pos.id_plana || pos.id;
            if (!planId) continue;

            // JOIN plan + osnastka — берём только нужные поля
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
                // Вливаем недостающие поля, не затирая те, что уже есть в pos
                if (pos.zak_pto === undefined) pos.zak_pto = enriched.zak_pto || '';
                if (pos.nomer_chertezha === undefined) pos.nomer_chertezha = enriched.nomer_chertezha || '';
                if (pos.osn_naimenovanie === undefined) pos.osn_naimenovanie = enriched.osn_naimenovanie || '';
                // plan_god_kolvo и cena_pto — на случай если их тоже не было в выборке
                if (pos.plan_god_kolvo === undefined) pos.plan_god_kolvo = enriched.plan_god_kolvo || 0;
                if (pos.cena_postavshika === undefined && enriched.cena_pto) {
                    pos.cena_postavshika = enriched.cena_pto;
                }
            }

            // Графики по месяцам (как и раньше)
            const grafiks = await db.all(
                'SELECT * FROM grafik WHERE id_plana = ? ORDER BY CAST(etap_nomer AS INTEGER)',
                [planId]
            );
            pos.grafiks = grafiks;
        }

        // Лог для отладки — убедимся, что поля заполнились
        console.log('[POST_GENERATE_EXCEL] positions enriched:', positions.map(p => ({
            id_plana: p.id_plana || p.id,
            nomer_chertezha: p.nomer_chertezha,
            zak_pto: p.zak_pto,
            osn_naimenovanie: p.osn_naimenovanie,
            grafiks_count: p.grafiks?.length || 0
        })));

        const dogovor = await db.get('SELECT * FROM dogovor WHERE id_dogovor = ?', [zakaz.id_dogovora]);
        if (!dogovor) return send(res, 404, { error: 'Договор не найден' });

        const firma = await db.get('SELECT * FROM firmy WHERE id_firmy = ?', [dogovor.id_firmy]);
        if (!firma) return send(res, 404, { error: 'Фирма не найдена' });

        // T22b: «Вид работ (по договору в целом)» — из базы:
        // dogovor.id_vid_rabot -> sprav_uslov.soderzhanie (справочник «Вид работ»)
        let vidRabotName = '';
        if (dogovor.id_vid_rabot) {
            const vr = await db.get('SELECT soderzhanie FROM sprav_uslov WHERE id_usloviya = ?', [dogovor.id_vid_rabot]);
            vidRabotName = vr && vr.soderzhanie ? String(vr.soderzhanie).trim() : '';
        }

        const baseYear = new Date(zakaz.data_zakaza).getFullYear();

        const excelResult = await exportZakazToExcel({ zakaz, dogovor, firma, positions, baseYear, vidRabotName });
        const preview = await generatePreviewHTML(excelResult.path);

        send(res, 200, {
            ...excelResult,
            preview
        });
    } catch (e) {
        console.error('[orderRoutes.POST_GENERATE_EXCEL] Error:', e.message);
        console.error(e.stack);  // полный стектрейс для диагностики
        send(res, 500, { error: e.message });
    }
},


  // ========================================================================
  // ✅ T26: POST_SEND_EMAIL перенесён в emailRoutes.js — вся работа с
  // письмами теперь в одном модуле. URL прежний (POST /api/orders/send-email),
  // router.js ведёт его на routes.email.POST_SEND_EMAIL; клиентских правок нет.
  // ========================================================================

  // ========================================================================
  // PUT_STEP — запись полей одного из 5 последовательных шагов + авто-статус
  // ========================================================================
  async PUT_STEP(req, res, url) {
    try {
      const id = url.pathname.split('/')[3];
      const d = await parseBody(req);
      const step = parseInt(d.step, 10);
      const patch = d.patch || {};
      if (!id || !step) return send(res, 400, { error: 'Не указаны id/step' });

      // ✅ T51: шага 3 больше нет — «Согл. структур. подр. АВТОВАЗ» перенесён
      // на страницу «Внесение коммерческих предложений» (поля в zapros_kp);
      // номера шагов 4/5 сервера не менялись (клиент продолжает слать 4/5)
      const ALLOWED = {
        1: ['data_email_firma', 'email_otpravki'],
        2: ['reshenie_firm', 'data_otv_firma', 'ssylka_reshenie'],
        4: ['data_peredano_direktor', 'data_podpisaniya_direktor', 'ssylka_scan_podpisannogo'],
        5: ['data_go_orig_zd', 'data_pol_orig_zd']
      };
      const fields = ALLOWED[step];
      if (!fields) return send(res, 400, { error: 'Неверный номер шага (1, 2, 4, 5)' });

      const z = await db.get('SELECT * FROM zakaz_po_dogovoru WHERE id = ?', [id]);
      if (!z) return send(res, 404, { error: 'Заказ не найден' });

      const merged = Object.assign({}, z);
      for (const f of fields) if (f in patch) merged[f] = patch[f] || '';

      // Нельзя очищать шаг, если более поздние шаги уже заполнены
      const LATER = ['data_email_firma', 'email_otpravki',
                     'data_otv_firma', 'ssylka_reshenie', 'reshenie_firm',
                     'data_peredano_direktor', 'data_podpisaniya_direktor', 'ssylka_scan_podpisannogo',
                     'data_go_orig_zd', 'data_pol_orig_zd'];
      const stepStart = { 1: 0, 2: 2, 4: 5, 5: 8 };   // ✅ T51: шага 3 нет
      const clearing = fields.some(f => f in patch && !(patch[f] && String(patch[f]).trim()));
      if (clearing) {
        const laterFilled = LATER.slice(stepStart[step] + fields.length).some(f => merged[f]);
        if (laterFilled) return send(res, 400, { error: 'Нельзя очистить шаг: более поздние шаги уже заполнены' });
      }

      // Гейты последовательности (как в эталоне)
      if (step >= 2 && !(merged.data_email_firma && String(merged.data_email_firma).trim()))
        return send(res, 400, { error: 'Шаг 1 не выполнен: заказ не отправлен контрагенту' });
      if (step >= 3 && !(merged.data_otv_firma && String(merged.data_otv_firma).trim()))
        return send(res, 400, { error: 'Шаг 2 не выполнен: нет даты ответа контрагента' });
      if (step === 5 && !(merged.data_podpisaniya_direktor && String(merged.data_podpisaniya_direktor).trim()))
        return send(res, 400, { error: 'Шаг 4 не выполнен: заказ не подписан директором' });

      merged.statys_zd = deriveOrderStatus(merged, await allPositionsApproved(db, id));

      const sets = [];
      const params = [];
      for (const f of fields) {
        if (f in patch) { sets.push(f + ' = ?'); params.push(patch[f] || ''); }
      }
      if (!sets.length) return send(res, 400, { error: 'Нет полей для обновления' });
      sets.push('statys_zd = ?'); params.push(merged.statys_zd);
      // ✅ T32: шаг 1 — фиксация отправки (дата заполнена) или откат («не отправляли»):
      // в обоих случаях флаг актуальности сбрасывается — актуальная отправка
      // фиксируется заново письмом (POST_SEND_EMAIL), либо отправки ещё нет.
      if (step === 1 && 'data_email_firma' in patch) {
        sets.push('aktualnost_email_firma = ?'); params.push('');
      }
      params.push(id);
      await db.run('UPDATE zakaz_po_dogovoru SET ' + sets.join(', ') + ' WHERE id = ?', params);

      // ✅ T21: при очистке ссылки на прикреплённый файл (шаг 2 «Решение
      // контрагента», шаг 4 «скан подписанного») — физически удаляем файл
      // из public/uploads/zakaz (только внутри этого каталога)
      for (const fl of ['ssylka_reshenie', 'ssylka_scan_podpisannogo']) {
        if (fl in patch && !(patch[fl] && String(patch[fl]).trim()) && z[fl]) {
          try {
            const rel = decodeURIComponent(String(z[fl]).replace(/^\/+/, ''));
            const root = path.normalize(path.join(__dirname, '..', '..', 'public'));
            const abs = path.normalize(path.join(root, rel));
            if (abs.startsWith(path.join(root, 'uploads', 'zakaz') + path.sep) && fs.existsSync(abs)) {
              fs.unlinkSync(abs);
              console.log('[orderRoutes.PUT_STEP] удалён файл решения:', abs);
            }
          } catch (e) { console.warn('[orderRoutes.PUT_STEP] unlink:', e.message); }
        }
      }

      // ✅ T30: откат шага 1 («не отправляли фирмам») — очистка data_email_firma:
      //   - отказные позиции («отказ фирмы»/«отказ УЭБ», вкл. legacy-строки)
      //     удаляются из заказа (их КП уже
      //     исключены, позиции плана уже освобождены в момент отказа);
      //   - статусы ОСТАЛЬНЫХ позиций возвращаются в исходное
      //     «формирование списка поз. заказа» (статусы позиции имеют смысл
      //     только у отправленного заказа);
      //   - если после этого в заказе не осталось позиций — заказ удаляется.
      const step1RolledBack = step === 1
        && z.data_email_firma && String(z.data_email_firma).trim()
        && !(merged.data_email_firma && String(merged.data_email_firma).trim());
      let step1OrderDeleted = false;
      if (step1RolledBack) {
        const refusedRows = await db.all(
          "SELECT id FROM poz_zakaz_dogovora WHERE id_zakaza_po_dogovoru = ? AND status_poz_zd IN ('отказ фирмы', 'отказ УЭБ')",
          [id]);
        if (refusedRows.length) {
          await db.run(
            "DELETE FROM poz_zakaz_dogovora WHERE id_zakaza_po_dogovoru = ? AND status_poz_zd IN ('отказ фирмы', 'отказ УЭБ')",
            [id]);
          for (const rr of refusedRows) {
            wsManager.notifyWithDependencies(getDependencies('orders.positions'), 'delete', rr.id);
          }
        }
        await db.run('UPDATE poz_zakaz_dogovora SET status_poz_zd = ? WHERE id_zakaza_po_dogovoru = ?',
          [POZ_STATUS_INITIAL, id]);
        wsManager.notifyWithDependencies(getDependencies('orders.positions'), 'update', id);
        // ✅ T30b: статус ЗАКАЗА тоже откатывается, а не только статусы позиций.
        // Строка «merged.statys_zd = ...» выше вычислена ДО сброса позиций:
        // если все позиции были «согласовано», allApproved=true и заказ
        // оставался «Согласовано», хотя отправки фирме уже нет. Позиции
        // только что сброшены в исходное состояние, поздние шаги пусты
        // (гейт выше не пропустил бы очистку шага 1) — производный статус
        // возвращается к исходному '' («не отправляли», как при создании).
        const rolledStatys = deriveOrderStatus(merged, false);
        await db.run('UPDATE zakaz_po_dogovoru SET statys_zd = ? WHERE id = ?',
          [rolledStatys, id]);
        const restCnt = await db.get(
          'SELECT COUNT(*) AS cnt FROM poz_zakaz_dogovora WHERE id_zakaza_po_dogovoru = ?', [id]);
        if (!restCnt || !restCnt.cnt) {
          await db.run('DELETE FROM zakaz_po_dogovoru WHERE id = ?', [id]);
          step1OrderDeleted = true;
        }
        console.log(`[orderRoutes.PUT_STEP] Откат шага 1, заказ ${id}: отказных позиций удалено ${refusedRows.length}, статусы позиций сброшены${step1OrderDeleted ? ', заказ удалён (пуст)' : ''}`);
      }

      if (step1OrderDeleted) {
        wsManager.notifyWithDependencies(getDependencies('orders.zakazy'), 'delete', id);
        return send(res, 200, { ok: true, deleted: true });
      }

      wsManager.notifyWithDependencies(getDependencies('orders.zakazy'), 'update', id);

      const row = await db.get(`
        SELECT z.*, d.nom_dogovor, d.data_dogovor, f.naimenovanie AS firma_nazvanie, f.id_firmy
        FROM zakaz_po_dogovoru z
        LEFT JOIN dogovor d ON z.id_dogovora = d.id_dogovor
        LEFT JOIN firmy f ON d.id_firmy = f.id_firmy
        WHERE z.id = ?`, [id]);

      send(res, 200, { ok: true, row });
    } catch (e) {
      console.error('[orderRoutes.PUT_STEP] Error:', e.message);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // ✅ T31: _handlePozOtkaz — ЕДИНЫЙ алгоритм для «отказ фирмы» И «отказ УЭБ»
  //   (раньше «отказ УЭБ» только ставил статус, без цепочки). Отказ по ОДНОЙ
  //   позиции заказа:
  //     - эта позиция УДАЛЯЕТСЯ из заказа: позиция плана должна существовать
  //       только в одном заказе (КП исключено, план освобождён);
  //     - исключается из расчётов ТОЛЬКО КП этой позиции (isklyuchen='1',
  //       reshenie/primechanie_kp сбрасываются — как при ручном исключении
  //       POST_SET_ISKLYUCHEN);
  //     - плановая позиция этой детали освобождается (plan.id_kp = NULL),
  //       если была привязана именно к этому КП;
  //     - статус затронутого запроса откатывается («выбраны лучшие КП» ->
  //       «отправлено (не) Всем контрагентам») — кнопка «Выбрать лучшие КП»
  //       снова активна для перерасчёта;
  //     - если позиций в заказе не осталось — заказ удаляется ЦЕЛИКОМ;
  //     - иначе статус заказа пересчитывается.
  // ========================================================================
  // ========================================================================
  // ✅ T32: состав ОТПРАВЛЕННОГО заказа изменился (позиция удалена по
  // «отказ фирмы»/«отказ УЭБ», добавлена/удалена вручную) — ранее
  // направленный фирме заказ «неактуален», после правок нужно отправить
  // обновлённый заказ. Флаг: zakaz_po_dogovoru.aktualnost_email_firma,
  //   '' — актуальна (или ещё не отправляли), 'неактуальна' — состав менялся.
  // Сброс: при отправке письма (POST_SEND_EMAIL) и при фиксации шага 1.
  // ========================================================================
  async _markStaleIfSent(zakazId) {
    const z = await db.get('SELECT data_email_firma FROM zakaz_po_dogovoru WHERE id = ?', [zakazId]);
    if (z && z.data_email_firma && String(z.data_email_firma).trim()) {
      await db.run("UPDATE zakaz_po_dogovoru SET aktualnost_email_firma = 'неактуальна' WHERE id = ?", [zakazId]);
      return true;
    }
    return false;
  },

  async _handlePozOtkaz(res, poz, status) {
    try {
      const zakazId = poz.id_zakaza_po_dogovoru;
      const zakaz = await db.get('SELECT * FROM zakaz_po_dogovoru WHERE id = ?', [zakazId]);
      if (!zakaz) return send(res, 404, { error: 'Заказ не найден' });

      const excludedKpIds = [];
      const freedPlanIds = [];
      const zaprosStatuses = []; // ✅ T19-OTKAZ-FIX1: уровень функции (не терять в ответе)

      await db.run('BEGIN TRANSACTION');
      try {
        // 1. ✅ T30: ТОЛЬКО КП этой позиции -> isklyuchen='1' + сброс назначения
        if (poz.id_kp) {
          const kpRow = await db.get('SELECT id, id_zaprosa_kp FROM kp WHERE id = ?', [poz.id_kp]);
          if (kpRow) {
            await db.run("UPDATE kp SET isklyuchen = '1', reshenie = '', primechanie_kp = '' WHERE id = ?", [kpRow.id]);
            excludedKpIds.push(kpRow.id);

            // 2. ✅ T30: позиция плана освобождается (если привязана к этому КП)
            if (poz.id_plana) {
              const planRow = await db.get('SELECT id, id_kp FROM plan WHERE id = ?', [poz.id_plana]);
              if (planRow && String(planRow.id_kp || '') === String(kpRow.id)) {
                await db.run('UPDATE plan SET id_kp = NULL WHERE id = ?', [poz.id_plana]);
                freedPlanIds.push(poz.id_plana);
              }
            }

            // 3. ✅ T30: статус запроса откатывается для перерасчёта (аналог fix A)
            if (kpRow.id_zaprosa_kp) {
              const z = await db.get('SELECT statys FROM zapros_kp WHERE id = ?', [kpRow.id_zaprosa_kp]);
              if (z && z.statys === 'выбраны лучшие КП') {
                const notSent = await db.get(
                  `SELECT COUNT(*) AS cnt FROM kp
                   WHERE id_zaprosa_kp = ? AND (date_otpravki IS NULL OR date_otpravki = '')`,
                  [kpRow.id_zaprosa_kp]
                );
                const prevStatus = (notSent && notSent.cnt > 0)
                  ? 'отправлено не Всем контрагентам'
                  : 'отправлено Всем контрагентам';
                await db.run('UPDATE zapros_kp SET statys = ? WHERE id = ?', [prevStatus, kpRow.id_zaprosa_kp]);
                zaprosStatuses.push({ zaprosId: kpRow.id_zaprosa_kp, status: prevStatus });
              }
            }
          }
        }

        // 4. ✅ T31: позиция УДАЛЯЕТСЯ из заказа — позиция плана должна
        //    существовать только в одном заказе (план освобождён в п.2)
        await db.run('DELETE FROM poz_zakaz_dogovora WHERE id = ?', [poz.id]);

        await db.run('COMMIT');
      } catch (txErr) {
        await db.run('ROLLBACK').catch(() => {});
        console.error('[orderRoutes._handlePozOtkaz] Транзакция отменена:', txErr.message);
        return send(res, 409, { error: 'Отказ фирмы не обработан (транзакция отменена): ' + txErr.message });
      }

      // 5. ✅ T31: позиция УДАЛЕНА — осталось ли что-то в заказе?
      const restCnt = await db.get(
        'SELECT COUNT(*) AS cnt FROM poz_zakaz_dogovora WHERE id_zakaza_po_dogovoru = ?', [zakazId]);
      const positionsLeft = restCnt ? restCnt.cnt : 0;

      // 6. ✅ T31: WS-уведомления (позиция УДАЛЕНА + КП/план/запросы)
      for (const kpId of excludedKpIds) wsManager.notifyDataChange('kp', 'update', kpId);
      for (const planId of freedPlanIds) wsManager.notifyDataChange('plan', 'update', planId);
      for (const zs of zaprosStatuses) wsManager.notifyDataChange('zapros_kp', 'update', zs.zaprosId);
      wsManager.notifyWithDependencies(getDependencies('orders.positions'), 'delete', poz.id);

      const zaprosHint = (zaprosStatuses.length ? ' Статус запроса: «' + zaprosStatuses[0].status + '» — запустите «Выбрать лучшие КП».' : '');

      if (!positionsLeft) {
        // 5a. ✅ T31: позиций не осталось — заказ удаляется ЦЕЛИКОМ
        await db.run('DELETE FROM zakaz_po_dogovoru WHERE id = ?', [zakazId]);
        wsManager.notifyWithDependencies(getDependencies('orders.zakazy'), 'delete', zakazId);
        console.log(`[orderRoutes._handlePozOtkaz] Заказ ${zakaz.nomer_zakaza}: позиция удалена, позиций не осталось — заказ удалён (КП исключено ${excludedKpIds.length}, плановых позиций освобождено ${freedPlanIds.length}, запросов откатено ${zaprosStatuses.length})`);
        send(res, 200, {
          ok: true,
          otkaz: true,
          pozDeleted: true,
          positionsLeft: 0,
          deleted: true,
          excludedKp: excludedKpIds.length,
          freedPositions: freedPlanIds.length,
          zaprosStatuses,
          message: '«' + status + '»: позиция удалена из заказа. Позиций в заказе не осталось — заказ удалён.' + zaprosHint
        });
        return;
      }

      // ✅ T32: состав отправленного заказа изменился — отправка «неактуальна»
      // (для неотправленного заказа флаг не ставится; порядок позиций в ответе не менялся)
      const markedStale = await this._markStaleIfSent(zakazId);

      // 7. ✅ T30/T31: статус заказа пересчитывается (удалённая позиция не «согласована»)
      const zrow = await db.get('SELECT * FROM zakaz_po_dogovoru WHERE id = ?', [zakazId]);
      const approvedAll = await allPositionsApproved(db, zakazId);
      const newStatys = deriveOrderStatus(zrow, approvedAll);
      const statysChanged = newStatys !== (zrow.statys_zd || '');
      if (statysChanged) {
        await db.run('UPDATE zakaz_po_dogovoru SET statys_zd = ? WHERE id = ?', [newStatys, zakazId]);
      }
      wsManager.notifyWithDependencies(getDependencies('orders.zakazy'), 'update', zakazId);

      console.log(`[orderRoutes._handlePozOtkaz] Заказ ${zakaz.nomer_zakaza}: позиция удалена, осталось ${positionsLeft} (КП исключено ${excludedKpIds.length}, плановых позиций освобождено ${freedPlanIds.length}, запросов откатено ${zaprosStatuses.length})`);

      send(res, 200, {
        ok: true,
        otkaz: true,
        pozDeleted: true,
        positionsLeft,
        deleted: false,
        excludedKp: excludedKpIds.length,
        freedPositions: freedPlanIds.length,
        zaprosStatuses,
        statys_zd: newStatys,
        statysChanged,
        aktualnost: markedStale ? 'неактуальна' : '',   // ✅ T32
        message: '«' + status + '»: позиция удалена из заказа. КП исключено из расчётов: ' + excludedKpIds.length +
          ', плановых позиций освобождено: ' + freedPlanIds.length + '.' + zaprosHint
      });
    } catch (e) {
      console.error('[orderRoutes._handlePozOtkaz] Error:', e.message);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // PUT_POSITION_STATUS — статус ОДНОЙ позиции (5 значений из эталона)
  // ========================================================================
  async PUT_POSITION_STATUS(req, res) {
    try {
      const d = await parseBody(req);
      if (!d.id) return send(res, 400, { error: 'Не указан id позиции' });
      const status = normalizePozStatus(d.status_poz_zd || '');
      if (!POZ_STATUSES.includes(status)) {
        return send(res, 400, { error: 'Недопустимый статус позиции: ' + status });
      }

      const poz = await db.get(`
        SELECT pz.*, z.data_email_firma
        FROM poz_zakaz_dogovora pz
        LEFT JOIN zakaz_po_dogovoru z ON pz.id_zakaza_po_dogovoru = z.id
        WHERE pz.id = ?`, [d.id]);
      if (!poz) return send(res, 404, { error: 'Позиция не найдена' });

      if (!(poz.data_email_firma && String(poz.data_email_firma).trim()) && status !== POZ_STATUS_INITIAL) {
        return send(res, 400, { error: 'Заказ ещё не отправлен контрагенту — статус позиции менять нельзя' });
      }

      // ✅ T31: «отказ фирмы» И «отказ УЭБ» — ЕДИНЫЙ алгоритм (_handlePozOtkaz):
      // КП ЭТОЙ позиции исключается (isklyuchen='1'), её плановая позиция
      // освобождается, статус запроса откатывается (кнопка «Выбрать лучшие
      // КП» активна); позиция УДАЛЯЕТСЯ из заказа, а если она была
      // последней — заказ удаляется целиком.
      if (status === 'отказ фирмы' || status === 'отказ УЭБ') {
        return await this._handlePozOtkaz(res, poz, status);
      }

      await db.run('UPDATE poz_zakaz_dogovora SET status_poz_zd = ? WHERE id = ?', [status, d.id]);

      // ✅ Правило: согласованы ВСЕ позиции -> заказ «Согласовано»;
      // если позиция ушла из «согласовано» — статус откатывается по датам шагов
      const zrow = await db.get('SELECT * FROM zakaz_po_dogovoru WHERE id = ?', [poz.id_zakaza_po_dogovoru]);
      const approvedAll = await allPositionsApproved(db, poz.id_zakaza_po_dogovoru);
      const newStatys = deriveOrderStatus(zrow, approvedAll);
      const statysChanged = newStatys !== (zrow.statys_zd || '');
      if (statysChanged) {
        await db.run('UPDATE zakaz_po_dogovoru SET statys_zd = ? WHERE id = ?', [newStatys, zrow.id]);
        wsManager.notifyWithDependencies(getDependencies('orders.zakazy'), 'update', zrow.id);
      }

      wsManager.notifyWithDependencies(getDependencies('orders.positions'), 'update', d.id);
      send(res, 200, { ok: true, statys_zd: newStatys, statysChanged });
    } catch (e) {
      console.error('[orderRoutes.PUT_POSITION_STATUS] Error:', e.message);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // POST_UPLOAD_FILE — сырая загрузка файла (без multipart): public/uploads/zakaz/
  // Параметры query: name, kind (reshenie|scan), zakazId. Лимит 25 МБ.
  // ========================================================================
  async POST_UPLOAD_FILE(req, res, url) {
    try {
      const name = url.searchParams.get('name') || 'file';
      const zakazId = url.searchParams.get('zakazId') || 'nofile';
      const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(-120) || 'file';
      const dir = path.join(__dirname, '..', '..', 'public', 'uploads', 'zakaz');
      fs.mkdirSync(dir, { recursive: true });

      const chunks = [];
      let size = 0;
      await new Promise((resolve, reject) => {
        req.on('data', c => {
          size += c.length;
          if (size > 25 * 1024 * 1024) { reject(new Error('Файл больше 25 МБ')); req.destroy(); return; }
          chunks.push(c);
        });
        req.on('error', reject);
        req.on('end', resolve);
      });
      if (!chunks.length) return send(res, 400, { error: 'Пустое тело запроса' });

      const fname = Date.now() + '_' + safe;
      fs.writeFileSync(path.join(dir, fname), Buffer.concat(chunks));

      send(res, 200, { ok: true, path: '/uploads/zakaz/' + encodeURIComponent(fname), name: safe });
    } catch (e) {
      console.error('[orderRoutes.POST_UPLOAD_FILE] Error:', e.message);
      send(res, 400, { error: e.message });
    }
  },

  // ========================================================================
  // POST_GENERATE_ORDERS — массовое создание заказов по лучшим КП
  // ========================================================================

  async POST_GENERATE_ORDERS(req, res) {
    try {
      const d = await parseBody(req);
      const { god } = d;

      if (!god) {
        return send(res, 400, { error: 'Не указан год' });
      }

      // ✅ Используем buildQuery для позиций плана
      const plansSpec = {
          from: 'plan',
          alias: 'p',
          fields: ['p.*', field('kp', 'id_firma')],
          joins: [join('kp', 'p.id_kp = kp.id')],
          // ✅ ИСПРАВЛЕНО: включаем и дочерние позиции (is_child_plan = 1)
          where: `p.god = ? 
                  AND p.id_kp != '' 
                  AND p.id_kp IS NOT NULL
                  AND kp.reshenie = 'лучшее предложение' 
                  AND COALESCE(kp.isklyuchen, '') = ''`,
          params: [god]
      };
      const { sql: plansSql, params: plansParams, dependencies: plansDeps } = buildQuery(plansSpec);
      const plans = await db.all(plansSql, plansParams);

      // Группируем по фирма+год
      const groups = new Map();
      for (const plan of plans) {
        // ✅ T30/T31: отказные позиции («отказ фирмы»/«отказ УЭБ») не блокируют перерасчёт —
        // их КП исключены, план освобождён; строка осталась только как история отказа
        const inOrder = await db.get("SELECT id FROM poz_zakaz_dogovora WHERE id_plana = ? AND COALESCE(status_poz_zd, '') NOT IN ('отказ фирмы', 'отказ УЭБ')", [plan.id]);
        if (inOrder) continue;

        const key = `${plan.id_firma}|${plan.god}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(plan);
      }

      let createdOrders = 0;
      let createdPositions = 0;

      for (const [key, positions] of groups) {
        const [idFirma, targetYear] = key.split('|');

        const dogovor = await db.get(`
          SELECT * FROM dogovor
          WHERE id_firmy = ? AND strftime('%Y', data_dogovor) <= ?
          ORDER BY data_dogovor DESC LIMIT 1
        `, [idFirma, targetYear]);

        if (!dogovor) continue;

        const existingOrder = await db.get(`
          SELECT * FROM zakaz_po_dogovoru
          WHERE id_dogovora = ? AND (statys_zd = '' OR statys_zd IS NULL)
          ORDER BY nomer_zakaza DESC LIMIT 1
        `, [dogovor.id_dogovor]);

        let zakazId;
        if (existingOrder) {
          zakazId = existingOrder.id;
        } else {
          zakazId = generateId('ZD');
          const lastOrder = await db.get(`
            SELECT nomer_zakaza FROM zakaz_po_dogovoru
            WHERE id_dogovora = ? ORDER BY nomer_zakaza DESC LIMIT 1
          `, [dogovor.id_dogovor]);

          let nextNum = 1;
          if (lastOrder && lastOrder.nomer_zakaza) {
            const match = lastOrder.nomer_zakaza.match(/ЗД-\d+-(\d+)/);
            if (match) nextNum = parseInt(match[1]) + 1;
          }

          await db.run(`
            INSERT INTO zakaz_po_dogovoru (id, id_dogovora, nomer_zakaza, data_zakaza, statys_zd)
            VALUES (?,?,?,?,?)
          `, [
            zakazId, dogovor.id_dogovor,
            `ЗД-${targetYear}-${String(nextNum).padStart(3, '0')}`,
            sqlDate(), ''
          ]);

          createdOrders++;
        }

        for (const pos of positions) {
          const pozId = generateId('PZD');
          await db.run(`
            INSERT INTO poz_zakaz_dogovora (id, id_zakaza_po_dogovoru, id_plana, id_kp, status_poz_zd)
            VALUES (?,?,?,?,?)
          `, [pozId, zakazId, pos.id, (pos.id_kp && String(pos.id_kp).trim()) ? pos.id_kp : null, 'формирование списка поз. заказа']);

          createdPositions++;
        }
      }

      // ✅ Авто-уведомление по всем зависимостям (plansDeps теперь определён через buildQuery)
      const deps = new Set([
        ...getDependencies('orders.zakazy'),
        ...getDependencies('orders.positions'),
        ...getDependencies('orders.available'), 
        ...plansDeps
      ]);
     
// ✅ НОВОЕ: отправляем уведомления с задержкой, чтобы клиент успел обработать
wsManager.notifyWithDependencies(deps, 'batch_add', 'batch');

// ✅ НОВОЕ: дополнительное уведомление через 500мс для гарантии обновления
setTimeout(() => {
  wsManager.notifyWithDependencies(
    getDependencies('orders.available'),
    'update',
    'refresh'
  );
}, 500);

      send(res, 200, {
        ok: true, createdOrders, createdPositions,
        message: `Создано заказов: ${createdOrders}, позиций: ${createdPositions}`
      });
    } catch (e) {
      console.error('[orderRoutes.POST_GENERATE_ORDERS] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  }
});