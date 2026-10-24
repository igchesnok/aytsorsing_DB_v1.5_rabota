const { parseBody, send, generateId } = require('../utils');

// ============================================================
// РОУТЫ: ШАГИ И ОПЕРАЦИИ МАРШРУТА (шаблоны)
// Адаптировано под финальную схему БД:
//   - shagi_marshruta БЕЗ ids_oper (операции — дочерние строки
//     operatsii_marshruta с FK id_shag ON DELETE CASCADE);
//   - operatsii_marshruta БЕЗ stat_oper/дат (шаблон: только
//     id_oper, id_shag, naim_oper — статус и даты живут в
//     fakt_marshruta по связке партия × операция);
//   - шаг с 0 операций — валиден (факт только по transport_oper);
//   - при добавлении операции выполняется бэкфилл строк
//     fakt_marshruta ('ожидание') для уже существующих партий;
//   - ✅ v3 ЦЕЛОСТНОСТЬ: добавление операции в шаг, завершённый фактом
//     хотя бы у одной партии этой позиции, БЛОКИРУЕТСЯ (409) —
//     новая операция стала бы «последней» (rowid) и сделала бы
//     завершённые партии «не готовыми к отправке» задним числом;
//     операции в начатый шаг добавляются со страницы «Протокол
//     совещаний» (meetingRoutes.js, POST_OP с тем же guard'ом);
//   - удаление шаблонов с фактами и/или планами перевозок
//     блокируется с кодом 409 (FK без CASCADE);
//   - validateFk: ссылки проверяются на уровне приложения
//     (Манифест v2.0, FK-правило).
// ============================================================

module.exports = (db, wsManager) => ({
  // ===== ЗАГРУЗКА МАРШРУТА ДЕТАЛИ =====
  async GET_ROUTE(req, res, url) {
    const detId = url.searchParams.get('detId');
    if (!detId) return send(res, 400, { error: 'detId не указан' });

    try {
      const steps = await db.all(
        'SELECT * FROM shagi_marshruta WHERE id_det = ? ORDER BY nom_shag',
        [detId]
      );

      // Операции берём напрямую по FK id_shag (не по строке-списку):
      // порядок — по номеру шага, внутри шага — по порядку создания (rowid).
      const operations = await db.all(
        `SELECT o.id_oper, o.id_shag, o.naim_oper
           FROM operatsii_marshruta o
           JOIN shagi_marshruta s ON o.id_shag = s.id_shag
          WHERE s.id_det = ?
          ORDER BY s.nom_shag, o.rowid`,
        [detId]
      );

      send(res, 200, { steps, operations });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  },

  // ===== ДОБАВИТЬ ШАГ (с опциональной первой операцией) =====
  async POST_SHAG(req, res) {
    const d = await parseBody(req);
    if (!d.id_det || !d.nom_shag) {
      return send(res, 400, { error: 'id_det и nom_shag обязательны' });
    }
    if (!d.id_tipa_perevozki) {
      return send(res, 400, { error: 'id_tipa_perevozki обязателен' });
    }
    if (!d.exec_shag) {
      return send(res, 400, { error: 'exec_shag обязателен' });
    }

    const idShag = generateId('SHG');

    try {
      // validateFk: позиция плана и тип перевозки должны существовать
      const plan = await db.get('SELECT id FROM plan WHERE id = ?', [d.id_det]);
      if (!plan) return send(res, 400, { error: 'Позиция плана не найдена: ' + d.id_det });
      const tp = await db.get('SELECT id_tipa FROM transport_types WHERE id_tipa = ?', [d.id_tipa_perevozki]);
      if (!tp) return send(res, 400, { error: 'Тип перевозки не найден: ' + d.id_tipa_perevozki });

      await db.run(
        `INSERT INTO shagi_marshruta (id_shag, id_det, nom_shag, exec_shag, comm_shag, id_tipa_perevozki)
         VALUES (?,?,?,?,?,?)`,
        [idShag, d.id_det, d.nom_shag, d.exec_shag, d.comm_shag || '', d.id_tipa_perevozki]
      );

      // Первая операция опциональна: шаг только с перевозкой допустим
      // (факт по нему ведётся через transport_oper).
      let idOper = null;
      if (d.naim_oper) {
        idOper = await this._createOperation(idShag, d.naim_oper, d.id_det);
      }

      wsManager.notifyDataChange('shagi_marshruta', 'add', idShag);
      if (idOper) wsManager.notifyDataChange('operatsii_marshruta', 'add', idOper);
      send(res, 201, { id_shag: idShag, id_oper: idOper });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },

  // ===== ОБНОВИТЬ ШАГ =====
  // id_det и nom_shag не редактируются: привязка к детали неизменна,
  // нумерация меняется только через POST_SWAP.
  async PUT_SHAG(req, res) {
    const idShag = req.url.split('/')[3];
    if (!idShag) return send(res, 400, { error: 'ID шага не указан' });
    const d = await parseBody(req);

    try {
      const shag = await db.get('SELECT * FROM shagi_marshruta WHERE id_shag=?', [idShag]);
      if (!shag) return send(res, 404, { error: 'Шаг не найден' });

      if (d.id_tipa_perevozki) {
        const tp = await db.get('SELECT id_tipa FROM transport_types WHERE id_tipa = ?', [d.id_tipa_perevozki]);
        if (!tp) return send(res, 400, { error: 'Тип перевозки не найден: ' + d.id_tipa_perevozki });
      }

      await db.run(
        `UPDATE shagi_marshruta
            SET exec_shag=?, comm_shag=?, id_tipa_perevozki=?
          WHERE id_shag=?`,
        [
          d.exec_shag || shag.exec_shag,
          d.comm_shag || '',
          d.id_tipa_perevozki || shag.id_tipa_perevozki,
          idShag
        ]
      );
      wsManager.notifyDataChange('shagi_marshruta', 'update', idShag);
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },

  // ===== УДАЛИТЬ ШАГ =====
  async DELETE_SHAG(req, res) {
    const idShag = req.url.split('/')[3];
    if (!idShag) return send(res, 400, { error: 'ID шага не указан' });

    try {
      const shag = await db.get('SELECT * FROM shagi_marshruta WHERE id_shag=?', [idShag]);
      if (!shag) return send(res, 404, { error: 'Шаг не найден' });

      // Блокировка 1: этап используется в плане перевозок (FK без CASCADE)
      const usedInPlan = await db.get(
        'SELECT COUNT(*) AS n FROM plan_perevozok WHERE id_shag = ?',
        [idShag]
      );
      if (usedInPlan.n > 0) {
        return send(res, 409, {
          error: `Этап используется в плане перевозок (${usedInPlan.n} записей plan_perevozok). Сначала удалите связанные перевозки.`
        });
      }

      // Блокировка 2: по операциям этапа есть факты (FK fakt_marshruta → operatsii_marshruta без CASCADE)
      const facts = await db.get(
        `SELECT COUNT(*) AS n
           FROM fakt_marshruta fm
           JOIN operatsii_marshruta o ON fm.id_oper = o.id_oper
          WHERE o.id_shag = ?`,
        [idShag]
      );
      if (facts.n > 0) {
        return send(res, 409, {
          error: `По операциям этапа есть записи факта (${facts.n} в fakt_marshruta). Удаление невозможно.`
        });
      }

      // Операции удаляются каскадом (FK id_shag ON DELETE CASCADE)
      await db.run('DELETE FROM shagi_marshruta WHERE id_shag=?', [idShag]);
      wsManager.notifyDataChange('shagi_marshruta', 'delete', idShag);

      await this._renumberSteps(shag.id_det);
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },

  // ===== ДОБАВИТЬ ОПЕРАЦИЮ К ШАГУ =====
  async POST_OPER(req, res) {
    const d = await parseBody(req);
    if (!d.id_shag || !d.naim_oper) {
      return send(res, 400, { error: 'id_shag и naim_oper обязательны' });
    }

    try {
      const shag = await db.get('SELECT * FROM shagi_marshruta WHERE id_shag=?', [d.id_shag]);
      if (!shag) return send(res, 404, { error: 'Шаг не найден' });

      // ✅ v3 ЦЕЛОСТНОСТЬ: завершённые фактом партии этой позиции на этом шаге.
      // Доставка не проверяется: подтверждённый факт завершения — уже
      // завершённый шаг, независимо от того, вывезена партия или ждёт отправки.
      const completed = await db.all(`
        SELECT gp.id, t.nomer_reisa
          FROM gryz_poz gp
          JOIN plan_perevozok pp ON gp.id_plana = pp.id
          JOIN transport_oper t ON gp.id_transporta = t.id
         WHERE pp.id_plana = ? AND pp.id_shag = ?
           AND EXISTS (SELECT 1 FROM fakt_marshruta fm
                         JOIN operatsii_marshruta om2 ON om2.id_oper = fm.id_oper
                        WHERE fm.id_gryz_poz = gp.id AND om2.id_shag = pp.id_shag)
           AND COALESCE(TRIM((SELECT fm3.data_fakt_end FROM operatsii_marshruta om3
                    LEFT JOIN fakt_marshruta fm3
                      ON fm3.id_oper = om3.id_oper AND fm3.id_gryz_poz = gp.id
                    WHERE om3.id_shag = pp.id_shag
                    ORDER BY om3.rowid DESC LIMIT 1)), '') != ''
      `, [shag.id_det, shag.id_shag]);
      if (completed.length > 0) {
        return send(res, 409, {
          error: `Нельзя добавить операцию: шаг №${shag.nom_shag} уже завершён фактом ` +
                 `для ${completed.length} парт. этой позиции` +
                 (completed[0].nomer_reisa ? ` (например, партия из рейса «${completed[0].nomer_reisa}»)` : '') +
                 `. Новая операция стала бы последней в шаге и сделала бы эти партии ` +
                 `«не готовыми к отправке» задним числом. Добавляйте операции в начатый шаг ` +
                 `со страницы «Протокол совещаний».`
        });
      }

      const idOper = await this._createOperation(d.id_shag, d.naim_oper, shag.id_det);

      wsManager.notifyDataChange('operatsii_marshruta', 'add', idOper);
      wsManager.notifyDataChange('shagi_marshruta', 'update', d.id_shag);
      send(res, 201, { id_oper: idOper });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },

  // ===== ОБНОВИТЬ ОПЕРАЦИЮ =====
  // В шаблоне операции правится только наименование: статус и даты
  // принадлежат факту (fakt_marshruta) и редактируются там.
  async PUT_OPER(req, res) {
    const idOper = req.url.split('/')[3];
    if (!idOper) return send(res, 400, { error: 'ID операции не указан' });
    const d = await parseBody(req);

    try {
      const op = await db.get('SELECT * FROM operatsii_marshruta WHERE id_oper=?', [idOper]);
      if (!op) return send(res, 404, { error: 'Операция не найдена' });

      if (!d.naim_oper) return send(res, 400, { error: 'naim_oper обязателен' });

      // Переименование автоматически отражается на всех фактах через JOIN
      await db.run(
        'UPDATE operatsii_marshruta SET naim_oper=? WHERE id_oper=?',
        [d.naim_oper, idOper]
      );
      wsManager.notifyDataChange('operatsii_marshruta', 'update', idOper);
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },

  // ===== УДАЛИТЬ ОПЕРАЦИЮ =====
  async DELETE_OPER(req, res) {
    const idOper = req.url.split('/')[3];
    if (!idOper) return send(res, 400, { error: 'ID операции не указан' });

    try {
      const op = await db.get('SELECT * FROM operatsii_marshruta WHERE id_oper=?', [idOper]);
      if (!op) return send(res, 404, { error: 'Операция не найдена' });

      // FK fakt_marshruta → operatsii_marshruta без CASCADE:
      // операция с фактами удалению не подлежит
      const facts = await db.get(
        'SELECT COUNT(*) AS n FROM fakt_marshruta WHERE id_oper = ?',
        [idOper]
      );
      if (facts.n > 0) {
        return send(res, 409, {
          error: `По операции есть записи факта (${facts.n} в fakt_marshruta). Удаление невозможно.`
        });
      }

      await db.run('DELETE FROM operatsii_marshruta WHERE id_oper=?', [idOper]);
      wsManager.notifyDataChange('operatsii_marshruta', 'delete', idOper);

      // ⚠️ ВАЖНО: пустой шаг НЕ удаляем. Шаг с 0 операций валиден
      // (факт ведётся только по transport_oper), его тип перевозки
      // и исполнитель остаются частью маршрута.
      wsManager.notifyDataChange('shagi_marshruta', 'update', op.id_shag);
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },

  // ===== ПЕРЕМЕСТИТЬ ШАГ =====
  async POST_SWAP(req, res) {
    const d = await parseBody(req);
    if (!d.id_det || !d.id_shag1 || !d.id_shag2) {
      return send(res, 400, { error: 'id_det, id_shag1, id_shag2 обязательны' });
    }

    try {
      const shag1 = await db.get('SELECT nom_shag FROM shagi_marshruta WHERE id_shag=?', [d.id_shag1]);
      const shag2 = await db.get('SELECT nom_shag FROM shagi_marshruta WHERE id_shag=?', [d.id_shag2]);
      if (!shag1 || !shag2) return send(res, 404, { error: 'Шаги не найдены' });

      await db.run('UPDATE shagi_marshruta SET nom_shag=? WHERE id_shag=?', [shag2.nom_shag, d.id_shag1]);
      await db.run('UPDATE shagi_marshruta SET nom_shag=? WHERE id_shag=?', [shag1.nom_shag, d.id_shag2]);

      wsManager.notifyDataChange('shagi_marshruta', 'update', d.id_shag1);
      wsManager.notifyDataChange('shagi_marshruta', 'update', d.id_shag2);
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },

  // ===== ПОЗИЦИИ ПЛАНА БЕЗ МАРШРУТА =====
  // Список для кнопки массового создания маршрутов на route-editor.html
  async GET_MISSING(req, res) {
    try {
      const rows = await db.all(`
        SELECT p.id,
               o.nomer_chertezha,
               o.naimenovanie AS osn_naimenovanie
          FROM plan p
          JOIN osnastka o ON o.id = p.id_osnastka
         WHERE NOT EXISTS (SELECT 1 FROM shagi_marshruta s WHERE s.id_det = p.id)
         ORDER BY o.nomer_chertezha
      `);
      send(res, 200, rows);
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  },

  // ===== МАССОВОЕ СОЗДАНИЕ СТАНДАРТНЫХ МАРШРУТОВ =====
  // Для всех позиций плана, у которых ещё нет маршрута, создаётся
  // стандартная пара этапов аутсорсинга:
  //   Шаг 1: «Контрагент» (отправка) — ПТО отправляет контрагенту заготовку,
  //          тип перевозки OUT_BL «Отправка заготовки»,
  //          первая операция «Механическая обработка» (стандартная
  //          предустановленная категория операций из routeSteps.js);
  //   Шаг 2: «ПТО» (получение) — контрагент возвращает готовую деталь,
  //          тип перевозки IN_GOOD «Получение готовой продукции».
  // Типы перевозок и операцию можно переопределить в теле запроса
  // (tp_out_id / tp_in_id / oper_naim; oper_naim = '' → шаг без операции).
  // Всё выполняется в одной транзакции: либо созданы все маршруты,
  // либо ни одного.
  async POST_BULK_STANDARD(req, res) {
    const d = await parseBody(req);

    // Стандартные предустановленные значения (seed справочника transport_types)
    const tpOutId  = d.tp_out_id  || 'OUT_BL';
    const tpInId   = d.tp_in_id   || 'IN_GOOD';
    const operNaim = typeof d.oper_naim === 'string' ? d.oper_naim.trim() : 'Механическая обработка';

    try {
      // Валидация типа перевозки отправки: должен быть Исходящим
      // (учёт в остатке = 1), чтобы шаг проходил фильтр
      // «Контрагент (отправка)» на клиенте
      const tpOut = await db.get('SELECT * FROM transport_types WHERE id_tipa = ?', [tpOutId]);
      if (!tpOut) return send(res, 400, { error: 'Тип перевозки (отправка) не найден: ' + tpOutId });
      if (Number(tpOut.uchet_v_ostatke) !== 1) {
        return send(res, 400, {
          error: `Тип «${tpOut.nazvanie_operatsii}» не является исходящим (учёт в остатке = ${tpOut.uchet_v_ostatke}). Выберите тип с флагом «отправка».`
        });
      }

      // Валидация типа перевозки получения: должен быть Входящим (-1)
      const tpIn = await db.get('SELECT * FROM transport_types WHERE id_tipa = ?', [tpInId]);
      if (!tpIn) return send(res, 400, { error: 'Тип перевозки (получение) не найден: ' + tpInId });
      if (Number(tpIn.uchet_v_ostatke) !== -1) {
        return send(res, 400, {
          error: `Тип «${tpIn.nazvanie_operatsii}» не является входящим (учёт в остатке = ${tpIn.uchet_v_ostatke}). Выберите тип с флагом «получение».`
        });
      }

      // Позиции плана без единого этапа маршрута
      const positions = await db.all(`
        SELECT p.id
          FROM plan p
         WHERE NOT EXISTS (SELECT 1 FROM shagi_marshruta s WHERE s.id_det = p.id)
         ORDER BY p.id
      `);

      if (positions.length === 0) {
        return send(res, 200, {
          created: 0, operations: 0,
          message: 'Все позиции плана уже имеют маршрут движения'
        });
      }

      await db.run('BEGIN IMMEDIATE');
      try {
        let createdOps = 0;
        for (const pos of positions) {
          // Шаг 1: отправка заготовки контрагенту (ПТО → контрагент)
          const idShagOut = generateId('SHG');
          await db.run(
            `INSERT INTO shagi_marshruta (id_shag, id_det, nom_shag, exec_shag, comm_shag, id_tipa_perevozki)
             VALUES (?,?,?,?,?,?)`,
            [idShagOut, pos.id, 1, 'Контрагент', 'Отправка заготовки контрагенту', tpOutId]
          );

          // Стандартная операция механической обработки (создаётся через
          // единый helper: при наличии партий выполнит бэкфилл fakt_marshruta)
          if (operNaim) {
            await this._createOperation(idShagOut, operNaim, pos.id);
            createdOps++;
          }

          // Шаг 2: возврат готовой детали (контрагент → ПТО)
          const idShagIn = generateId('SHG');
          await db.run(
            `INSERT INTO shagi_marshruta (id_shag, id_det, nom_shag, exec_shag, comm_shag, id_tipa_perevozki)
             VALUES (?,?,?,?,?,?)`,
            [idShagIn, pos.id, 2, 'ПТО', 'Возврат готовой детали от контрагента', tpInId]
          );
        }
        await db.run('COMMIT');

        // Одиночное групповое уведомление вместо потока по каждой строке:
        // клиент перезагрузит открытый маршрут один раз
        wsManager.notifyDataChange('shagi_marshruta', 'batch_add', 'bulk');
        if (createdOps > 0) {
          wsManager.notifyDataChange('operatsii_marshruta', 'batch_add', 'bulk');
        }

        send(res, 200, {
          created: positions.length,
          operations: createdOps,
          tp_out: tpOut.nazvanie_operatsii,
          tp_in: tpIn.nazvanie_operatsii,
          oper: operNaim || null
        });
      } catch (txErr) {
        await db.run('ROLLBACK').catch(() => {});
        throw txErr;
      }
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },

  // ===== КОПИРОВАТЬ МАРШРУТ =====
  async POST_COPY(req, res) {
    const d = await parseBody(req);
    if (!d.source_det_id || !d.target_det_id) {
      return send(res, 400, { error: 'source_det_id и target_det_id обязательны' });
    }

    try {
      // Целевая деталь не должна иметь фактов и планов перевозок по своим этапам:
      // иначе старые шаги не удалить (FK без CASCADE)
      const targetFacts = await db.get(
        `SELECT COUNT(*) AS n
           FROM fakt_marshruta fm
           JOIN operatsii_marshruta o ON fm.id_oper = o.id_oper
           JOIN shagi_marshruta s ON o.id_shag = s.id_shag
          WHERE s.id_det = ?`,
        [d.target_det_id]
      );
      if (targetFacts.n > 0) {
        return send(res, 409, {
          error: `У целевой детали есть записи факта (${targetFacts.n} в fakt_marshruta). Копирование маршрута невозможно.`
        });
      }

      const targetPlans = await db.get(
        `SELECT COUNT(*) AS n
           FROM plan_perevozok pp
           JOIN shagi_marshruta s ON pp.id_shag = s.id_shag
          WHERE s.id_det = ?`,
        [d.target_det_id]
      );
      if (targetPlans.n > 0) {
        return send(res, 409, {
          error: `По этапам целевой детали есть план перевозок (${targetPlans.n} записей plan_perevozok). Копирование маршрута невозможно.`
        });
      }

      // Удаляем старый маршрут цели (операции — каскадом)
      await db.run('DELETE FROM shagi_marshruta WHERE id_det=?', [d.target_det_id]);

      // Источник: шаги + операции по FK (без строки-списка ids_oper)
      const sourceSteps = await db.all(
        'SELECT * FROM shagi_marshruta WHERE id_det=? ORDER BY nom_shag',
        [d.source_det_id]
      );
      const sourceOps = await db.all(
        `SELECT o.id_oper, o.id_shag, o.naim_oper
           FROM operatsii_marshruta o
           JOIN shagi_marshruta s ON o.id_shag = s.id_shag
          WHERE s.id_det = ?
          ORDER BY s.nom_shag, o.rowid`,
        [d.source_det_id]
      );

      // Копируем: шаг → его операции (связь через новый id_shag)
      const stepIdMap = new Map();
      for (const step of sourceSteps) {
        const newStepId = generateId('SHG');
        await db.run(
          `INSERT INTO shagi_marshruta (id_shag, id_det, nom_shag, exec_shag, comm_shag, id_tipa_perevozki) VALUES (?,?,?,?,?,?)`,
          [newStepId, d.target_det_id, step.nom_shag, step.exec_shag, step.comm_shag, step.id_tipa_perevozki]
        );
        stepIdMap.set(step.id_shag, newStepId);
      }

      let copiedOps = 0;
      for (const op of sourceOps) {
        const newStepId = stepIdMap.get(op.id_shag);
        if (!newStepId) continue;
        await db.run(
          'INSERT INTO operatsii_marshruta (id_oper, id_shag, naim_oper) VALUES (?,?,?)',
          [generateId('OPR'), newStepId, op.naim_oper]
        );
        copiedOps++;
      }

      wsManager.notifyDataChange('shagi_marshruta', 'copy', d.target_det_id);
      send(res, 200, { ok: true, copied_steps: sourceSteps.length, copied_operations: copiedOps });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },

  // ===== СОЗДАНИЕ ОПЕРАЦИИ + БЭКФИЛЛ ФАКТОВ =====
  // Новая операция шаблона автоматически получает строки fakt_marshruta
  // ('ожидание') для всех уже существующих партий детали — матрица
  // партия × операция остаётся полной. Для будущих партий строки
  // создаёт код создания gryz_poz.
  async _createOperation(idShag, naimOper, idDet) {
    const idOper = generateId('OPR');
    await db.run(
      'INSERT INTO operatsii_marshruta (id_oper, id_shag, naim_oper) VALUES (?,?,?)',
      [idOper, idShag, naimOper]
    );

    // Партии данной детали: gryz_poz → plan_perevozok → id_det
    const parties = await db.all(
      `SELECT gp.id
         FROM gryz_poz gp
         JOIN plan_perevozok pp ON gp.id_plana = pp.id
        WHERE pp.id_plana = ?`,
      [idDet]
    );

    let backfilled = 0;
    for (const p of parties) {
      // Защита от дублей: строка партия × операция может уже существовать
      const exists = await db.get(
        'SELECT id FROM fakt_marshruta WHERE id_gryz_poz = ? AND id_oper = ?',
        [p.id, idOper]
      );
      if (exists) continue;
      await db.run(
        `INSERT INTO fakt_marshruta (id, id_gryz_poz, id_oper, status_operatsii) VALUES (?,?,?, 'ожидание')`,
        [generateId('FMT'), p.id, idOper]
      );
      backfilled++;
    }

    if (backfilled > 0) {
      wsManager.notifyDataChange('fakt_marshruta', 'backfill', idDet);
    }
    return idOper;
  },

  async _renumberSteps(idDet) {
    const steps = await db.all(
      'SELECT id_shag FROM shagi_marshruta WHERE id_det=? ORDER BY nom_shag',
      [idDet]
    );
    for (let i = 0; i < steps.length; i++) {
      await db.run('UPDATE shagi_marshruta SET nom_shag=? WHERE id_shag=?', [i + 1, steps[i].id_shag]);
    }
  }
});