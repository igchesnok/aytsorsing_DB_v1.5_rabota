// ============================================================
// src/routes/meetingRoutes.js
// API: ПРОТОКОЛ СОВЕЩАНИЙ (страница protokol-soveshchaniy.html)
// Интерфейс цеха/ОТК на стороне получателя: ведение плановых и
// фактических дат операций шага по каждой партии (fakt_marshruta),
// подтверждение факта завершения = продвижение партии по маршруту.
// Совещание ведётся с конкретной фирмой (режим «Фирма») либо
// с собственным производством (режим «ПТО»).
// ============================================================
// МОДЕЛЬ ГОТОВНОСТИ (синхронно с computePositionFlow v6 в
// planPerevozokRoutes.js / transportOperRoutes.js):
// партия привязана к рейсу шага k (gryz_poz -> plan_perevozok.id_shag);
// операции шага k выполняются на стороне ПРИБЫТИЯ (exec_shag шага);
// их завершение по факту открывает шаг k+1:
//   ГОТОВА к отправке = рейс доставлен И (шаг без операций ИЛИ
//   у партии нет строк факта [легаси] ИЛИ дата факта ПОСЛЕДНЕЙ
//   операции шага заполнена И выполненное количество последней
//   операции >= количества партии [v4; NULL = полное количество]).
// ПОСЛЕДНЯЯ операция шага = последняя по порядку добавления
// (operatsii_marshruta.rowid) — та же семантика, что в v6.
// ============================================================
// ДОБАВЛЕНИЕ ОПЕРАЦИЙ В НАЧАТЫЙ ШАГ (только с этой страницы):
// перед вставкой проверяется целостность — если для ХОТЯ БЫ ОДНОЙ
// партии этой позиции на этом шаге факт уже завершён (дата факта
// последней операции заполнена), добавление БЛОКИРУЕТСЯ (409):
// новая операция становится «последней» (rowid) и сделала бы
// завершённые партии «не готовыми к отправке» задним числом.
// Если завершённых партий нет — операция добавляется в конец шага,
// а всем активным партиям шага (у кого уже есть строки факта)
// создаются строки факта по новой операции (статус 'ожидание').
// Легаси-партии без строк факта не трогаются — их готовность
// по-прежнему определяется фактом доставки (v6-правило fakt_cnt=0).
// ============================================================

// ============================================================
// v2 (частичное выполнение): fakt_marshruta.kolvo_vypolneno — сколько шт.
// ИЗ ПАРТИИ сделано по операции (накопительно, правится на совещаниях).
// v3 (пул по последней операции): готовое к отправке количество партии
//   по шагу = ВЫПОЛНЕННОЕ КОЛИЧЕСТВО ПОСЛЕДНЕЙ операции шага (по rowid;
//   NULL/легаси = полное количество партии) при готовности isReady v6 —
//   только оно попадает в доступные перевозки (computePositionFlow v8 в
//   planPerevozokRoutes/transportOperRoutes); количества промежуточных
//   операций пул не ограничивают.
// v4 (ГОТОВНОСТЬ ПО КОЛИЧЕСТВУ): закрытый факт ПОСЛЕДНЕЙ операции готовит
//   партию к отправке только при выполненном количестве последней операции
//   >= количества партии (kolvo_vypolneno; NULL = полное количество —
//   совместимость со старыми данными). Частично выполненная партия
//   (например, 50 из 100) остаётся «В работе», пока не доделана.
//   Синхронно: batchStatus/batchReadiness здесь, isReady в
//   computePositionFlow (план v9 / транспорт v11), счётчик «в работе»
//   GET_FIRMS, guard COMPLETED_BATCHES («завершён» = факт + полный объём).
// PUT_FAKT: факт-даты не больше текущей даты; если количество шага уже
// включено в план перевозок (заявки на следующие шаги позиции) — запрещено
// уменьшать выполненное количество и снимать дату факта (409).
// ============================================================
const { parseBody, send, generateId } = require('../utils');

// ------------------------------------------------------------
// БАЗОВАЯ выборка партии с её шагом, позицией плана и прогрессом факта.
// Шаг партии — шаг её заявки (gryz_poz.id_plana -> plan_perevozok.id_shag).
// Операции шага выполняются на стороне прибытия (exec_shag шага).
// ------------------------------------------------------------
const BATCH_BASE_SQL = `
  SELECT gp.id AS gp_id,
         gp.kolvo_no_br, gp.kolvo_yes_br,
         COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0) AS qty,
         gp.created_at AS gp_created,
         t.id AS trip_id, t.nomer_reisa, t.pribytie_data, t.otgruzka_data,
         pp.id AS pp_id, pp.id_plana, pp.id_shag,
         sm.nom_shag, sm.exec_shag, sm.comm_shag,
         tp.nazvanie_operatsii, tp.napravlenie,
         p.id AS plan_id, p.plan_god_kolvo, p.data_yes_zagot,
         o.nomer_chertezha, o.naimenovanie AS osn_naimenovanie,
         f.naimenovanie AS firma_name,
         d.nom_dogovor,
         (SELECT COUNT(*) FROM operatsii_marshruta om
           WHERE om.id_shag = pp.id_shag) AS ops_total,
         (SELECT COUNT(*) FROM fakt_marshruta fm
           JOIN operatsii_marshruta om2 ON om2.id_oper = fm.id_oper
           WHERE fm.id_gryz_poz = gp.id AND om2.id_shag = pp.id_shag) AS fakt_cnt,
         (SELECT COUNT(*) FROM fakt_marshruta fmc
           JOIN operatsii_marshruta omc ON omc.id_oper = fmc.id_oper
           WHERE fmc.id_gryz_poz = gp.id AND omc.id_shag = pp.id_shag
             AND fmc.data_fakt_end IS NOT NULL
             AND TRIM(fmc.data_fakt_end) != '') AS closed_cnt,
         (CASE WHEN (SELECT COUNT(*) FROM operatsii_marshruta om
                      WHERE om.id_shag = pp.id_shag) = 0
                 OR (SELECT COUNT(*) FROM fakt_marshruta fm
                      JOIN operatsii_marshruta om2 ON om2.id_oper = fm.id_oper
                      WHERE fm.id_gryz_poz = gp.id AND om2.id_shag = pp.id_shag) = 0
                 OR (COALESCE(TRIM((SELECT fm3.data_fakt_end FROM operatsii_marshruta om3
                       LEFT JOIN fakt_marshruta fm3
                         ON fm3.id_oper = om3.id_oper AND fm3.id_gryz_poz = gp.id
                       WHERE om3.id_shag = pp.id_shag
                       ORDER BY om3.rowid DESC LIMIT 1)), '') != ''
                     AND COALESCE((SELECT fm5.kolvo_vypolneno
                         FROM operatsii_marshruta om5
                         LEFT JOIN fakt_marshruta fm5
                           ON fm5.id_oper = om5.id_oper AND fm5.id_gryz_poz = gp.id
                        WHERE om5.id_shag = pp.id_shag
                        ORDER BY om5.rowid DESC LIMIT 1),
                       COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0))
                     >= COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0))
              THEN COALESCE(
                (SELECT fm5.kolvo_vypolneno
                   FROM operatsii_marshruta om5
                   LEFT JOIN fakt_marshruta fm5
                     ON fm5.id_oper = om5.id_oper AND fm5.id_gryz_poz = gp.id
                  WHERE om5.id_shag = pp.id_shag
                  ORDER BY om5.rowid DESC LIMIT 1),
                COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0))
              ELSE 0 END) AS done_qty,
         (SELECT fm5.kolvo_vypolneno
            FROM operatsii_marshruta om5
            LEFT JOIN fakt_marshruta fm5
              ON fm5.id_oper = om5.id_oper AND fm5.id_gryz_poz = gp.id
           WHERE om5.id_shag = pp.id_shag
           ORDER BY om5.rowid DESC LIMIT 1) AS last_done,
         (SELECT fm3.data_fakt_end FROM operatsii_marshruta om3
           LEFT JOIN fakt_marshruta fm3
             ON fm3.id_oper = om3.id_oper AND fm3.id_gryz_poz = gp.id
           WHERE om3.id_shag = pp.id_shag
           ORDER BY om3.rowid DESC LIMIT 1) AS last_op_fakt_end
  FROM gryz_poz gp
  JOIN transport_oper t ON gp.id_transporta = t.id
  JOIN plan_perevozok pp ON gp.id_plana = pp.id
  JOIN shagi_marshruta sm ON pp.id_shag = sm.id_shag
  JOIN transport_types tp ON sm.id_tipa_perevozki = tp.id_tipa
  JOIN plan p ON pp.id_plana = p.id
  JOIN osnastka o ON p.id_osnastka = o.id
  LEFT JOIN kp k ON p.id_kp = k.id
  LEFT JOIN firmy f ON k.id_firma = f.id_firmy
  LEFT JOIN dogovor d ON k.id_dogovor = d.id_dogovor
  WHERE (t.status = 'Выполнена'
          OR (t.pribytie_data IS NOT NULL AND TRIM(t.pribytie_data) != ''))
`;
// ⚠️ BASE не фильтрует исполнителя: GET_POSITIONS добавляет sm.exec_shag = ?,
// GET_BATCH ищет партию без ограничения по режиму (карточка нужна и в «Фирме», и в «ПТО»).

// Партии позиции НА КОНКРЕТНОМ ШАГЕ, у которых уже есть строки факта
// (активное ведение факта) — им создаётся строка факта по новой операции
const ACTIVE_BATCHES_SQL = `
  SELECT DISTINCT gp.id AS gp_id
  FROM gryz_poz gp
  JOIN plan_perevozok pp ON gp.id_plana = pp.id
  WHERE pp.id_plana = ? AND pp.id_shag = ?
    AND EXISTS (SELECT 1 FROM fakt_marshruta fm
                  JOIN operatsii_marshruta om2 ON om2.id_oper = fm.id_oper
                  WHERE fm.id_gryz_poz = gp.id AND om2.id_shag = pp.id_shag)
`;

// ЦЕЛОСТНОСТЬ: партии позиции на шаге, у которых шаг уже завершён
// (v4: дата факта последней операции заполнена И выполненное количество
// довело партию до полного объёма; NULL = полное количество). Доставка не
// проверяется: подтверждённое завершение — уже закрытый шаг, независимо
// от того, вывезена партия или ждёт отправки. Частично выполненная партия
// (50 из 100) завершённой не считается — операции в такой шаг добавить
// можно (её ещё доделывают).
const COMPLETED_BATCHES_SQL = `
  SELECT gp.id AS gp_id, gp.kolvo_no_br, gp.kolvo_yes_br, t.nomer_reisa,
         (SELECT fm3.data_fakt_end FROM operatsii_marshruta om3
           LEFT JOIN fakt_marshruta fm3
             ON fm3.id_oper = om3.id_oper AND fm3.id_gryz_poz = gp.id
           WHERE om3.id_shag = pp.id_shag
           ORDER BY om3.rowid DESC LIMIT 1) AS last_op_fakt_end
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
    AND COALESCE((SELECT fm5.kolvo_vypolneno
           FROM operatsii_marshruta om5
           LEFT JOIN fakt_marshruta fm5
             ON fm5.id_oper = om5.id_oper AND fm5.id_gryz_poz = gp.id
           WHERE om5.id_shag = pp.id_shag
           ORDER BY om5.rowid DESC LIMIT 1),
          COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0))
          >= COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0)
`;

// ------------------------------------------------------------
// Статус партии на шаге (точно по формуле isReady v6)
// ------------------------------------------------------------
function batchStatus(r) {
  const ops = r.ops_total || 0;
  const fakt = r.fakt_cnt || 0;
  const lastFilled = r.last_op_fakt_end != null &&
    String(r.last_op_fakt_end).trim() !== '';
  // легаси: операции есть, строк факта нет — готовность по доставке
  const legacy = ops > 0 && fakt === 0;
  // v4 ГОТОВНОСТЬ ПО КОЛИЧЕСТВУ: закрытый факт последней операции готовит
  // партию только при выполненном количестве последней операции >= объёма
  // партии; NULL-количество = учёт не ведётся (полное количество,
  // совместимость со старыми данными). 50 из 100 — партия ещё в работе.
  const qty = Number(r.qty) || 0;
  const lastDone = (r.last_done != null && r.last_done !== '')
    ? (parseFloat(r.last_done) || 0)
    : qty;
  if (ops === 0 || fakt === 0 || (lastFilled && lastDone >= qty)) {
    return { status: 'Готова к отправке', legacy };
  }
  return { status: 'В работе', legacy };
}

const normStr = v => (v == null ? '' : String(v).trim());

// ------------------------------------------------------------
// Гарантия полного покрытия партии строками факта по шагу:
// для каждой операции шага без строки факта этой партии
// создаётся строка ('ожидание'). Идемпотентно. Нужно:
// - для легаси-партий при первом сохранении с этой страницы;
// - если операции добавлялись в шаг вне страницы совещаний.
// ------------------------------------------------------------
async function ensureFaktCoverage(db, gpId, shagId) {
  const ops = await db.all(
    'SELECT id_oper FROM operatsii_marshruta WHERE id_shag = ? ORDER BY rowid',
    [shagId]
  );
  let created = 0;
  for (const op of ops) {
    const exists = await db.get(
      'SELECT id FROM fakt_marshruta WHERE id_gryz_poz = ? AND id_oper = ?',
      [gpId, op.id_oper]
    );
    if (!exists) {
      await db.run(
        `INSERT INTO fakt_marshruta (id, id_gryz_poz, id_oper, status_operatsii)
         VALUES (?, ?, ?, 'ожидание')`,
        [generateId('FM'), gpId, op.id_oper]
      );
      created++;
    }
  }
  return created;
}

// Повторный расчёт готовности партии после сохранения (для ответа клиенту).
// done_qty — сколько шт. партии ГОТОВО к отправке по этому шагу (v4):
//   партия готова (факт последней операции + полное выполненное
//   количество) -> выполненное количество ПОСЛЕДНЕЙ операции шага
//   (по rowid; NULL = полное количество партии);
//   не готова (в т.ч. частично выполненная) -> 0;
//   легаси / шаг без операций -> полное количество партии.
async function batchReadiness(db, gpId, shagId) {
  const r = await db.get(`
    SELECT
      (SELECT COUNT(*) FROM operatsii_marshruta om
        WHERE om.id_shag = ?) AS ops_total,
      (SELECT COUNT(*) FROM fakt_marshruta fm
        JOIN operatsii_marshruta om2 ON om2.id_oper = fm.id_oper
        WHERE fm.id_gryz_poz = ? AND om2.id_shag = ?) AS fakt_cnt,
      (SELECT fm3.data_fakt_end FROM operatsii_marshruta om3
        LEFT JOIN fakt_marshruta fm3
          ON fm3.id_oper = om3.id_oper AND fm3.id_gryz_poz = ?
        WHERE om3.id_shag = ?
        ORDER BY om3.rowid DESC LIMIT 1) AS last_op_fakt_end,
      (SELECT COALESCE(g2.kolvo_no_br, 0) + COALESCE(g2.kolvo_yes_br, 0)
         FROM gryz_poz g2 WHERE g2.id = ?) AS qty,
      (SELECT fm5.kolvo_vypolneno
         FROM operatsii_marshruta om5
         LEFT JOIN fakt_marshruta fm5
           ON fm5.id_oper = om5.id_oper AND fm5.id_gryz_poz = ?
        WHERE om5.id_shag = ?
        ORDER BY om5.rowid DESC LIMIT 1) AS last_done
  `, [shagId, gpId, shagId, gpId, shagId, gpId, gpId, shagId]);
  const st = batchStatus(r || {});
  const qty = r?.qty || 0;
  const doneQty = st.status === 'Готова к отправке'
    ? ((r?.last_done != null) ? r.last_done : qty)
    : 0;
  return {
    ops_total: r?.ops_total || 0,
    fakt_cnt: r?.fakt_cnt || 0,
    last_op_fakt_end: r?.last_op_fakt_end || null,
    qty,
    done_qty: doneQty,
    status: st.status,
    legacy: st.legacy
  };
}

function toBatchDto(r) {
  const st = batchStatus(r);
  return {
    gp_id: r.gp_id,
    trip_id: r.trip_id,
    pp_id: r.pp_id,
    plan_id: r.plan_id,
    id_shag: r.id_shag,
    nomer_chertezha: r.nomer_chertezha,
    osn_naimenovanie: r.osn_naimenovanie,
    firma_name: r.firma_name || '',
    nom_dogovor: r.nom_dogovor || '',
    nom_shag: r.nom_shag,
    exec_shag: r.exec_shag,
    comm_shag: r.comm_shag || '',
    tip_perevozki: r.nazvanie_operatsii,
    napravlenie: r.napravlenie,
    nomer_reisa: r.nomer_reisa || '',
    pribytie_data: r.pribytie_data || '',
    otgruzka_data: r.otgruzka_data || '',
    qty: r.qty || 0,
    done_qty: r.done_qty || 0,
    last_done: (r.last_done != null && r.last_done !== '') ? Number(r.last_done) : null,
    kolvo_no_br: r.kolvo_no_br || 0,
    kolvo_yes_br: r.kolvo_yes_br || 0,
    plan_god_kolvo: r.plan_god_kolvo,
    data_yes_zagot: r.data_yes_zagot,
    ops_total: r.ops_total || 0,
    fakt_cnt: r.fakt_cnt || 0,
    closed_cnt: r.closed_cnt || 0,
    last_op_fakt_end: r.last_op_fakt_end || null,
    status: st.status,
    legacy: st.legacy
  };
}

module.exports = (db, wsManager) => ({

  // ========================================================================
  // GET_FIRMS — справочник фирм для режима «Совещание с фирмой»
  // (+ количество партий в работе у каждой — для выбора на совещании)
  // ========================================================================
  async GET_FIRMS(req, res) {
    try {
      const rows = await db.all(`
        SELECT f.id_firmy, f.naimenovanie,
          (SELECT COUNT(*) FROM gryz_poz gp
            JOIN transport_oper t ON gp.id_transporta = t.id
            JOIN plan_perevozok pp ON gp.id_plana = pp.id
            JOIN shagi_marshruta sm ON pp.id_shag = sm.id_shag
            JOIN plan p ON pp.id_plana = p.id
            LEFT JOIN kp k ON p.id_kp = k.id
            WHERE k.id_firma = f.id_firmy
              AND sm.exec_shag = 'Контрагент'
              AND (t.status = 'Выполнена'
                    OR (t.pribytie_data IS NOT NULL AND TRIM(t.pribytie_data) != ''))
              AND (SELECT COUNT(*) FROM operatsii_marshruta om
                    WHERE om.id_shag = pp.id_shag) > 0
              AND EXISTS (SELECT 1 FROM fakt_marshruta fm
                            JOIN operatsii_marshruta om2 ON om2.id_oper = fm.id_oper
                            WHERE fm.id_gryz_poz = gp.id AND om2.id_shag = pp.id_shag)
              AND (COALESCE(TRIM((SELECT fm3.data_fakt_end FROM operatsii_marshruta om3
                    LEFT JOIN fakt_marshruta fm3
                      ON fm3.id_oper = om3.id_oper AND fm3.id_gryz_poz = gp.id
                    WHERE om3.id_shag = pp.id_shag
                    ORDER BY om3.rowid DESC LIMIT 1)), '') = ''
                   OR COALESCE((SELECT fm5.kolvo_vypolneno
                      FROM operatsii_marshruta om5
                      LEFT JOIN fakt_marshruta fm5
                        ON fm5.id_oper = om5.id_oper AND fm5.id_gryz_poz = gp.id
                       WHERE om5.id_shag = pp.id_shag
                       ORDER BY om5.rowid DESC LIMIT 1),
                      COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0))
                      < COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0))
          ) AS cnt_v_rabote
        FROM firmy f
        ORDER BY f.naimenovanie
      `);
      send(res, 200, rows);
    } catch (e) {
      console.error('[meetingRoutes.GET_FIRMS]', e);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // GET_POSITIONS — перечень партий у исполнителя в работе.
  //   mode=firm (по умолчанию): партии на шагах «Контрагент» выбранной
  //                             фирмы (КП позиции плана), обязателен id_firma;
  //   mode=pto:                 партии на шагах «ПТО» (наше производство).
  //   status=work|ready — необязательный фильтр статуса партии.
  // Показываются ТОЛЬКО доставленные партии (рейс «Выполнена» либо
  // заполнена дата прибытия) — работать можно только с тем, что приехало.
  // ========================================================================
  async GET_POSITIONS(req, res, url) {
    try {
      const mode = url.searchParams.get('mode') === 'pto' ? 'pto' : 'firm';
      const idFirma = url.searchParams.get('id_firma');
      const statusFilter = url.searchParams.get('status') || '';

      if (mode === 'firm' && !idFirma) {
        return send(res, 400, { error: 'Для режима «Фирма» выберите фирму (id_firma)' });
      }

      const sql = mode === 'pto'
        ? BATCH_BASE_SQL + ' AND sm.exec_shag = ?'
        : BATCH_BASE_SQL + ' AND sm.exec_shag = ? AND f.id_firmy = ?';
      const params = mode === 'pto' ? ['ПТО'] : ['Контрагент', idFirma];

      const rows = await db.all(sql, params);

      const result = rows
        .map(toBatchDto)
        .filter(r => !statusFilter ||
          r.status === (statusFilter === 'work' ? 'В работе' : 'Готова к отправке'))
        .sort((a, b) =>
          String(a.nomer_chertezha || '').localeCompare(String(b.nomer_chertezha || ''), 'ru') ||
          (a.nom_shag - b.nom_shag) ||
          String(a.pribytie_data || '').localeCompare(String(b.pribytie_data || '')) ||
          String(a.nomer_reisa || '').localeCompare(String(b.nomer_reisa || ''), 'ru')
        );

      send(res, 200, result);
    } catch (e) {
      console.error('[meetingRoutes.GET_POSITIONS]', e);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // GET_BATCH — карточка партии для формы совещания:
  //   ?id_gryz_poz=... -> { batch, ops, sled_reys_count }
  // ops — операции шага партии (по rowid) со строками факта (LEFT JOIN:
  // у легаси-партий строк факта ещё нет — fm_id пуст).
  // sled_reys_count — сколько следующих шагов позиции уже имеют партии
  // в рейсах (признак «по этой партии уже сформирован следующий рейс»).
  // ========================================================================
  async GET_BATCH(req, res, url) {
    try {
      const gpId = url.searchParams.get('id_gryz_poz');
      if (!gpId) return send(res, 400, { error: 'id_gryz_poz не указан' });

      const rows = await db.all(BATCH_BASE_SQL + ' AND gp.id = ?', [gpId]);
      const batch = rows[0];
      if (!batch) {
        return send(res, 404, {
          error: 'Партия не найдена среди доставленных (рейс ещё не доставлен или партия удалена)'
        });
      }

      const ops = await db.all(`
        SELECT om.id_oper, om.naim_oper, om.rowid AS om_rowid,
               fm.id AS fm_id,
               fm.data_plan_start, fm.data_plan_end,
               fm.data_fakt_start, fm.data_fakt_end,
               fm.status_operatsii, fm.kommentariy, fm.kolvo_vypolneno
        FROM operatsii_marshruta om
        LEFT JOIN fakt_marshruta fm
          ON fm.id_oper = om.id_oper AND fm.id_gryz_poz = ?
        WHERE om.id_shag = ?
        ORDER BY om.rowid
      `, [gpId, batch.id_shag]);

      const sled = await db.get(`
        SELECT COUNT(*) AS n
        FROM plan_perevozok pp2
        JOIN shagi_marshruta sm2 ON sm2.id_shag = pp2.id_shag
        WHERE pp2.id_plana = ? AND sm2.nom_shag > ?
          AND EXISTS (SELECT 1 FROM gryz_poz g2 WHERE g2.id_plana = pp2.id)
      `, [batch.plan_id, batch.nom_shag]);

      send(res, 200, {
        batch: toBatchDto(batch),
        ops,
        sled_reys_count: sled?.n || 0
      });
    } catch (e) {
      console.error('[meetingRoutes.GET_BATCH]', e);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // PUT_FAKT — сохранить одну строку факта операции (форма совещания).
  //   PUT /api/meeting/fakt
  //   { id_gryz_poz, id_oper, data_plan_start, data_plan_end,
  //     data_fakt_start, data_fakt_end, kommentariy, kolvo_vypolneno }
  // kolvo_vypolneno (v2) — частичное (накопительное) выполнение: сколько шт.
  // из партии сделано; пусто/NULL — не ведётся (учёт по полному количеству).
  // Строка факта ищется по (партия × операция); если её нет (легаси
  // или операция добавлена позже) — покрытие дозаводится целиком по
  // шагу (ensureFaktCoverage), затем строка обновляется.
  // status_operatsii — вычисляемый при сохранении:
  //   data_fakt_end -> 'выполнена'; data_fakt_start -> 'в работе'; иначе 'ожидание'.
  // Факт окончания ПОСЛЕДНЕЙ операции шага + выполненное количество не
  // меньше объёма партии = партия готова к отправке (v4; NULL-количество =
  // полное количество — совместимость). В ответе возвращается
  // пересчитанный статус партии.
  // ========================================================================
  async PUT_FAKT(req, res) {
    try {
      const d = await parseBody(req);
      if (!d.id_gryz_poz || !d.id_oper) {
        return send(res, 400, { error: 'id_gryz_poz и id_oper обязательны' });
      }

      const ctx = await db.get(`
        SELECT gp.id AS gp_id, pp.id AS pp_id, pp.id_shag, pp.id_plana,
               sm.nom_shag, sm.exec_shag,
               COALESCE(gp.kolvo_no_br, 0) + COALESCE(gp.kolvo_yes_br, 0) AS qty
        FROM gryz_poz gp
        JOIN plan_perevozok pp ON gp.id_plana = pp.id
        JOIN shagi_marshruta sm ON pp.id_shag = sm.id_shag
        WHERE gp.id = ?
      `, [d.id_gryz_poz]);
      if (!ctx) return send(res, 400, { error: 'Партия не найдена' });

      const op = await db.get(
        'SELECT id_oper, id_shag, naim_oper FROM operatsii_marshruta WHERE id_oper = ?',
        [d.id_oper]
      );
      if (!op) return send(res, 400, { error: 'Операция не найдена' });
      if (op.id_shag !== ctx.id_shag) {
        return send(res, 400, { error: 'Операция не принадлежит шагу партии' });
      }

      // Даты: план-окончание не раньше план-начала,
      // факт-окончание не раньше факт-начала
      const pS = normStr(d.data_plan_start), pE = normStr(d.data_plan_end);
      const fS = normStr(d.data_fakt_start), fE = normStr(d.data_fakt_end);
      if (pS && pE && pE < pS) {
        return send(res, 400, { error: 'Плановая дата окончания раньше плановой даты начала' });
      }
      if (fS && fE && fE < fS) {
        return send(res, 400, { error: 'Фактическая дата окончания раньше фактической даты начала' });
      }

      // v2 ЧАСТИЧНОЕ ВЫПОЛНЕНИЕ: количество выполненных шт. по операции
      // (пусто — не ведётся, учёт готовности по полному количеству партии)
      let kolvo = null;
      if (d.kolvo_vypolneno !== undefined && d.kolvo_vypolneno !== null &&
          String(d.kolvo_vypolneno).trim() !== '') {
        kolvo = Number(String(d.kolvo_vypolneno).replace(',', '.'));
        if (!isFinite(kolvo) || kolvo <= 0) {
          return send(res, 400, { error: 'Количество выполненных должно быть положительным числом' });
        }
        if (kolvo > (ctx.qty || 0)) {
          return send(res, 400, { error:
            `Количество выполненных (${kolvo}) не может превышать количество в партии (${ctx.qty} шт.)` });
        }
      }

      // v2 ФАКТ НЕ МОЖЕТ БЫТЬ В БУДУЩЕМ: дата фактического выполнения
      // (и факт-начала) не больше текущей даты
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (fS && fS > todayStr) {
        return send(res, 400, { error:
          `Фактическая дата начала (${fS}) не может быть больше текущей даты (${todayStr})` });
      }
      if (fE && fE > todayStr) {
        return send(res, 400, { error:
          `Фактическая дата выполнения (${fE}) не может быть больше текущей даты (${todayStr})` });
      }

      // v2 ЦЕЛОСТНОСТЬ: если количество этого шага уже включено в план
      // перевозок (есть заявки на СЛЕДУЮЩИЕ шаги позиции), задним числом
      // нельзя уменьшать выполненное количество и снимать дату факта —
      // партия стала бы «не готовой к отправке» и учёт запланированных
      // перевозок сломался бы
      const usedRow = await db.get(`
        SELECT COALESCE(SUM(COALESCE(pp2.kolvo_no_br, 0) + COALESCE(pp2.kolvo_yes_br, 0)), 0) AS used
        FROM plan_perevozok pp2
        JOIN shagi_marshruta sm2 ON sm2.id_shag = pp2.id_shag
        WHERE pp2.id_plana = ? AND sm2.nom_shag > ?
      `, [ctx.id_plana, ctx.nom_shag]);
      const usedQty = usedRow?.used || 0;
      if (usedQty > 0) {
        const oldRow = await db.get(
          'SELECT data_fakt_end, kolvo_vypolneno FROM fakt_marshruta WHERE id_gryz_poz = ? AND id_oper = ?',
          [ctx.gp_id, d.id_oper]
        );
        const oldEnd = oldRow && oldRow.data_fakt_end != null ? String(oldRow.data_fakt_end).trim() : '';
        if (oldEnd !== '' && !fE) {
          return send(res, 409, { error:
            `Нельзя удалить дату фактического выполнения: количество этого шага уже включено в план перевозок ` +
            `(${usedQty} шт. заявками на следующие шаги). Снятие факта сделало бы партию ` +
            `«не готовой к отправке» и сломало учёт уже запланированных перевозок.` });
        }
        const oldKolvo = oldRow && oldRow.kolvo_vypolneno != null ? Number(oldRow.kolvo_vypolneno) : null;
        if (oldKolvo != null && kolvo != null && kolvo < oldKolvo) {
          return send(res, 409, { error:
            `Нельзя уменьшать выполненное количество (${oldKolvo} -> ${kolvo}): количество этого шага ` +
            `уже включено в план перевозок (${usedQty} шт. заявками на следующие шаги). ` +
            `Уменьшение сделало бы готовым меньше, чем уже запланировано.` });
        }
      }

      const status = fE ? 'выполнена' : (fS ? 'в работе' : 'ожидание');
      const komment = normStr(d.kommentariy);

      let fm = await db.get(
        'SELECT id FROM fakt_marshruta WHERE id_gryz_poz = ? AND id_oper = ?',
        [ctx.gp_id, d.id_oper]
      );

      let createdCoverage = 0;
      if (!fm) {
        // легаси/дозаведение: сначала полное покрытие шага строками факта,
        // затем точечное обновление целевой строки
        createdCoverage = await ensureFaktCoverage(db, ctx.gp_id, ctx.id_shag);
        fm = await db.get(
          'SELECT id FROM fakt_marshruta WHERE id_gryz_poz = ? AND id_oper = ?',
          [ctx.gp_id, d.id_oper]
        );
        if (!fm) return send(res, 500, { error: 'Не удалось создать строку факта' });
      }

      await db.run(`
        UPDATE fakt_marshruta SET
          data_plan_start = ?, data_plan_end = ?,
          data_fakt_start = ?, data_fakt_end = ?,
          status_operatsii = ?, kommentariy = ?, kolvo_vypolneno = ?
        WHERE id = ?
      `, [pS || null, pE || null, fS || null, fE || null, status, komment, kolvo, fm.id]);

      wsManager.notifyDataChange('fakt_marshruta', 'update', fm.id);

      const readiness = await batchReadiness(db, ctx.gp_id, ctx.id_shag);
      send(res, 200, {
        ok: true,
        id: fm.id,
        status_operatsii: status,
        kolvo_vypolneno: kolvo,
        created_coverage: createdCoverage,
        readiness
      });
    } catch (e) {
      console.error('[meetingRoutes.PUT_FAKT]', e);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // POST_OP — добавить операцию в уже начатый шаг (ТОЛЬКО со страницы
  // совещаний).   POST /api/meeting/op   { id_shag, naim_oper }
  // ЦЕЛОСТНОСТЬ: если у любой партии этой позиции на этом шаге факт
  // уже завершён (дата факта последней операции заполнена) — 409,
  // добавление блокируется: новая операция становится «последней»
  // (rowid) и задним числом сделала бы эти партии неготовыми.
  // Если завершённых нет — операция добавляется в конец шага, активным
  // партиям шага (с существующими строками факта) создаются строки
  // факта по новой операции. Легаси-партии (без строк факта) не
  // затрагиваются.
  // ========================================================================
  async POST_OP(req, res) {
    try {
      const d = await parseBody(req);
      const naim = normStr(d.naim_oper);
      if (!d.id_shag || !naim) {
        return send(res, 400, { error: 'id_shag и naim_oper обязательны' });
      }

      const shag = await db.get(`
        SELECT sm.id_shag, sm.id_det, sm.nom_shag, sm.exec_shag
        FROM shagi_marshruta sm
        WHERE sm.id_shag = ?
      `, [d.id_shag]);
      if (!shag) return send(res, 400, { error: 'Шаг маршрута не найден' });

      // 1. ЦЕЛОСТНОСТЬ: завершённые фактом партии этой позиции на этом шаге
      const completed = await db.all(COMPLETED_BATCHES_SQL, [shag.id_det, shag.id_shag]);
      if (completed.length > 0) {
        const sample = completed[0];
        return send(res, 409, {
          error:
            `Добавление операции заблокировано: шаг №${shag.nom_shag} уже завершён фактом ` +
            `для ${completed.length} парт. этой позиции` +
            (sample.nomer_reisa ? ` (например, партия из рейса «${sample.nomer_reisa}»)` : '') +
            `. Новая операция стала бы последней в шаге и сделала бы эти партии ` +
            `«не готовыми к отправке» задним числом. Если операция действительно нужна — ` +
            `сначала снимите факт с последней операции этих партий на этой странице ` +
            `(очистите дату факта окончания) и подтвердите шаг заново.`
        });
      }

      // 2. Добавление операции в конец шага (rowid -> «последняя»)
      const idOper = generateId('OPR');
      await db.run(
        'INSERT INTO operatsii_marshruta (id_oper, id_shag, naim_oper) VALUES (?,?,?)',
        [idOper, shag.id_shag, naim]
      );

      // 3. Бэкфилл строк факта активным партиям шага (у кого факт уже ведётся)
      const affected = await db.all(ACTIVE_BATCHES_SQL, [shag.id_det, shag.id_shag]);
      let created = 0;
      for (const b of affected) {
        const exists = await db.get(
          'SELECT id FROM fakt_marshruta WHERE id_gryz_poz = ? AND id_oper = ?',
          [b.gp_id, idOper]
        );
        if (!exists) {
          await db.run(
            `INSERT INTO fakt_marshruta (id, id_gryz_poz, id_oper, status_operatsii)
             VALUES (?, ?, ?, 'ожидание')`,
            [generateId('FM'), b.gp_id, idOper]
          );
          created++;
        }
      }

      wsManager.notifyDataChange('operatsii_marshruta', 'add', idOper);
      if (created > 0) {
        wsManager.notifyDataChange('fakt_marshruta', 'bulk_add', String(created));
      }

      send(res, 201, {
        id_oper: idOper,
        naim_oper: naim,
        affected_batches: affected.length,
        created_fakt: created
      });
    } catch (e) {
      console.error('[meetingRoutes.POST_OP]', e);
      send(res, 500, { error: e.message });
    }
  },

  // ========================================================================
  // Fallback-делегаты: если диспетчер сервера резолвит /api/meeting/<action>
  // как обычный POST/PUT с «id» = action (а не METHOD_<ACTION>), вызовы
  // всё равно попадают в нужную логику.
  // ========================================================================
  async PUT(req, res) {
    const seg = (req.url || '').split('?')[0].split('/').filter(Boolean);
    if (seg[2] === 'fakt') return this.PUT_FAKT(req, res);
    return send(res, 400, { error: 'Неизвестный PUT-адрес: ' + req.url });
  },
  async POST(req, res) {
    const seg = (req.url || '').split('?')[0].split('/').filter(Boolean);
    if (seg[2] === 'op') return this.POST_OP(req, res);
    return send(res, 400, { error: 'Неизвестный POST-адрес: ' + req.url });
  }
});
