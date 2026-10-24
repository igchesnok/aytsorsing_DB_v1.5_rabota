const { parseBody, send, generateId } = require('../utils');

// ================================================================
// НОВАЯ СХЕМА: общие проверки для POST / POST_BULK / PUT
// - id_tipa_perevozki убран из plan_perevozok: тип перевозки определяется
//   шагом маршрута (shagi_marshruta.id_tipa_perevozki)
// - факт исполнения живёт в цепочке plan_perevozok -> gryz_poz (партия)
//   -> fakt_marshruta (операция по партии); строки факта создаются
//   автоматически при добавлении партии в рейс
// ================================================================

// Шаг маршрута + направление его типа перевозки
async function getShagWithType(db, idShag) {
  return db.get(`
    SELECT sm.id_shag, sm.id_det, sm.id_tipa_perevozki, tp.napravlenie
    FROM shagi_marshruta sm
    JOIN transport_types tp ON sm.id_tipa_perevozki = tp.id_tipa
    WHERE sm.id_shag = ?
  `, [idShag]);
}

// ================================================================
// НОВЫЙ АЛГОРИТМ ПРОДВИЖЕНИЯ ПО МАРШРУТУ (фактическое перемещение):
// физическое состояние позиции плана (сколько на ПТО, сколько у контрагента,
// какой шаг готов к перемещению) вычисляется ТОЛЬКО по факту —
// партиям gryz_poz, размещённым в рейсах transport_oper.
// Рейс доставлен: transport_oper.status = 'Выполнена' (канон статусов:
// Новая -> Ожидает отправки -> В пути -> Выполнена) либо заполнена pribytie_data.
// Если партии позиции нет в transport_oper/gryz_poz и есть КП — она на ПТО,
// готовая к 1-му шагу маршрута.
// Заявки plan_perevozok физику НЕ двигают — только резервируют количество.
// Шаг закрывается ТОЛЬКО доставкой (доставлено >= запланировано).
// Незавершёнка (запланировано/в пути без доставки) делает шаг АКТИВНЫМ
// с available = 0 (blockedStep) — заявки этого шага видны для загрузки
// партиями в рейсы, а следующий шаг не наступил.
// ГОТОВНОСТЬ К ОТПРАВКЕ (бизнес-правило) — доставка рейса НЕ равна готовности:
// - 1-й шаг (отправка заготовки с ПТО) доступен, только если в позиции плана
//   заполнена дата готовности заготовки (plan.data_yes_zagot);
// - следующий шаг доступен, когда шаг-поставщик ЗАВЕРШЁН на стороне получателя:
//   последняя (по порядку добавления) операция шага имеет фактическую дату
//   окончания в fakt_marshruta (data_fakt_end) для доставленной партии;
//   строки факта создаются автоматически при добавлении партии в рейс
//   (createFaktForPoz в transportOperRoutes.js);
// - шаг без операций или партия без строк факта (легаси-данные) —
//   готовность принимается по факту доставки рейса.
// v8 (пул по последней операции): готовое количество партии = ВЫПОЛНЕННОЕ
// КОЛИЧЕСТВО ПОСЛЕДНЕЙ операции шага (kolvo_vypolneno по rowid; NULL/легаси
// = полное количество партии) — только оно попадает в доступные перевозки;
// количества промежуточных операций пул не ограничивают.
// ВАЖНО: копия хелпера дублируется в planPerevozokRoutes.js и
// transportOperRoutes.js — при изменении алгоритма править в ОБОИХ.
// ================================================================
async function computePositionFlow(db, idPlana, planQty) {
  const steps = await db.all(`
    SELECT sm.id_shag, sm.nom_shag, tp.id_tipa, tp.nazvanie_operatsii, tp.napravlenie
    FROM shagi_marshruta sm
    JOIN transport_types tp ON sm.id_tipa_perevozki = tp.id_tipa
    WHERE sm.id_det = ?
    ORDER BY sm.nom_shag
  `, [idPlana]);

  // ФАКТ перемещения: партии позиции, размещённые в рейсах
  // (шаг известен через заявку: gryz_poz.id_plana -> plan_perevozok.id_shag)
  // + ГОТОВНОСТЬ партии к следующему шагу:
  //   ops_total        — сколько операций в шаге партии;
  //   fakt_cnt         — сколько строк факта (fakt_marshruta) заведено партии по шагу;
  //   last_op_fakt_end — фактическая дата окончания ПОСЛЕДНЕЙ операции шага
  //                      (по порядку добавления, rowid) для этой партии.
  const moves = await db.all(`
    SELECT ppr.id_shag,
           COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0) as qty,
           CASE WHEN t.status = 'Выполнена'
                  OR (t.pribytie_data IS NOT NULL AND TRIM(t.pribytie_data) != '')
                THEN 1 ELSE 0 END as delivered,
           (SELECT COUNT(*) FROM operatsii_marshruta om
             WHERE om.id_shag = ppr.id_shag) as ops_total,
           (SELECT COUNT(*) FROM fakt_marshruta fm
             JOIN operatsii_marshruta om2 ON om2.id_oper = fm.id_oper
             WHERE fm.id_gryz_poz = gp.id AND om2.id_shag = ppr.id_shag) as fakt_cnt,
           (SELECT fm3.data_fakt_end
             FROM operatsii_marshruta om3
             LEFT JOIN fakt_marshruta fm3
               ON fm3.id_oper = om3.id_oper AND fm3.id_gryz_poz = gp.id
             WHERE om3.id_shag = ppr.id_shag
             ORDER BY om3.rowid DESC LIMIT 1) as last_op_fakt_end,
           (SELECT fm5.kolvo_vypolneno
             FROM operatsii_marshruta om5
             LEFT JOIN fakt_marshruta fm5
               ON fm5.id_oper = om5.id_oper AND fm5.id_gryz_poz = gp.id
            WHERE om5.id_shag = ppr.id_shag
            ORDER BY om5.rowid DESC LIMIT 1) as done_qty
    FROM gryz_poz gp
    JOIN transport_oper t ON gp.id_transporta = t.id
    JOIN plan_perevozok ppr ON gp.id_plana = ppr.id
    WHERE ppr.id_plana = ?
  `, [idPlana]);

  // Резерв: заявки плана (в т.ч. без партий — рейс ещё не сформирован)
  const orders = await db.all(`
    SELECT id_shag,
           COALESCE(kolvo_no_br, 0) + COALESCE(kolvo_yes_br, 0) as qty
    FROM plan_perevozok
    WHERE id_plana = ?
  `, [idPlana]);

  // ГОТОВНОСТЬ ЗАГОТОВКИ на ПТО: дата готовности заготовки (plan.data_yes_zagot).
  // Не заполнена — отправлять нечего: первая Исходящая недоступна.
  const planExt = await db.get('SELECT data_yes_zagot FROM plan WHERE id = ?', [idPlana]);
  const zagotovkaReady = !!(planExt && planExt.data_yes_zagot && String(planExt.data_yes_zagot).trim() !== '');

  // Партия ГОТОВА к следующему шагу, когда: рейс доставлен И
  // (в шаге нет операций ИЛИ у партии ещё нет строк факта — легаси ИЛИ
  //  последняя операция шага закрыта фактом И выполненное количество
  //  последней операции довело партию до полного объёма — v9/v11;
  //  NULL-количество = полное количество партии, совместимость).
  const isReady = m => !!m.delivered && (
    m.ops_total === 0 ||
    (m.fakt_cnt || 0) === 0 ||
    (m.last_op_fakt_end != null && String(m.last_op_fakt_end).trim() !== '' &&
      ((parseFloat(m.done_qty != null ? m.done_qty : m.qty) || 0) >=
       (parseFloat(m.qty) || 0)))
  );

  let naPto = parseFloat(planQty) || 0;   // физически на ПТО
  let uKontr = 0;                          // физически у контрагента
  let readyPto = zagotovkaReady ? (parseFloat(planQty) || 0) : 0; // ГОТОВО к отправке с ПТО
  let readyKontr = 0;                      // ГОТОВО к отправке от контрагента
  let moved = false;                       // было ли первое перемещение партий
  let notReadyReason = null;               // причина, почему доступного количества нет

  // v9: ГОТОВОЕ количество по шагу — партия считается готовой только при
  // ПОЛНОМ выполненном количестве последней операции (>= количества
  // партии) и даёт в пул выполненное количество ПОСЛЕДНЕЙ операции шага
  // (kolvo_vypolneno последней по rowid; NULL/легаси = полное количество).
  // Частично выполненная партия остаётся «В работе» и в пул не попадает,
  // пока не доделана; количества промежуточных операций пул не ограничивают.
  const countReady = idShag => moves
    .filter(m => m.id_shag === idShag && isReady(m))
    .reduce((s, m) => s + (parseFloat(m.done_qty != null ? m.done_qty : m.qty) || 0), 0);

  for (const step of steps) {
    const reserved = orders
      .filter(r => r.id_shag === step.id_shag)
      .reduce((s, r) => s + (parseFloat(r.qty) || 0), 0);
    const delivered = moves
      .filter(m => m.id_shag === step.id_shag && m.delivered)
      .reduce((s, m) => s + (parseFloat(m.qty) || 0), 0);
    const ready = countReady(step.id_shag);

    // ГОТОВНОСТЬ != НАЛИЧИЕ: объясняем корневую причину отсутствия доступного
    if (!notReadyReason) {
      if (!moved && step.napravlenie === 'Исходящая' && !zagotovkaReady) {
        notReadyReason = 'Заготовка не готова к отправке: в позиции плана не заполнена дата готовности заготовки (data_yes_zagot)';
      } else if (ready < delivered) {
        notReadyReason = 'Партии доставлены, но шаг завершён не полностью на стороне получателя: не у всего количества закрыта дата факта последней операции (fakt_marshruta.data_fakt_end) и/или выполненное количество (kolvo_vypolneno) меньше количества партии';
      }
    }

    if (step.napravlenie === 'Исходящая') {
      // точка отправления — ПТО: доступно ГОТОВОЕ к отправке минус резерв заявками
      const available = readyPto - reserved;
      if (available > 0) {
        return { naPto, uKontr, readyPto, readyKontr, currentStep: step, available, blockedStep: null, notReadyReason: null };
      }
      if (delivered > 0) {
        naPto -= delivered;   // ФАКТ: доставлено контрагенту
        uKontr += delivered;
      }
      // ГОТОВО: с ПТО уходят ВСЕ доставленные (готовые и нет),
      // к контрагенту готовы только завершённые шагом партии
      readyPto -= Math.min(readyPto, delivered);
      readyKontr += ready;
      if (reserved - delivered > 0) {
        // запланировано/в пути, но доставки нет — шаг активен, но доступного нет
        return { naPto, uKontr, readyPto, readyKontr, currentStep: step, available: 0, blockedStep: step, notReadyReason };
      }
      moved = moved || delivered > 0 || ready > 0;
    } else {
      // точка отправления — контрагент
      const available = readyKontr - reserved;
      if (available > 0) {
        return { naPto, uKontr, readyPto, readyKontr, currentStep: step, available, blockedStep: null, notReadyReason: null };
      }
      if (delivered > 0) {
        uKontr -= delivered;  // ФАКТ: доставлено на ПТО
        naPto += delivered;
      }
      // ГОТОВО: от контрагента уходят ВСЕ доставленные, на ПТО возвращаются
      // готовые (завершённые шагом) партии
      readyKontr -= Math.min(readyKontr, delivered);
      readyPto += ready;
      if (reserved - delivered > 0) {
        return { naPto, uKontr, readyPto, readyKontr, currentStep: step, available: 0, blockedStep: step, notReadyReason };
      }
      moved = moved || delivered > 0 || ready > 0;
    }
  }
  return { naPto, uKontr, readyPto, readyKontr, currentStep: null, blockedStep: null, notReadyReason };
}

// Планировать можно только активный шаг позиции и в пределах
// физически доступного количества (работает для обоих направлений).
// Позиции без КП (подрядчика) не планируются вовсе.
async function checkStepReady(db, idPlana, idShag, requestedQty) {
  const planRow = await db.get('SELECT plan_god_kolvo, id_kp, is_no_kp_plan FROM plan WHERE id = ?', [idPlana]);
  if (!planRow) {
    return 'Позиция плана не найдена';
  }
  if (!planRow.id_kp || planRow.is_no_kp_plan === 1) {
    return 'Позиция плана не имеет КП (подрядчика) — перевозка не планируется';
  }
  const flow = await computePositionFlow(db, idPlana, planRow.plan_god_kolvo);
  if (!flow.currentStep) {
    if (flow.notReadyReason) return flow.notReadyReason;
    return 'Нет шага, готового к перемещению: проверьте маршрут позиции и выполненные рейсы';
  }
  if (flow.currentStep.id_shag !== idShag) {
    if (flow.notReadyReason) return flow.notReadyReason;
    return `Шаг не готов к перемещению: активный шаг позиции — №${flow.currentStep.nom_shag} (${flow.currentStep.nazvanie_operatsii}), доступно ${flow.available} шт.`;
  }
  if (requestedQty > flow.available) {
    if (flow.notReadyReason) return flow.notReadyReason;
    if (flow.blockedStep) {
      return `Шаг №${flow.blockedStep.nom_shag} (${flow.blockedStep.nazvanie_operatsii}) полностью запланирован, но не закрыт фактом доставки (нет выполненных рейсов) — доступно 0 шт.`;
    }
    return `Нельзя запланировать ${requestedQty} шт.: доступно только ${flow.available} шт.`;
  }
  return null;
}

// id_brak без FK (циклическая зависимость с braki) — валидация в роутах (требование схемы)
async function checkBrakExists(db, idBrak) {
  if (!idBrak) return null;
  const brak = await db.get('SELECT id_braka FROM braki WHERE id_braka = ?', [idBrak]);
  return brak ? null : `Брак ${idBrak} не найден`;
}

module.exports = (db, wsManager) => ({
  // ===== ПОЛУЧИТЬ ПЛАН ПЕРЕВОЗОК (с JOIN) =====
  async GET(req, res, url) {
    try {
      const direction = url.searchParams.get('direction');
      let query = `
        SELECT
          pp.*,
          sm.nom_shag,
          o.nomer_chertezha,
          o.naimenovanie as osn_naimenovanie,
          p.plan_god_kolvo,
          tp.nazvanie_operatsii as tip_perevozki_name,
          tp.napravlenie,
          tp.uchet_v_ostatke,
          d.nom_dogovor,
          f.naimenovanie as firma_name -- ✅ T95: фирма из КП (как в «доступных позициях»)
        FROM plan_perevozok pp
        LEFT JOIN plan p ON pp.id_plana = p.id
        LEFT JOIN osnastka o ON p.id_osnastka = o.id
        LEFT JOIN shagi_marshruta sm ON pp.id_shag = sm.id_shag
        LEFT JOIN transport_types tp ON sm.id_tipa_perevozki = tp.id_tipa
        LEFT JOIN kp k ON p.id_kp = k.id
        LEFT JOIN dogovor d ON k.id_dogovor = d.id_dogovor
        LEFT JOIN firmy f ON k.id_firma = f.id_firmy -- ✅ T95: фирма для колонки «Фирма»
      `;
      // ✅ T50: заявки, по которым уже созданы грузовые позиции (партии в
      // рейсах gryz_poz), на странице «План перевозок» НЕ показываются.
      // Количество таких заявок зафиксировано партиями (копия на момент
      // загрузки), а остаток перевозки считается как «заявка минус
      // загруженное» — правка количества заявки делала уже отвезённое
      // количество «доступным» для повторного включения. Заявка снова
      // становится видимой и редактируемой после удаления её партий из рейса
      // (вкладка «Грузовые места» Редактора транспортных операций).
      query += ` WHERE NOT EXISTS (SELECT 1 FROM gryz_poz gp WHERE gp.id_plana = pp.id)`;
      if (direction) {
        query += ` AND tp.napravlenie = ?`;
        const rows = await db.all(query, [direction]);
        send(res, 200, rows);
      } else {
        const rows = await db.all(query);
        send(res, 200, rows);
      }
    } catch (e) {
      console.error('[planPerevozokRoutes.GET]', e);
      send(res, 500, { error: e.message });
    }
  },

  // ===== ПОЛУЧИТЬ ДОСТУПНЫЕ ПОЗИЦИИ ДЛЯ ДОБАВЛЕНИЯ =====
  async GET_AVAILABLE(req, res, url) {
    try {
      const direction = url.searchParams.get('direction');
      if (!direction) {
        return send(res, 400, { error: 'direction обязателен' });
      }
      
      // ✅ ТОЛЬКО позиции плана, у которых есть КП (выбран подрядчик):
      // позиции-остатки без КП (is_no_kp_plan = 1) возить некому — не предлагаем.
      // ✅ ИСПРАВЛЕНО: позиции плана создаются БЕЗ КП с id_kp = '' (пустая
      // строка, планRoutes.POST: d.id_kp || ''), а не с NULL. Проверка
      // `id_kp IS NOT NULL` такие позиции ПРОПУСКАЛА — они попадали в список,
      // но при добавлении отклонялись checkStepReady («не имеет КП»).
      // Исключаем и NULL, и пустую/пробельную строку; is_no_kp_plan через
      // COALESCE — старые строки до появления колонки имеют NULL.
      const plans = await db.all(`
        SELECT
          p.id as plan_id,
          p.plan_god_kolvo,
          o.nomer_chertezha,
          o.naimenovanie as osn_naimenovanie,
          f.naimenovanie as firma_name,
          d.nom_dogovor
        FROM plan p
        LEFT JOIN osnastka o ON p.id_osnastka = o.id
        LEFT JOIN kp k ON p.id_kp = k.id
        LEFT JOIN firmy f ON k.id_firma = f.id_firmy
        LEFT JOIN dogovor d ON k.id_dogovor = d.id_dogovor
        WHERE p.plan_god_kolvo > 0
          AND TRIM(COALESCE(p.id_kp, '')) != ''
          AND COALESCE(p.is_no_kp_plan, 0) = 0
      `);

      const available = [];

      for (const plan of plans) {
        // ✅ Вычисляем физическое состояние позиции: сколько на ПТО, сколько
        // у контрагента и какой шаг готов к перемещению (computePositionFlow)
        const flow = await computePositionFlow(db, plan.plan_id, plan.plan_god_kolvo);

        // ✅ Показываем ТОЛЬКО текущий шаг запрошенного направления:
        // не наступившие шаги не предлагаются — количество не задваивается
        if (!flow.currentStep || flow.currentStep.napravlenie !== direction) continue;
        if (flow.available <= 0) continue;

        available.push({
          plan_id: plan.plan_id,
          id_shag: flow.currentStep.id_shag,
          nom_shag: flow.currentStep.nom_shag,
          id_tipa_perevozki: flow.currentStep.id_tipa,   // для клиентского фильтра по типу
          nomer_chertezha: plan.nomer_chertezha,
          osn_naimenovanie: plan.osn_naimenovanie,
          firma_name: plan.firma_name || '',
          tip_perevozki: flow.currentStep.nazvanie_operatsii,
          available_qty: flow.available,
          na_pto: flow.naPto,              // сейчас физически на ПТО
          u_kontragenta: flow.uKontr,      // сейчас физически у контрагента
          ready_pto: flow.readyPto,        // ГОТОВО к отправке с ПТО (data_yes_zagot / fakt)
          ready_kontragenta: flow.readyKontr, // ГОТОВО к отправке от контрагента (fakt)
          nom_dogovor: plan.nom_dogovor || ''
        });
      }
      
      send(res, 200, available);
    } catch (e) {
      console.error('[planPerevozokRoutes.GET_AVAILABLE]', e);
      send(res, 500, { error: e.message });
    }
  },

  // ===== ДОБАВИТЬ ПЛАН ПЕРЕВОЗКИ (с проверкой для входящих) =====
  async POST(req, res) {
    const d = await parseBody(req);
    if (!d.id_plana || !d.id_shag || !d.plan_data) {
      return send(res, 400, { error: 'Заполните обязательные поля' });
    }

    // НОВАЯ СХЕМА: поля id_tipa_perevozki в plan_perevozok больше нет —
    // тип перевозки определяется шагом маршрута (shagi_marshruta.id_tipa_perevozki)
    const shag = await getShagWithType(db, d.id_shag);
    if (!shag) {
      return send(res, 400, { error: 'Шаг маршрута не найден' });
    }
    if (shag.id_det !== d.id_plana) {
      return send(res, 400, { error: 'Шаг маршрута принадлежит другой позиции плана' });
    }

    // НОВАЯ СХЕМА: id_brak без FK (циклическая зависимость с braki) — валидация здесь
    const errBrak = await checkBrakExists(db, d.id_brak);
    if (errBrak) {
      return send(res, 400, { error: errBrak });
    }

    // ✅ БИЗНЕС-ЛОГИКА: планировать можно только шаг, готовый к перемещению,
    // и в пределах физически доступного количества (оба направления)
    const errFlow = await checkStepReady(
      db, d.id_plana, d.id_shag,
      (parseFloat(d.kolvo_no_br) || 0) + (parseFloat(d.kolvo_yes_br) || 0)
    );
    if (errFlow) {
      return send(res, 400, { error: errFlow });
    }
    
    const id = generateId('PP');
    try {
      await db.run(
        `INSERT INTO plan_perevozok
        (id, id_plana, id_brak, plan_data, id_shag, kolvo_no_br, kolvo_yes_br, statys, dog_osnov)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          id,
          d.id_plana,
          d.id_brak || null,
          d.plan_data,
          d.id_shag,
          parseFloat(d.kolvo_no_br) || 0,
          parseFloat(d.kolvo_yes_br) || 0,
          d.statys || '',
          d.dog_osnov || ''
        ]
      );
      wsManager.notifyDataChange('plan_perevozok', 'add', id);
      send(res, 201, { id });
    } catch (e) {
      console.error('[planPerevozokRoutes.POST]', e);
      send(res, 400, { error: e.message });
    }
  },

  // ===== ГРУППОВОЕ ДОБАВЛЕНИЕ (с проверкой для входящих) =====
  async POST_BULK(req, res) {
    const d = await parseBody(req);
    if (!d.items || !Array.isArray(d.items) || d.items.length === 0) {
      return send(res, 400, { error: 'Список позиций пуст' });
    }
    
    // НОВАЯ СХЕМА: каждая позиция — шаг существует, принадлежит позиции плана,
    // тип определяется шагом; для входящих — проверка доступности;
    // id_brak валидируем (FK нет)
    for (const item of d.items) {
      if (!item.id_plana || !item.id_shag || !item.plan_data) {
        return send(res, 400, { error: 'Каждая позиция требует id_plana, id_shag и plan_data' });
      }

      const shag = await getShagWithType(db, item.id_shag);
      if (!shag) {
        return send(res, 400, { error: `Шаг маршрута ${item.id_shag} не найден` });
      }
      if (shag.id_det !== item.id_plana) {
        return send(res, 400, { error: `Шаг ${item.id_shag} принадлежит другой позиции плана` });
      }

      const errBrak = await checkBrakExists(db, item.id_brak);
      if (errBrak) {
        return send(res, 400, { error: errBrak });
      }

      const errFlow = await checkStepReady(
        db, item.id_plana, item.id_shag,
        (parseFloat(item.kolvo_no_br) || 0) + (parseFloat(item.kolvo_yes_br) || 0)
      );
      if (errFlow) {
        return send(res, 400, { error: `Позиция ${item.id_plana}: ${errFlow}` });
      }
    }
    
    const addedIds = [];
    try {
      for (const item of d.items) {
        const id = generateId('PP');
        await db.run(
          `INSERT INTO plan_perevozok
          (id, id_plana, id_brak, plan_data, id_shag, kolvo_no_br, kolvo_yes_br, statys, dog_osnov)
          VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            id,
            item.id_plana,
            item.id_brak || null,
            item.plan_data,
            item.id_shag,
            parseFloat(item.kolvo_no_br) || 0,
            parseFloat(item.kolvo_yes_br) || 0,
            item.statys || '',
            item.dog_osnov || ''
          ]
        );
        addedIds.push(id);
      }
      wsManager.notifyDataChange('plan_perevozok', 'bulk_add', addedIds.join(','));
      send(res, 201, { ids: addedIds, count: addedIds.length });
    } catch (e) {
      console.error('[planPerevozokRoutes.POST_BULK]', e);
      send(res, 400, { error: e.message });
    }
  },

  // ===== ОБНОВИТЬ ПЛАН ПЕРЕВОЗКИ =====
  async PUT(req, res) {
    const id = req.url.split('/')[3];
    if (!id) return send(res, 400, { error: 'ID не указан' });
    const d = await parseBody(req);

    // НОВАЯ СХЕМА: тип перевозки хранится в шаге маршрута, а не в записи плана.
    // Проверяем шаг и его принадлежность позиции плана (если обе ссылки заданы).
    const shag = d.id_shag ? await getShagWithType(db, d.id_shag) : null;
    if (d.id_shag && !shag) {
      return send(res, 400, { error: 'Шаг маршрута не найден' });
    }
    if (shag && d.id_plana && shag.id_det !== d.id_plana) {
      return send(res, 400, { error: 'Шаг маршрута принадлежит другой позиции плана' });
    }

    // НОВАЯ СХЕМА: id_brak без FK — валидация здесь
    const errBrak = await checkBrakExists(db, d.id_brak);
    if (errBrak) {
      return send(res, 400, { error: errBrak });
    }

    // ✅ T50: заявка с грузовыми позициями (партиями в рейсах) защищена от
    // изменения количества и перепривязки (позиция плана/шаг маршрута):
    // у партий gryz_poz — своя копия количества на момент загрузки, фактическое
    // движение и остатки считаются по партиям, поэтому правка заявки делала бы
    // уже отвезённое количество «доступным» повторно. Разрешено менять только
    // план-дату, статус, дог. основание и брак. Чтобы править количество/шаг —
    // удалите партии заявки из рейса (вкладка «Грузовые места»).
    const usedPoz = await db.get('SELECT COUNT(*) as cnt FROM gryz_poz WHERE id_plana = ?', [id]);
    if (usedPoz && usedPoz.cnt > 0) {
      const cur = await db.get('SELECT id_plana, id_shag, kolvo_no_br, kolvo_yes_br FROM plan_perevozok WHERE id = ?', [id]);
      if (!cur) return send(res, 404, { error: 'Заявка не найдена' });
      const qtyDiff = (a, b) => Math.abs((parseFloat(a) || 0) - (parseFloat(b) || 0)) > 1e-9;
      const qtyChanged = qtyDiff(d.kolvo_no_br, cur.kolvo_no_br) || qtyDiff(d.kolvo_yes_br, cur.kolvo_yes_br);
      const refChanged = (d.id_plana != null && d.id_plana !== cur.id_plana) ||
                         (d.id_shag != null && d.id_shag !== cur.id_shag);
      if (qtyChanged || refChanged) {
        return send(res, 409, {
          error: `Нельзя изменить: по заявке уже создано ${usedPoz.cnt} грузовых позиций (партий) в рейсах — количество и шаг зафиксированы партиями. Сначала удалите их из рейса (вкладка «Грузовые места» Редактора транспортных операций).`
        });
      }
    }

    try {
      await db.run(
        `UPDATE plan_perevozok SET
        id_plana=?, id_brak=?, plan_data=?, id_shag=?,
        kolvo_no_br=?, kolvo_yes_br=?, statys=?, dog_osnov=?
        WHERE id=?`,
        [
          d.id_plana,
          d.id_brak || null,
          d.plan_data,
          d.id_shag,
          parseFloat(d.kolvo_no_br) || 0,
          parseFloat(d.kolvo_yes_br) || 0,
          d.statys || '',
          d.dog_osnov || '',
          id
        ]
      );
      wsManager.notifyDataChange('plan_perevozok', 'update', id);
      send(res, 200, { ok: true });
    } catch (e) {
      console.error('[planPerevozokRoutes.PUT]', e);
      send(res, 400, { error: e.message });
    }
  },

  // ===== УДАЛИТЬ ПЛАН ПЕРЕВОЗКИ =====
  async DELETE(req, res) {
    const id = req.url.split('/')[3];
    if (!id) return send(res, 400, { error: 'ID не указан' });

    // НОВАЯ СХЕМА: на заявку ссылаются партии gryz_poz (id_plana -> plan_perevozok),
    // а на партии — факт операций fakt_marshruta. FK без CASCADE, поэтому
    // запрещаем удаление заявки, по которой уже разложены партии по рейсам.
    const used = await db.get('SELECT COUNT(*) as cnt FROM gryz_poz WHERE id_plana = ?', [id]);
    if (used && used.cnt > 0) {
      return send(res, 409, {
        error: `Нельзя удалить: по заявке уже создано ${used.cnt} грузовых позиций (партий) в рейсах. Сначала удалите их.`
      });
    }

    try {
      await db.run('DELETE FROM plan_perevozok WHERE id=?', [id]);
      wsManager.notifyDataChange('plan_perevozok', 'delete', id);
      send(res, 200, { ok: true });
    } catch (e) {
      console.error('[planPerevozokRoutes.DELETE]', e);
      send(res, 400, { error: e.message });
    }
  }
});