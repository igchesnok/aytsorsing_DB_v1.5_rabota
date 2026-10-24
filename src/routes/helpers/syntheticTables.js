// ============================================================
// src/routes/helpers/syntheticTables.js
// Реестр синтетических таблиц с авто-выводом зависимостей
// ============================================================

const { buildQuery,buildConditions, join, field, subquery, exists, notInSubquery, raw, cyrGlobPattern } = require('./queryBuilder');

// ============================================================
// ✅ СТАТУС ТРАНСПОРТНОЙ ОПЕРАЦИИ — ВЫЧИСЛЯЕМОЕ ПОЛЕ (бизнес-логика):
// вычисляется по датам отправки (otgruzka_data) и прибытия
// (pribytie_data) от ТЕКУЩЕЙ даты. Хранимая колонка
// transport_oper.status на экран не выводится и фильтром не
// используется (ранее PUT при каждом сохранении записывал туда
// статус «Изменена», которого нет в комбобоксе фильтра статуса).
// Правила — те же 6 статусов, что в комбобоксе фильтра:
//   Исходящая: до отгрузки >3 дней — «Ожидает отправки»;
//     0..3 дней до отгрузки — «Подготовка к отгрузке»;
//     отгрузка..прибытие — «В пути» (в т.ч. когда дата прибытия ещё
//     не заполнена — починенный кейс старого CASE, который падал в
//     ELSE «Ожидает отправки»); позже прибытия — «Выполнена».
//   Входящая: прибытие позже чем через 3 дня — «Ожидает прибытия»;
//     0..3 дней до прибытия — «Подготовка к прибытию»;
//     отгрузка прошла, прибытие дальше 3 дней — «В пути»;
//     позже прибытия — «Выполнена».
// ЕДИНЫЙ источник выражения для поля status в transportOps.list и
// для SQL-фильтра статуса (buildWhere) — правится в одном месте.
// ============================================================
const TRANSPORT_STATUS_SQL = `CASE
  WHEN toper.napravlenie = 'Исходящая' THEN
    CASE
      WHEN julianday(toper.otgruzka_data) IS NULL THEN 'Ожидает отправки'
      WHEN julianday(toper.otgruzka_data) - julianday('now', 'localtime') > 3 THEN 'Ожидает отправки'
      WHEN julianday(toper.otgruzka_data) - julianday('now', 'localtime') >= 0 THEN 'Подготовка к отгрузке'
      WHEN julianday(toper.pribytie_data) IS NOT NULL
           AND julianday('now', 'localtime') > julianday(toper.pribytie_data) THEN 'Выполнена'
      ELSE 'В пути'
    END
  WHEN toper.napravlenie = 'Входящая' THEN
    CASE
      WHEN julianday(toper.pribytie_data) IS NULL THEN 'Ожидает прибытия'
      WHEN julianday('now', 'localtime') > julianday(toper.pribytie_data) THEN 'Выполнена'
      WHEN julianday(toper.otgruzka_data) IS NOT NULL
           AND julianday('now', 'localtime') >= julianday(toper.otgruzka_data) THEN 'В пути'
      WHEN julianday(toper.pribytie_data) - julianday('now', 'localtime') > 3 THEN 'Ожидает прибытия'
      ELSE 'Подготовка к прибытию'
    END
  ELSE 'Не определено'
END`;

/**
 * Реестр синтетических таблиц
 * Каждая запись описывает:
 * - spec: базовый QuerySpec (таблица + JOIN'ы)
 * - buildWhere: функция для построения WHERE по фильтрам
 */
const SYNTHETIC_TABLES = {

  // ==========================================================================
  // 1. ТАБЛИЦА "СПИСОК ЗАКАЗОВ" (orders.zakazy)
  // ==========================================================================
  'orders.zakazy': {
    spec: {
      from: 'zakaz_po_dogovoru',
      alias: 'z',
      fields: [
        'z.*',
        field('d', 'nom_dogovor'),
        field('d', 'data_dogovor'),
        field('f', 'naimenovanie', 'firma_nazvanie'),
        field('f', 'id_firmy')
      ],
      joins: [
        join('dogovor', 'z.id_dogovora = d.id_dogovor', 'd'),
        join('firmy', 'd.id_firmy = f.id_firmy', 'f')
      ]
    },
    buildWhere(filters) {
      const conditions = ['1=1'];
      const params = [];

      if (filters.god) {
        conditions.push("(strftime('%Y', z.data_zakaza) = ? OR z.data_zakaza IS NULL OR z.data_zakaza = '')");
        params.push(String(filters.god));
      }
      if (filters.idFirma) {
        conditions.push('d.id_firmy = ?');
        params.push(filters.idFirma);
      }
      if (filters.idDogovora) {
        conditions.push('z.id_dogovora = ?');
        params.push(filters.idDogovora);
      }
      if (filters.nomerZakaza) {
        conditions.push('z.nomer_zakaza GLOB ?');
        params.push(cyrGlobPattern(filters.nomerZakaza));
      }
      // ✅ T93: фильтр «№ запроса» — заказы, у которых хотя бы одна позиция
      // привязана к КП этого запроса (pz → plan → kp → zapros_kp.n_zaprosa)
      if (filters.nZaprosa) {
        conditions.push(`EXISTS (
          SELECT 1 FROM poz_zakaz_dogovora pzq
          JOIN plan pq ON pzq.id_plana = pq.id
          JOIN kp kq ON pq.id_kp = kq.id
          JOIN zapros_kp zkq ON kq.id_zaprosa_kp = zkq.id
          WHERE pzq.id_zakaza_po_dogovoru = z.id AND zkq.n_zaprosa GLOB ?
        )`);
        params.push(cyrGlobPattern(filters.nZaprosa));
      }
      // ✅ ИСПРАВЛЕНО: строгая проверка на null, чтобы не было "statys_zd = NULL"
      if (filters.statysZd !== undefined && filters.statysZd !== null && filters.statysZd !== '') {
        conditions.push('z.statys_zd = ?');
        params.push(filters.statysZd);
      }

      return {
        where: conditions.join(' AND '),
        params,
        orderBy: 'z.data_zakaza DESC, z.nomer_zakaza DESC'
      };
    }
  },

  // ==========================================================================
  // 2. ТАБЛИЦА "ПОЗИЦИИ ЗАКАЗА" (orders.positions)
  // ==========================================================================
  'orders.positions': {
    spec: {
      from: 'poz_zakaz_dogovora',
      alias: 'pz',
      fields: [
        'pz.*',
        field('o', 'nomer_chertezha'),
        field('o', 'naimenovanie', 'osn_naimenovanie'),
        field('p', 'plan_god_kolvo'),
        field('kp', 'cena_postavshika'),
        field('kp', 'trudoemkost_postavshika'),
        field('f', 'naimenovanie', 'firma_nazvanie'),
        // ✅ T93: № запроса КП (pz → plan → kp → zapros_kp)
        field('zk', 'n_zaprosa')
      ],
      joins: [
        join('plan', 'pz.id_plana = p.id', 'p'),
        join('osnastka', 'p.id_osnastka = o.id', 'o'),
        join('kp', 'pz.id_kp = kp.id'),
        join('firmy', 'kp.id_firma = f.id_firmy', 'f'),
        join('zapros_kp', 'kp.id_zaprosa_kp = zk.id', 'zk')
      ]
    },
    buildWhere(filters) {
      const conditions = ['pz.id_zakaza_po_dogovoru = ?'];
      const params = [filters.zakazId];
      
      return {
        where: conditions.join(' AND '),
        params,
        orderBy: 'o.nomer_chertezha'
      };
    }
  },

  // ==========================================================================
  // 3. ТАБЛИЦА "ДОСТУПНЫЕ ПОЗИЦИИ" (orders.available)
  // ✅ ЗДЕСЬ ИСПРАВЛЕНО: используются ТОЛЬКО алиасы p, o, kp, f. Никаких z.
  // ==========================================================================
  'orders.available': {
      spec: {
        from: 'plan',
        alias: 'p',
        fields: [
            'p.id',
            field('kp', 'id', 'id_kp'),
            field('o', 'nomer_chertezha'),
            field('o', 'naimenovanie'),
            field('p', 'plan_god_kolvo'),
            field('f', 'naimenovanie', 'firma_nazvanie'),
            // ✅ T93: № запроса КП (p → kp → zapros_kp)
            field('zk', 'n_zaprosa')
        ],
        joins: [
            join('kp', 'p.id_kp = kp.id', 'kp'),
            join('osnastka', 'p.id_osnastka = o.id', 'o'),
            join('firmy', 'kp.id_firma = f.id_firmy', 'f'),
            join('zapros_kp', 'kp.id_zaprosa_kp = zk.id', 'zk')
        ]
    },
    buildWhere(filters) {
      const conditions = [
        raw('p.god = ?'),
        raw("p.id_kp != ''"),
        raw('p.id_kp IS NOT NULL'),
        raw("COALESCE(kp.isklyuchen, '') = ''"),
        raw("kp.id_firma != ''")
      ];
      const params = [filters.god];

      if (filters.firmaId) {
        conditions.push(raw('kp.id_firma = ?'));
        params.push(filters.firmaId);
      }
      if (filters.nomerChertezha) {
        conditions.push(raw('o.nomer_chertezha GLOB ?'));
        params.push(cyrGlobPattern(filters.nomerChertezha));
      }
      if (filters.naimenovanie) {
        conditions.push(raw('o.naimenovanie GLOB ?'));
        params.push(cyrGlobPattern(filters.naimenovanie));
      }

      // ✅ Вместо extraDeps: ['poz_zakaz_dogovora'] — автоматический подзапрос
      conditions.push(notInSubquery('p.id',
        subquery('poz_zakaz_dogovora', 'pz', 'pz.id_plana', [],
          'pz.id_kp = p.id_kp')
      ));

      const { sql: whereSql, dependencies } = buildConditions(conditions);

      return {
        where: whereSql,
        params,
        orderBy: 'o.nomer_chertezha',
        dependencies  // ← автоматически включает poz_zakaz_dogovora!
      };
    }
  },
  // ==========================================================================
  // СТРАНИЦА "ТРАНСПОРТНЫЕ ОПЕРАЦИИ"
  // ==========================================================================
  
  // Таблица списка операций
  // ✅ СТАТУС — ВЫЧИСЛЯЕМОЕ ПОЛЕ по датам отправки/прибытия от текущей
  // даты (TRANSPORT_STATUS_SQL, объявлен вверху файла). Хранимая колонка
  // transport_oper.status игнорируется: PUT больше не пишет туда
  // «Изменена», список показывает статус, вычисленный по датам, — он же
  // работает в SQL-фильтре статуса.
  // JOIN'ы переведены на LEFT: рейс без фирмы/перевозчика не должен
  // исчезать из списка (FK nullable).
  'transportOps.list': {
    spec: {
      from: 'transport_oper',
      alias: 'toper',
      fields: [
        'toper.*',
        field('f', 'naimenovanie', 'firma_nazvanie'),
        field('p', 'marka_tc'),
        field('p', 'gos_n'),
        field('p', 'fio_vodit'),
        // ✅ ВЫЧИСЛЯЕМЫЙ статус: идёт ПОСЛЕ toper.* и перекрывает
        // одноимённую хранимую колонку (как в исходном коде страницы)
        `${TRANSPORT_STATUS_SQL} as status`
      ],
      joins: [
        { table: 'firmy', alias: 'f', on: 'toper.id_firma = f.id_firmy', type: 'LEFT' },
        { table: 'perevozchik', alias: 'p', on: 'toper.id_perevozchik = p.id', type: 'LEFT' }
      ]
    },
    buildWhere(filters) {
      const conditions = ['1=1'];
      const params = [];

      if (filters.napravlenie) {
        conditions.push('toper.napravlenie = ?');
        params.push(filters.napravlenie);
      }

      if (filters.idFirma) {
        conditions.push('toper.id_firma = ?');
        params.push(filters.idFirma);
      }

      // ✅ СТАТУС ВЫЧИСЛЯЕМЫЙ: фильтр — по тому же CASE-выражению в SQL
      // (хранимая колонка toper.status больше не источник истины)
      if (filters.status) {
        conditions.push(`(${TRANSPORT_STATUS_SQL}) = ?`);
        params.push(filters.status);
      }

      return {
        where: conditions.join(' AND '),
        params,
        orderBy: 'toper.otgruzka_data DESC, toper.id DESC'
      };
    }
  },
  
  // ==========================================================================
  // ТАБЛИЦА "ПОЗИЦИИ ОПЕРАЦИИ" (gryz_poz)
  // ✅ НОВАЯ СХЕМА:
  // - tip_perevozki и nom_shag берутся через заявку plan_perevozok ->
  //   shagi_marshruta -> transport_types (в plan_perevozok больше нет
  //   id_tipa_perevozki — тип перевозки теперь атрибут шага маршрута);
  // - таблица detal_status_pto УДАЛЕНА из схемы: статусы операций партии
  //   хранятся в fakt_marshruta (id_gryz_poz x id_oper) и на этой странице
  //   не нужны;
  // - вторичные JOIN'ы LEFT: партия с неполной цепочкой не исчезает
  //   из таблицы.
  // ==========================================================================
  'transportOps.positions': {
    spec: {
      from: 'gryz_poz',
      alias: 'gp',
      fields: [
        'gp.id',
        'gp.id_transporta',
        'gp.id_plana',
        'gp.id_plana as plan_perevozok_id',
        'gp.kolvo_no_br',
        'gp.kolvo_yes_br',
        'gp.primechanie',
        field('pp', 'plan_data'),
        field('pp', 'statys'),
        field('pp', 'id_shag'),
        field('pp', 'id_brak'),
        field('sm', 'nom_shag'),
        field('tp', 'nazvanie_operatsii', 'tip_perevozki'),
        field('p', 'plan_god_kolvo'),
        field('p', 'cex_zatrat'),
        field('o', 'nomer_chertezha'),
        field('o', 'naimenovanie', 'osn_naimenovanie'),
        field('o', 'ves_det'),
        field('o', 'ves_zag'),
        field('o', 'dlina'),
        field('o', 'shirina'),
        field('o', 'vysota'),
        // ✅ ЗАТРАТЫ (VBA frmTransportOper): заказ ПТО, КОД цеха (ceh, не id),
        // передел позиции — из cex_zatrat с откатом на поля плана
        field('p', 'id', 'plan_row_id'),
        field('p', 'zak_pto'),
        // ✅ ТИПЫ ГРУЗА: параметры раскроя заготовки по позиции плана
        // (пусто = деталь/заготовка штучные)
        field('p', 'list_dlina'),
        field('p', 'list_shirina'),
        field('p', 'list_tolshina'),
        field('p', 'prutok_dlina'),
        field('gp', 'kolvo_zagotovok'), // T24B: кол-во заготовок ГРУЗОВОЙ ПОЗИЦИИ (у каждой части партии своё; пусто = авто)
        // T56-b: марка материала — факт (грузовая позиция) и конструкторская (оснастка)
        field('gp', 'marka_materiala'),
        field('o', 'marka_materiala', 'marka_materiala_osn'),
        // ✅ T57: ТИП ГРУЗА позиции (listy | prutki | zagotovki) + параметры
        // по типу (Ø прутка; габарит тары/поддона; укладка внутри деревянной тары)
        field('gp', 'tip_gruza'),
        field('gp', 'prutok_diametr'),
        field('gp', 'tara_dlina'),
        field('gp', 'tara_shirina'),
        field('gp', 'tara_vysota'),
        field('gp', 'ukladka'),
        `COALESCE(NULLIF(cz.ceh, ''), p.cex_zatrat) as ceh_izg`,
        `COALESCE(NULLIF(cz.peredel, ''), NULLIF(p.peredel, ''), '') as peredel_poz`,
      ],
      joins: [
        // Заявка плана перевозок (gryz_poz.id_plana -> plan_perevozok.id)
        join('plan_perevozok', 'gp.id_plana = pp.id', 'pp'),
        // Тип перевозки и № этапа — через ШАГ заявки (новая схема)
        { table: 'shagi_marshruta', alias: 'sm', on: 'pp.id_shag = sm.id_shag', type: 'LEFT' },
        { table: 'transport_types', alias: 'tp', on: 'sm.id_tipa_perevozki = tp.id_tipa', type: 'LEFT' },
        // Позиция плана (для заявок брака pp.id_plana пуст — LEFT)
        { table: 'plan', alias: 'p', on: 'pp.id_plana = p.id', type: 'LEFT' },
        { table: 'osnastka', alias: 'o', on: 'p.id_osnastka = o.id', type: 'LEFT' },
        { table: 'cex_zatrat', alias: 'cz', on: 'p.cex_zatrat = cz.id', type: 'LEFT' }
      ]
    },
    buildWhere(filters) {
      return {
        where: 'gp.id_transporta = ?',
        params: [filters.transId],
        orderBy: 'sm.nom_shag, gp.id'
      };
    }
  },

  // ==========================================================================
  // ТАБЛИЦА "ДОСТУПНЫЕ ПОЗИЦИИ" (plan_perevozok)
  // ✅ НОВАЯ СХЕМА + НОВЫЙ АЛГОРИТМ (синхронно с planPerevozokRoutes.js):
  // - тип перевозки — атрибут ШАГА: pp.id_shag -> shagi_marshruta ->
  //   transport_types (колонки pp.id_tipa_perevozki в plan_perevozok
  //   больше нет — это была старая схема);
  // - перевозятся только позиции плана с КП (подрядчиком): p.id_kp IS NOT
  //   NULL AND p.is_no_kp_plan = 0; для заявок брака (pp.id_plana пуст)
  //   требование КП не действует;
  // - остаток = заявка минус партии, уже загруженные в рейсы (loaded:
  //   gryz_poz по ЗАЯВКЕ gp.id_plana -> pp.id);
  // - АКТИВНЫЙ шаг позиции (готовность к перемещению по факту рейсов
  //   transport_oper + gryz_poz) вычисляется в роуте computePositionFlow
  //   и фильтруется в JS: SQL не умеет последовательное продвижение
  //   по шагам маршрута;
  // - текстовые фильтры (чертёж/наименование/договор) тоже в JS роута —
  //   SQLite LIKE регистрозависим для кириллицы.
  // ==========================================================================
  'transportOps.available': {
    spec: {
      from: 'plan_perevozok',
      alias: 'pp',
      fields: [
        'pp.id as plan_perevozok_id',
        'pp.id_plana',
        'pp.id_brak',
        'pp.plan_data',
        'pp.statys',
        'pp.id_shag',
        'pp.kolvo_no_br as plan_kolvo_no_br',
        'pp.kolvo_yes_br as plan_kolvo_yes_br',
        field('sm', 'nom_shag'),
        field('tp', 'id_tipa', 'id_tipa_perevozki'),
        field('tp', 'nazvanie_operatsii', 'tip_perevozki'),
        field('tp', 'uchet_v_ostatke'),
        field('p', 'id', 'plan_id'),
        field('p', 'plan_god_kolvo'),
        field('p', 'cex_zatrat'),
        field('k', 'id_firma'),
        field('f', 'naimenovanie', 'firma_name'),
        field('o', 'nomer_chertezha'),
        field('o', 'naimenovanie', 'osn_naimenovanie'),
        field('o', 'ves_det'),
        field('o', 'ves_zag'),
        field('o', 'dlina'),
        field('o', 'shirina'),
        field('o', 'vysota'),
        // ✅ ЗАТРАТЫ (VBA frmTransportOper): заказ ПТО, КОД цеха (ceh, не id),
        // передел позиции — из cex_zatrat с откатом на поля плана
        field('p', 'zak_pto'),
        // ✅ ТИПЫ ГРУЗА: параметры раскроя заготовки по позиции плана
        // (пусто = деталь/заготовка штучные)
        field('p', 'list_dlina'),
        field('p', 'list_shirina'),
        field('p', 'list_tolshina'),
        field('p', 'prutok_dlina'),
        // T56-b: конструкторская марка материала (оснастка) — дефолт для грузовой позиции
        field('o', 'marka_materiala', 'marka_materiala_osn'),
        `COALESCE(NULLIF(cz.ceh, ''), p.cex_zatrat) as ceh_izg`,
        `COALESCE(NULLIF(cz.peredel, ''), NULLIF(p.peredel, ''), '') as peredel_poz`,
        field('d', 'nom_dogovor'),
        `COALESCE(loaded.loaded_no_br, 0) as loaded_no_br`,
        `COALESCE(loaded.loaded_yes_br, 0) as loaded_yes_br`
      ],
      joins: [
        // Тип перевозки и № этапа — через ШАГ заявки (новая схема)
        { table: 'shagi_marshruta', alias: 'sm', on: 'pp.id_shag = sm.id_shag', type: 'LEFT' },
        { table: 'transport_types', alias: 'tp', on: 'sm.id_tipa_perevozki = tp.id_tipa', type: 'LEFT' },
        // Позиция плана (для заявок брака pp.id_plana пуст — LEFT)
        { table: 'plan', alias: 'p', on: 'pp.id_plana = p.id', type: 'LEFT' },
        { table: 'osnastka', alias: 'o', on: 'p.id_osnastka = o.id', type: 'LEFT' },
        { table: 'kp', alias: 'k', on: 'p.id_kp = k.id', type: 'LEFT' },
        { table: 'firmy', alias: 'f', on: 'k.id_firma = f.id_firmy', type: 'LEFT' },
        { table: 'dogovor', alias: 'd', on: 'k.id_dogovor = d.id_dogovor', type: 'LEFT' },
        { table: 'cex_zatrat', alias: 'cz', on: 'p.cex_zatrat = cz.id', type: 'LEFT' },
        {
          // Партии, уже размещённые в рейсах: группировка по ЗАЯВКЕ
          table: subquery(
            'gryz_poz',
            'gp',
            [
              'gp.id_plana as gp_plan_perevozok_id',
              'SUM(COALESCE(gp.kolvo_no_br, 0)) as loaded_no_br',
              'SUM(COALESCE(gp.kolvo_yes_br, 0)) as loaded_yes_br'
            ],
            [],
            '',
            'gp.id_plana' // GROUP BY
          ),
          alias: 'loaded',
          on: 'loaded.gp_plan_perevozok_id = pp.id',
          type: 'LEFT'
        }
      ]
    },
    buildWhere(filters) {
      const conditions = [];
      const params = [];

      // Направление шага заявки = направлению рейса
      if (filters.direction) {
        conditions.push('tp.napravlenie = ?');
        params.push(filters.direction);
      }

      // ✅ Позиции без КП не перевозятся (некем); заявки брака — исключение.
      // ✅ ИСПРАВЛЕНО: id_kp бывает '' (пустая строка, планRoutes.POST) —
      // `IS NOT NULL` её пропускал; исключаем и NULL, и пустую строку.
      conditions.push(`(pp.id_plana IS NULL OR (TRIM(COALESCE(p.id_kp, '')) != '' AND COALESCE(p.is_no_kp_plan, 0) = 0))`);

      // Заявка, полностью размещённая в рейсах, не предлагается
      conditions.push(`(
        (pp.kolvo_no_br - COALESCE(loaded.loaded_no_br, 0)) > 0
        OR (pp.kolvo_yes_br - COALESCE(loaded.loaded_yes_br, 0)) > 0
      )`);

      return {
        where: conditions.join(' AND '),
        params,
        orderBy: 'o.nomer_chertezha, sm.nom_shag'
      };
    }
  },
     // Добавить в SYNTHETIC_TABLES:

  // ==========================================================================
  // 5. ТАБЛИЦА "СТАТУС ЗАПРОСА КП" (offers.status)
  // ==========================================================================
  'offers.status': {
      spec: {
          from: 'zapros_kp',
          alias: 'z',
          fields: [
              'z.id',
              'z.n_zaprosa',
              'z.data_form',
              'z.statys',
              'z.date_url_update'
          ],
          joins: []
      },
      buildWhere(filters) {
          const conditions = ['1=1'];
          const params = [];
          if (filters.zaprosId) {
              conditions.push('z.id = ?');
              params.push(filters.zaprosId);
          }
          return {
              where: conditions.join(' AND '),
              params,
              orderBy: 'z.data_form DESC'
          };
      }
  },

  'offers.zaprosy': {
    spec: {
      from: 'zapros_kp',
      alias: 'z',
      fields: ['z.id', 'z.n_zaprosa', 'z.data_form', 'z.statys'],
      joins: []
    },
    buildWhere(filters) {
      return { where: '1=1', params: [], orderBy: 'z.data_form DESC' };
    }
  },
  // ==========================================================================
  // 6. ТАБЛИЦА "СПИСОК ЗАПРОСОВ КП" (requests.zaprosy)
  // ==========================================================================
  'requests.zaprosy': {
      spec: {
          from: 'zapros_kp',
          alias: 'z',
          fields: [
              'z.id', 'z.n_zaprosa', 'z.data_form', 'z.statys',
              'z.data_peredach_tehnologu',
              'z.ssylka_na_chertezh', 'z.srok_predostavleniya_kp',
              'z.id_tehnologa', 'z.kommentariy'
          ],
          joins: []
    },
    buildWhere(filters) {
      const conditions = [];    // ← массив Condition-объектов
      const params = [];

      if (filters.god) {
        conditions.push(raw("strftime('%Y', z.data_form) = ?"));
        params.push(filters.god);
      }

      if (filters.firma) {
        // ✅ exists() автоматически добавит 'kp' в зависимости
        conditions.push(exists(
          subquery('kp', 'k', '1', [],
            'k.id_zaprosa_kp = z.id AND k.id_firma = ?')
        ));
        params.push(filters.firma);
      }

      if (filters.nomer_chertezha) {
        // ✅ exists() + subquery с JOIN'ами → зависимости kp, plan, osnastka
        conditions.push(exists(
          subquery('kp', 'k', '1',
            [
              join('plan', 'k.id_plana = p.id', 'p'),
              join('osnastka', 'p.id_osnastka = o.id', 'o')
            ],
            'k.id_zaprosa_kp = z.id AND o.nomer_chertezha GLOB ?')
        ));
        params.push(cyrGlobPattern(filters.nomer_chertezha));
      }

      // ✅ Собираем WHERE-строку и извлекаем зависимости
      const { sql: whereSql, dependencies } = buildConditions(conditions);

      return {
        where: whereSql || '1=1',
        params,
        orderBy: 'z.data_form DESC, z.n_zaprosa DESC',
        dependencies  // ← АВТОМАТИЧЕСКИ извлечённые зависимости!
      };
    }
  },

  // ==========================================================================
  // 7. ТАБЛИЦА "ДОСТУПНЫЕ ДЕТАЛИ ДЛЯ ЗАПРОСА" (requests.available)
  // ==========================================================================
  'requests.available': {
    spec: {
      from: 'plan',
      alias: 'p',
      fields: [
        'p.id',
        field('o', 'nomer_chertezha'),
        field('o', 'naimenovanie', 'osn_naimenovanie'),
        field('p', 'plan_god_kolvo'),
        field('p', 'id_kp')
      ],
      joins: [
        join('osnastka', 'p.id_osnastka = o.id', 'o')
      ]
    },
    buildWhere(filters) {
      const conditions = [];
      const params = [filters.god || new Date().getFullYear()];

      conditions.push(raw('p.god = ?'));

      // ✅ Позиции, уже привязанные к текущему запросу: сервер исключает их
      // сам по таблице kp (левый список DualListBlock = kp-строки запроса,
      // их id_plana). Раньше клиент собирал этот список и слал параметром
      // excludePlanIds. excludePlanIds оставлен для старых клиентов.
      if (filters.zaprosId) {
        conditions.push(notInSubquery('p.id',
          subquery('kp', 'kz', 'kz.id_plana', [], 'kz.id_zaprosa_kp = ?')
        ));
        params.push(filters.zaprosId);
      }

      if (filters.excludePlanIds) {
        const ids = filters.excludePlanIds.split(',').filter(id => id);
        if (ids.length > 0) {
          conditions.push(raw(`p.id NOT IN (${ids.map(() => '?').join(',')})`));
          params.push(...ids);
        }
      }

      // ✅ ПЕРЕНОС ФИЛЬТРАЦИИ НА СЕРВЕР: позиции, на которые ссылается хоть
      // одно КП (таблица kp), исключает сам сервер. Раньше клиент собирал
      // этот список сам (GET /api/kom-predl → excludeKpPlanIds: сотни
      // дублированных id_plana в URL, риск 414/400 от nginx). Семантика та же:
      // p.id NOT IN (SELECT kx.id_plana FROM kp kx).
      // notInSubquery автоматически добавит 'kp' в зависимости
      // (WebSocket-инвалидация: изменение kp → обновление requests.available).
      conditions.push(notInSubquery('p.id',
        subquery('kp', 'kx', 'kx.id_plana', [], '1=1')
      ));

      // ✅ Кир→Лат (гомоглифы): hg=0 — строгий режим (переключатель «Кир→Лат»
      //    выключен). Единое поведение с plan.list/osnastka.list: FilterableTable
      //    сам добавляет hg=0 в URL при выключенном переключателе.
      const hg = filters.hg !== '0';

      if (filters.nomer_chertezha) {
        conditions.push(raw('o.nomer_chertezha GLOB ?'));
        params.push(cyrGlobPattern(filters.nomer_chertezha, hg));
      }
      if (filters.naimenovanie) {
        conditions.push(raw('o.naimenovanie GLOB ?'));
        params.push(cyrGlobPattern(filters.naimenovanie, hg));
      }
      if (filters.avto_mob_det) {
        conditions.push(raw('o.avto_mob_det GLOB ?'));
        params.push(cyrGlobPattern(filters.avto_mob_det, hg));
      }
      if (filters.zakalka === '1') conditions.push(raw('o.zakalka = 1'));
      if (filters.ppd === '1') conditions.push(raw('o.ppd = 1'));
      if (filters.tisnenie === '1') conditions.push(raw('o.tisnenie = 1'));
      if (filters.pokrytie === '1') conditions.push(raw('o.pokrytie = 1'));
      if (filters.nitrocementaciya === '1') conditions.push(raw('o.nitrocementaciya = 1'));

      const { sql: whereSql, dependencies } = buildConditions(conditions);

      return {
        where: whereSql,
        params,
        orderBy: 'o.nomer_chertezha',
        dependencies  // ← автоматически!
      };
    }
  },

  // ==========================================================================
  // 8. ТАБЛИЦА "КП ЗАПРОСА" (requests.kp)
  // ==========================================================================
  'requests.kp': {
      spec: {
          from: 'kp',
          alias: 'k',
          fields: [
              'k.*',
              field('p', 'id', 'plan_id'),
              field('o', 'nomer_chertezha'),
              field('o', 'naimenovanie', 'osn_naimenovanie'),
              field('p', 'plan_god_kolvo'),
              field('f', 'naimenovanie', 'firma_nazvanie'),
              field('f', 'id_firmy')
          ],
          joins: [
              join('plan', 'k.id_plana = p.id', 'p'),
              join('osnastka', 'p.id_osnastka = o.id', 'o'),
              join('firmy', 'k.id_firma = f.id_firmy', 'f')
          ]
      },
      buildWhere(filters) {
          const conditions = ['1=1'];
          const params = [];
          if (filters.zaprosId) {
              conditions.push('k.id_zaprosa_kp = ?');
              params.push(filters.zaprosId);
          }
          return {
              where: conditions.join(' AND '),
              params,
              orderBy: 'o.nomer_chertezha'
          };
      }
  },

  // ==========================================================================
  // 9. ТАБЛИЦА "КП ДЛЯ СТРАНИЦЫ ВНЕДРЕНИЯ" (offers.kp)
  // Используется на странице offers.html для сводной таблицы и деталей
  // ==========================================================================
  'offers.kp': {
    spec: {
      from: 'kp',
      alias: 'kp',
      fields: [
        'kp.*',
        field('p', 'id', 'plan_id'),
        field('o', 'nomer_chertezha'),
        field('o', 'naimenovanie', 'osn_naimenovanie'),
        field('o', 'trudoemkost_pto'),
        field('p', 'plan_god_kolvo'),
        field('p', 'cena_pto'),
        field('p', 'id_kp'),
        field('f', 'naimenovanie', 'firma_nazvanie'),
        field('f', 'id_firmy', 'firma_id'),
        field('z', 'statys', 'zapros_statys'),
        field('d', 'nom_dogovor'),
        field('d', 'data_dogovor')// ✅ НОВОЕ: дата договора — колонка «№ договора и дата» на странице «Запросы КП»
      ],
      joins: [
        join('plan', 'kp.id_plana = p.id', 'p'),
        join('osnastka', 'p.id_osnastka = o.id', 'o'),
        join('firmy', 'kp.id_firma = f.id_firmy', 'f'),
        join('zapros_kp', 'kp.id_zaprosa_kp = z.id', 'z'),
        join('dogovor', 'kp.id_dogovor = d.id_dogovor', 'd')
      ]
    },

    buildWhere(filters) {
      const conditions = ['1=1'];
      const params = [];
      if (filters.zaprosId) {
        conditions.push('kp.id_zaprosa_kp = ?');
        params.push(filters.zaprosId);
      }
      // Фильтр "нет КП" — исключаем выбранные лучшие и завершённые
      if (filters.no_kp === '1') {
        conditions.push(`(kp.reshenie IS NULL OR kp.reshenie != 'лучшее предложение')`);
        conditions.push(`(z.statys IS NULL OR z.statys != 'выбраны лучшие КП')`);
      }
      return {
        where: conditions.join(' AND '),
        params,
        orderBy: 'f.naimenovanie, o.nomer_chertezha'
      };
    }
  },

  // Перевозчики (для комбоксов)
  'transportOps.perevozchik': {
    spec: {
      from: 'perevozchik',
      alias: 'p',
      fields: ['p.*'],
      joins: []
    },
    buildWhere(filters) {
      return {
        where: '1=1',
        params: [],
        orderBy: 'p.firma, p.gos_n'
      };
    }
  },



  // ==========================================================================
  // СПРАВОЧНИК ЦЕХОВ ЗАТРАТ (cex.list — для страницы цехов)
  // Фильтры: ceh, peredel, nazvanie, nach_ceha
  // ==========================================================================
  'cex.list': {
      spec: {
          from: 'cex_zatrat',
          alias: 'c',
          fields: ['c.*'],
          joins: []
      },
      buildWhere(filters) {
          const conditions = [];
          const params = [];

          if (filters.id) {
            conditions.push(raw('c.id = ?'));
            params.push(filters.id);
          }
          if (filters.ceh) {
              conditions.push(raw('c.ceh GLOB ?'));
              params.push(cyrGlobPattern(filters.ceh));
          }
          if (filters.peredel) {
              conditions.push(raw('c.peredel GLOB ?'));
              params.push(cyrGlobPattern(filters.peredel));
          }
          if (filters.nazvanie) {
              conditions.push(raw('c.nazvanie GLOB ?'));
              params.push(cyrGlobPattern(filters.nazvanie));
          }
          if (filters.nach_ceha) {
              conditions.push(raw('c.nach_ceha GLOB ?'));
              params.push(cyrGlobPattern(filters.nach_ceha));
          }

          const { sql: whereSql, dependencies } = buildConditions(conditions);

          return {
              where: whereSql || '1=1',
              params,
              orderBy: 'c.ceh',
              dependencies
          };
      }
  },

  // ==========================================================================
  // СПРАВОЧНИК ТЕХНОЛОГОВ (tech.list)
  // Фильтры: fio, email, telefon, tip_osnastki
  // ==========================================================================
  'tech.list': {
      spec: {
          from: 'tech',
          alias: 't',
          fields: ['t.*'],
          joins: []
      },
      buildWhere(filters) {
          const conditions = [];
          const params = [];

          if (filters.id) {
            conditions.push(raw('t.id = ?'));
            params.push(filters.id);
          }
          if (filters.fio) {
              conditions.push(raw('t.fio GLOB ?'));
              params.push(cyrGlobPattern(filters.fio));
          }
          if (filters.email) {
              conditions.push(raw('t.email GLOB ?'));
              params.push(cyrGlobPattern(filters.email));
          }
          if (filters.telefon) {
              conditions.push(raw('t.telefon GLOB ?'));
              params.push(cyrGlobPattern(filters.telefon));
          }
          if (filters.tip_osnastki) {
              conditions.push(raw('t.tip_osnastki GLOB ?'));
              params.push(cyrGlobPattern(filters.tip_osnastki));
          }

          const { sql: whereSql, dependencies } = buildConditions(conditions);

          return {
              where: whereSql || '1=1',
              params,
              orderBy: 't.fio',
              dependencies
          };
      }
  },

  // ==========================================================================
  // СПРАВОЧНИК ФИРМ (firms.list — базовый список для комбоксов)
  // ==========================================================================
  'firms.list': {
      spec: {
          from: 'firmy',
          alias: 'f',
          fields: ['f.*'],
          joins: []
      },
      buildWhere(filters) {
          const conditions = ['1=1'];
          const params = [];
          if (filters.id_firmy) {
              conditions.push('f.id_firmy = ?');
              params.push(filters.id_firmy);
          }
          if (filters.kod) {
              conditions.push('f.kod = ?');
              params.push(filters.kod);
          }
          if (filters.naimenovanie) {
              conditions.push('f.naimenovanie GLOB ?');
              params.push(cyrGlobPattern(filters.naimenovanie));
          }
          if (filters.search) {
              // ✅ Кир→Лат: один GLOB-паттерн на все три поля
              const s = cyrGlobPattern(filters.search);
              conditions.push('(f.kod GLOB ? OR f.naimenovanie GLOB ? OR f.inn GLOB ?)');
              params.push(s, s, s);
          }
          return {
              where: conditions.join(' AND '),
              params,
              orderBy: 'f.naimenovanie'
          };
      }
  },
  // ==========================================================================
  // СПРАВОЧНИК ПЕРЕВОЗЧИКОВ (perevozchik.list)
  // Фильтры: id, firma, gos_n, fio_vodit
  // ==========================================================================
  'perevozchik.list': {
      spec: {
          from: 'perevozchik',
          alias: 'p',
          fields: ['p.*'],
          joins: []
      },
      buildWhere(filters) {
          const conditions = [];
          const params = [];

          // Фильтр по первичному ключу (для checkForExternalChanges)
          if (filters.id) {
              conditions.push('p.id = ?');
              params.push(filters.id);
          }

          if (filters.god) {
              conditions.push('p.god = ?');
              params.push(filters.god);
          }
          if (filters.firma) {
              conditions.push(raw('p.firma GLOB ?'));
              params.push(cyrGlobPattern(filters.firma));
          }
          if (filters.gos_n) {
              conditions.push(raw('p.gos_n GLOB ?'));
              params.push(cyrGlobPattern(filters.gos_n));
          }
          if (filters.fio_vodit) {
              conditions.push(raw('p.fio_vodit GLOB ?'));
              params.push(cyrGlobPattern(filters.fio_vodit));
          }

          const { sql: whereSql, dependencies } = buildConditions(conditions);
          return {
              where: whereSql || '1=1',
              params,
              orderBy: 'p.firma, p.gos_n',
              dependencies
          };
      }
  },
  // ==========================================================================
  // СПРАВОЧНИК ОСНАСТКИ (osnastka.list)
  // ==========================================================================
  'osnastka.list': {
      spec: {
          from: 'osnastka',
          alias: 'o',
          fields: ['o.*'],
          joins: []
      },
      buildWhere(filters) {
          const conditions = ['1=1'];
          const params = [];
          
          // ✅ НОВОЕ: фильтр по id
          if (filters.id) {
              conditions.push('o.id = ?');
              params.push(filters.id);
          }
          
          // ✅ Кир→Лат (гомоглифы): в GLOB-классы добавлены латинские двойники букв,
          // поэтому «швеллер» находит «ШBEЛЛЕР» (B, E, P — латиница в данных).
          // hg=0 — строгий режим (переключатель «Кир→Лат» выключен).
          const hg = filters.hg !== '0';
          if (filters.nomer_chertezha) {
              conditions.push('o.nomer_chertezha GLOB ?');
              params.push(cyrGlobPattern(filters.nomer_chertezha, hg));
          }
          if (filters.naimenovanie) {
              conditions.push('o.naimenovanie GLOB ?');
              params.push(cyrGlobPattern(filters.naimenovanie, hg));
          }
          // ✅ НОВОЕ: обобщённый поиск VirtualSelect — ИЛИ по № чертежа / наименованию
          if (filters.search) {
              const p = cyrGlobPattern(filters.search, hg);
              conditions.push('(o.nomer_chertezha GLOB ? OR o.naimenovanie GLOB ?)');
              params.push(p, p);
          }
          if (filters.avto_mob_det) {
              conditions.push('o.avto_mob_det GLOB ?');
              params.push(cyrGlobPattern(filters.avto_mob_det, hg));
          }
          if (filters.zakalka === '1') conditions.push('o.zakalka = 1');
          if (filters.ppd === '1') conditions.push('o.ppd = 1');
          if (filters.tisnenie === '1') conditions.push('o.tisnenie = 1');
          if (filters.pokrytie === '1') conditions.push('o.pokrytie = 1');
          if (filters.nitrocementaciya === '1') conditions.push('o.nitrocementaciya = 1');
          
          return {
              where: conditions.join(' AND '),
              params,
              orderBy: 'o.nomer_chertezha'
          };
      }
  },
  // ==========================================================================
  // ПЛАН ПРОИЗВОДСТВА (plan.list)
  // ==========================================================================
  'plan.list': {
      spec: {
          from: 'plan',
          alias: 'p',
          fields: [
              'p.*',
              field('o', 'nomer_chertezha'),
              field('o', 'naimenovanie', 'osn_naimenovanie'),
              field('o', 'avto_mob_det'),
              field('o', 'zakalka'),
              field('o', 'ppd'),
              field('o', 'tisnenie'),
              field('o', 'pokrytie'),
              field('o', 'nitrocementaciya'),
              field('k', 'id_firma'),
              field('f', 'naimenovanie', 'firma_nazvanie'),
              field('f', 'kod', 'firma_kod'),
              // t71: «№ запроса» — запрос, в который позиция плана УЖЕ включена:
              // kp.id_plana = plan.id -> kp.id_zaprosa_kp -> zapros_kp.n_zaprosa.
              // (t70 брал запрос только лучшего КП plan.id_kp — позиции без выбранного
              // решения оставались с пустым «№ запроса», хотя запрос КП для них есть.)
              // Скалярный подзапрос: строки не множатся даже при нескольких КП;
              // без КП/запроса — пусто; запросы с пустым номером пропускаем.
              `COALESCE((SELECT zk.n_zaprosa FROM kp kq INNER JOIN zapros_kp zk ON zk.id = kq.id_zaprosa_kp WHERE kq.id_plana = p.id AND COALESCE(zk.n_zaprosa, '') != '' ORDER BY kq.rowid LIMIT 1), '') AS zapros_nomer`,
              // t70: «№ зак. по дог.» — номер и дата заказа по договору, в котором состоит
              // позиция плана (poz_zakaz_dogovora.id_plana -> zakaz_po_dogovoru);
              // формат «<№> от <ДД.ММ.ГГГГ>», без заказа — пусто. Скалярный подзапрос:
              // не множит строки, даже если позиция попадёт в несколько заказов
              `COALESCE((SELECT CASE WHEN COALESCE(z.nomer_zakaza, '') = '' THEN '' ELSE z.nomer_zakaza || CASE WHEN COALESCE(z.data_zakaza, '') != '' THEN ' от ' || substr(z.data_zakaza, 9, 2) || '.' || substr(z.data_zakaza, 6, 2) || '.' || substr(z.data_zakaza, 1, 4) ELSE '' END END FROM poz_zakaz_dogovora pz INNER JOIN zakaz_po_dogovoru z ON z.id = pz.id_zakaza_po_dogovoru WHERE pz.id_plana = p.id ORDER BY pz.rowid DESC LIMIT 1), '') AS zak_po_dog`
          ],
          joins: [
              join('osnastka', 'p.id_osnastka = o.id', 'o'),
              join('kp', 'p.id_kp = k.id', 'k'),
              join('firmy', 'k.id_firma = f.id_firmy', 'f')
              // t71: join zapros_kp из t70 (запрос лучшего КП plan.id_kp) удалён —
              // «№ запроса» теперь скалярный подзапрос по kp.id_plana (см. поля выше)
          ]
      },
      buildWhere(filters) {
          const conditions = ['1=1'];
          const params = [];

          if (filters.god) {
              conditions.push('p.god = ?');
              params.push(filters.god);
          }
          // ✅ Кир→Лат (гомоглифы) + регистронезависимость: GLOB с классами символов
          // (cyrGlobPattern, см. queryBuilder). «Шток», «ШТОК», «шток» и «ШBEЛЛЕР»
          // при запросе «швеллер» находят одно и то же. hg=0 — строгий режим.
          const hg = filters.hg !== '0';
          if (filters.nomer_chertezha) {
              conditions.push('o.nomer_chertezha GLOB ?');
              params.push(cyrGlobPattern(filters.nomer_chertezha, hg));
          }
          if (filters.naimenovanie) {
              conditions.push('o.naimenovanie GLOB ?');
              params.push(cyrGlobPattern(filters.naimenovanie, hg));
          }
          // ✅ T94: обобщённый поиск VirtualSelect (route-editor «Позиция плана»)
          // — ИЛИ по № чертежа / наименованию, единый шаблон с osnastka.list
          if (filters.search) {
              const sp = cyrGlobPattern(filters.search, hg);
              conditions.push('(o.nomer_chertezha GLOB ? OR o.naimenovanie GLOB ?)');
              params.push(sp, sp);
          }
          if (filters.avto_mob_det) {
              conditions.push('o.avto_mob_det GLOB ?');
              params.push(cyrGlobPattern(filters.avto_mob_det, hg));
          }
          if (filters.firma) {
              conditions.push('k.id_firma = ?');
              params.push(filters.firma);
          }
          // t72: фильтр «№ запроса» — позиция включена в запрос КП, номер
          // которого совпадает с шаблоном (GLOB + cyrGlobPattern: Кир→Лат,
          // регистронезависимость — как у остальных текстовых фильтров).
          // IN-подзапрос — строки не множит.
          if (filters.zapros_nomer) {
              conditions.push(`p.id IN (SELECT kq.id_plana FROM kp kq INNER JOIN zapros_kp zk ON zk.id = kq.id_zaprosa_kp WHERE COALESCE(zk.n_zaprosa, '') != '' AND zk.n_zaprosa GLOB ?)`);
              params.push(cyrGlobPattern(filters.zapros_nomer, hg));
          }
          if (filters.zakalka === '1') conditions.push('o.zakalka = 1');
          if (filters.ppd === '1') conditions.push('o.ppd = 1');
          if (filters.tisnenie === '1') conditions.push('o.tisnenie = 1');
          if (filters.pokrytie === '1') conditions.push('o.pokrytie = 1');
          if (filters.nitrocementaciya === '1') conditions.push('o.nitrocementaciya = 1');

          return {
              where: conditions.join(' AND '),
              params,
              orderBy: 'p.god DESC, o.nomer_chertezha'
          };
      }
  },
  // ==========================================================================
  // ФИРМЫ С ДОГОВОРАМИ (firms.withContracts — для transport-ops)
  // Фильтры: yearFrom/yearTo, hasCargo, id_firmy
  // ==========================================================================
  'firms.withContracts': {
      spec: {
          from: 'firmy',
          alias: 'f',
          fields: ['DISTINCT f.id_firmy', 'f.kod', 'f.naimenovanie', 'f.inn', 'f.ur_adres',
                   'f.gorod', 'f.cena_perevozki'], // ✅ T84: город и цена перевозки
          joins: []
      },
      buildWhere(filters) {
          const conditions = [];
          const params = [];

          // Фильтр по году договора
          if (filters.yearFrom && filters.yearTo) {
              conditions.push(exists(
                  subquery('dogovor', 'd', '1', [],
                      'd.id_firmy = f.id_firmy AND CAST(substr(d.data_dogovor, 1, 4) AS INTEGER) BETWEEN ? AND ?')
              ));
              params.push(parseInt(filters.yearFrom), parseInt(filters.yearTo));
          } else if (filters.yearFrom) {
              conditions.push(exists(
                  subquery('dogovor', 'd', '1', [],
                      'd.id_firmy = f.id_firmy AND CAST(substr(d.data_dogovor, 1, 4) AS INTEGER) >= ?')
              ));
              params.push(parseInt(filters.yearFrom));
          } else if (filters.yearTo) {
              conditions.push(exists(
                  subquery('dogovor', 'd', '1', [],
                      'd.id_firmy = f.id_firmy AND CAST(substr(d.data_dogovor, 1, 4) AS INTEGER) <= ?')
              ));
              params.push(parseInt(filters.yearTo));
          }

          if (filters.id_firmy) {
              conditions.push(raw('f.id_firmy = ?'));
              params.push(filters.id_firmy);
          }

          // Только фирмы с доступным грузом
          if (filters.hasCargo === '1') {
              conditions.push(exists(
                  subquery('plan_perevozok', 'pp', '1', [
                      join('plan', 'pp.id_plana = p.id', 'p'),
                      join('kp', 'p.id_kp = k.id', 'k'),
                      // LEFT JOIN на агрегированный подзапрос (производная таблица)
                      {
                          table: `(SELECT id_plana, SUM(kolvo_no_br) as sum_no, SUM(kolvo_yes_br) as sum_yes FROM gryz_poz GROUP BY id_plana)`,
                          alias: 'loaded',
                          on: 'loaded.id_plana = pp.id',
                          type: 'LEFT'
                      }
                  ],
                  'k.id_firma = f.id_firmy AND ((pp.kolvo_no_br - COALESCE(loaded.sum_no, 0)) > 0 OR (pp.kolvo_yes_br - COALESCE(loaded.sum_yes, 0)) > 0)')
              ));
          }

          // Собираем WHERE-строку и автоматически извлекаем зависимости (dogovor, plan_perevozok, plan, kp, gryz_poz)
          const { sql: whereSql, dependencies } = buildConditions(conditions);

          return {
              where: whereSql || '1=1',
              params,
              orderBy: 'f.naimenovanie',
              dependencies  // ← Сервер теперь сам знает, что эта синтетическая таблица зависит от этих базовых таблиц!
          };
      }
  },
  // ==========================================================================
  // СПРАВОЧНИК ТИПОВ ПЕРЕВОЗОК (transportTypes.list)
  // Фильтры: id_tipa, nazvanie_operatsii, napravlenie
  // ==========================================================================
  'transportTypes.list': {
      spec: {
          from: 'transport_types',
          alias: 'tt',
          fields: ['tt.*'],
          joins: []
      },
      buildWhere(filters) {
          const conditions = [];
          const params = [];
          if (filters.id_tipa) {
              conditions.push(raw('tt.id_tipa GLOB ?'));
              params.push(cyrGlobPattern(filters.id_tipa));
          }
          if (filters.nazvanie_operatsii) {
              conditions.push(raw('tt.nazvanie_operatsii GLOB ?'));
              params.push(cyrGlobPattern(filters.nazvanie_operatsii));
          }
          if (filters.napravlenie) {
              conditions.push(raw('tt.napravlenie = ?'));
              params.push(filters.napravlenie);
          }
          const { sql: whereSql, dependencies } = buildConditions(conditions);
          return {
              where: whereSql || '1=1',
              params,
              orderBy: 'tt.id_tipa',
              dependencies
          };
      }
},
  // ==========================================================================
  // СПРАВОЧНИК ДОГОВОРОВ (dogovor.list)
  // Фильтры: id_firmy, id_dogovor, nom_dogovor, god, yearFrom, yearTo
  // ==========================================================================
  'dogovor.list': {
      spec: {
          from: 'dogovor',
          alias: 'd',
          fields: [
              'd.*',
              field('f', 'naimenovanie', 'firma_nazvanie'),
              field('f', 'kod', 'firma_kod'),
              field('f', 'id_firmy')
          ],
          joins: [
              join('firmy', 'd.id_firmy = f.id_firmy', 'f')
          ]
      },
      buildWhere(filters) {
          const conditions = ['1=1'];
          const params = [];

          if (filters.id_firmy) {
              conditions.push('d.id_firmy = ?');
              params.push(filters.id_firmy);
          }
          if (filters.id_dogovor) {
              conditions.push('d.id_dogovor = ?');
              params.push(filters.id_dogovor);
          }
          if (filters.nom_dogovor) {
              conditions.push('d.nom_dogovor GLOB ?');
              params.push(cyrGlobPattern(filters.nom_dogovor));
          }
          // Фильтр по конкретному году (формат YYYY-MM-DD)
          if (filters.god) {
              conditions.push(`CAST(substr(d.data_dogovor, 1, 4) AS INTEGER) = ?`);
              params.push(parseInt(filters.god));
          }
          if (filters.yearFrom) {
              conditions.push(`CAST(substr(d.data_dogovor, 1, 4) AS INTEGER) >= ?`);
              params.push(parseInt(filters.yearFrom));
          }
          if (filters.yearTo) {
              conditions.push(`CAST(substr(d.data_dogovor, 1, 4) AS INTEGER) <= ?`);
              params.push(parseInt(filters.yearTo));
          }

          return {
              where: conditions.join(' AND '),
              params,
              orderBy: 'd.data_dogovor DESC, d.nom_dogovor'
          };
      }
  },

  // ==========================================================================
  // СПРАВОЧНИК КОНТАКТОВ (kont.list)
  // Фильтры: id_firmy, firma_kod, fio, aktivnost, withEmail
  // ==========================================================================
  'kont.list': {
      spec: {
          from: 'kont',
          alias: 'k',
          fields: [
              'k.*',
              field('f', 'naimenovanie', 'firma_nazvanie'),
              field('f', 'kod', 'firma_kod'),
              field('f', 'id_firmy')
          ],
          joins: [
              join('firmy', 'k.id_firmy = f.id_firmy', 'f')
          ]
      },
      buildWhere(filters) {
          const conditions = ['1=1'];
          const params = [];

          if (filters.id_firmy) {
              conditions.push('k.id_firmy = ?');
              params.push(filters.id_firmy);
          }
          if (filters.firma_kod) {
              conditions.push('f.kod = ?');
              params.push(filters.firma_kod);
          }
          if (filters.fio) {
              conditions.push('k.fio GLOB ?');
              params.push(cyrGlobPattern(filters.fio));
          }
          if (filters.email) {
              conditions.push('k.email GLOB ?');
              params.push(cyrGlobPattern(filters.email));
          }
          if (filters.aktivnost !== undefined && filters.aktivnost !== '') {
              conditions.push('k.aktivnost = ?');
              params.push(filters.aktivnost === '1' || filters.aktivnost === true ? 1 : 0);
          }
          if (filters.withEmail) {
              conditions.push("k.email IS NOT NULL AND k.email != ''");
          }
          // Для ПТО: только активные с email
          if (filters.ptoOnly) {
              conditions.push("k.aktivnost = 1 AND k.email IS NOT NULL AND k.email != ''");
          }

          return {
              where: conditions.join(' AND '),
              params,
              orderBy: 'k.fio'
          };
      }
  },

  // ==========================================================================
  // СПРАВОЧНИК АДРЕСОВ (adres.list)
  // Фильтры: id_firmy, fakt_adres
  // ==========================================================================
  'adres.list': {
      spec: {
          from: 'fakt_adres',
          alias: 'a',
          fields: [
              'a.*',
              field('f', 'naimenovanie', 'firma_nazvanie'),
              field('f', 'kod', 'firma_kod'),
              field('f', 'id_firmy')
          ],
          joins: [
              join('firmy', 'a.id_firmy = f.id_firmy', 'f')
          ]
      },
      buildWhere(filters) {
          const conditions = ['1=1'];
          const params = [];

          if (filters.id_firmy) {
              conditions.push('a.id_firmy = ?');
              params.push(filters.id_firmy);
          }
          if (filters.fakt_adres) {
              conditions.push('a.fakt_adres GLOB ?');
              params.push(cyrGlobPattern(filters.fakt_adres));
          }

          return {
              where: conditions.join(' AND '),
              params,
              orderBy: 'a.fakt_adres'
          };
      }
  },
  // ==========================================================================
  // СПРАВОЧНИК ПОЛЬЗОВАТЕЛЕЙ (users.list)
  // Фильтры: login, fio, role, aktivnost
  // ==========================================================================
  'users.list': {
      spec: {
          from: 'users',
          alias: 'u',
          fields: ['u.id', 'u.login', 'u.fio', 'u.role', 'u.aktivnost', 'u.last_login', 'u.created_at'],
          joins: []
      },
      buildWhere(filters) {
          const conditions = [];
          const params = [];

          if (filters.login) {
              conditions.push(raw('u.login GLOB ?'));
              params.push(cyrGlobPattern(filters.login));
          }
          if (filters.fio) {
              conditions.push(raw('u.fio GLOB ?'));
              params.push(cyrGlobPattern(filters.fio));
          }
          if (filters.role) {
              conditions.push(raw('u.role = ?'));
              params.push(filters.role);
          }
          if (filters.aktivnost !== undefined && filters.aktivnost !== null && filters.aktivnost !== '') {
              conditions.push(raw('u.aktivnost = ?'));
              params.push(filters.aktivnost === '1' || filters.aktivnost === true ? 1 : 0);
          }

          const { sql: whereSql, dependencies } = buildConditions(conditions);
          return {
              where: whereSql || '1=1',
              params,
              orderBy: 'u.login',
              dependencies
          };
      }
  },

  // ==========================================================================
  // ЛОГИ ДЕЙСТВИЙ (users.logs)
  // Фильтры: action, user_login
  // ==========================================================================
  'users.logs': {
    spec: {
      from: 'user_logs',
      alias: 'l',
      fields: ['l.id', 'l.created_at', 'l.user_id', 'l.user_login', 'l.action',
              'l.target_table', 'l.target_id', 'l.ip', 'l.details'],
      joins: []
    },
    buildWhere(filters) {
      const conditions = [];
      const params = [];
      if (filters.action) {
        conditions.push(raw('l.action = ?'));
        params.push(filters.action);
      }
      if (filters.user_login) {
        conditions.push(raw('l.user_login GLOB ?'));
        params.push(cyrGlobPattern(filters.user_login));
      }
      const { sql: whereSql, dependencies } = buildConditions(conditions);
      return { where: whereSql || '1=1', params, orderBy: 'l.created_at DESC', dependencies };
    }
  },
};

/**
 * Получить зависимости для синтетической таблицы
 */
function getDependencies(key) {
  const entry = SYNTHETIC_TABLES[key];
  if (!entry) return new Set();
  const { dependencies } = buildQuery(entry.spec);
  // Добавляем дополнительные зависимости из buildWhere (например, подзапросы)
  if (entry.buildWhere) {
    // Передаем фиктивные данные, чтобы функция вернула структуру с extraDeps
    const testResult = entry.buildWhere({ god: '2026' });
    if (testResult.extraDeps) {
      testResult.extraDeps.forEach(dep => dependencies.add(dep));
    }
  }
  return dependencies;
}

/**
 * Построить SQL для синтетической таблицы с фильтрами
 */
function buildSyntheticQuery(key, filters = {}) {
  const entry = SYNTHETIC_TABLES[key];
  if (!entry) throw new Error(`Синтетическая таблица "${key}" не найдена`);

  const base = buildQuery(entry.spec);

  if (entry.buildWhere) {
    const { where, params, orderBy, dependencies, extraDeps } = entry.buildWhere(filters);
    base.sql += ` WHERE ${where}`;
    base.params = [...base.params, ...params];
    if (orderBy) base.sql += ` ORDER BY ${orderBy}`;
    // ✅ Новые автоматические зависимости
    if (dependencies) {
      dependencies.forEach(dep => base.dependencies.add(dep));
    }
    // Обратная совместимость
    if (extraDeps) {
      extraDeps.forEach(dep => base.dependencies.add(dep));
    }
  }

  return base;
}

/**
 * Автоматически строит маппинг "базовая таблица → список синтетических таблиц"
 * на основе JOIN'ов и extraDeps из SYNTHETIC_TABLES.
 *
 * @returns {Object} { tableName: [syntheticKey1, syntheticKey2, ...] }
 */
function buildSubscriptionsFromSyntheticTables() {
  const subscriptions = {};

  for (const [syntheticKey, entry] of Object.entries(SYNTHETIC_TABLES)) {
    const deps = new Set();

    // 1. Основная таблица
    if (entry.spec.from) deps.add(entry.spec.from);

  // 2. Таблицы из JOIN'ов
  if (entry.spec.joins) {
    for (const j of entry.spec.joins) {
      if (typeof j.table === 'string') {
        // Обычное имя таблицы или сырой SQL
        if (!j.table.trim().startsWith('(')) {
        deps.add(j.table);
        }
      } else if (typeof j.table === 'object' && j.table !== null && typeof j.table.getDependencies === 'function') {
        // ✅ НОВОЕ: Это объект subquery() — добавляем его зависимости
        j.table.getDependencies().forEach(dep => deps.add(dep));
      }
    }
  }

    // 3. ✅ НОВОЕ: зависимости из buildWhere (через Condition-объекты)
    if (entry.buildWhere) {
      try {
        const testResult = entry.buildWhere({
          god: '2026', zakazId: 'test', direction: 'Исходящая',
          zaprosId: 'test',
          firma: 'test', nomer_chertezha: 'test',
          excludePlanIds: 'test1,test2',
          firmaId: 'test', nomerChertezha: 'test', naimenovanie: 'test',
          nomDogovor: 'test'
        });
        // ✅ Автоматически извлечённые зависимости из Condition-объектов
        if (testResult.dependencies) {
          testResult.dependencies.forEach(dep => deps.add(dep));
        }
        // Обратная совместимость: если кто-то ещё использует extraDeps
        if (testResult.extraDeps) {
          testResult.extraDeps.forEach(dep => deps.add(dep));
        }
      } catch (e) {
        // Игнорируем ошибки при тестовом вызове
      }
    }

    // 4. Добавляем syntheticKey в маппинг
    for (const dep of deps) {
      if (!subscriptions[dep]) subscriptions[dep] = [];
      if (!subscriptions[dep].includes(syntheticKey)) {
        subscriptions[dep].push(syntheticKey);
      }
    }
  }

  return subscriptions;
}

module.exports = {
  SYNTHETIC_TABLES,
  getDependencies,
  buildSyntheticQuery,
  buildSubscriptionsFromSyntheticTables  // ← ЭКСПОРТИРУЕМ
};