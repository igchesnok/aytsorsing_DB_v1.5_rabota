// configs/firms.config.js
//
// ✅ ИНТЕГРАЦИЯ clipboard-import.js
// Для каждой сущности, где нужна вставка из буфера, определён importConfig:
//   - fields          — порядок колонок в буфере (как в Excel)
//   - columnHints     — человеческие заголовки колонок для подсказки в модалке
//   - requiredFields  — обязательные поля
//   - booleanFields   — поля, преобразуемые в 1/0
//   - numericFields    — поля, преобразуемые в число
//   - preprocessRow    — хук предобработки (например, код фирмы → id_firmy)
//   - isDuplicate      — кастомная проверка дубликата (по бизнес-ключу)
//   - onDuplicate      — действие при дубликате (PUT-обновление)
//
// columnHints можно НЕ задавать — CrudModule._importFromClipboard()
// сгенерирует их автоматически из config.fields[].label.
// Но если в fields есть служебные ключи (например, 'id_firmy', которого нет
// в config.fields), columnHints нужно задавать явно.
//
import { api } from '../common/utils.js';
import { state } from '../common/state.js';

// ─── Вспомогательные функции ─────────────────────────────────

// Конвертация даты DD.MM.YYYY → YYYY-MM-DD (формат HTML <input type="date">)
// Если уже YYYY-MM-DD — возвращаем как есть.
function toIsoDate(s) {
  if (!s) return '';
  const str = String(s).trim();
  // DD.MM.YYYY или DD/MM/YYYY
  const m = str.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  }
  // YYYY-MM-DD (уже ISO)
  if (str.match(/^\d{4}-\d{2}-\d{2}$/)) return str;
  return str;
}

// Безопасное сравнение строк (trim + lower) для дедупликации
function eqStr(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

// Нормализация пустых значений: '' / null / undefined / '-' → null
function norm(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s.toLowerCase() === 'null') return null;
  return s;
}

// Кэш справочника sprav_uslov по категориям (чтобы не дёргать API на каждой строке)
const _spravUslovCache = { data: null, promise: null };
async function loadSpravUslov() {
  if (_spravUslovCache.data) return _spravUslovCache.data;
  if (_spravUslovCache.promise) return _spravUslovCache.promise;
  _spravUslovCache.promise = api('GET', '/api/uslov').then(rows => {
    _spravUslovCache.data = Array.isArray(rows) ? rows : [];
    return _spravUslovCache.data;
  }).catch(err => {
    console.warn('[firms.config] loadSpravUslov failed:', err);
    _spravUslovCache.data = [];
    return [];
  });
  return _spravUslovCache.promise;
}

// Резолвинг id_usloviya по текстовому названию (для FK из Excel)
// Ищет по точному совпадению soderzhanie (case-insensitive),
// затем по частичному включению.
async function resolveUslovId(text, kategoriya) {
  if (!text) return null;
  const rows = await loadSpravUslov();
  const q = String(text).trim().toLowerCase();
  const filtered = kategoriya
    ? rows.filter(r => eqStr(r.kategoriya, kategoriya))
    : rows;
  // Точное совпадение
  const exact = filtered.find(r => eqStr(r.soderzhanie, text));
  if (exact) return exact.id_usloviya;
  // Частичное: текст содержит soderzhanie или наоборот
  const partial = filtered.find(r => {
    const s = String(r.soderzhanie || '').toLowerCase();
    return s && (s.includes(q) || q.includes(s));
  });
  return partial ? partial.id_usloviya : null;
}

export default {
  pageKey: 'firms',

  // ============================================================
  // МАСТЕР: фирмы
  // ============================================================
  master: {
    entity: 'firmy',
    tabId: 'tabFirma',
    apiUrl: '/api/firmy',
    idKey: 'id_firmy',
    tableContainerId: 'firmaTable',
    formTitleId: 'firmaFormTitle',
    searchId: 'firmaSearch',
    tableTitle: 'Фирма',
    wsSync: false, // Управляется через MasterDetailModule
    buttons: { add: 'btnFirmaAdd', save: 'btnFirmaSave', del: 'btnFirmaDel', paste: 'btnFirmaPaste' },
    fields: [
      { key: 'kod', domId: 'fKod', label: 'Код', type: 'text', required: true, table: true, tableWidth: 80, filter: true, filterId: 'fltFirmaKod' },
      { key: 'naimenovanie', domId: 'fName', label: 'Наименование', type: 'text', required: true, table: true, tableWidth: 260, filter: true, filterId: 'fltFirmaName' },
      { key: 'inn', domId: 'fInn', label: 'ИНН', type: 'text', required: true, table: true, tableWidth: 100, filter: true, filterId: 'fltFirmaInn' },
      { key: 'gorod', domId: 'fGorod', label: 'Город', type: 'text', table: true, tableWidth: 130 }, // ✅ T84
      { key: 'ur_adres', domId: 'fAddr', label: 'Юр. адрес', type: 'text', table: true, tableWidth: 320 },
      { key: 'cena_perevozki', domId: 'fCenaPerevozki', label: 'Цена перевозки', type: 'text', table: true, tableWidth: 130 }, // ✅ T84
    ],
    filterClearButtons: [
      { buttonId: 'btnClearFirmaKod', filterId: 'fltFirmaKod' },
      { buttonId: 'btnClearFirmaName', filterId: 'fltFirmaName' },
      { buttonId: 'btnClearFirmaInn', filterId: 'fltFirmaInn' },
    ],

    // ✅ ИМПОРТ ИЗ БУФЕРА для мастера
    // Вставка: Код | Наименование | ИНН | Юр. адрес
    // Дубликат: по ИНН (ИНН уникален по закону)
    // При дубликате: PUT-обновление по id_firmy
    importConfig: {
      fields: ['kod', 'naimenovanie', 'inn', 'ur_adres'],
      requiredFields: ['kod', 'naimenovanie', 'inn'],
      columnHints: ['Код', 'Наименование', 'ИНН', 'Юр. адрес'],
      isDuplicate: (existingRow, newObj) => eqStr(existingRow.inn, newObj.inn),
      onDuplicate: async (existingRow, newObj) => {
        const r = await api('PUT', `/api/firmy/${existingRow.id_firmy}`, {
          kod:          newObj.kod          || existingRow.kod,
          naimenovanie: newObj.naimenovanie || existingRow.naimenovanie,
          inn:          newObj.inn          || existingRow.inn,
          ur_adres:     newObj.ur_adres     ?? existingRow.ur_adres ?? '',
          gorod:        newObj.gorod        ?? existingRow.gorod ?? '',        // ✅ T84: импорт не затирает
          cena_perevozki: newObj.cena_perevozki ?? existingRow.cena_perevozki ?? '', // ✅ T84
        });
        if (r.error) throw new Error(r.error);
      }
    }
  },

  // ============================================================
  // ДОЧЕРНИЕ (зависят от мастера через parentEntity)
  // ============================================================
  children: [
    // ─── ФАКТ. АДРЕС ─────────────────────────────────────────
    {
      entity: 'fakt_adres',
      parentEntity: 'firmy',
      fkField: 'id_firmy',
      apiUrl: '/api/adres',
      idKey: 'id_adres',
      tabId: 'tabAdres',
      tableContainerId: 'adresTable',
      formTitleId: 'adresFormTitle',
      titleId: 'adresTitle',
      tableTitle: 'Факт. адрес',
      wsSync: false,
      buttons: { add: 'btnAdresAdd', save: 'btnAdresSave', del: 'btnAdresDel', paste: 'btnAdresPaste' },
      fields: [
        { key: 'fakt_adres', domId: 'aAddr', label: 'Факт. адрес', type: 'text', required: true, table: true, tableWidth: 500 },
      ],

      // ✅ ИМПОРТ ИЗ БУФЕРА
      // Вставка: Код фирмы | Факт. адрес
      // preprocessRow: резолвит код фирмы → id_firmy через state._allFirms
      // Дубликат: по паре (id_firmy, fakt_adres)
      importConfig: {
        fields: ['id_firmy', 'fakt_adres'],
        requiredFields: ['id_firmy', 'fakt_adres'],
        columnHints: ['Код фирмы', 'Факт. адрес'],
        preprocessRow: (obj, cols) => {
          const kodFirmy = String(cols[0] ?? '').trim();
          const adres    = String(cols[1] ?? '').trim();
          if (!kodFirmy || !adres) return null;
          const firm = state._allFirms?.find(f => String(f.kod) === kodFirmy);
          if (!firm) return null;
          return { id_firmy: firm.id_firmy, fakt_adres: adres };
        },
        isDuplicate: (existingRow, newObj) =>
          String(existingRow.id_firmy) === String(newObj.id_firmy) &&
          eqStr(existingRow.fakt_adres, newObj.fakt_adres),
        onDuplicate: async (existingRow, newObj) => {
          const r = await api('PUT', `/api/adres/${existingRow.id_adres}`, {
            id_firmy:  newObj.id_firmy,
            fakt_adres: newObj.fakt_adres,
          });
          if (r.error) throw new Error(r.error);
        }
      }
    },

    // ─── КОНТАКТНОЕ ЛИЦО ──────────────────────────────────────
    {
      entity: 'kont',
      parentEntity: 'firmy',
      fkField: 'id_firmy',
      apiUrl: '/api/kont',
      idKey: 'id_kont',
      tabId: 'tabKont',
      tableContainerId: 'kontTable',
      formTitleId: 'kontFormTitle',
      titleId: 'kontTitle',
      tableTitle: 'Контактное лицо',
      wsSync: false,
      buttons: { add: 'btnKontAdd', save: 'btnKontSave', del: 'btnKontDel', paste: 'btnKontPaste' },
      fields: [
        { key: 'fio', domId: 'kFio', label: 'ФИО', type: 'text', required: true, table: true, tableWidth: 200 },
        { key: 'tel', domId: 'kTel', label: 'Телефон', type: 'text', table: true, tableWidth: 140 },
        { key: 'email', domId: 'kEmail', label: 'Email', type: 'text', table: true, tableWidth: 200 },
        { key: 'aktivnost', domId: 'kAktiv', label: 'Активен', type: 'checkbox', table: true, tableWidth: 70, default: true },
      ],

      // ✅ ИМПОРТ ИЗ БУФЕРА
      // Вставка: Код фирмы | ФИО | Телефон | Email | Активен
      // preprocessRow: резолвит код фирмы → id_firmy
      //   Активность НЕ трогаем — её обработает booleanFields в clipboard-import.js
      //   (понимает: 1/0, true/false, да/нет, yes/no, истина/ложь)
      // Дубликат: по паре (id_firmy, fio)
      // При дубликате: PUT-обновление по id_kont
      importConfig: {
        fields: ['id_firmy', 'fio', 'tel', 'email', 'aktivnost'],
        requiredFields: ['id_firmy', 'fio'],
        booleanFields: ['aktivnost'],
        columnHints: ['Код фирмы', 'ФИО', 'Телефон', 'Email', 'Активен'],
        preprocessRow: (obj, cols) => {
          const kodFirmy = String(cols[0] ?? '').trim();
          const firm = state._allFirms?.find(f => String(f.kod) === kodFirmy);
          if (!firm) return null;
          // aktivnost обработается через booleanFields — НЕ трогаем здесь
          return {
            id_firmy: firm.id_firmy,
            fio:    String(cols[1] ?? '').trim(),
            tel:    String(cols[2] ?? '').trim(),
            email:  String(cols[3] ?? '').trim(),
          };
        },
        isDuplicate: (existingRow, newObj) =>
          String(existingRow.id_firmy) === String(newObj.id_firmy) &&
          eqStr(existingRow.fio, newObj.fio),
        onDuplicate: async (existingRow, newObj) => {
          const r = await api('PUT', `/api/kont/${existingRow.id_kont}`, {
            id_firmy:  newObj.id_firmy,
            fio:       newObj.fio       || existingRow.fio       || '',
            tel:       norm(newObj.tel)      ?? existingRow.tel      ?? '',
            email:     norm(newObj.email)    ?? existingRow.email    ?? '',
            aktivnost: newObj.aktivnost ?? existingRow.aktivnost ?? 0,
          });
          if (r.error) throw new Error(r.error);
        }
      }
    },

    // ─── ДОГОВОР (полный набор колонок из БД) ─────────────────
    // БД: nom_dogovor, data_dogovor, data_ok, rasch_schet, ssylka_na_dok,
    //     id_vid_rabot, predoplata_pr, id_predoplata_yclov, predoplata_data,
    //     hdc, ctoimost, priemka_data, oplata_rabot_data, otschet_priemka,
    //     otschet_oplata, data_oplata_avanca
    //
    // Вставка поддерживает ПОЛНЫЙ набор полей из Excel/1С.
    // Справочные FK (id_vid_rabot, id_predoplata_yclov) резолвятся по текстовому
    // названию через GET /api/uslov с кэшированием.
    // Дубликат: по паре (id_firmy, nom_dogovor)
    // При дубликате: PUT-обновление по id_dogovor (только непустые поля)
    {
      entity: 'dogovor',
      parentEntity: 'firmy',
      fkField: 'id_firmy',
      apiUrl: '/api/dogovor',
      idKey: 'id_dogovor',
      tabId: 'tabDog',
      tableContainerId: 'dogTable',
      formTitleId: 'dogFormTitle',
      titleId: 'dogTitle',
      tableTitle: 'Договор',
      wsSync: false,
      buttons: {
        add: 'btnDogAdd', save: 'btnDogSave', del: 'btnDogDel',
        paste: 'btnDogPaste'   // ✅ НОВАЯ кнопка — нужен HTML-элемент с id="btnDogPaste"
      },
      fields: [
        { key: 'nom_dogovor', domId: 'dNom', label: '№', type: 'text', required: true, table: true, tableWidth: 100 },
        { key: 'data_dogovor', domId: 'dData', label: 'Дата', type: 'date', required: true, table: true, tableWidth: 100 },
        { key: 'data_ok', domId: 'dDataOk', label: 'Оконч.', type: 'date', table: true, tableWidth: 100 },
        { key: 'ctoimost', domId: 'dCost', label: 'Сумма', type: 'text', table: true, tableWidth: 120 },
        { key: 'hdc', domId: 'dHdc', label: 'НДС%', type: 'text', table: true, tableWidth: 60 },
        { key: 'rasch_schet', domId: 'dSchet', label: 'Р/С', type: 'text', table: true, tableWidth: 180 },
        { key: 'id_vid_rabot', domId: 'dVidRabot', type: 'select', formOnly: true,
          optionsApi: { url: '/api/uslov?kategoriya=Вид работ', valueKey: 'id_usloviya', labelKey: 'soderzhanie', placeholder: '— Выберите —' }
        },
        { key: 'predoplata_pr', domId: 'dPrePr', type: 'text', formOnly: true },
        { key: 'predoplata_data', domId: 'dPreData', type: 'text', formOnly: true },
        { key: 'data_oplata_avanca', domId: 'dAvansData', type: 'date', formOnly: true },
        { key: 'id_predoplata_yclov', domId: 'dPredYcl', type: 'select', formOnly: true,
          optionsApi: { url: '/api/uslov?kategoriya=Условия предоплаты', valueKey: 'id_usloviya', labelKey: 'soderzhanie', placeholder: '— Выберите —' }
        },
        { key: 'priemka_data', domId: 'dPriemData', type: 'text', formOnly: true },
        { key: 'oplata_rabot_data', domId: 'dOplataData', type: 'text', formOnly: true },
        { key: 'otschet_priemka', domId: 'dOtschetPriem', type: 'select', formOnly: true, default: 'рабочих дней', options: ['рабочих дней', 'календарных дней'] },
        { key: 'otschet_oplata', domId: 'dOtschetOpl', type: 'select', formOnly: true, default: 'рабочих дней', options: ['рабочих дней', 'календарных дней'] },
      ],

      // ✅ ИМПОРТ ИЗ БУФЕРА — полный набор колонок как в БД
      // Порядок колонок (Excel):
      //  1.  Код фирмы *
      //  2.  № договора *
      //  3.  Дата договора *
      //  4.  Дата окончания
      //  5.  Р/С
      //  6.  Ссылка на документ
      //  7.  Вид работ (текст из справочника)
      //  8.  Предоплата %
      //  9.  Условия предоплаты (текст из справочника)
      // 10.  Дата предоплаты
      // 11.  НДС %
      // 12.  Сумма
      // 13.  Дата приёмки
      // 14.  Дата оплаты работ
      // 15.  Отсчёт приёмки (рабочих/календарных дней)
      // 16.  Отсчёт оплаты (рабочих/календарных дней)
      // 17.  Дата оплаты аванса
      //
      // beforeParse (async): заранее загружаем кэш sprav_uslov —
      //   чтобы в синхронном preprocessRow можно было резолвить
      //   "Вид работ" и "Условия предоплаты" по тексту в id.
      importConfig: {
        fields: [
          'id_firmy',              // 1
          'nom_dogovor',          // 2
          'data_dogovor',         // 3
          'data_ok',              // 4
          'rasch_schet',          // 5
          'ssylka_na_dok',        // 6
          'id_vid_rabot',         // 7
          'predoplata_pr',       // 8
          'id_predoplata_yclov',  // 9
          'predoplata_data',      // 10
          'hdc',                  // 11
          'ctoimost',             // 12
          'priemka_data',        // 13
          'oplata_rabot_data',   // 14
          'otschet_priemka',     // 15
          'otschet_oplata',      // 16
          'data_oplata_avanca',  // 17
        ],
        requiredFields: ['id_firmy', 'nom_dogovor', 'data_dogovor'],
        numericFields: ['ctoimost', 'hdc'],
        columnHints: [
          'Код фирмы',
          '№ договора',
          'Дата договора',
          'Дата окончания',
          'Р/С',
          'Ссылка на документ',
          'Вид работ',
          'Предоплата %',
          'Условия предоплаты',
          'Дата предоплаты',
          'НДС %',
          'Сумма',
          'Дата приёмки',
          'Дата оплаты работ',
          'Отсчёт приёмки',
          'Отсчёт оплаты',
          'Дата оплаты аванса',
        ],

        // ✅ beforeParse: загружаем справочник ДО парсинга строк
        beforeParse: async () => {
          await loadSpravUslov();
        },

        // ─── Предобработка строки (теперь кэш уже загружен) ────
        preprocessRow: (obj, cols) => {
          const kodFirmy = String(cols[0] ?? '').trim();
          const firm = state._allFirms?.find(f => String(f.kod) === kodFirmy);
          if (!firm) return null;

          // Резолвим FK по тексту — кэш точно загружен (beforeParse уже отработал)
          let idVidRabot = norm(cols[6]);
          if (idVidRabot && isNaN(Number(idVidRabot))) {
            const txt = idVidRabot.toLowerCase();
            const found = (_spravUslovCache.data || []).find(r =>
              eqStr(r.kategoriya, 'Вид работ') && eqStr(r.soderzhanie, idVidRabot)
            ) || (_spravUslovCache.data || []).find(r =>
              eqStr(r.kategoriya, 'Вид работ') &&
              String(r.soderzhanie || '').toLowerCase().includes(txt)
            );
            idVidRabot = found ? found.id_usloviya : null;
          }

          let idPredoplataYclov = norm(cols[8]);
          if (idPredoplataYclov && isNaN(Number(idPredoplataYclov))) {
            const txt = idPredoplataYclov.toLowerCase();
            const found = (_spravUslovCache.data || []).find(r =>
              eqStr(r.kategoriya, 'Условия предоплаты') && eqStr(r.soderzhanie, idPredoplataYclov)
            ) || (_spravUslovCache.data || []).find(r =>
              eqStr(r.kategoriya, 'Условия предоплаты') &&
              String(r.soderzhanie || '').toLowerCase().includes(txt)
            );
            idPredoplataYclov = found ? found.id_usloviya : null;
          }

          return {
            id_firmy:             firm.id_firmy,
            nom_dogovor:          String(cols[1] ?? '').trim(),
            data_dogovor:         toIsoDate(cols[2]),
            data_ok:              toIsoDate(cols[3]),
            rasch_schet:          norm(cols[4]),
            ssylka_na_dok:        norm(cols[5]),
            id_vid_rabot:         idVidRabot,
            predoplata_pr:        norm(cols[7]),
            id_predoplata_yclov:  idPredoplataYclov,
            predoplata_data:      norm(cols[9]),
            // hdc, ctoimost обработает numericFields
            priemka_data:         norm(cols[12]),
            oplata_rabot_data:    norm(cols[13]),
            otschet_priemka:      norm(cols[14]) || 'рабочих дней',
            otschet_oplata:       norm(cols[15]) || 'рабочих дней',
            data_oplata_avanca:   toIsoDate(cols[16]),
          };
        },

        isDuplicate: (existingRow, newObj) =>
          String(existingRow.id_firmy) === String(newObj.id_firmy) &&
          eqStr(existingRow.nom_dogovor, newObj.nom_dogovor),

        onDuplicate: async (existingRow, newObj) => {
          const payload = {
            id_firmy:             newObj.id_firmy,
            nom_dogovor:          newObj.nom_dogovor          || existingRow.nom_dogovor,
            data_dogovor:         newObj.data_dogovor         || existingRow.data_dogovor,
            data_ok:              newObj.data_ok              ?? norm(existingRow.data_ok) ?? '',
            rasch_schet:          newObj.rasch_schet          ?? norm(existingRow.rasch_schet) ?? '',
            ssylka_na_dok:        newObj.ssylka_na_dok        ?? norm(existingRow.ssylka_na_dok) ?? '',
            id_vid_rabot:         newObj.id_vid_rabot         ?? norm(existingRow.id_vid_rabot),
            predoplata_pr:        newObj.predoplata_pr        ?? norm(existingRow.predoplata_pr),
            id_predoplata_yclov:  newObj.id_predoplata_yclov  ?? norm(existingRow.id_predoplata_yclov),
            predoplata_data:      newObj.predoplata_data      ?? norm(existingRow.predoplata_data) ?? '',
            hdc:                  newObj.hdc                  ?? existingRow.hdc                  ?? 0,
            ctoimost:             newObj.ctoimost             ?? existingRow.ctoimost             ?? 0,
            priemka_data:         newObj.priemka_data         ?? norm(existingRow.priemka_data) ?? '',
            oplata_rabot_data:    newObj.oplata_rabot_data    ?? norm(existingRow.oplata_rabot_data) ?? '',
            otschet_priemka:      newObj.otschet_priemka      || existingRow.otschet_priemka || 'рабочих дней',
            otschet_oplata:       newObj.otschet_oplata       || existingRow.otschet_oplata  || 'рабочих дней',
            data_oplata_avanca:   newObj.data_oplata_avanca   ?? norm(existingRow.data_oplata_avanca) ?? '',
          };
          const r = await api('PUT', `/api/dogovor/${existingRow.id_dogovor}`, payload);
          if (r.error) throw new Error(r.error);
        }
      }
    },
  ],

  // ============================================================
  // САМОСТОЯТЕЛЬНАЯ ВКЛАДКА (без parentEntity)
  // ============================================================
  standalone: [
    {
      entity: 'sprav_uslov',
      apiUrl: '/api/uslov',
      idKey: 'id_usloviya',
      tabId: 'tabUslov',
      tableContainerId: 'uslovTable',
      formTitleId: 'uslovFormTitle',
      tableTitle: 'Условие договора',
      wsSync: false,
      buttons: {
        add: 'btnUslovAdd', save: 'btnUslovSave', del: 'btnUslovDel',
        paste: 'btnUslovPaste'   // ✅ НОВАЯ кнопка — нужен HTML-элемент с id="btnUslovPaste"
      },
      fields: [
        { key: 'soderzhanie', domId: 'uText', label: 'Содержание', type: 'text', required: true, table: true, tableWidth: 460 },
        { key: 'kategoriya', domId: 'uKat', label: 'Категория', type: 'select', table: true, tableWidth: 200, options: ['Вид работ', 'Условия предоплаты'] },
      ],

      // ✅ ИМПОРТ ИЗ БУФЕРА
      // Вставка: Содержание | Категория
      // Дубликат: по паре (soderzhanie, kategoriya)
      // При дубликате: PUT-обновление по id_usloviya
      importConfig: {
        fields: ['soderzhanie', 'kategoriya'],
        requiredFields: ['soderzhanie'],
        columnHints: ['Содержание', 'Категория'],
        isDuplicate: (existingRow, newObj) =>
          eqStr(existingRow.soderzhanie, newObj.soderzhanie) &&
          eqStr(existingRow.kategoriya, newObj.kategoriya),
        onDuplicate: async (existingRow, newObj) => {
          const r = await api('PUT', `/api/uslov/${existingRow.id_usloviya}`, {
            soderzhanie: newObj.soderzhanie || existingRow.soderzhanie,
            kategoriya:  newObj.kategoriya  || existingRow.kategoriya  || '',
          });
          if (r.error) throw new Error(r.error);
        }
      }
    }
  ]
};

// ============================================================
// АРХИТЕКТУРА АСИНХРОННОЙ ВСТАВКИ
// ============================================================
// clipboard-import.js v3.0 поддерживает три async-хука:
//
//   1. beforeParse(config)  — вызывается ОДИН раз перед парсингом строк.
//      Используется для предзагрузки справочников (sprav_uslov, firmy и т.д.),
//      чтобы в синхронном preprocessRow можно было резолвить FK по тексту.
//
//   2. preprocessRow(obj, cols) → obj | null | Promise<obj|null>
//      Может быть async. Если возвращает null — строка пропускается.
//
//   3. onDuplicate(existingRow, newObj) → Promise<void>
//      Async. Если бросает — строка идёт в skipped.
//
// Для договоров:
//   - beforeParse загружает /api/uslov (категории 'Вид работ' + 'Условия предоплаты')
//   - preprocessRow резолвит код фирмы → id_firmy (state._allFirms)
//     и текстовые названия FK → id_usloviya (из кэша)
//   - onDuplicate делает PUT-запрос с объединением старых и новых полей
