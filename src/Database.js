// src/Database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
    constructor(dbFile = 'firmy.db') {
        this.dbFile = dbFile;
        this.db = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbFile, (err) => {
                if (err) return reject(err);
                console.log('✅ Connected to SQLite:', this.dbFile);
                // ✅ T85: после схемы — ремонт данных (маршруты дочерних позиций)
                this.initTables()
                    .then(() => this.repairChildPlanRoutes())
                    .then(resolve)
                    .catch(reject);
            });
        });
    }

    initTables() {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {

                // ================================================================
                // БЛОК 1: АВТОРИЗАЦИЯ И АУДИТ
                // ================================================================

                this.db.run(`CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    login TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    fio TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'viewer',
                    aktivnost INTEGER DEFAULT 1,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    last_login TEXT
                )`);

                this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    token TEXT NOT NULL UNIQUE,
                    ip TEXT,
                    user_agent TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    expires_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);

                this.db.run(`CREATE TABLE IF NOT EXISTS roles (
                    name TEXT PRIMARY KEY,
                    description TEXT,
                    permissions TEXT NOT NULL DEFAULT '{}'
                )`);

                // ✅ ИСПРАВЛЕНО: добавлен FK на users(id)
                this.db.run(`CREATE TABLE IF NOT EXISTS user_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT,
                    user_login TEXT,
                    action TEXT NOT NULL,
                    target_table TEXT,
                    target_id TEXT,
                    ip TEXT,
                    user_agent TEXT,
                    details TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_user ON user_logs(user_id)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_time ON user_logs(created_at)`);

                // Seed ролей (расширенный: добавлены otk и aoutsorser)
                this.db.get('SELECT COUNT(*) as cnt FROM roles', [], async (err, row) => {
                    if (!err && row && row.cnt === 0) {
                        const roles = [
                            ['admin', 'Администратор', JSON.stringify({
                                pages: ['*'],
                                api: ['*']
                            })],
                            ['pto', 'ПТО', JSON.stringify({
                                pages: ['plan', 'grafik', 'requests', 'offers', 'route-editor',
                                        'orders', 'plan-perevozok', 'transport-ops', 'quality',
                                        'defects', 'payment', 'osnastka', 'cex', 'tech'],
                                api: ['*']
                            })],
                            ['otk', 'Контролёр ОТК', JSON.stringify({
                                pages: ['quality', 'defects'],
                                api: ['otk-zamery', 'braki', 'braki-files', 'transport-oper']
                            })],
                            ['teholog', 'Технолог', JSON.stringify({
                                pages: ['plan', 'grafik', 'requests', 'offers', 'route-editor',
                                        'defects', 'osnastka', 'cex', 'tech'],
                                api: ['plan', 'grafik', 'requests', 'kom-predl', 'zapros-kp',
                                      'routes', 'steps', 'operations', 'osnastka', 'cex', 'tech', 'braki']
                            })],
                            ['aoutsorser', 'Специалист по аутсорсингу', JSON.stringify({
                                pages: ['defects'],
                                api: ['braki']
                            })],
                            ['logist', 'Логист', JSON.stringify({
                                pages: ['plan-perevozok', 'transport-ops', 'carriers',
                                        'transport-types', 'orders'],
                                api: ['plan-perevozok', 'transport-oper', 'perevozchik',
                                      'transport_types', 'zakaz-dog']
                            })],
                            ['viewer', 'Только просмотр', JSON.stringify({ pages: [], api: [] })]
                        ];
                        const stmt = this.db.prepare('INSERT OR IGNORE INTO roles VALUES (?,?,?)');
                        roles.forEach(r => stmt.run(r));
                        stmt.finalize();
                        console.log('✅ Seed: 7 ролей добавлено');
                    }
                });

                // Seed админа + seed пользователей ОТК/технолога/аутсорсера
                this.db.get('SELECT COUNT(*) as cnt FROM users', [], async (err, row) => {
                    if (!err && row && row.cnt === 0) {
                        const crypto = require('crypto');
                        const mk = (p) => crypto.createHash('sha256').update(p).digest('hex');
                        await this.db.run(
                            'INSERT INTO users (id, login, password_hash, fio, role) VALUES (?,?,?,?,?)',
                            ['U_admin', 'admin', mk('admin123'), 'Администратор Системы', 'admin']
                        );
                        const seeds = [
                            ['U_otk1',   'otk1',   mk('otk1'),   'Иванов Иван Иванович',    'otk'],
                            ['U_teh1',   'teh1',   mk('teh1'),   'Петров Пётр Петрович',    'teholog'],
                            ['U_aouts1', 'aouts1', mk('aouts1'), 'Сидоров Сидор Сидорович', 'aoutsorser'],
                        ];
                        for (const s of seeds) {
                            await this.db.run(
                                'INSERT OR IGNORE INTO users (id, login, password_hash, fio, role, aktivnost) VALUES (?,?,?,?,?,1)', s);
                        }
                        console.log('✅ Seed: пользователь admin создан (пароль: admin123); otk1/teh1/aouts1 (пароли = логины)');
                    }
                });

                // ================================================================
                // БЛОК 2: СПРАВОЧНИКИ КОНТРАГЕНТОВ
                // ================================================================

                this.db.run(`CREATE TABLE IF NOT EXISTS firmy (
                    id_firmy TEXT PRIMARY KEY, kod TEXT NOT NULL,
                    naimenovanie TEXT NOT NULL, inn TEXT NOT NULL, ur_adres TEXT
                )`);

                this.db.run(`CREATE TABLE IF NOT EXISTS fakt_adres (
                    id_adres TEXT PRIMARY KEY, id_firmy TEXT NOT NULL, fakt_adres TEXT,
                    FOREIGN KEY(id_firmy) REFERENCES firmy(id_firmy) ON DELETE CASCADE
                )`);

                this.db.run(`CREATE TABLE IF NOT EXISTS kont (
                    id_kont TEXT PRIMARY KEY, id_firmy TEXT NOT NULL,
                    fio TEXT, tel TEXT, email TEXT, aktivnost INTEGER DEFAULT 1,
                    FOREIGN KEY(id_firmy) REFERENCES firmy(id_firmy) ON DELETE CASCADE
                )`);

                this.db.run(`CREATE TABLE IF NOT EXISTS dogovor (
                    id_dogovor TEXT PRIMARY KEY, id_firmy TEXT NOT NULL,
                    nom_dogovor TEXT, data_dogovor TEXT, data_ok TEXT, rasch_schet TEXT,
                    ssylka_na_dok TEXT, id_vid_rabot TEXT, predoplata_pr TEXT,
                    id_predoplata_yclov TEXT, predoplata_data TEXT, hdc TEXT,
                    ctoimost TEXT, priemka_data TEXT, oplata_rabot_data TEXT,
                    otschet_priemka TEXT, otschet_oplata TEXT, data_oplata_avanca TEXT,
                    FOREIGN KEY(id_firmy) REFERENCES firmy(id_firmy) ON DELETE CASCADE
                )`);

                // ================================================================
                // БЛОК 3: ОСНАСТКА И ТЕХНОЛОГИ (СПРАВОЧНИКИ)
                // ================================================================

                this.db.run(`CREATE TABLE IF NOT EXISTS osnastka (
                    id TEXT PRIMARY KEY,
                    nomer_chertezha TEXT NOT NULL UNIQUE,
                    naimenovanie TEXT,
                    avto_mob_det TEXT,
                    ves_det TEXT,
                    ves_zag TEXT,
                    trudoemkost_pto TEXT,
                    dlina TEXT,
                    shirina TEXT,
                    vysota TEXT,
                    nitrocementaciya INTEGER DEFAULT 0,
                    zakalka INTEGER DEFAULT 0,
                    ppd INTEGER DEFAULT 0,
                    pokrytie INTEGER DEFAULT 0,
                    tisnenie INTEGER DEFAULT 0,
                    cena_zagotovki REAL DEFAULT 0,
                    trudoemkost_frez_universal REAL DEFAULT 0,
                    trudoemkost_frez_chpu REAL DEFAULT 0,
                    trudoemkost_tokarn REAL DEFAULT 0,
                    trudoemkost_tokarn_chpu REAL DEFAULT 0,
                    marka_materiala TEXT DEFAULT '' -- T56-b: марка материала, заложенная конструктором
                )`);

                this.db.run(`CREATE TABLE IF NOT EXISTS cex_zatrat (
                    id TEXT PRIMARY KEY,
                    ceh TEXT NOT NULL,
                    peredel TEXT NOT NULL,
                    nazvanie TEXT NOT NULL,
                    nach_ceha TEXT,
                    telefon TEXT,
                    email TEXT
                )`);

                this.db.run(`CREATE TABLE IF NOT EXISTS tech (
                    id TEXT PRIMARY KEY,
                    fio TEXT NOT NULL,
                    email TEXT,
                    telefon TEXT,
                    tip_osnastki TEXT
                )`);

                this.db.run(`CREATE TABLE IF NOT EXISTS perevozchik (
                    id TEXT PRIMARY KEY,
                    marka_tc TEXT,
                    gos_n TEXT,
                    vodit_ud TEXT,
                    fio_vodit TEXT,
                    kontakt TEXT,
                    firma TEXT
                )`);
                this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_perevozchik_gos_ud ON perevozchik(gos_n, vodit_ud)`);

                this.db.run(`CREATE TABLE IF NOT EXISTS sprav_uslov (
                    id_usloviya TEXT PRIMARY KEY, soderzhanie TEXT, kategoriya TEXT
                )`);

                // src/Database.js — добавить в initTables() после sprav_uslov

                // ================================================================
                // БЛОК 3.1: ВИДЫ РАБОТ ПО ДОГОВОРАМ
                // ================================================================
                // Справочник видов работ (общий, для выбора при добавлении в договор)
                this.db.run(`CREATE TABLE IF NOT EXISTS sprav_vidy_rabot (
                id TEXT PRIMARY KEY,
                naimenovanie TEXT NOT NULL UNIQUE
                )`);

                // Виды работ конкретного договора с ценой н/ч
                this.db.run(`CREATE TABLE IF NOT EXISTS vidy_rabot_dogovor (
                    id TEXT PRIMARY KEY,
                    id_dogovor TEXT NOT NULL,
                    id_sprav_vid TEXT,
                    naimenovanie TEXT NOT NULL,
                    stoimost REAL DEFAULT 0,
                    FOREIGN KEY(id_dogovor) REFERENCES dogovor(id_dogovor) ON DELETE CASCADE,
                    FOREIGN KEY(id_sprav_vid) REFERENCES sprav_vidy_rabot(id)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_vrd_dogovor ON vidy_rabot_dogovor(id_dogovor)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_vrd_sprav ON vidy_rabot_dogovor(id_sprav_vid)`);

                // Seed справочника видов работ (из ТЗ)
                this.db.get('SELECT COUNT(*) as cnt FROM sprav_vidy_rabot', [], (err, row) => {
                if (!err && row && row.cnt === 0) {
                    const seed = [
                    'Фрезерная обработка с ЧПУ (габарит стола 850х500)',
                    'Фрезерная обработка с ЧПУ (габарит стола 1050х600)',
                    'Фрезерная обработка с ЧПУ (габарит стола 1400х700)',
                    'Фрезерная обработка с ЧПУ (габарит стола 1800х3100)',
                    'Фрезерная обработка универсальная',
                    'Электроэрозионная обработка',
                    'Слесарно-сборочные работы',
                    'Шлифовка',
                    'Токарная обработка универсальная',
                    'Токарная обработка на станке ЧПУ',
                    ];
                    const stmt = this.db.prepare('INSERT OR IGNORE INTO sprav_vidy_rabot (id, naimenovanie) VALUES (?, ?)');
                    seed.forEach((name, i) => stmt.run(`SVR_${String(i + 1).padStart(3, '0')}`, name));
                    stmt.finalize();
                    console.log('✅ Seed: 10 видов работ добавлено в справочник');
                }
                });

                // Типы перевозок (справочник с бизнес-ключом)
                this.db.run(`CREATE TABLE IF NOT EXISTS transport_types (
                    id_tipa TEXT PRIMARY KEY,
                    nazvanie_operatsii TEXT NOT NULL,
                    napravlenie TEXT NOT NULL,
                    uchet_v_ostatke INTEGER NOT NULL
                )`);

                this.db.get('SELECT COUNT(*) as cnt FROM transport_types', [], (err, row) => {
                    if (!err && row && row.cnt === 0) {
                        const seed = [
                            ['OUT_BL',  'Отправка заготовки',                            'Исходящая',  1],
                            ['IN_PF',   'Получение полуфабриката на выполнение опреаций ПТО', 'Входящая', -1],
                            ['OUT_PF',  'Отправка полуфабриката',                        'Исходящая',  1],
                            ['IN_GOOD', 'Получение готовой продукции',                   'Входящая',  -1],
                            ['OUT_DEF', 'Отправка брака окончательного',                 'Исходящая',  1],
                            ['IN_TO',   'Получение на TO',                               'Входящая',  -1],
                            ['OUT_TO',  'Отправка после TO',                             'Исходящая',  1],
                            ['OUT_REW', 'Отправка брака на доработку',                   'Исходящая',  1]
                        ];
                        const stmt = this.db.prepare('INSERT OR IGNORE INTO transport_types VALUES (?,?,?,?)');
                        seed.forEach(r => stmt.run(r));
                        stmt.finalize();
                        console.log('✅ Seed: 8 типов перевозок добавлено');
                    }
                });

                // ================================================================
                // БЛОК 4: ПЛАН ПРОИЗВОДСТВА И ГРАФИК
                // ================================================================
                this.db.run(`CREATE TABLE IF NOT EXISTS plan (
                    id TEXT PRIMARY KEY,
                    god TEXT NOT NULL,
                    id_osnastka TEXT NOT NULL,
                    id_kp TEXT,
                    cena_pto TEXT,
                    plan_god_kolvo TEXT NOT NULL,
                    stoim_zagot TEXT,
                    zak_pto TEXT,
                    data_zak TEXT,
                    kol_fakt_got TEXT,
                    data_yes_zagot TEXT,
                    cex_zatrat TEXT,
                    peredel TEXT,
                    stat_poz TEXT,
                    plan_izgot TEXT,
                    primechanie TEXT,
                    n_nazv_osnovn_det_zakaza TEXT,

                    -- ✅ ТИПЫ ГРУЗА: параметры раскроя заготовки по позиции плана.
                    -- Пустые поля = деталь/заготовка ШТУЧНЫЕ (расчёт на поддонах)
                    list_dlina TEXT,     -- длина листа, мм (из которого рубится деталь)
                    list_shirina TEXT,   -- ширина листа, мм
                    list_tolshina TEXT,  -- толщина листа, мм
                    prutok_dlina TEXT,   -- длина прутка, мм (из которого режется деталь)
                    
                    -- ✅ НОВЫЕ СЛУЖЕБНЫЕ ПОЛЯ (для механизма разделения при выборе лучших КП)
                    parent_plan_id TEXT,              -- ID родительской позиции (для дочерних)
                    zapros_kp_id TEXT,                -- ID запроса КП, создавшего эту позицию
                    split_group TEXT,                 -- Группа разделения: 'Полные операции' / 'Частичные операции' / 'Нет КП'
                    split_reason TEXT,                -- Причина: 'по мощности' / 'нет КП'
                    is_child_plan INTEGER DEFAULT 0,  -- 1 = это дочерняя позиция (создана разделением)
                    is_no_kp_plan INTEGER DEFAULT 0,  -- 1 = позиция без КП (остаток после распределения)
                    
                    FOREIGN KEY(id_osnastka) REFERENCES osnastka(id),
                    FOREIGN KEY(parent_plan_id) REFERENCES plan(id),
                    FOREIGN KEY(zapros_kp_id) REFERENCES zapros_kp(id)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_plan_parent ON plan(parent_plan_id)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_plan_zapros ON plan(zapros_kp_id)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_plan_is_child ON plan(is_child_plan)`);

                this.db.run(`CREATE TABLE IF NOT EXISTS grafik (
                    id TEXT PRIMARY KEY,
                    id_plana TEXT NOT NULL,
                    etap_nomer TEXT NOT NULL,
                    plan_data TEXT,
                    plan_kolvo TEXT,
                    fact_data TEXT,
                    fact_kolvo TEXT,
                    status_etapa TEXT,
                    primechanie TEXT,
                    FOREIGN KEY(id_plana) REFERENCES plan(id) ON DELETE CASCADE
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_grafik_plan ON grafik(id_plana)`);

                // ================================================================
                // БЛОК 5: ЗАПРОСЫ И КП
                // ================================================================

           		// zapros_kp — заменить email_tehnologa на id_tehnologa
				this.db.run(`CREATE TABLE IF NOT EXISTS zapros_kp (
					id TEXT PRIMARY KEY,
					n_zaprosa TEXT NOT NULL,
					data_form TEXT NOT NULL,
					data_peredach_tehnologu TEXT,
					id_tehnologa TEXT,             
					kommentariy TEXT,
					ssylka_na_chertezh TEXT,
					srok_predostavleniya_kp TEXT,
					data_otv_tehnolog TEXT,
					statys TEXT DEFAULT 'создание',
					date_url_update TEXT,

					-- ✅ T51: согласование структурным подразделением АВТОВАЗа перенесено
					--   сюда из zakaz_po_dogovoru: на согласование направляется сводная
					--   таблица КП с лучшими предложениями (страница «Внесение
					--   коммерческих предложений»), поэтому согласование привязано
					--   к ЗАПРОСУ КП, а не к заказу.
					n_sogl_avtovaz TEXT,
					statys_sogl_avtovaz TEXT,
					id_doc_edo TEXT,
					UNIQUE(n_zaprosa, data_form),
					FOREIGN KEY(id_tehnologa) REFERENCES tech(id)  -- ← НОВОЕ
				)`);

				this.db.run(`CREATE TABLE IF NOT EXISTS kp (
                    id TEXT PRIMARY KEY,
                    id_plana TEXT,
                    id_zaprosa_kp TEXT,
                    id_firma TEXT,
                    id_dogovor TEXT,
                    trudoemkost_postavshika TEXT,
                    cena_postavshika TEXT,
                    moshchnost_kolvo TEXT,
                    srok_vipolneniya TEXT,
                    tip_izgotovleniya TEXT,
                    reshenie TEXT,
                    primechanie_kp TEXT,   -- ✅ НОВОЕ: комментарий к назначению лучшего КП
                                            --   'лучшее предложение по цене' — автоназначение
                                            --   произвольный текст — ручное назначение (обязательно)
                    date_otv TEXT,
                    link_dok TEXT,
                    email_otpravki TEXT,
                    date_otpravki TEXT,
                    isklyuchen TEXT,
                    FOREIGN KEY(id_zaprosa_kp) REFERENCES zapros_kp(id) ON DELETE CASCADE,
                    FOREIGN KEY(id_plana) REFERENCES plan(id),
                    FOREIGN KEY(id_firma) REFERENCES firmy(id_firmy)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_kp_zapros ON kp(id_zaprosa_kp)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_kp_plan ON kp(id_plana)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_kp_firma ON kp(id_firma)`);
                // ============================================================
                // ✅ T48: ТКПоснование — основания (PDF-документы) от фирм
                //   по запросам КП. Одно основание на пару «запрос КП + фирма»
                //   (id_zaprosa_kp + id_firma — ключевые поля), документ
                //   относится ко ВСЕМ деталям запроса этой фирмы.
                //   Файлы хранятся на сервере в структуре:
                //     public/запросы/<год запроса>/<номер запроса>/<файл>.pdf
                //   ssylka — относительный путь (для ссылки «открыть документ»),
                //   imya_fayla — исходное имя файла, data_zagruzki — когда загружен.
                // ============================================================
                this.db.run(`CREATE TABLE IF NOT EXISTS "ТКПоснование" (
                    id TEXT PRIMARY KEY,
                    id_zaprosa_kp TEXT NOT NULL,
                    id_firma TEXT NOT NULL,
                    ssylka TEXT,
                    imya_fayla TEXT,
                    data_zagruzki TEXT,
                    UNIQUE(id_zaprosa_kp, id_firma),
                    FOREIGN KEY(id_zaprosa_kp) REFERENCES zapros_kp(id) ON DELETE CASCADE,
                    FOREIGN KEY(id_firma) REFERENCES firmy(id_firmy)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_tkp_osn_zapros ON "ТКПоснование"(id_zaprosa_kp)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_tkp_osn_firma ON "ТКПоснование"(id_firma)`);

                // ✅ НОВОЕ: миграция — добавляем колонку primechanie_kp, если её нет
                // (для существующих баз, созданных до этого изменения)
                this.db.all(`PRAGMA table_info(kp)`, [], (err, rows) => {
                    if (err) return console.error('[Database] PRAGMA table_info(kp):', err.message);
                    const hasCol = Array.isArray(rows) && rows.some(r => r.name === 'primechanie_kp');
                    if (!hasCol) {
                        this.db.run(`ALTER TABLE kp ADD COLUMN primechanie_kp TEXT`,
                            (e) => {
                                if (e) console.error('[Database] ALTER TABLE kp ADD primechanie_kp:', e.message);
                                else console.log('[Database] ✅ Колонка kp.primechanie_kp добавлена (миграция)');
                            });
                    }
                });

                // ================================================================
                // БЛОК 6: МАРШРУТЫ (НОВАЯ СТРУКТУРА!)
                // ================================================================

                // ✅ ИЗМЕНЕНО: убран ids_oper, добавлен FK на id_det → plan(id)
                this.db.run(`CREATE TABLE IF NOT EXISTS shagi_marshruta (
                    id_shag TEXT PRIMARY KEY,
                    id_det TEXT NOT NULL,
                    nom_shag INTEGER NOT NULL,
                    exec_shag TEXT NOT NULL,
                    comm_shag TEXT,
                    id_tipa_perevozki TEXT NOT NULL,
                    FOREIGN KEY(id_det) REFERENCES plan(id) ON DELETE CASCADE,
                    FOREIGN KEY(id_tipa_perevozki) REFERENCES transport_types(id_tipa)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_shagi_det ON shagi_marshruta(id_det)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_shagi_nom ON shagi_marshruta(id_det, nom_shag)`);

                // ✅ ИЗМЕНЕНО: добавлен id_shag, убраны stat_oper/dt_start_oper/dt_end_oper
                this.db.run(`CREATE TABLE IF NOT EXISTS operatsii_marshruta (
                    id_oper TEXT PRIMARY KEY,
                    id_shag TEXT NOT NULL,
                    naim_oper TEXT NOT NULL,
                    FOREIGN KEY(id_shag) REFERENCES shagi_marshruta(id_shag) ON DELETE CASCADE
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_oper_shag ON operatsii_marshruta(id_shag)`);

                // ================================================================
                // БЛОК 7: ПЛАН ПЕРЕВОЗОК (НОВАЯ СТРУКТУРА!)
                // ================================================================

                // ✅ ИЗМЕНЕНО: убран id_tipa_perevozki (берётся через JOIN с shagi_marshruta)
                // ✅ ИЗМЕНЕНО: id_plana теперь nullable (может быть пустым для перевозок брака)
                // ⚠️ id_brak без FK (циклическая зависимость с braki), валидация в planPerevozokRoutes.js
                this.db.run(`CREATE TABLE IF NOT EXISTS plan_perevozok (
                    id TEXT PRIMARY KEY,
                    id_plana TEXT,
                    id_brak TEXT,
                    plan_data TEXT NOT NULL,
                    id_shag TEXT NOT NULL,
                    kolvo_no_br REAL DEFAULT 0,
                    kolvo_yes_br REAL DEFAULT 0,
                    statys TEXT DEFAULT '',
                    dog_osnov TEXT,
                    FOREIGN KEY(id_plana) REFERENCES plan(id),
                    FOREIGN KEY(id_shag) REFERENCES shagi_marshruta(id_shag)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_plan_perevozok_plana ON plan_perevozok(id_plana)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_plan_perevozok_shag ON plan_perevozok(id_shag)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_plan_perevozok_brak ON plan_perevozok(id_brak)`);

                // ================================================================
                // БЛОК 8: ТРАНСПОРТНЫЕ ОПЕРАЦИИ И ГРУЗОВЫЕ ПОЗИЦИИ
                // ================================================================

                this.db.run(`CREATE TABLE IF NOT EXISTS transport_oper (
                    id TEXT PRIMARY KEY,
                    napravlenie TEXT NOT NULL,
                    id_firma TEXT,
                    gruz_name TEXT,
                    opasnost_class TEXT,
                    tarn_places TEXT,
                    dlina_m TEXT,
                    shirina_m TEXT,
                    vysota_m TEXT,
                    obem_m3 TEXT,
                    shtabil_gryz TEXT,
                    brutto_ves_kg TEXT,
                    otgruzka_data TEXT,
                    otgruzka_vremya TEXT,
                    pribytie_data TEXT,
                    pribytie_vremya TEXT,
                    nomer_reisa TEXT,
                    transport_tip TEXT,
                    zagruzka_sposob TEXT,
                    temp_rezhim TEXT,
                    tn_oformlenie TEXT,
                    kommentariy TEXT,
                    platelshchik TEXT,
                    stoimost_perovozki TEXT,
                    form_m15upd TEXT,
                    tn_nomer TEXT,
                    id_perevozchik TEXT,
                    zatrata_prisvoenie TEXT,
                    sz_transport_nomer TEXT,
                    sz_transport_data TEXT,
                    sz_sb_otgruzka TEXT,
                    sz_sb_otgruzka_data TEXT, -- ✅ T42: дата СЗ в СБ об отгрузке
                    sz_sb_id TEXT,           -- ✅ T42: d_kod СЗ в СБ в ЭДО (защищено от формы — как sz_transport_id)
                    sz_transport_id TEXT,
                    status TEXT DEFAULT 'Новая',
                    otv_pto_fio TEXT,
                    otv_pog_pto_fio TEXT,
                    otv_pog_firm_fio TEXT,
                    adres_pog_firm TEXT,
                    cex_izgot TEXT,
                    vid_gruza TEXT,          -- ✅ тип груза: tara/listy/prutki (ДЕТАЛИ на дерев. таре / ЗАГОТОВКИ в листах / в прутках)
                    FOREIGN KEY(id_firma) REFERENCES firmy(id_firmy),
                    FOREIGN KEY(id_perevozchik) REFERENCES perevozchik(id)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_transport_oper_firma ON transport_oper(id_firma)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_transport_oper_napravlenie ON transport_oper(napravlenie)`);

                this.db.run(`CREATE TABLE IF NOT EXISTS gryz_poz (
                    id TEXT PRIMARY KEY,
                    id_transporta TEXT NOT NULL,
                    id_plana TEXT NOT NULL,
                    id_oplata_rabot TEXT, -- ✅ T102: оплата работ, привязанная к этой грузовой позиции (1 оплата — много позиций)
                    kolvo_no_br REAL DEFAULT 0,
                    kolvo_yes_br REAL DEFAULT 0,
                    kolvo_zagotovok TEXT, -- T24B: кол-во заготовок ЭТОЙ грузовой позиции (партию плана возят частями); пусто = авто по раскрою
                    marka_materiala TEXT, -- T56-b: марка материала ФАКТ (что везём); пусто = марка оснастки
                    primechanie TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(id_transporta) REFERENCES transport_oper(id) ON DELETE CASCADE,
                    FOREIGN KEY(id_plana) REFERENCES plan_perevozok(id)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_gryz_poz_transporta ON gryz_poz(id_transporta)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_gryz_poz_plana ON gryz_poz(id_plana)`);
                // ✅ T102: индекс gryz_poz.id_oplata_rabot создаёт колбэк
                // ensureColT102 (ниже) — и для новых, и для существующих БД

                // ================================================================
                // ✅ T37-B: ОТКАТ T37 — служебная записка создаётся в ЭДО
                // АВТОВАЗа (tportal.vaz.ru, модуль helpers/edoPortal.js).
                // В БД хранятся только поля transport_oper:
                //   sz_transport_nomer — номер СЗ (в шаблон заявки);
                //   sz_transport_data  — дата СЗ (в шаблон заявки);
                //   sz_transport_id    — d_kod документа (переход в ИДО:
                //                        docs.vaz.ru/main.aspx?d_kod=ID).
                // Таблица dok_sz из ошибочной реализации T37 удаляется.
                // ================================================================
                this.db.run(`DROP TABLE IF EXISTS dok_sz`);
                // ✅ ТИПЫ ГРУЗА: миграции для существующих БД
                // (базы, созданные до появления параметров раскроя)
                const ensureCol = (table, col, type) => {
                    this.db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
                        if (err) return console.error(`[Database] PRAGMA table_info(${table}):`, err.message);
                        const has = Array.isArray(rows) && rows.some(r => r.name === col);
                        if (!has) {
                            this.db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`, (e) => {
                                if (e) console.error(`[Database] ALTER TABLE ${table} ADD ${col}:`, e.message);
                                else console.log(`[Database] ✅ Колонка ${table}.${col} добавлена (миграция)`);
                            });
                        }
                    });
                };
                ensureCol('plan', 'list_dlina', 'TEXT');
                ensureCol('plan', 'list_shirina', 'TEXT');
                ensureCol('plan', 'list_tolshina', 'TEXT');
                ensureCol('plan', 'prutok_dlina', 'TEXT');
                // T24B: кол-во заготовок — атрибут ГРУЗОВОЙ позиции (gryz_poz),
                // не позиции плана: партию плана возят частями (по рейсам),
                // и у каждой части своё количество заготовок.
                ensureCol('gryz_poz', 'kolvo_zagotovok', 'TEXT');
                // T56-b: марка материала — надёжность группировки листов при раскрое:
                // конструкторская марка — в оснастке, факт (что везём) — в грузовой позиции
                ensureCol('osnastka', 'marka_materiala', "TEXT DEFAULT ''");
                ensureCol('gryz_poz', 'marka_materiala', "TEXT DEFAULT ''");
                // ✅ T78: требование запроса «все позиции изготавливаются
                // комплектом» (не допускается разбивать партию) — чекбокс
                // на странице «Внесение КП», колонка «Лучшее предложение»,
                // итоги по фирмам и диаграмма учитывают это требование
                ensureCol('zapros_kp', 'komplekt', 'INTEGER DEFAULT 0');
                // ✅ T84: фирма — ГОРод и ЦЕНА ПЕРЕВОЗКИ (подготовка учёта
                // стоимости перевозки партии деталей при выборе лучшего КП)
                ensureCol('firmy', 'gorod', "TEXT DEFAULT ''");
                ensureCol('firmy', 'cena_perevozki', "TEXT DEFAULT ''");
                ensureCol('transport_oper', 'vid_gruza', "TEXT DEFAULT ''");
                // ✅ T42: СЗ в СБ об отгрузке — дата письма и d_kod созданного документа
                ensureCol('transport_oper', 'sz_sb_otgruzka_data', "TEXT DEFAULT ''");
                ensureCol('transport_oper', 'sz_sb_id', "TEXT DEFAULT ''");

                // ✅ T57: ТИП ГРУЗА на каждой грузовой позиции (всего 3 типа) +
                // параметры по типу + ручная УКЛАДКА внутри деревянной тары.
                // Листовые параметры (list_dlina/list_shirina/list_tolshina)
                // и prutok_dlina остаются в plan (общие для рейсов); марка — факт
                // в gryz_poz.marka_materiala (T56-b).
                ensureCol('gryz_poz', 'tip_gruza', "TEXT DEFAULT ''");        // listy | prutki | zagotovki
                ensureCol('gryz_poz', 'prutok_diametr', 'TEXT');              // Ø прутка, мм (сечение связки)
                ensureCol('gryz_poz', 'tara_dlina', 'TEXT');                  // габарит тары/поддона, мм
                ensureCol('gryz_poz', 'tara_shirina', 'TEXT');
                ensureCol('gryz_poz', 'tara_vysota', 'TEXT');
                ensureCol('gryz_poz', 'ukladka', "TEXT DEFAULT ''");          // sloy | piramida | stoyma (ручной параметр позиции)
                // ✅ T57: ТАРНЫЕ МЕСТА ПЕРЕВОЗКИ (группы по типам) — JSON в transport_oper.
                // [{tip,name,dlina_m,shirina_m,vysota_m,shtabil,kolvo,ves_kg,
                //   ukladka,pozcii:[id]}]. Источник — модальный диалог
                // «Расчёт тарных мест»; строки СЗ на транспорт строятся из него.
                ensureCol('transport_oper', 'tarn_mesta', "TEXT DEFAULT ''");

                // ✅ T51: согласование АВТОВАЗа перенесено из zakaz_po_dogovoru в zapros_kp
                ensureCol('zapros_kp', 'n_sogl_avtovaz', 'TEXT');
                ensureCol('zapros_kp', 'statys_sogl_avtovaz', 'TEXT');
                ensureCol('zapros_kp', 'id_doc_edo', 'TEXT');

                // T24B: план-колонка kolvo_zagotovok из T24 более не используется —
                // значение хранится в gryz_poz. Пробуем удалить её из БД, где
                // T24 успел создать (нужен SQLite >= 3.35; иначе просто не используется).
                this.db.get(`SELECT COUNT(*) AS c FROM pragma_table_info('plan') WHERE name = 'kolvo_zagotovok'`, (e, r) => {
                    if (!e && r && r.c > 0) {
                        this.db.run('ALTER TABLE plan DROP COLUMN kolvo_zagotovok', (e2) => {
                            if (e2) console.log('[Database] plan.kolvo_zagotovok не удалена (старый SQLite) — колонка больше не используется');
                            else console.log('[Database] ✅ plan.kolvo_zagotovok удалена (T24B: перенесена в gryz_poz)');
                        });
                    }
                });

                // ✅ T51: согласование структурного подразделения АВТОВАЗа — теперь
                // свойство ЗАПРОСА КП (на согласование уходит сводная таблица КП с
                // лучшими предложениями). Колонки n_sogl_avtovaz/statys_sogl_avtovaz/
                // id_doc_edo перенесены в zapros_kp (ensureCol выше) и из
                // zakaz_po_dogovoru удаляются (нужен SQLite >= 3.35; иначе колонки
                // просто больше не используются — код их не читает и не пишет).
                this.db.get(`SELECT COUNT(*) AS c FROM pragma_table_info('zakaz_po_dogovoru') WHERE name IN ('n_sogl_avtovaz', 'statys_sogl_avtovaz', 'id_doc_edo')`, (e, r) => {
                    if (!e && r && r.c > 0) {
                        const dropOldSogl = (col, done) => {
                            this.db.get(`SELECT COUNT(*) AS c FROM pragma_table_info('zakaz_po_dogovoru') WHERE name = ?`, [col], (e3, r3) => {
                                if (e3 || !r3 || !r3.c) return done();
                                this.db.run(`ALTER TABLE zakaz_po_dogovoru DROP COLUMN ${col}`, (e2) => {
                                    if (e2) console.log(`[Database] zakaz_po_dogovoru.${col} не удалена (старый SQLite) — колонка больше не используется`);
                                    else console.log(`[Database] ✅ zakaz_po_dogovoru.${col} удалена (T51: перенесена в zapros_kp)`);
                                    done();
                                });
                            });
                        };
                        dropOldSogl('n_sogl_avtovaz', () => dropOldSogl('statys_sogl_avtovaz', () => dropOldSogl('id_doc_edo', () => {})));
                    }
                });

                // ================================================================
                // БЛОК 9: БРАК И ЕГО WORKFLOW (РАСШИРЕННАЯ СТРУКТУРА!)
                // ================================================================

                // ✅ РАСШИРЕНО: добавлены поля для workflow ОТК → технолог → аутсорсер
                this.db.run(`CREATE TABLE IF NOT EXISTS braki (
					id_braka TEXT PRIMARY KEY,
					id_gp TEXT NOT NULL,                    -- ссылка на партию (gryz_poz)
					zabrakovano_sht INTEGER NOT NULL DEFAULT 0,
					
					-- ================================================================
					-- БЛОК КОНТРОЛЁРА ОТК (выявление)
					-- ================================================================
					id_kontrolera TEXT,                     -- кто выявил (users.id)
					data_zamera TEXT,                       -- когда замеряли
					kommentariy_kontrolera TEXT,
					
					-- ================================================================
					-- WORKFLOW (управление процессом)
					-- ================================================================
					status_workflow TEXT DEFAULT 'vyavlen', -- 'vyavlen' -> 'peredan_tehnologu' -> 'reshenie_prinyato' -> 'zakryt'
					data_peredachi_tehnologu TEXT,          -- когда передан технологу
					data_polucheniya_tehnologom TEXT,       -- когда технолог получил
					
					-- ================================================================
					-- ССЫЛКА НА АКТУАЛЬНОЕ РЕШЕНИЕ ТЕХНОЛОГА
					-- ================================================================
					id_resheniya TEXT,                      -- ← ссылка на resheniya_tehnologa
					
					-- ================================================================
					-- ЗАКРЫТИЕ
					-- ================================================================
					data_zakrytiya TEXT,
					
					FOREIGN KEY (id_gp) REFERENCES gryz_poz(id),
					FOREIGN KEY (id_kontrolera) REFERENCES users(id),
					FOREIGN KEY (id_resheniya) REFERENCES resheniya_tehnologa(id)
				)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_braki_gp ON braki(id_gp)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_braki_workflow ON braki(status_workflow)`);

				
				this.db.run(`-- Таблица решений технолога (1:N с braki)
					CREATE TABLE IF NOT EXISTS resheniya_tehnologa (
					id TEXT PRIMARY KEY,
					id_braka TEXT NOT NULL,                 -- ссылка на брак
					id_tehnologa TEXT NOT NULL,             -- кто принял решение (users.id)
					
					data_priyoma TEXT,                      -- когда технолог принял в работу
					data_resheniya TEXT NOT NULL,           -- когда вынес решение
					
					-- ================================================================
					-- ТИП РЕШЕНИЯ
					-- ================================================================
					tip_resheniya TEXT NOT NULL CHECK (tip_resheniya IN (
						'spisat_okonchatelno',      -- брак окончательный, утилизируем
						'otpravit_podryadchiku',    -- вернуть подрядчику на переделку
						'peredelat_v_pto',          -- переделать силами ПТО
						'dopustit_kak_godnoe'       -- использовать как годное
					)),
					
					kommentariy TEXT,                       -- заключение технолога
					
					-- ================================================================
					-- АТРИБУТЫ ДЛЯ РАЗНЫХ ТИПОВ РЕШЕНИЙ
					-- ================================================================
					
					-- Для 'otpravit_podryadchiku':
					kto_oplachivaet_transport TEXT,         -- 'подрядчик' / 'заказчик'
					srok_vozvrata TEXT,                     -- крайний срок возврата
					
					-- Для 'peredelat_v_pto':
					id_cex_izgotovitel TEXT,                -- какой цех ПТО переделывает
					data_peredachi_v_cex TEXT,              -- когда передано в цех
					
					-- Для 'spisat_okonchatelno':
					summa_uscherba REAL DEFAULT 0,          -- стоимость ущерба
					kto_neset_ubutki TEXT,                  -- 'подрядчик' / 'заказчик'
					
					-- ================================================================
					-- СТАТУС РЕШЕНИЯ
					-- ================================================================
					status_resheniya TEXT DEFAULT 'aktivno' CHECK (status_resheniya IN (
						'aktivno',                  -- действующее решение
						'otmeneno',                 -- отменено (появилось новое)
						'ispolneno'                 -- исполнено
					)),
					
					-- ================================================================
					-- СВЯЗЬ С ПЕРЕВОЗКОЙ БРАКА (если создана)
					-- ================================================================
					id_plan_perevozok_vozvrata TEXT,        -- план перевозки, созданный по этому решению
					
					-- ================================================================
					-- ДОКУМЕНТЫ И АУДИТ
					-- ================================================================
					nomer_pisma_kontragentu_o_brake TEXT,   -- номер письма подрядчику
					chya_povtornaya_zagotovka TEXT,         -- чья повторная заготовка
					
					created_at TEXT DEFAULT CURRENT_TIMESTAMP,
					updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
					
					FOREIGN KEY(id_braka) REFERENCES braki(id_braka) ON DELETE CASCADE,
					FOREIGN KEY(id_tehnologa) REFERENCES users(id),
					FOREIGN KEY(id_cex_izgotovitel) REFERENCES cex_zatrat(id),
					FOREIGN KEY(id_plan_perevozok_vozvrata) REFERENCES plan_perevozok(id)
				)`);

				this.db.run(`CREATE INDEX IF NOT EXISTS idx_rt_brak ON resheniya_tehnologa(id_braka)`);
				this.db.run(`CREATE INDEX IF NOT EXISTS idx_rt_tehnolog ON resheniya_tehnologa(id_tehnologa)`);
				this.db.run(`CREATE INDEX IF NOT EXISTS idx_rt_status ON resheniya_tehnologa(status_resheniya)`);
				
                // Карты замеров ОТК (детализация по параметрам)
                this.db.run(`CREATE TABLE IF NOT EXISTS otk_zamery (
					id TEXT PRIMARY KEY,
					id_braka TEXT NOT NULL,              -- ✅ Связь с braki (отсюда берём id_kontrolera)
					id_gryz_poz TEXT NOT NULL,
					data_zamera TEXT NOT NULL,

					-- Параметр замера
					parametr TEXT NOT NULL,
					nominal REAL,
					fakt REAL,
					otklonenie REAL,
					dopusk_verh REAL,
					dopusk_niz REAL,
					rezultat TEXT NOT NULL,
					kommentariy TEXT,
					
					FOREIGN KEY(id_braka) REFERENCES braki(id_braka) ON DELETE CASCADE,
					FOREIGN KEY(id_gryz_poz) REFERENCES gryz_poz(id) ON DELETE CASCADE
				)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_otk_brak ON otk_zamery(id_braka)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_otk_gryz ON otk_zamery(id_gryz_poz)`);

                // ✅ МИГРАЦИЯ: количество штук, переданное на замеры и забракованное
                // по каждому параметру — нужно для правила браковки:
                //   передана ЧАСТЬ партии + брак >=1 шт -> бракуется ВСЯ партия;
                //   переданы ВСЕ детали -> бракуется только бракованное количество.
                ensureCol('otk_zamery', 'sht_peredano', 'REAL DEFAULT 0');
                ensureCol('otk_zamery', 'sht_brakovannye', 'REAL DEFAULT 0');

                // Файлы, приложенные к браку (фото, сканы карт замеров)
                this.db.run(`CREATE TABLE IF NOT EXISTS braki_files (
                    id TEXT PRIMARY KEY,
                    id_braka TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_type TEXT,
                    uploaded_by TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(id_braka) REFERENCES braki(id_braka) ON DELETE CASCADE
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_bf_brak ON braki_files(id_braka)`);

                // Журнал изменений брака (аудит workflow)
                this.db.run(`CREATE TABLE IF NOT EXISTS braki_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    id_braka TEXT NOT NULL,
                    action TEXT NOT NULL,
                    old_value TEXT,
                    new_value TEXT,
                    user_id TEXT,
                    user_login TEXT,
                    kommentariy TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(id_braka) REFERENCES braki(id_braka) ON DELETE CASCADE
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_bh_brak ON braki_history(id_braka)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_bh_time ON braki_history(created_at)`);

                // ✅ МИГРАЦИЯ: назначенный технолог (выбор контролёра ОТК при передаче).
                // id_resheniya — ссылка на ПРИНЯТОЕ решение, до передачи она NULL,
                // поэтому назначение хранится отдельно.
                ensureCol('braki', 'id_tehnologa_naznachen', 'TEXT');

                // ✅ МИГРАЦИЯ: created_at в журнале изменений — GET_OCHERED сортирует
                // очередь по b.created_at; в существующих БД braki_history мог быть
                // создан без этой колонки (DEFAULT CURRENT_TIMESTAMP добавляется безопасно).
                ensureCol('braki_history', 'created_at', 'TEXT DEFAULT CURRENT_TIMESTAMP');

                // ✅ seed-пользователи ролей ОТК/технолог (для существующих БД,
                // где users уже заполнены и seed не выполнялся)
                this.db.get('SELECT COUNT(*) c FROM users WHERE role = ?', ['otk'], async (err, row) => {
                    if (err || !row || row.c > 0) return;
                    const crypto = require('crypto');
                    const mk = (login) => crypto.createHash('sha256').update(login).digest('hex');
                    await this.db.run(
                        'INSERT OR IGNORE INTO users (id, login, password_hash, fio, role, aktivnost) VALUES (?,?,?,?,?,1)',
                        ['U_otk1', 'otk1', mk('otk1'), 'Иванов Иван Иванович', 'otk']);
                    console.log('✅ Seed: пользователь otk1 добавлен (миграция, пароль = otk1)');
                });
                this.db.get('SELECT COUNT(*) c FROM users WHERE role = ?', ['teholog'], async (err, row) => {
                    if (err || !row || row.c > 0) return;
                    const crypto = require('crypto');
                    const mk = (login) => crypto.createHash('sha256').update(login).digest('hex');
                    await this.db.run(
                        'INSERT OR IGNORE INTO users (id, login, password_hash, fio, role, aktivnost) VALUES (?,?,?,?,?,1)',
                        ['U_teh1', 'teh1', mk('teh1'), 'Петров Пётр Петрович', 'teholog']);
                    console.log('✅ Seed: пользователь teh1 добавлен (миграция, пароль = teh1)');
                });

                // ================================================================
                // БЛОК 10: ФАКТ ВЫПОЛНЕНИЯ МАРШРУТА ПО ПАРТИИ (НОВАЯ ТАБЛИЦА!)
                // ================================================================

                // Факт прохождения операций маршрута для каждой грузовой позиции
                // Содержит блок ОТК (контролёр) и блок технолога
                this.db.run(`CREATE TABLE IF NOT EXISTS fakt_marshruta (
					id TEXT PRIMARY KEY,
					id_gryz_poz TEXT NOT NULL,          -- Конкретная партия
					id_oper TEXT NOT NULL,              -- Конкретная операция
					
					-- План/факт выполнения
					data_plan_start TEXT,
					data_plan_end TEXT,
					data_fakt_start TEXT,
					data_fakt_end TEXT,
					
					-- Общий статус операции
					status_operatsii TEXT DEFAULT 'ожидание',
					kommentariy TEXT,
					kolvo_vypolneno REAL,
					FOREIGN KEY(id_gryz_poz) REFERENCES gryz_poz(id) ON DELETE CASCADE,
					FOREIGN KEY(id_oper) REFERENCES operatsii_marshruta(id_oper)
				)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_fm_gryz ON fakt_marshruta(id_gryz_poz)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_fm_oper ON fakt_marshruta(id_oper)`);

				// ========================================================================
				// БЛОК 11: ФИНАНСЫ И СКЛАД (ВЗАМЕН УДАЛЕННОЙ detal_status_pto)
				// ========================================================================

				// Учёт оплат работ
				// ✅ T102: связь с грузовыми позициями — gryz_poz.id_oplata_rabot
				// (1 оплата — НЕСКОЛЬКО позиций); поле id_gryz_poz удалено.
				this.db.run(`CREATE TABLE IF NOT EXISTS oplata_rabot (
					id TEXT PRIMARY KEY,
					tip_oplaty TEXT NOT NULL, -- 'avans' или 'okonchatelny_raschet'
					nomer_akta_upd TEXT,
					data_sogl_akta TEXT,
					nomer_schet_faktura TEXT,
					data_predostavleniya_dok TEXT,
					data_vneseniya_1s TEXT,
					data_sogl_po_dogovoru TEXT,
					kraynyaya_data_oplaty TEXT,
					data_fakt_oplaty TEXT,
					summa_k_oplate REAL DEFAULT 0,
					primechanie TEXT,
					ssylka_doc TEXT,
					ssylka_scan_reestra TEXT,
					email_otpravki TEXT,
					data_email_otpravki TEXT,
					created_at TEXT DEFAULT CURRENT_TIMESTAMP
				)`);

				// ================================================================
				// ✅ T102: инверсия связи «оплата ↔ грузовые позиции»
				// было: oplata_rabot.id_gryz_poz (1 оплата — 1 позиция);
				// стало: gryz_poz.id_oplata_rabot (1 оплата — НЕСКОЛЬКО позиций).
				// Миграция существующих БД:
				//   1) gryz_poz + id_oplata_rabot (если колонки ещё нет);
				//   2) перенос ссылок oplata_rabot.id_gryz_poz → gryz_poz.id_oplata_rabot
				//      (позиции достаётся первая по created_at оплата);
				//   3) удаление idx_oplata_gryz и колонки oplata_rabot.id_gryz_poz
				//      (нужен SQLite >= 3.35; иначе колонка просто не используется).
				// ================================================================
				const ensureColT102 = (table, col, type, after) => {
					this.db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
						if (err) return console.error(`[Database] PRAGMA table_info(${table}):`, err.message);
						const has = Array.isArray(rows) && rows.some(r => r.name === col);
						if (!has) {
							this.db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`, (e) => {
								if (e) return console.error(`[Database] ALTER TABLE ${table} ADD ${col}:`, e.message);
								console.log(`[Database] ✅ Колонка ${table}.${col} добавлена (миграция T102)`);
								if (after) after();
							});
						} else if (after) { after(); }
					});
				};
				ensureColT102('gryz_poz', 'id_oplata_rabot', 'TEXT', () => {
					this.db.run(`CREATE INDEX IF NOT EXISTS idx_gryz_oplata ON gryz_poz(id_oplata_rabot)`);
					// перенос ссылок — только если у oplata_rabot ещё есть id_gryz_poz
					this.db.get(`SELECT COUNT(*) AS c FROM pragma_table_info('oplata_rabot') WHERE name = 'id_gryz_poz'`, (e, r) => {
						if (e || !r || !r.c) return; // новой БД или миграция уже выполнена
						this.db.run(`UPDATE gryz_poz SET id_oplata_rabot =
								(SELECT o.id FROM oplata_rabot o WHERE o.id_gryz_poz = gryz_poz.id ORDER BY o.created_at LIMIT 1)
							WHERE id_oplata_rabot IS NULL
								AND EXISTS (SELECT 1 FROM oplata_rabot o WHERE o.id_gryz_poz = gryz_poz.id)`,
							(e2) => {
								if (e2) return console.error('[Database] миграция T102 (перенос ссылок):', e2.message);
								console.log('[Database] ✅ T102: ссылки oplata_rabot.id_gryz_poz перенесены в gryz_poz.id_oplata_rabot');
								// DROP COLUMN здесь невозможен: на колонку ссылается
								// FK-определение внутри самой таблицы
								// (FOREIGN KEY(id_gryz_poz) ...) — SQLite выдаёт
								// «unknown column ... in foreign key definition».
								// Штатная процедура: копия без колонки → перенос данных →
								// удаление старой → переименование.
								this.db.run('DROP INDEX IF EXISTS idx_oplata_gryz', () => {
									this.db.run('DROP TABLE IF EXISTS oplata_rabot_t102');
									this.db.run(`CREATE TABLE oplata_rabot_t102 (
										id TEXT PRIMARY KEY,
										tip_oplaty TEXT NOT NULL,
										nomer_akta_upd TEXT,
										data_sogl_akta TEXT,
										nomer_schet_faktura TEXT,
										data_predostavleniya_dok TEXT,
										data_vneseniya_1s TEXT,
										data_sogl_po_dogovoru TEXT,
										kraynyaya_data_oplaty TEXT,
										data_fakt_oplaty TEXT,
										summa_k_oplate REAL DEFAULT 0,
										primechanie TEXT,
										ssylka_doc TEXT,
										ssylka_scan_reestra TEXT,
										email_otpravki TEXT,
										data_email_otpravki TEXT,
										created_at TEXT DEFAULT CURRENT_TIMESTAMP
									)`, (eT) => {
										if (eT) return console.error('[Database] миграция T102 (создание копии):', eT.message);
										this.db.run(`INSERT INTO oplata_rabot_t102
											(id, tip_oplaty, nomer_akta_upd, data_sogl_akta, nomer_schet_faktura,
											 data_predostavleniya_dok, data_vneseniya_1s, data_sogl_po_dogovoru,
											 kraynyaya_data_oplaty, data_fakt_oplaty, summa_k_oplate, primechanie, created_at)
											SELECT id, tip_oplaty, nomer_akta_upd, data_sogl_akta, nomer_schet_faktura,
											 data_predostavleniya_dok, data_vneseniya_1s, data_sogl_po_dogovoru,
											 kraynyaya_data_oplaty, data_fakt_oplaty, summa_k_oplate, primechanie, created_at
											FROM oplata_rabot`, (eI) => {
											if (eI) return console.error('[Database] миграция T102 (перенос данных):', eI.message);
											this.db.run('DROP TABLE oplata_rabot', (eD) => {
												if (eD) return console.error('[Database] миграция T102 (удаление старой таблицы):', eD.message);
												this.db.run('ALTER TABLE oplata_rabot_t102 RENAME TO oplata_rabot', (eR) => {
													if (eR) return console.error('[Database] миграция T102 (переименование):', eR.message);
													console.log('[Database] ✅ oplata_rabot пересоздана без id_gryz_poz (T102: связь инвертирована в gryz_poz.id_oplata_rabot)');
												});
											});
										});
									});
								});
							});
					});
				});

				// ================================================================
				// ✅ T104: распределение суммы оплаты по грузовым позициям
				// (связь М:М: одна позиция — в нескольких платежках (аванс +
				// окончательный расчёт); по каждой платежке позиции относится
				// ЧАСТЬ суммы документа; сумма распределений ≤ сумма документа)
				// ================================================================
				this.db.run(`CREATE TABLE IF NOT EXISTS oplata_poz (
					id TEXT PRIMARY KEY,
					id_oplata_rabot TEXT NOT NULL,
					id_gryz_poz TEXT NOT NULL,
					summa REAL NOT NULL DEFAULT 0,
					created_at TEXT DEFAULT CURRENT_TIMESTAMP
				)`);
				this.db.run(`CREATE INDEX IF NOT EXISTS idx_oplata_poz_opl ON oplata_poz(id_oplata_rabot)`);
				this.db.run(`CREATE INDEX IF NOT EXISTS idx_oplata_poz_poz ON oplata_poz(id_gryz_poz)`);
				// миграция данных T102 → T104: существующие привязки
				// gryz_poz.id_oplata_rabot → oplata_poz (позиции достаётся вся
				// сумма платежки — данные не теряются)
				this.db.get(`SELECT COUNT(*) AS c FROM oplata_poz`, (eM104, rM104) => {
					if (eM104) return console.error('[Database] oplata_poz count:', eM104.message);
					if (rM104 && rM104.c === 0) {
						this.db.run(`INSERT INTO oplata_poz (id, id_oplata_rabot, id_gryz_poz, summa)
							SELECT 'OPZ_' || gp.id, gp.id_oplata_rabot, gp.id, op.summa_k_oplate
							FROM gryz_poz gp
							JOIN oplata_rabot op ON op.id = gp.id_oplata_rabot
							WHERE gp.id_oplata_rabot IS NOT NULL`, (eI104) => {
								if (eI104) return console.error('[Database] миграция T104:', eI104.message);
								console.log('[Database] ✅ T104: привязки gryz_poz перенесены в oplata_poz');
							});
					}
				});

				// ================================================================
				// ✅ T106: шаги работы с платежкой — прикреплённые файлы и
				// отправка на почту. Колонки для существующих БД
				// (data_vneseniya_1s есть в схеме с T102).
				// ================================================================
				const ensureColT106 = (col, type) => {
					this.db.all(`PRAGMA table_info(oplata_rabot)`, [], (err, rows) => {
						if (err) return console.error('[Database] PRAGMA oplata_rabot:', err.message);
						if (Array.isArray(rows) && rows.some(r => r.name === col)) return;
						this.db.run(`ALTER TABLE oplata_rabot ADD COLUMN ${col} ${type}`, (e) => {
						if (e) return console.error(`[Database] ALTER oplata_rabot ADD ${col}:`, e.message);
						console.log(`[Database] ✅ T106: колонка oplata_rabot.${col} добавлена`);
						});
					});
				};
				ensureColT106('ssylka_doc', 'TEXT');
				ensureColT106('ssylka_scan_reestra', 'TEXT');
				ensureColT106('email_otpravki', 'TEXT');
				ensureColT106('data_email_otpravki', 'TEXT');

				// Учёт передачи на склад
				this.db.run(`CREATE TABLE IF NOT EXISTS peredacha_sklad (
					id TEXT PRIMARY KEY,
					id_gryz_poz TEXT NOT NULL,
					data_peredachi TEXT NOT NULL,
					nomer_dokumenta TEXT,
					kto_perdal TEXT,
					kto_prinyal TEXT,
					primechanie TEXT,
					created_at TEXT DEFAULT CURRENT_TIMESTAMP,
					FOREIGN KEY(id_gryz_poz) REFERENCES gryz_poz(id) ON DELETE CASCADE
				)`);
				this.db.run(`CREATE INDEX IF NOT EXISTS idx_peredacha_gryz ON peredacha_sklad(id_gryz_poz)`);

       
                // ================================================================
                // БЛОК 12: ЗАКАЗЫ ПО ДОГОВОРАМ
                // ================================================================

                this.db.run(`CREATE TABLE IF NOT EXISTS zakaz_po_dogovoru (
                    id TEXT PRIMARY KEY,
                    id_dogovora TEXT NOT NULL,
                    nomer_zakaza TEXT NOT NULL,
                    data_zakaza TEXT,
                    data_podpisaniya_direktor TEXT,
                    data_peredano_direktor TEXT,
                    ssylka_scan_podpisannogo TEXT,
                    data_go_orig_zd TEXT,
                    data_pol_orig_zd TEXT,
                    statys_zd TEXT DEFAULT '',
                    -- ✅ T51: n_sogl_avtovaz/statys_sogl_avtovaz/id_doc_edo перенесены
                    --    в zapros_kp (согласование привязано к запросу КП)
                    ssylka_reshenie TEXT,
                    reshenie_firm TEXT,
                    data_otv_firma TEXT,
                    data_email_firma TEXT,
                    email_otpravki TEXT,
                    aktualnost_email_firma TEXT DEFAULT '', -- ✅ T32: актуальность отправки ('' - актуальна, 'неактуальна' - состав менялся после отправки)
                    FOREIGN KEY(id_dogovora) REFERENCES dogovor(id_dogovor) ON DELETE CASCADE
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_zakaz_dogovora ON zakaz_po_dogovoru(id_dogovora)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_zakaz_statys ON zakaz_po_dogovoru(statys_zd)`);

                // ✅ T32: актуальность отправленного заказа — миграция для существующих БД
                // ('' — актуальна/не отправляли, 'неактуальна' — состав заказа менялся после отправки)
                ensureCol('zakaz_po_dogovoru', 'aktualnost_email_firma', "TEXT DEFAULT ''");

                this.db.run(`CREATE TABLE IF NOT EXISTS poz_zakaz_dogovora (
                    id TEXT PRIMARY KEY,
                    id_zakaza_po_dogovoru TEXT NOT NULL,
                    id_plana TEXT NOT NULL,
                    id_kp TEXT,
                    status_poz_zd TEXT DEFAULT 'формирование списка поз. заказа',
                    FOREIGN KEY(id_zakaza_po_dogovoru) REFERENCES zakaz_po_dogovoru(id) ON DELETE CASCADE,
                    FOREIGN KEY(id_plana) REFERENCES plan(id),
                    FOREIGN KEY(id_kp) REFERENCES kp(id)
                )`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_poz_zakaz ON poz_zakaz_dogovora(id_zakaza_po_dogovoru)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_poz_plana ON poz_zakaz_dogovora(id_plana)`);

                // ================================================================
                // БЛОК 13: VIEWS ДЛЯ АНАЛИТИКИ
                // ================================================================

                // View 1: Детализация каждой грузовой позиции
                this.db.run(`DROP VIEW IF EXISTS v_gp_detail`);
                this.db.run(`
                CREATE VIEW v_gp_detail AS
                SELECT
                    gp.id                AS id_gp,
                    sm.id_det            AS id_plan,
                    sm.id_shag,
                    sm.nom_shag,
                    tt.id_tipa,
                    tt.nazvanie_operatsii,
                    tt.napravlenie,
                    tt.uchet_v_ostatke,
                    gp.kolvo_no_br AS kolvo_syroe,
                    gp.kolvo_yes_br,
                    COALESCE((SELECT SUM(b.zabrakovano_sht) FROM braki b WHERE b.id_gp = gp.id), 0) AS kolvo_brak,
                    gp.kolvo_no_br - COALESCE((SELECT SUM(b.zabrakovano_sht) FROM braki b WHERE b.id_gp = gp.id), 0) AS kolvo_godno_net
                FROM gryz_poz gp
                JOIN plan_perevozok pp  ON pp.id = gp.id_plana
                JOIN shagi_marshruta sm ON sm.id_shag = pp.id_shag
                JOIN transport_types tt ON tt.id_tipa = sm.id_tipa_perevozki
                `);

                // View 2: Сводка по позиции годового плана (остатки, брак, движения)
                this.db.run(`DROP VIEW IF EXISTS v_svodka_po_pozicii`);
                this.db.run(`
                CREATE VIEW v_svodka_po_pozicii AS
                SELECT
                    gd.id_plan,
                    SUM(CASE WHEN gd.nazvanie_operatsii = 'Отправка заготовки' THEN gd.kolvo_godno_net ELSE 0 END) AS otpravleno_zagotovki_shag1,
                    SUM(CASE WHEN gd.nazvanie_operatsii = 'Получение на TO' THEN gd.kolvo_godno_net ELSE 0 END) AS poluchno_na_to_shag2,
                    SUM(CASE WHEN gd.nazvanie_operatsii = 'Получение полуфабриката на выполнение опреаций ПТО' THEN gd.kolvo_godno_net ELSE 0 END) AS poluchno_polufabrikat,
                    SUM(CASE WHEN gd.nazvanie_operatsii = 'Отправка полуфабриката' THEN gd.kolvo_godno_net ELSE 0 END) AS otpravleno_polufabrikat,
                    SUM(CASE WHEN gd.nazvanie_operatsii = 'Получение готовой продукции' THEN gd.kolvo_godno_net ELSE 0 END) AS poluchno_gotovoy,
                    SUM(CASE WHEN gd.nazvanie_operatsii = 'Отправка после TO' THEN gd.kolvo_godno_net ELSE 0 END) AS otpravleno_posle_to,
                    SUM(CASE WHEN gd.nazvanie_operatsii = 'Отправка заготовки' THEN gd.kolvo_godno_net ELSE 0 END)
                      - SUM(CASE WHEN gd.nazvanie_operatsii = 'Получение на TO' THEN gd.kolvo_godno_net ELSE 0 END)
                      AS ostatok_u_firmy_na_chernovoy_shag2,
                    COALESCE(brak.brak_vyyavleno_vsego, 0) AS brak_vyyavleno_vsego,
                    SUM(CASE WHEN gd.uchet_v_ostatke = 1 THEN gd.kolvo_yes_br ELSE 0 END) AS otpravleno_braka_firme,
                    COALESCE(brak.brak_vyyavleno_vsego, 0)
                      - SUM(CASE WHEN gd.uchet_v_ostatke = 1 THEN gd.kolvo_yes_br ELSE 0 END) AS brak_v_rabote_u_firmy
                FROM v_gp_detail gd
                LEFT JOIN (
                    SELECT sm.id_det AS id_plan, COALESCE(SUM(b.zabrakovano_sht), 0) AS brak_vyyavleno_vsego
                    FROM braki b
                    JOIN gryz_poz gp ON gp.id = b.id_gp
                    JOIN plan_perevozok pp ON pp.id = gp.id_plana
                    JOIN shagi_marshruta sm ON sm.id_shag = pp.id_shag
                    GROUP BY sm.id_det
                ) brak ON brak.id_plan = gd.id_plan
                GROUP BY gd.id_plan, brak.brak_vyyavleno_vsego
                `);

                console.log('✅ Views v_gp_detail и v_svodka_po_pozicii созданы');

                // ================================================================
                // ФИНАЛЬНАЯ АКТИВАЦИЯ FOREIGN KEYS
                // ================================================================

                this.db.run(`PRAGMA foreign_keys = ON`, (err) => {
                    if (err) reject(err); else resolve();
                });

            }); // конец this.db.serialize
        });
    }

    // ✅ T85: локальная генерация ID (тот же формат, что generateId в utils.js,
    // Database.js остаётся автономным — без импортов из routes/utils)
    _genId(prefix) {
        const now = new Date();
        const pad = (n, l = 2) => String(n).padStart(l, '0');
        const ts = now.getFullYear().toString() +
            pad(now.getMonth() + 1) + pad(now.getDate()) +
            pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
        const rnd = Math.floor(Math.random() * 100000);
        return `${prefix}_${ts}_${rnd}`;
    }

    // ================================================================
    // ✅ T85: РЕМОНТ ДАННЫХ ПРИ СТАРТЕ — маршруты дочерних позиций плана.
    // Дочерние позиции, созданные РАЗДЕЛЕНИЕМ до исправления в
    // zaprosKpRoutes.js (copyPlanRoute), не имели шагов маршрута
    // (shagi_marshruta): computePositionFlow возвращал currentStep = null —
    // позиция не попадала в «доступные позиции для добавления» страницы
    // «План перевозок», её нельзя было добавить в план перевозок и создать
    // грузовые позиции (реальный кейс: PPG_20261017055955_70128).
    // Ремонт: дочерней позиции без единого шага, у родителя которой маршрут
    // есть, копируем шаги и операции родителя. Идемпотентно: после копирования
    // выборка пуста — повторные старты ничего не меняют.
    // ================================================================
    async repairChildPlanRoutes() {
        try {
            const orphans = await this.all(`
                SELECT c.id, c.parent_plan_id
                FROM plan c
                WHERE COALESCE(c.is_child_plan, 0) = 1
                  AND c.parent_plan_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM shagi_marshruta s WHERE s.id_det = c.id)
                  AND EXISTS (SELECT 1 FROM shagi_marshruta ps WHERE ps.id_det = c.parent_plan_id)
            `);
            if (!orphans.length) return;
            console.log(`[Database] 🔧 T85: найдено дочерних позиций без маршрута: ${orphans.length} — восстанавливаю из родителя`);
            for (const child of orphans) {
                const steps = await this.all(
                    'SELECT * FROM shagi_marshruta WHERE id_det = ? ORDER BY nom_shag',
                    [child.parent_plan_id]
                );
                if (!steps.length) continue;
                const stepIdMap = new Map();
                for (const st of steps) {
                    const newId = this._genId('SHG');
                    await this.run(
                        'INSERT INTO shagi_marshruta (id_shag, id_det, nom_shag, exec_shag, comm_shag, id_tipa_perevozki) VALUES (?,?,?,?,?,?)',
                        [newId, child.id, st.nom_shag, st.exec_shag, st.comm_shag, st.id_tipa_perevozki]
                    );
                    stepIdMap.set(st.id_shag, newId);
                }
                let ops = 0;
                const sourceOps = await this.all(`
                    SELECT o.id_shag, o.naim_oper
                    FROM operatsii_marshruta o
                    JOIN shagi_marshruta s ON o.id_shag = s.id_shag
                    WHERE s.id_det = ?
                    ORDER BY s.nom_shag, o.rowid
                `, [child.parent_plan_id]);
                for (const op of sourceOps) {
                    const newStepId = stepIdMap.get(op.id_shag);
                    if (!newStepId) continue;
                    await this.run(
                        'INSERT INTO operatsii_marshruta (id_oper, id_shag, naim_oper) VALUES (?,?,?)',
                        [this._genId('OPR'), newStepId, op.naim_oper]
                    );
                    ops++;
                }
                console.log(`[Database] ✅ T85: маршрут восстановлен у дочерней позиции ${child.id} (из родителя ${child.parent_plan_id}: шагов ${steps.length}, операций ${ops})`);
            }
        } catch (e) {
            // Ремонт не должен блокировать запуск сервера
            console.error('[Database] ❌ T85 repairChildPlanRoutes:', e.message);
        }
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
        });
    }

    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                err ? reject(err) : resolve(this);
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
        });
    }

    close() {
        return new Promise((resolve) => {
            this.db.close(() => {
                console.log('🔒 Database closed');
                resolve();
            });
        });
    }
}

module.exports = Database;