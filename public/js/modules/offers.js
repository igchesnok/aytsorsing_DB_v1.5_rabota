// ============================================================
// public/js/modules/offers.js
// МОДУЛЬ: ВНЕСЕНИЕ КОММЕРЧЕСКИХ ПРЕДЛОЖЕНИЙ
// Гибридная архитектура:
//   • FormStateManager — единый менеджер формы КП
//   • registerLockAwareRecord — регистрация в реестре авто-блокировки
//   • checkForExternalChanges — проверка конфликта данных
//   • showLockBanner / removeLockBanner — визуализация блокировки
//   • batchManager.withBatch — подавление WS-эхо
//   • dispatchCrudCompleted — уведомление auto-lock.js
//   • DirtyGuard — модалка "Сохранить/Сбросить/Остаться"
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { VirtualTable } from '../common/virtual-table.js';
import { EditLock, isLocked } from '../common/websocket.js';
import { batchManager } from '../common/batch-update.js';
import { FormStateManager } from '../common/form-state-manager.js';
import { registerLockAwareRecord } from '../common/lock-aware-registry.js';
import { showLockBanner, removeLockBanner } from '../common/ui/auto-lock.js';
import offersKpConfig from '../configs/offers-kp.config.js';
// ✅ T74: «Матрица выбора поставщика» — визуализация сводной КП
import { renderChoiceMatrix, clearChoiceMatrix } from './offers-matrix.js';

// ✅ НОВОЕ: локальная функция форматирования даты (клиентский аналог
//   displayDate из routes/helpers/dateHelpers). Принимает строку даты
//   в любом из форматов: 'YYYY-MM-DD', 'YYYY-MM-DDTHH:mm:ss', 'DD.MM.YYYY'.
//   Возвращает 'DD.MM.YYYY' или исходную строку, если распарсить не удалось.
function formatDateRu(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return dateStr || '';
  const s = dateStr.trim();
  if (!s) return '';
  // Если уже в формате DD.MM.YYYY — возвращаем как есть
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return s;
  // Пробуем ISO: YYYY-MM-DD или YYYY-MM-DDTHH:mm:ss
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/);
  if (m) {
    return `${m[3]}.${m[2]}.${m[1]}`;
  }
  // Пробуем Date.parse (для других форматов)
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  }
  return s;
}

// Типы изготовления (для приоритетов)
const TIP_IZGOT = [
  'ПОЛНЫЙ ЦИКЛ (ТО + МЕХ. ОБРАБОТКА)',
  'ПОЛНАЯ МЕХ ОБРАБОТКА БЕЗ ТО',
  'ЧАСТИЧНАЯ МЕХ ОБРАБОТКА С ТО',
  'ЧАСТИЧНАЯ МЕХ ОБРАБОТКА БЕЗ ТО',
];

// Колонки блока фирмы в сводной таблице
// ✅ ИЗМЕНЕНО (ревизия 2):
//   • убрана колонка 'econom' (Эконом) — она переехала в группу «Лучшее ТКП» как best_econom
//   • добавлена колонка 'cena_nch' (Цена н/ч) = Стоим / Труд
//   • добавлена колонка 'stoim_partii' (Стоим. (руб. без НДС)) = Стоим * Кол-во
//   Порядок: Труд → Стоим → Цена н/ч → Кол-во → Стоим. (руб. без НДС) → Срок → Тип
const FIRM_COLUMNS = [
  { suffix: 'trud',         label: 'Труд',          width: 60  },
  { suffix: 'cost',         label: 'Стоим',         width: 80  },
  { suffix: 'cena_nch',     label: 'Цена н/ч',      width: 80  },  // ✅ НОВОЕ: Стоим / Труд
  { suffix: 'mosh',         label: 'Кол-во',        width: 60  },
  // ✅ ИЗМЕНЕНО: 'tip' перенесён перед 'srok' (раньше был последним)
  { suffix: 'tip',          label: 'Тип',           width: 120 },
  { suffix: 'srok',         label: 'Срок',          width: 50  },
  // ✅ ИЗМЕНЕНО: 'stoim_partii' теперь ПОСЛЕДНЯЯ колонка группы фирмы.
  //   Это нужно для схлопывания группы (collapsibleGroups): при сворачивании
  //   остаются видны только последние колонки групп фирм (Стоим. (руб. без НДС)).
  { suffix: 'stoim_partii', label: 'Стоим. (руб. без НДС)', width: 90  },
];

export const Offers = {
  _selectedZaprosId: null,
  _selectedFirmaId: null,
  _selectedKpId: null,
  _lastSelectedKpId: null,
  _allZaprosy: [],
  _allFirmy: [],
  _allDetali: [],
  _allDogovory: [],
  _allKP: [],
  _summaryTable: null,
  _formStateManager: null,

  // ============================================================
  // ✅ T48: текущее основание фирмы по запросу (таблица ТКПоснование)
  //   { ssylka, imya_fayla, data_zagruzki } | null
  // ============================================================
  _osnovanie: null,

  // ============================================================
  // ✅ T49: индекс оснований ТЕКУЩЕГО запроса — Map<firmaId, имя файла>.
  //   Источник скрепок 📎 в списке фирм #fltFirma: у фирмы с основанием
  //   перед названием ставится 📎, при наведении на пункт — имя файла.
  //   Наполняется в _loadOsnovanieIndex() одним GET-запросом.
  // ============================================================
  _osnovanieIndex: new Map(),

  // ============================================================
  // ✅ НОВОЕ: кэш условий предоплаты для подвала групп фирм
  //   _firmFooterCache    : Map<firmaId, soserzhanie>
  //   _firmFooterCacheKey : "zaprosId|firmaId1,firmaId2,..." (инвалидация)
  //   _uslovMapCache      : Map<id_usloviya, soderzhanie> (справочник sprav_uslov)
  // ============================================================
  _firmFooterCache: null,
  _firmFooterCacheKey: null,
  _uslovMapCache: null,

  // ============================================================
  // ИНИЦИАЛИЗАЦИЯ
  // ============================================================
  async init() {
    // ===== 1. FormStateManager из конфига =====
    Offers._formStateManager = new FormStateManager({
      ...offersKpConfig,
      formTitleId: 'kpFormTitle',
      defaultTitle: 'Данные коммерческого предложения',
      formatTitle: (row) => {
        // ✅ T49: заголовок строится ИЗ ДАННЫХ выбранной записи (offers.kp
        // содержит nomer_chertezha и firma_nazvanie), а не из информационных
        // полей DOM — те заполняются ПОСЛЕ fillFromRow, из-за чего заголовок
        // отставал на один клик (прочерки при первом клике, данные предыдущей
        // записи при следующих).
        const chertezh = row?.nomer_chertezha || '—';
        const firma = row?.firma_nazvanie || '—';
        return `КП: ${chertezh} — ${firma}`;
      },
      onDirtyChange: () => Offers.updateButtonStates(),
    });

    // ===== 2. Таблица деталей (VirtualTable — ручная загрузка) =====
    const detaliCols = [
      { key: 'nomer_chertezha',  label: '№ чертежа',    width: '120px' },
      { key: 'osn_naimenovanie', label: 'Наименование', width: '200px' },
      { key: 'plan_god_kolvo',   label: 'План кол-во',  width: '80px'  },
      { key: 'dogovor_nom',      label: 'Договор',      width: '100px' },
    ];

    state.tables.detali = new VirtualTable(
      document.getElementById('detaliTable'),
      detaliCols,
      {
        idKey: 'id',
        onSelect: (r) => Offers.onDetalSelect(r),
        onHeaderClick: () => Offers.onHeaderClick(),
        getLockInfo: (item) => isLocked('kp', item.kp_id),
      }
    );

    // ===== 3. Регистрация в реестре lock-aware =====
    registerLockAwareRecord('kp', {
      form: Offers._formStateManager,
      save: () => Offers.saveSingleKP(),
      onHeaderClick: () => Offers.onHeaderClick(),
      checkForExternalChanges: () => Offers.checkForExternalChanges(),
    });

    // ===== 4. Обработчики фильтров =====
    document.getElementById('fltGod').addEventListener('input', async () => {
      document.getElementById('fltZapros').value = '';
      await Offers.loadZaprosy();
      await Offers.onZaprosChange();
    });
    document.getElementById('btnClearGod').onclick = async () => {
      document.getElementById('fltGod').value = new Date().getFullYear();
      document.getElementById('fltZapros').value = '';
      await Offers.loadZaprosy();
      await Offers.onZaprosChange();
    };
    document.getElementById('fltNoKP').addEventListener('change', async () => {
      document.getElementById('fltZapros').value = '';
      await Offers.loadZaprosy();
      await Offers.onZaprosChange();
    });
    document.getElementById('fltZapros').addEventListener('change', () => Offers.onZaprosChange());
    document.getElementById('fltFirma').addEventListener('change', () => Offers.onFirmaChange());

    // ✅ T78: требование «не допускается разбивать партию» хранится в запросе
    // (zapros_kp.komplekt); переключение чекбокса на странице сохраняет поле
    // и перестраивает матрицу выбора поставщика с диаграммой
    document.addEventListener('kp-nosplit-change', async (ev) => {
      const zaprosId = Offers._selectedZaprosId;
      if (!zaprosId) return;
      const chk = document.getElementById('chkNoSplitBatch');
      try {
        await api('POST', '/api/zapros-kp/komplekt', { zaprosId, komplekt: ev.detail.checked ? 1 : 0 });
        const z = Offers._allZaprosy.find((x) => x.id === zaprosId);
        if (z) z.komplekt = ev.detail.checked ? 1 : 0;
      } catch (e) {
        console.warn('[Offers] не удалось сохранить требование запроса:', e);
        if (chk) chk.checked = !ev.detail.checked; // откат при ошибке
        toast('Не удалось сохранить требование «не допускается разбивать партию»', 'error');
      }
      Offers._renderChoiceMatrix();
    });

    // ===== 5. Кнопки =====
    document.getElementById('btnKpSave').onclick = () => Offers.saveSingleKP();
    document.getElementById('btnBestKP').onclick = () => Offers.selectBestKP();
    // ✅ НОВОЕ: экспорт сводной таблицы в Excel
    const btnExportSummary = document.getElementById('btnExportSummary');
    if (btnExportSummary) btnExportSummary.onclick = () => Offers.exportSummary();

    // ✅ T48: прикрепление основания фирмы (PDF) — выбор файла
    const btnOsnovanieSelect = document.getElementById('btnOsnovanieSelect');
    const osnovanieFile = document.getElementById('kpOsnovanieFile');
    if (btnOsnovanieSelect && osnovanieFile) {
      btnOsnovanieSelect.addEventListener('click', () => osnovanieFile.click());
      osnovanieFile.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        osnovanieFile.value = ''; // сброс — тот же файл можно выбрать повторно
        if (f) Offers._uploadOsnovanie(f);
      });
    }

    // ✅ T51: обработчики шагов согласования (шаг 1 «СЗ в ЭДО»,
    // шаг 2 «Согл. структур. подр. АВТОВАЗ»)
    const soglNomer = document.getElementById('soglNomer');
    if (soglNomer) soglNomer.addEventListener('change', () =>
      Offers._putSoglas({ n_sogl_avtovaz: soglNomer.value }));
    const soglEdo = document.getElementById('soglEdo');
    if (soglEdo) soglEdo.addEventListener('change', () =>
      Offers._putSoglas({ id_doc_edo: soglEdo.value }));
    const soglUzb = document.getElementById('soglUzb');
    if (soglUzb) soglUzb.addEventListener('change', () =>
      Offers._putSoglas({ statys_sogl_avtovaz: soglUzb.value }));
    const btnSoglasEdoGo = document.getElementById('btnSoglasEdoGo');
    // ✅ T51-b: «Перейти в ЭДО» — ТОТ ЖЕ механизм, что «🌐 Откр.» у СЗ в СБ
    // (Редактор транспортных операций → Документы): POST open-sz-browser
    // открывает письмо в Яндекс Браузере, только d_kod = id_doc_edo запроса
    if (btnSoglasEdoGo) btnSoglasEdoGo.onclick = () => Offers._openSoglEdo();
    const btnCreateSzSoglas = document.getElementById('btnCreateSzSoglas');
    if (btnCreateSzSoglas) btnCreateSzSoglas.onclick = () => Offers._createSzSoglas();
    // ✅ T51-c: «Ред.» — правка текста письма СЗ на портале (модалка WYSIWYG,
    // загрузка/сохранение по d_kod — как «Ред.» у СЗ в СБ, T44);
    // «✖» — удаление СЗ (красный крест — как на вкладке «Документы», T47)
    const btnEditSzSoglas = document.getElementById('btnEditSzSoglas');
    if (btnEditSzSoglas) btnEditSzSoglas.onclick = () => Offers._editSzSoglas();
    const btnDelSzSoglas = document.getElementById('btnDelSzSoglas');
    if (btnDelSzSoglas) btnDelSzSoglas.onclick = () => Offers._deleteSzSoglas();
    // WYSIWYG-модалка письма согласования
    document.querySelectorAll('#szSoglasToolbar [data-cmd]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // выделение не сбрасывается
      b.addEventListener('click', () => {
        const editor = document.getElementById('szSoglasEditor');
        editor.focus();
        document.execCommand(b.dataset.cmd, false, null);
      });
    });
    const szSoglasSourceBtn = document.getElementById('szSoglasSourceBtn');
    if (szSoglasSourceBtn) szSoglasSourceBtn.onclick = () =>
      Offers._setSzSoglasMode(!Offers._szSoglasSrcMode);
    const szSoglasCancel = document.getElementById('szSoglasCancel');
    if (szSoglasCancel) szSoglasCancel.onclick = () =>
      document.getElementById('szSoglasModal').classList.add('hidden');
    const szSoglasCreate = document.getElementById('szSoglasCreate');
    if (szSoglasCreate) szSoglasCreate.onclick = () => Offers._createSzSoglasFromModal();
    // ✅ T51-c: «Сохранить на портал» — сохранение отредактированного текста
    // СУЩЕСТВУЮЩЕГО письма (режим модалки «Ред.»)
    const szSoglasSave = document.getElementById('szSoglasSave');
    if (szSoglasSave) szSoglasSave.onclick = () => Offers._saveSzSoglas();

    // ===== 6. Первичная загрузка =====
    await Offers.loadZaprosy();

    // --- Привязка событий (твой стиль) ---
    document.getElementById('btnImportExcel').addEventListener('click', () => {
        if (!Offers._isReadyForImport())   return;
        document.getElementById('excelFileInput').click();
    });

    document.getElementById('excelFileInput').addEventListener('change', async (e) => {
        await Offers._handleExcelFileChange(e);
    });


    document.getElementById('kpTrudoemkost').addEventListener('input', Offers.recalcCenaNCh);
    document.getElementById('kpCena').addEventListener('input', Offers.recalcCenaNCh);

    // ✅ НОВОЕ: обработчик чекбокса ручного назначения лучшего КП
    const chkManualBest = document.getElementById('chkManualBestKp');
    if (chkManualBest) {
      chkManualBest.addEventListener('change', () => Offers.onManualBestKpToggle(chkManualBest.checked));
    }

    // ✅ T19-ISKLYUCHEN: обработчик чекбокса «исключено из расчётов»
    const chkKpIsklyuchen = document.getElementById('chkKpIsklyuchen');
    if (chkKpIsklyuchen) {
      chkKpIsklyuchen.addEventListener('change', () => Offers.onKpIsklyuchenToggle(chkKpIsklyuchen.checked));
    }

    // ✅ НОВОЕ: обработчик чекбокса свернуть/развернуть все группы фирм
    const chkCollapseAll = document.getElementById('chkCollapseAllGroups');
    if (chkCollapseAll) {
      chkCollapseAll.addEventListener('change', () => {
        Offers.onCollapseAllGroupsChange(chkCollapseAll.checked);
      });
    }

    // ✅ НОВОЕ: Enter в textarea комментария — триггер назначения или обновления
    //   (Shift+Enter — перенос строки, обычный Enter — отправка)
    const manualCommentTa = document.getElementById('manualBestKpComment');
    if (manualCommentTa) {
      manualCommentTa.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const chk = document.getElementById('chkManualBestKp');
          // ✅ НОВОЕ: если КП уже ручное ЛКП — обновляем только комментарий
          const currentKP = Offers._allKP.find(k => k.id === Offers._selectedKpId);
          const isManualBest = currentKP && currentKP.reshenie === 'лучшее предложение' &&
            currentKP.primechanie_kp && currentKP.primechanie_kp !== 'лучшее предложение по цене';
          if (isManualBest) {
            const primechanieKp = (manualCommentTa.value || '').trim();
            if (primechanieKp && primechanieKp !== currentKP.primechanie_kp) {
              Offers.updateManualBestKPComment(primechanieKp);
            }
          } else if (chk && !chk.checked) {
            chk.checked = true;
            Offers.onManualBestKpToggle(true);
          } else if (chk && chk.checked) {
            // Уже установлен — повторно вызовем с уже заполненным комментарием
            Offers.onManualBestKpToggle(true);
          }
        }
      });
    }
  },
  // ============================================================
  // ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
  // ============================================================
  // --- Функция: чтение файла через FileReader и возврат Base64 (без data:...) ---
  async  _readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
          const reader = new FileReader();

          reader.onload = (event) => {
              // event.target.result — это строка вида "data:application/vnd...;base64,AAAA..."
              const dataUrl = event.target.result;
              const base64Part = dataUrl.split(',')[1]; // берём только часть после запятой
              resolve(base64Part);
          };

          reader.onerror = () => {
              reject(new Error('Ошибка чтения файла'));
          };

          reader.readAsDataURL(file);
      });
  },
    // автоматический пересчет цены нормо-часа при изменении трудоемкости или стоимости:
     recalcCenaNCh() {
        const trud = parseFloat(document.getElementById('kpTrudoemkost').value.replace(',', '.')) || 0;
        const stoimost = parseFloat(document.getElementById('kpCena').value.replace(',', '.')) || 0;
        const cenaNCh = (trud > 0) ? (stoimost / trud) : 0;
        document.getElementById('kpCenaNCh').value = cenaNCh > 0 ? cenaNCh.toFixed(2) : '';
    },
  // --- Обработчик change у инпута (вся логика импорта) ---
  async  _handleExcelFileChange(e) {
      const input = e.target;
      const file = input.files[0];

      // Если файл не выбран — ничего не делаем
      if (!file) return;

      // Подтверждение от пользователя
      if (!confirm(`Загрузить данные из файла "${file.name}"?\n\nТекущие значения трудоемкости и цены будут перезаписаны расчетными данными из файла.`)) {
          input.value = '';
          return;
      }

      toast('Чтение файла...', 'info');

      let fileBase64;
      try {
          fileBase64 = await Offers._readFileAsBase64(file);
      } catch (err) {
          console.error('Read error:', err);
          toast('Ошибка чтения файла', 'error');
          input.value = '';
          return;
      }

      toast('Отправка на сервер и обработка...', 'info');

      try {
          const response = await fetch('/api/kom-predl/import-excel', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                  zaprosId: Offers._selectedZaprosId,
                  firmaId: Offers._selectedFirmaId,
                  fileBase64: fileBase64
              })
          });

          const result = await response.json();

          if (result.ok) {
              toast(result.message, 'success');
              await Offers._reloadKPAndSummary();

              if (Offers._selectedKpId) {
                  const currentKP = Offers._allKP.find(k => k.id === Offers._selectedKpId);
                  if (currentKP) {
                      Offers._formStateManager.fillFromRow(currentKP);
                  }
              }
          } else {
              toast('Ошибка: ' + (result.error || 'Неизвестная ошибка'), 'error');
          }
      } catch (err) {
          console.error('Import error:', err);
          toast('Ошибка сети при загрузке файла', 'error');
      } finally {
          // Сброс инпута в любом случае (успех/ошибка)
          input.value = '';
      }
  },
  // --- Вспомогательная функция: проверка обязательных ID ---
  _isReadyForImport() {
      if (!Offers._selectedZaprosId) {
          toast('Сначала выберите Запрос КП', 'warning');
          return false;
      }
      if (!Offers._selectedFirmaId) {
          toast('Сначала выберите Фирму', 'warning');
          return false;
      }
      return true;
  },
  /** Сброс всех зависимых данных */
  _resetDependentData() {
    const selFirma = document.getElementById('fltFirma');
    selFirma.innerHTML = '<option value="">— Выберите фирму —</option>';
    selFirma.value = '';
    Offers._selectedFirmaId = null;
    Offers._allFirmy = [];
    Offers._osnovanieIndex = new Map(); // ✅ T49: скрепки старого запроса больше неактуальны
    Offers._allDetali = [];
    Offers._selectedKpId = null;
    state.tables.detali.setData([]);
    document.getElementById('kpDogovor').innerHTML = '<option value="">— Выберите договор —</option>';
    Offers.clearForm();
  },

  /** Загрузка КП для запроса с учётом фильтра no_kp и обновление сводной таблицы */
  async _loadKPForZapros(zaprosId) {
    const noKP = document.getElementById('fltNoKP').checked ? '1' : '0';
    const kp = await api('GET', `/api/kom-predl?zaprosId=${zaprosId}&no_kp=${noKP}`);
    Offers._allKP = Array.isArray(kp) ? kp : [];

    // Уникальные фирмы
    const firmMap = new Map();
    Offers._allKP.forEach((k) => {
      if (k.id_firma && !firmMap.has(k.id_firma)) {
        firmMap.set(k.id_firma, {
          id_firmy: k.id_firma,
          naimenovanie: k.firma_nazvanie || k.id_firma,
        });
      }
    });
    Offers._allFirmy = Array.from(firmMap.values());

    // ✅ T49: список фирм строит _rebuildFirmaOptions —
    // у фирм с основанием в пункте списка ставится скрепка 📎
    Offers._rebuildFirmaOptions();

    Offers._rebuildSummaryTable(Offers._allKP);
  },
  // ============================================================
  // ✅ T49: СКРЕПКИ В СПИСКЕ ФИРМ (#fltFirma)
  // ============================================================

  /**
   * ✅ T49: перестроить пункты #fltFirma из _allFirmy.
   * У фирмы с основанием (есть в _osnovanieIndex) перед названием
   * ставится «📎 », а в title пункта — имя файла (видно при наведении).
   * Текущий выбор фирмы сохраняется, если она осталась в списке
   * (например, сразу после прикрепления документа).
   */
  _rebuildFirmaOptions() {
    const selFirma = document.getElementById('fltFirma');
    if (!selFirma) return;
    const prev = selFirma.value;
    selFirma.innerHTML = '<option value="">— Выберите фирму —</option>';
    Offers._allFirmy.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f.id_firmy;
      const fname = Offers._osnovanieIndex.get(f.id_firmy);
      if (fname) {
        opt.textContent = '📎 ' + f.naimenovanie;
        opt.title = fname; // при наведении — имя файла основания
      } else {
        opt.textContent = f.naimenovanie;
      }
      selFirma.appendChild(opt);
    });
    if (prev && Array.from(selFirma.options).some((o) => o.value === prev)) {
      selFirma.value = prev;
    }
  },

  /**
   * ✅ T49: загрузить основания ВСЕХ фирм текущего запроса одним GET-запросом
   * (GET /api/kom-predl/osnovanie?zaprosId=... без firmaId → { all: [...] })
   * и перестроить список фирм со скрепками. Вызывается при смене запроса.
   */
  async _loadOsnovanieIndex() {
    Offers._osnovanieIndex = new Map();
    if (!Offers._selectedZaprosId) {
      Offers._rebuildFirmaOptions();
      return;
    }
    try {
      const r = await api('GET', `/api/kom-predl/osnovanie?zaprosId=${encodeURIComponent(Offers._selectedZaprosId)}`);
      (r && Array.isArray(r.all) ? r.all : []).forEach((o) => {
        if (o && o.id_firma) Offers._osnovanieIndex.set(o.id_firma, o.imya_fayla || o.ssylka || '');
      });
    } catch (e) {
      // не удалось получить индекс — список останется без скрепок
    }
    Offers._rebuildFirmaOptions();
  },

  /** Универсальная загрузка договоров в селект */
  async _loadDogovory(selectId, firmaId) {
    const data = await api('GET', `/api/dogovor?id_firmy=${firmaId}`);
    const dogovory = Array.isArray(data) ? data : [];
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const currentValue = sel.value;
    sel.innerHTML = '<option value="">— Выберите договор —</option>';
    dogovory.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.id_dogovor;
      // ✅ НОВОЕ: форматируем дату в DD.MM.YYYY для всех селектов договоров
      opt.textContent = `${d.nom_dogovor} от ${formatDateRu(d.data_dogovor)}`;
      sel.appendChild(opt);
    });
    if (currentValue && Array.from(sel.options).some((opt) => opt.value === currentValue)) {
      sel.value = currentValue;
    }
  },
  /** Обновить статус, перезагрузить КП и сводную таблицу (после сохранения) */
  async _refreshStatusAndKP() {
    await Offers.loadZaprosy();
    const currentZapros = Offers._allZaprosy.find((z) => z.id === Offers._selectedZaprosId);
    if (currentZapros) {
      document.getElementById('lblStatus').textContent = currentZapros.statys || '—';
    }
    await Offers._reloadKPAndSummary();
    if (Offers._selectedFirmaId) {
      await Offers.onFirmaChange();
    }
    Offers.updateButtonStates();
  },
  /** Перезагрузка КП и сводной таблицы (без обновления статуса) */
  async _reloadKPAndSummary() {
    const noKP = document.getElementById('fltNoKP').checked ? '1' : '0';
    const kp = await api('GET', `/api/kom-predl?zaprosId=${Offers._selectedZaprosId}&no_kp=${noKP}`);
    Offers._allKP = Array.isArray(kp) ? kp : [];
    Offers._rebuildSummaryTable(Offers._allKP);
  },
  /** Обновление лейбла статуса */
  async _refreshStatusLabel() {
    const zaprosId = Offers._selectedZaprosId;
    if (!zaprosId) return;
    const statusData = await api('GET', `/api/zapros-kp/status?zaprosId=${zaprosId}`);
    if (statusData && statusData.length > 0) {
      document.getElementById('lblStatus').textContent = statusData[0].statys || '—';
      Offers.updateButtonStates();
    }
  },
  /** Перезагрузка договоров в комбобоксе формы (персональный договор позиции) */
  async _reloadDogovory() {
    if (Offers._selectedFirmaId) {
      await Offers._loadDogovory('kpDogovor', Offers._selectedFirmaId);
    }
  },
  // ============================================================
  // ПУБЛИЧНЫЕ МЕТОДЫ
  // ============================================================

  // ===== Загрузка списка запросов =====
  async loadZaprosy() {
    const god = document.getElementById('fltGod').value || new Date().getFullYear();
    const noKP = document.getElementById('fltNoKP').checked;
    const params = new URLSearchParams();
    params.append('god', god);
    if (noKP) params.append('no_kp', '1');
    const data = await api('GET', `/api/zapros-kp?${params.toString()}`);
    Offers._allZaprosy = Array.isArray(data) ? data : [];

    const sel = document.getElementById('fltZapros');
    const currentValue = sel.value;
    sel.innerHTML = '<option value="">— Выберите запрос —</option>';
    Offers._allZaprosy.forEach((z) => {
      const opt = document.createElement('option');
      opt.value = z.id;
      // ✅ НОВОЕ: форматируем дату в DD.MM.YYYY
      opt.textContent = `${z.n_zaprosa} от ${formatDateRu(z.data_form)}`;
      sel.appendChild(opt);
    });
    if (currentValue && Offers._allZaprosy.find((z) => z.id === currentValue)) {
      sel.value = currentValue;
    } else {
      sel.value = '';
    }
    // ✅ T51: панель шагов согласования следует за выбранным запросом
    // (в т.ч. при WS-обновлении zapros_kp — app-offers.js вызывает loadZaprosy)
    Offers._renderSoglSteps();
  },

  // ===== Смена запроса =====
  async onZaprosChange() {
    Offers._resetDependentData();
    const zaprosId = document.getElementById('fltZapros').value;
    Offers._selectedZaprosId = zaprosId;

    if (!zaprosId) {
      Offers._allKP = [];
      Offers._rebuildSummaryTable([]);
      document.getElementById('lblStatus').textContent = '—';
      await Offers._loadOsnovanie(); // ✅ T48: без запроса основания нет — очистить
      Offers._renderSoglSteps();     // ✅ T51: сброс панели шагов согласования
      Offers.updateButtonStates();
      return;
    }

    const zapros = Offers._allZaprosy.find((z) => z.id === zaprosId);
    document.getElementById('lblStatus').textContent = zapros?.statys || '—';
    // ✅ T78: чекбокс «не допускается разбивать партию» — из поля запроса
    // (zapros_kp.komplekt — требование «все позиции изготавливаются
    // комплектом»); переключение сохраняется на сервере (см. init)
    const chkNoSplit = document.getElementById('chkNoSplitBatch');
    if (chkNoSplit) chkNoSplit.checked = !!zapros?.komplekt;
    await Offers._loadKPForZapros(zaprosId);
    await Offers._loadOsnovanieIndex(); // ✅ T49: скрепки 📎 в списке фирм по основаниям запроса
    await Offers._loadOsnovanie(); // ✅ T48: фирма ещё не выбрана — поле очистится
    Offers._renderSoglSteps(); // ✅ T51: панель шагов согласования для выбранного запроса
    Offers.updateButtonStates();
  },

  // ===== Смена фирмы =====
  async onFirmaChange() {
    const firmaId = document.getElementById('fltFirma').value;
    Offers._selectedFirmaId = firmaId;

    if (!firmaId || !Offers._selectedZaprosId) {
      Offers._allDetali = [];
      state.tables.detali.setData([]);
      await Offers._loadOsnovanie(); // ✅ T48: фирма сброшена — очистить основание
      Offers.updateButtonStates();
      return;
    }

    const detaliMap = new Map();
    Offers._allKP
      .filter((k) => k.id_firma === firmaId)
      .forEach((k) => {
        if (!detaliMap.has(k.id_plana)) {
          detaliMap.set(k.id_plana, {
            id: k.id_plana,
            kp_id: k.id,
            nomer_chertezha: k.nomer_chertezha,
            osn_naimenovanie: k.osn_naimenovanie,
            plan_god_kolvo: k.plan_god_kolvo,
            dogovor_nom: k.nom_dogovor || '',
          });
        }
      });
    Offers._allDetali = Array.from(detaliMap.values());
    state.tables.detali.setData(Offers._allDetali);
    Offers.updateButtonStates();

    // ✅ НОВОЕ: при смене фирмы в фильтре — центрируем группу колонок
    // этой фирмы в сводной таблице. Сводная таблица уже отрисована
    // (она перестраивается только при смене запроса), так что просто
    // вызываем скролл. Если таблицы ещё нет (нет данных) — тихо выходим.
    Offers._scrollToSelectedFirmaGroup();

    // ✅ T48: основание относится к паре «запрос + фирма» — грузим для новой фирмы
    await Offers._loadOsnovanie();
  },

  // ============================================================
  // ✅ T51: ШАГИ СОГЛАСОВАНИЯ ЗАКАЗА ПО ЗАПРОСУ.
  //   Шаг 1 — «СЗ в ЭДО»: письмо «Согласование заказа по запросу
  //   ТКП № …» создаётся на портале (аналог «СЗ в СБ об отгрузке»,
  //   Редактор транспортных операций → вкладка Документы):
  //   предпросмотр текста из лучших КП запроса → правка в модальном
  //   окне WYSIWYG → создание; № СЗ (n_sogl_avtovaz) и № письма ЭДО
  //   (id_doc_edo) сохраняются в zapros_kp.
  //   Шаг 2 — «Согл. структур. подр. АВТОВАЗ» — перенесён со страницы
  //   «Заказы по договорам» (там был шаг 3): № письма ЭДО (id_doc_edo,
  //   ручной ввод/автозаполнение шагом 1), «Перейти в ЭДО» и решение
  //   УЗБ (statys_sogl_avtovaz).
  // ============================================================

  /** Рендер панели шагов из данных текущего запроса (кэш _allZaprosy) */
  _renderSoglSteps() {
    const el = (id) => document.getElementById(id);
    const nomer = el('soglNomer'), edo = el('soglEdo'), uzb = el('soglUzb');
    const btnCreate = el('btnCreateSzSoglas'), btnGo = el('btnSoglasEdoGo');
    const btnEdit = el('btnEditSzSoglas'), btnDel = el('btnDelSzSoglas');
    if (!nomer || !edo || !uzb || !btnCreate || !btnGo) return;
    const b1 = el('soglBadge1'), b2 = el('soglBadge2');
    const fs1 = el('soglStep1'), fs2 = el('soglStep2');
    const h1 = el('soglHint1'), h2 = el('soglHint2');
    const zapros = Offers._selectedZaprosId
      ? Offers._allZaprosy.find((z) => z.id === Offers._selectedZaprosId)
      : null;
    if (!zapros) {
      nomer.value = ''; edo.value = ''; uzb.value = '';
      if (fs1) fs1.classList.add('blocked');
      if (fs2) fs2.classList.add('blocked');
      if (b1) b1.className = 'sogl-badge';
      if (b2) b2.className = 'sogl-badge';
      [btnCreate, btnGo, btnEdit, btnDel, nomer, edo, uzb].forEach((x) => { if (x) x.disabled = true; });
      if (h1) h1.style.display = 'none';
      if (h2) h2.style.display = 'none';
      return;
    }
    // Шаг 1 выполнен: есть № согласования или № письма ЭДО (ручной ввод — тоже вариант)
    const done1 = !!(String(zapros.n_sogl_avtovaz || '').trim() || String(zapros.id_doc_edo || '').trim());
    const done2 = !!(zapros.statys_sogl_avtovaz && String(zapros.statys_sogl_avtovaz).trim());
    // ✅ T51-c: «Ред.» и «✖» работают с письмом НА ПОРТАЛЕ — им нужен
    // id_doc_edo (№ СЗ может быть введён вручную без создания письма)
    const idEdo = String(zapros.id_doc_edo || '').trim();
    nomer.value = zapros.n_sogl_avtovaz || '';
    edo.value = zapros.id_doc_edo || '';
    uzb.value = zapros.statys_sogl_avtovaz || '';
    if (b1) b1.className = 'sogl-badge' + (done1 ? ' done' : ' active');
    if (b2) b2.className = 'sogl-badge' + (done2 ? ' done' : (done1 ? ' active' : ''));
    if (fs1) fs1.classList.remove('blocked');
    if (fs2) fs2.classList.toggle('blocked', !done1);
    nomer.disabled = false;
    edo.disabled = !done1;
    uzb.disabled = !done1;
    btnCreate.disabled = done1;   // письмо уже создано — повторно создавать нельзя
    // ✅ T51-b: «Перейти в ЭДО» активна ТОЛЬКО после выполнения шага 1
    // (есть № СЗ/№ письма ЭДО) — как «🌐 Откр.» требует созданного письма
    btnGo.disabled = !done1;
    // ✅ T51-c: «Ред.» и «✖» — активны только при наличии письма на портале
    if (btnEdit) btnEdit.disabled = !idEdo;
    if (btnDel) btnDel.disabled = !idEdo;
    if (h1) {
      // ✅ T51-c: № СЗ введён вручную, а письма на портале нет — «Ред.»/«✖» недоступны
      if (done1 && !idEdo) {
        h1.textContent = 'Письмо в ЭДО не создано (введён только № СЗ) — «Ред.» и «✖» недоступны.';
        h1.style.display = 'block';
      } else h1.style.display = 'none';
    }
    if (h2) {
      if (!done1) {
        h2.textContent = 'Шаг недоступен: сначала создайте СЗ в ЭДО (шаг 1) или введите № СЗ вручную.';
        h2.style.display = 'block';
      } else h2.style.display = 'none';
    }
  },

  /** Сохранение поля согласования запроса на сервер (PUT /api/zapros-kp/:id/soglas) */
  async _putSoglas(patch) {
    if (!Offers._selectedZaprosId) return null;
    try {
      const r = await api('PUT', `/api/zapros-kp/${encodeURIComponent(Offers._selectedZaprosId)}/soglas`, patch);
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return null; }
      if (r.row) {
        const z = Offers._allZaprosy.find((x) => x.id === Offers._selectedZaprosId);
        if (z) Object.assign(z, r.row);
      }
      Offers._renderSoglSteps();
      toast('Согласование сохранено', 'success');
      return r;
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
      return null;
    }
  },

  /**
   * ✅ T51-b: «Перейти в ЭДО» (шаг 2) — открытие письма согласования
   * на сайте ЭДО (docs.vaz.ru) в Яндекс Браузере — ТОТ ЖЕ механизм,
   * что у кнопки «🌐 Откр.» СЗ в СБ об отгрузке (Редактор транспортных
   * операций → вкладка Документы): POST /api/transport-oper/open-sz-browser
   * (puppeteer-core --app + Basic-аутентификация в браузере), только
   * d_kod = id_doc_edo ЭТОГО запроса (письмо шага 1).
   */
  async _openSoglEdo() {
    const btn = document.getElementById('btnSoglasEdoGo');
    const z = Offers._selectedZaprosId
      ? Offers._allZaprosy.find((x) => x.id === Offers._selectedZaprosId)
      : null;
    const edoId = String((document.getElementById('soglEdo') || {}).value || '').trim() ||
      String((z && z.id_doc_edo) || '').trim();
    // аналог guard-а btnGoIdoSb «СЗ в СБ об отгрузке не создана»
    if (!edoId) { toast('СЗ в ЭДО не создана (сначала выполните шаг 1)', 'error'); return; }
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/transport-oper/open-sz-browser', { d_kod: edoId });
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      if (r.warning) { toast('Открыто с предупреждением: ' + r.warning, 'warning'); return; }
      toast('СЗ согласования открыта на сайте ЭДО (Яндекс Браузер)', 'success');
    } catch (e) {
      toast('Сетевая ошибка: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  // --- WYSIWYG-режим модалки письма согласования (эталон T39-C) ---
  _szSoglasSrcMode: false,
  _setSzSoglasMode(src) {
    const ta = document.getElementById('szSoglasText');
    const editor = document.getElementById('szSoglasEditor');
    const toolbar = document.getElementById('szSoglasToolbar');
    const btn = document.getElementById('szSoglasSourceBtn');
    Offers._szSoglasSrcMode = src;
    // ✅ T61: выход из режима «Только просмотр» (модалка могла быть открыта
    // для подписанного письма) — редактор снова редактируемый
    if (Offers._szSoglasViewMode) Offers._setSzSoglasViewMode(false);
    editor.style.display = src ? 'none' : '';
    toolbar.style.display = src ? 'none' : '';
    ta.hidden = !src;
    if (src) ta.value = editor.innerHTML;
    else if (ta.value !== '') editor.innerHTML = ta.value;
    if (btn) btn.classList.toggle('szl-on', src);
  },

  // --- ✅ T61: режим «Только просмотр» модалки письма согласования --------
  // Документ подписан на портале (страница ViewShablon.aspx?mode=edit
  // отдаёт <div id="LetterDiv"> без редактируемой формы): письмо можно
  // только посмотреть. Редактор contenteditable=false, панель форматиро-
  // вания и кнопки сохранения/создания скрыты. Обратное включение выпол-
  // няется автоматически из _setSzSoglasMode при следующем открытии.
  _szSoglasViewMode: false,
  _setSzSoglasViewMode(view) {
    Offers._szSoglasViewMode = !!view;
    const editor = document.getElementById('szSoglasEditor');
    const toolbar = document.getElementById('szSoglasToolbar');
    const btnSave = document.getElementById('szSoglasSave');
    const btnCreate = document.getElementById('szSoglasCreate');
    if (!editor) return;
    if (view) {
      editor.contentEditable = 'false';
      editor.style.background = '#f6f7f9';
      toolbar.style.display = 'none';
      btnSave.style.display = 'none';
      btnCreate.style.display = 'none';
    } else {
      editor.contentEditable = 'true';
      editor.style.background = '#fff';
    }
  },

  /** Шаг 1: «Создать» — предпросмотр письма в модалке WYSIWYG (режим СОЗДАНИЯ) */
  async _createSzSoglas() {
    if (!Offers._selectedZaprosId) { toast('Сначала выберите Запрос КП', 'warning'); return; }
    const btn = document.getElementById('btnCreateSzSoglas');
    btn.disabled = true;
    try {
      const p = await api('POST', '/api/zapros-kp/sz-soglas-preview', { id_zaprosa: Offers._selectedZaprosId });
      if (p.error) { toast('Ошибка: ' + p.error, 'error'); return; }
      const modal = document.getElementById('szSoglasModal');
      const info = document.getElementById('szSoglasInfo');
      const ta = document.getElementById('szSoglasText');
      const editor = document.getElementById('szSoglasEditor');
      // ✅ T51-c: режим модалки СОЗДАНИЯ — видна «Создать СЗ в ЭДО»,
      // «Сохранить на портал» скрыта (модалка могла быть открыта в «Ред.»)
      Offers._szSoglasEditMode = false;
      document.getElementById('szSoglasCreate').style.display = '';
      document.getElementById('szSoglasSave').style.display = 'none';
      ta.value = p.letter || '';
      editor.innerHTML = p.letter || '';
      Offers._setSzSoglasMode(false);   // модалка открывается в WYSIWYG
      // ✅ T52: в шапке модалки — РЕАЛЬНАЯ тема письма (tema.sz_soglasovanie
      // с подстановками {номер}/{дата}/{фирмы}), а не жёсткая строка
      info.textContent = 'Тема: «' + (p.tema || ('Согласование заказа по запросу ТКП № ' + (p.n_zaprosa || ''))) + '».' +
        ' Текст письма — проверьте, исправьте и нажмите «Создать СЗ в ЭДО»' +
        ' (позиций: ' + (p.positions || []).length + ', фирм: ' + (p.firms || []).length + ')';
      modal.classList.remove('hidden');
    } catch (e) {
      toast('Сетевая ошибка: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  /**
   * ✅ T51-c: «Ред.» (шаг 1) — редактирование текста СУЩЕСТВУЮЩЕГО письма
   * согласования на портале — ТОТ ЖЕ механизм, что «Ред.» у СЗ в СБ об
   * отгрузке (T44): GET /api/transport-oper/sz-letter?d_kod= загружает текст
   * ЛЮБОГО письма по идентификатору портала, сохранение — POST
   * save-sz-template {d_kod, letter}. Модалка та же (szSoglasModal), но в
   * режиме ПРАВКИ: видна «Сохранить на портал», «Создать» скрыта.
   */
  async _editSzSoglas() {
    if (!Offers._selectedZaprosId) { toast('Сначала выберите Запрос КП', 'warning'); return; }
    const edoId = Offers._soglEdoId();
    // аналог guard-а btnEditSzTextSb «СЗ в СБ об отгрузке не создана»
    if (!edoId) { toast('СЗ в ЭДО не создана (сначала выполните шаг 1)', 'error'); return; }
    const modal = document.getElementById('szSoglasModal');
    const info = document.getElementById('szSoglasInfo');
    const ta = document.getElementById('szSoglasText');
    const editor = document.getElementById('szSoglasEditor');
    const btnSave = document.getElementById('szSoglasSave');
    // режим модалки ПРАВКИ: «Сохранить на портал» видна, «Создать» скрыта
    Offers._szSoglasEditMode = true;
    document.getElementById('szSoglasCreate').style.display = 'none';
    btnSave.style.display = '';
    btnSave.disabled = true;
    info.textContent = 'Загрузка текста с портала…';
    ta.value = '';
    editor.innerHTML = '';
    Offers._setSzSoglasMode(false); // модалка открывается в WYSIWYG
    modal.classList.remove('hidden');
    try {
      const r = await api('GET', '/api/transport-oper/sz-letter?d_kod=' + encodeURIComponent(edoId));
      if (r.error) {
        modal.classList.add('hidden');
        toast('Ошибка: ' + r.error, 'error');
        return;
      }
      ta.value = r.letter || '';
      editor.innerHTML = r.letter || '';
      if (r.signed) {
        // ✅ T61: документ подписан на портале — письмо только для просмотра
        Offers._setSzSoglasViewMode(true);
        info.textContent = 'Документ ПОДПИСАН на портале — просмотр без редактирования. ' +
          'СЗ согласования №' + (r.d_nom || '') + ' от ' + (r.date_doc || '') +
          ' (ID ' + (r.id_sz || '') + ')';
        return;
      }
      info.textContent = 'СЗ согласования №' + (r.d_nom || '') + ' от ' + (r.date_doc || '') +
        ' (ID ' + (r.id_sz || '') + ')';
      btnSave.disabled = false;
    } catch (e) {
      modal.classList.add('hidden');
      toast('Сетевая ошибка: ' + e.message, 'error');
    }
  },

  /** id письма ЭДО выбранного запроса: поле soglEdo, иначе кэш _allZaprosy */
  _soglEdoId() {
    const z = Offers._selectedZaprosId
      ? Offers._allZaprosy.find((x) => x.id === Offers._selectedZaprosId)
      : null;
    return String((document.getElementById('soglEdo') || {}).value || '').trim() ||
      String((z && z.id_doc_edo) || '').trim();
  },

  /**
   * ✅ T51-c: «Сохранить на портал» (модалка в режиме «Ред.») — POST
   * /api/transport-oper/save-sz-template {d_kod, letter} — ТОТ ЖЕ эндпоинт,
   * что у «Ред.» СЗ в СБ (T44): d_kod в теле — сохранение текста ЛЮБОГО
   * письма по идентификатору портала.
   */
  async _saveSzSoglas() {
    const edoId = Offers._soglEdoId();
    if (!edoId) { toast('СЗ в ЭДО не создана', 'error'); return; }
    const btnSave = document.getElementById('szSoglasSave');
    const letter = Offers._szSoglasSrcMode
      ? document.getElementById('szSoglasText').value
      : document.getElementById('szSoglasEditor').innerHTML;
    btnSave.disabled = true;
    try {
      const r = await api('POST', '/api/transport-oper/save-sz-template', { d_kod: edoId, letter: letter });
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; } // окно остаётся открытым — можно повторить
      document.getElementById('szSoglasModal').classList.add('hidden');
      toast('Текст письма согласования сохранён на портале', 'success');
    } catch (e) {
      toast('Сетевая ошибка: ' + e.message, 'error');
    } finally {
      btnSave.disabled = false;
    }
  },

  /**
   * ✅ T51-c: «✖» (шаг 1) — удаление СЗ согласования — ТОТ ЖЕ механизм,
   * что у красного крестика СЗ в СБ (T47): простой GET document_delete.aspx?
   * d_kod= в системе ВАЗ (Basic-аутентификация); при успехе сервер очищает
   * n_sogl_avtovaz/id_doc_edo в zapros_kp. При ошибке портала база НЕ
   * очищается (документ остаётся и в системе, и в базе).
   */
  async _deleteSzSoglas() {
    const btn = document.getElementById('btnDelSzSoglas');
    if (!Offers._selectedZaprosId) { toast('Сначала выберите Запрос КП', 'warning'); return; }
    const edoId = Offers._soglEdoId();
    if (!edoId) { toast('СЗ в ЭДО не создана', 'error'); return; }
    if (!window.confirm('Удалить СЗ согласования из системы ВАЗ и очистить № СЗ и № письма ЭДО? Действие необратимо.')) return;
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/zapros-kp/delete-sz-soglas',
        { id_zaprosa: Offers._selectedZaprosId, d_kod: edoId });
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      const z = Offers._allZaprosy.find((x) => x.id === Offers._selectedZaprosId);
      if (z) { z.n_sogl_avtovaz = ''; z.id_doc_edo = ''; }
      toast('СЗ согласования удалена из системы ВАЗ, поля и база очищены', 'success');
    } catch (e) {
      toast('Сетевая ошибка: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      // финальная синхронизация ВСЕХ кнопок шагов по данным запроса
      // (после успешного удаления Ред./✖ блокируются — письма больше нет)
      Offers._renderSoglSteps();
    }
  },

  /** Кнопка модалки «Создать СЗ в ЭДО» — создание на портале с отредактированным текстом */
  async _createSzSoglasFromModal() {
    if (!Offers._selectedZaprosId) { toast('Сначала выберите Запрос КП', 'warning'); return; }
    const btnCreate = document.getElementById('szSoglasCreate');
    const letter = Offers._szSoglasSrcMode
      ? document.getElementById('szSoglasText').value
      : document.getElementById('szSoglasEditor').innerHTML;
    btnCreate.disabled = true;
    try {
      const r = await api('POST', '/api/zapros-kp/create-sz-soglas',
        { id_zaprosa: Offers._selectedZaprosId, letter: letter });
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; } // окно остаётся открытым — можно повторить
      document.getElementById('szSoglasModal').classList.add('hidden');
      const z = Offers._allZaprosy.find((x) => x.id === Offers._selectedZaprosId);
      if (z) { z.n_sogl_avtovaz = r.n_sogl_avtovaz || ''; z.id_doc_edo = r.id_doc_edo || ''; }
      Offers._renderSoglSteps();
      const msg = 'СЗ №' + (r.n_sogl_avtovaz || '') + ' от ' + (r.data_ru || '') +
        ' создана (ID ' + (r.id_doc_edo || '') + '); подписант: ' + (r.podp || '');
      if (r.letter_saved === false) toast(msg + '. ТЕКСТ письма НЕ сохранён: ' + (r.letter_error || ''), 'warning');
      else toast(msg, 'success');
      // ✅ T51-b: итог вложений (сводная + запрос Excel + основания PDF) —
      // проблемы НЕ прерывают создание СЗ, но показываются пользователю
      const at = r.attachments;
      if (at && at.failed > 0) {
        const probs = (at.details || []).filter((x) => !x.ok)
          .slice(0, 3).map((x) => x.file + ' — ' + (x.error || 'ошибка'));
        toast('Вложения (' + at.ok + ' из ' + at.total + '): ' + probs.join('; ') +
          (at.failed > 3 ? '; и ещё ' + (at.failed - 3) : ''), 'warning');
      } else if (at && at.ok > 0) {
        toast('Вложения прикреплены к СЗ: ' + at.ok + ' (сводная, запрос Excel, основания)', 'success');
      }
    } catch (e) {
      toast('Сетевая ошибка: ' + e.message, 'error');
    } finally {
      btnCreate.disabled = false;
    }
  },

  // ============================================================
  // ✅ T48: ОСНОВАНИЕ ОТ ФИРМЫ (PDF, таблица ТКПоснование)
  //   Документ относится ко всем деталям запроса для выбранной фирмы.
  //   Хранение на сервере: public/запросы/<год>/<номер запроса>/.
  // ============================================================

  /** Загрузить основание для текущей пары «запрос + фирма» и показать */
  async _loadOsnovanie() {
    Offers._osnovanie = null;
    if (!Offers._selectedZaprosId || !Offers._selectedFirmaId) {
      Offers._renderOsnovanie();
      return;
    }
    try {
      const r = await api('GET', `/api/kom-predl/osnovanie?zaprosId=${encodeURIComponent(Offers._selectedZaprosId)}&firmaId=${encodeURIComponent(Offers._selectedFirmaId)}`);
      Offers._osnovanie = (r && r.osnovanie) ? r.osnovanie : null;
    } catch (e) {
      Offers._osnovanie = null;
    }
    Offers._renderOsnovanie();
  },

  /** Отрисовать название документа и ссылку «Открыть» */
  _renderOsnovanie() {
    const nameEl = document.getElementById('kpOsnovanieName');
    const linkEl = document.getElementById('kpOsnovanieLink');
    if (!nameEl || !linkEl) return;
    const o = Offers._osnovanie;
    nameEl.value = (o && o.imya_fayla) ? o.imya_fayla : '';
    if (o && o.ssylka) {
      linkEl.href = o.ssylka;
      linkEl.style.visibility = 'visible';
      linkEl.title = 'Открыть документ: ' + (o.imya_fayla || o.ssylka) +
        (o.data_zagruzki ? (' (загружен ' + o.data_zagruzki + ')') : '');
    } else {
      linkEl.style.visibility = 'hidden';
      linkEl.removeAttribute('href');
    }
  },

  /** Загрузить выбранный PDF-файл на сервер и прикрепить к паре «запрос + фирма» */
  async _uploadOsnovanie(file) {
    if (!file) return;
    if (!Offers._selectedZaprosId || !Offers._selectedFirmaId) {
      toast('Сначала выберите Запрос КП и Фирму', 'warning');
      return;
    }
    if (!/\.pdf$/i.test(file.name || '')) {
      toast('Можно прикреплять только PDF-файл', 'warning');
      return;
    }
    try {
      toast('Загрузка документа...', 'warning');
      const url = `/api/kom-predl/osnovanie/upload?zaprosId=${encodeURIComponent(Offers._selectedZaprosId)}` +
        `&firmaId=${encodeURIComponent(Offers._selectedFirmaId)}&name=${encodeURIComponent(file.name)}`;
      const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const r = await resp.json();
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      Offers._osnovanie = r;
      Offers._renderOsnovanie();
      // ✅ T49: скрепка 📎 в списке фирм появляется СРАЗУ после прикрепления
      // документа, без перезагрузки страницы (выбор фирмы сохраняется)
      Offers._osnovanieIndex.set(Offers._selectedFirmaId, r.imya_fayla || r.ssylka || '');
      Offers._rebuildFirmaOptions();
      toast('Документ прикреплён: ' + (r.imya_fayla || ''), 'success');
    } catch (e) {
      toast('Ошибка загрузки: ' + e.message, 'error');
    }
  },

  // ===== Загрузка договоров для формы (одна позиция) =====
  async loadDogovoryForForm(firmaId) {
    await Offers._loadDogovory('kpDogovor', firmaId);
  },

  // ===== Обновление состояния кнопок =====
  updateButtonStates() {
    const status = (document.getElementById('lblStatus').textContent || '').trim();
    // ✅ ИСПРАВЛЕНО: canEdit-фильтр статусов убран из условия кнопки «Сохранить»
    // (внесение КП должно быть возможно при любом статусе, не попавшем в белый
    // список — например «создание»); сервер по-прежнему отклоняет недопустимые
    // сохранения (КП уже в заказе и т.п.).

    // Активируем кнопку импорта, если выбраны и запрос, и фирма
    const btnImport = document.getElementById('btnImportExcel');
    if (btnImport) btnImport.disabled = !(Offers._selectedZaprosId && Offers._selectedFirmaId);

    // ✅ T48: кнопка выбора основания — активна только при выбранной паре «запрос + фирма»
    const btnOsnovanie = document.getElementById('btnOsnovanieSelect');
    if (btnOsnovanie) btnOsnovanie.disabled = !(Offers._selectedZaprosId && Offers._selectedFirmaId);

    const btnBestKP = document.getElementById('btnBestKP');
    if (btnBestKP) btnBestKP.disabled = !Offers._selectedZaprosId || status === 'выбраны лучшие КП';

    const btnKpSave = document.getElementById('btnKpSave');
    const hasKp = !!Offers._selectedKpId;
    const locker = hasKp ? isLocked('kp', Offers._selectedKpId) : null;
    // ✅ ИСПРАВЛЕНО: кнопка активируется при выборе КП и изменении ХОТЯ БЫ
    // ОДНОГО поля формы (isDirty). Условия «!tipIzgot» и «!canEdit» убраны:
    // у нового КП тип изготовления ещё пуст — кнопка навсегда оставалась
    // заблокированной, хотя валидация типа уже есть в saveSingleKP (тост),
    // а статусные ограничения дублируются сервером (CHAIN_IN_ORDER и др.).
    if (btnKpSave) btnKpSave.disabled = !hasKp || !!locker || !Offers.isDirty();

    // ✅ НОВОЕ: синхронизируем чекбокс ручного назначения лучшего КП
    // (показ/скрытие и состояние галочки зависит от статуса запроса и КП)
    const currentKpForCheckbox = hasKp
      ? Offers._allKP.find(k => k.id === Offers._selectedKpId)
      : null;
    Offers._updateManualBestKpCheckbox(currentKpForCheckbox);
    // ✅ T19-ISKLYUCHEN: синхронизируем чекбокс «исключено из расчётов»
    Offers._updateKpIsklyuchenCheckbox(currentKpForCheckbox);
  },

  // ===== Проверка dirty =====
  isDirty() {
    return Offers._formStateManager?.isDirty() || false;
  },

    // ===== Выбор детали =====
  async onDetalSelect(row) {
    const currentKP = Offers._allKP.find(
      (k) => k.id_plana === row.id && k.id_firma === Offers._selectedFirmaId
    );

    if (!currentKP) {
      Offers.clearForm();
      if (Offers._summaryTable) {
        Offers._summaryTable.clearSelection();
      }
      return;
    }

    Offers._selectedKpId = currentKP.id;
    Offers._lastSelectedKpId = currentKP.id;
    if (Offers._summaryTable) {
        Offers._summaryTable.selectById(row.id); 
    }
    // 1. ✅ ИСПРАВЛЕНО: договоры загружаем и выставляем в select ДО fillFromRow.
    //    Снапшот формы снимается ВНУТРИ fillFromRow из DOM — раньше договор
    //    подставлялся ПОСЛЕ снимка, снапшот фиксировал пустой id_dogovor,
    //    форма становилась «грязной» сразу после выбора записи, а при
    //    возврате фокуса в форму срабатывала ложная модалка «Конфликт данных:
    //    Другой пользователь изменил эту запись (Договор)».
    await Offers.loadDogovoryForForm(Offers._selectedFirmaId);

    // 2. Заполняем форму через FormStateManager (включая договор) + снапшот.
    //    Если договор КП отсутствует среди опций (удалён), select корректно
    //    сбросится на «— Выберите договор —» и попадёт в снапшот как ''.
    Offers._formStateManager.fillFromRow(currentKP);

    // 3. ✅ НАДЕЖНЫЙ РАСЧЕТ ЦЕНЫ НОРМО-ЧАСА
    // Берем данные напрямую из объекта, чтобы избежать рассинхронизации с DOM
    const trud = parseFloat(currentKP.trudoemkost_postavshika) || 0;
    const stoimostDetali = parseFloat(currentKP.cena_postavshika) || 0; // Это полная стоимость детали
    
    const cenaNCh = (trud > 0) ? (stoimostDetali / trud) : 0;
    
    // Принудительно обновляем поле в форме
    const cenaNChEl = document.getElementById('kpCenaNCh');
    if (cenaNChEl) {
      cenaNChEl.value = cenaNCh > 0 ? cenaNCh.toFixed(2) : '';
    }

    // 3. Информационные поля (договоры уже загружены выше, ДО снапшота)
    document.getElementById('infoNomerChertezha').textContent = row.nomer_chertezha || '—';
    document.getElementById('infoNaimenovanie').textContent = row.osn_naimenovanie || '—';
    document.getElementById('infoPlanKolvo').textContent = row.plan_god_kolvo || '—';
    const firma = Offers._allFirmy.find((f) => f.id_firmy === Offers._selectedFirmaId);
    document.getElementById('infoFirma').textContent = firma?.naimenovanie || '—';

    Offers.updateButtonStates();
    Offers._syncFormLockState(currentKP);

    // ✅ НОВОЕ: обновляем видимость и состояние чекбокса ручного назначения
    Offers._updateManualBestKpCheckbox(currentKP);
    // ✅ T19-ISKLYUCHEN: обновляем чекбокс «исключено из расчётов»
    Offers._updateKpIsklyuchenCheckbox(currentKP);
  },
  // ===== Синхронизация баннера блокировки =====
  _syncFormLockState(kpRow = null) {
    const formPanel = document.querySelector('.form-panel');
    if (!formPanel) return;

    const id = kpRow?.id || Offers._selectedKpId;
    if (!id) {
      removeLockBanner(formPanel);
      formPanel.classList.remove('editing');
      return;
    }

    const locker = isLocked('kp', id);
    if (locker) {
      showLockBanner(formPanel, locker);
      formPanel.classList.remove('editing');
    } else {
      removeLockBanner(formPanel);
      if (EditLock.current?.table === 'kp' && EditLock.current?.id === id) {
        formPanel.classList.add('editing');
      } else {
        formPanel.classList.remove('editing');
      }
    }
  },

  // ===== Проверка конфликта данных (как в requests.js) =====
  async checkForExternalChanges() {
    const id = Offers._selectedKpId;
    if (!id) return { changed: false };
    if (!Offers.isDirty()) return { changed: false };

    try {
      const kpList = await api('GET', `/api/kom-predl?zaprosId=${Offers._selectedZaprosId}`);
      const serverData = (Array.isArray(kpList) ? kpList : []).find((k) => k.id === id);
      if (!serverData) return { changed: false, deleted: true };

      const snapshot = Offers._formStateManager._initialSnapshot;
      if (!snapshot) return { changed: false };

      const changes = [];
      for (const key of Object.keys(snapshot)) {
        const field = Offers._formStateManager._fields.find((f) => f.key === key);
        const snapshotVal = Offers._normalizeForCompare(snapshot[key], field);
        const serverVal = Offers._normalizeForCompare(serverData[key], field);
        if (snapshotVal !== serverVal) {
          changes.push({
            key,
            label: field?.label || key,
            snapshot: Offers._formatForDisplay(snapshot[key], field),
            server: Offers._formatForDisplay(serverData[key], field),
          });
        }
      }
      return { changed: changes.length > 0, changes, serverData };
    } catch (e) {
      return { changed: false, error: e.message };
    }
  },

  _normalizeForCompare(value, field) {
    if (value === null || value === undefined || value === '') return '';
    return String(value).trim();
  },

  _formatForDisplay(value, field) {
    if (value === null || value === undefined || value === '') return '—';
    return String(value).trim();
  },

  // ===== Очистка формы =====
  clearForm() {
    Offers._selectedKpId = null;
    Offers._lastSelectedKpId = null;
    Offers._formStateManager.clearForm();

    // ✅ НОВОЕ: скрываем чекбокс ручного назначения лучшего КП
    const manualBestFs = document.getElementById('manualBestKpFieldset');
    if (manualBestFs) manualBestFs.style.display = 'none';
    const chkManualBest = document.getElementById('chkManualBestKp');
    if (chkManualBest) { chkManualBest.checked = false; chkManualBest.disabled = false; chkManualBest.title = ''; }
    // ✅ T19-ISKLYUCHEN: скрываем чекбокс «исключено из расчётов»
    const isklyFs = document.getElementById('kpIsklyuchenFieldset');
    if (isklyFs) isklyFs.style.display = 'none';
    const chkIskly = document.getElementById('chkKpIsklyuchen');
    if (chkIskly) { chkIskly.checked = false; chkIskly.disabled = false; }
    // ✅ НОВОЕ: скрываем блок комментария и очищаем textarea
    const commentBox = document.getElementById('manualBestKpCommentBox');
    if (commentBox) commentBox.style.display = 'none';
    const commentTa = document.getElementById('manualBestKpComment');
    if (commentTa) commentTa.value = '';
    const currentCommentBox = document.getElementById('manualBestKpCurrentComment');
    if (currentCommentBox) currentCommentBox.style.display = 'none';

    document.getElementById('infoNomerChertezha').textContent = '—';
    document.getElementById('infoNaimenovanie').textContent = '—';
    document.getElementById('infoPlanKolvo').textContent = '—';
    document.getElementById('infoFirma').textContent = '—';
    document.getElementById('kpFormTitle').textContent = 'Данные коммерческого предложения';

    // Снимаем баннер блокировки
    const formPanel = document.querySelector('.form-panel');
    if (formPanel) {
      removeLockBanner(formPanel);
      formPanel.classList.remove('editing');
    }
  },

  onHeaderClick() {
    Offers.clearForm();
    Offers.updateButtonStates();
  },

  // ===== СОХРАНЕНИЕ ОДНОЙ ПОЗИЦИИ КП =====
  async saveSingleKP() {
    if (!Offers._selectedKpId) {
      toast('Выберите позицию КП для сохранения', 'warning');
      return;
    }

    const v = Offers._formStateManager.validate();
    if (!v.ok) {
      toast(`Заполните: ${v.missing.join(', ')}`, 'warning');
      return;
    }

    const payload = Offers._formStateManager.buildPayload();
    if (!payload.tip_izgotovleniya) {
      toast('Выберите тип изготовления', 'warning');
      return;
    }

    await batchManager.withBatch('kp', async () => {
      const r = await api('PUT', `/api/kom-predl/${Offers._selectedKpId}`, payload);
      if (r.error) {
        if (r.code === 'CHAIN_IN_ORDER') {
          alert(r.error);
          return;
        }
        if (r.code === 'DEPENDENT_POSITIONS_EXIST') {
          const msg = r.error + '\nХотите удалить проблемные позиции из зависимых запросов?';
          if (confirm(msg)) {
            let deletedCount = 0;
            for (const zapros of r.dependentZaprosy) {
              for (const pos of zapros.positions) {
                const delResult = await api(
                  'DELETE',
                  `/api/zapros-kp/${zapros.zaprosId}/position/${pos.childPlanId}`
                );
                if (delResult.ok) deletedCount++;
              }
            }
            toast(`Удалено ${deletedCount} проблемных позиций`, 'success');
            return Offers.saveSingleKP();
          }
          return;
        }
        toast('Ошибка: ' + r.error, 'error');
        return;
      }

      toast('КП сохранено');

      // ✅ Персональный договор позиции мог измениться — сбрасываем кэш
      //    подвала сводной таблицы (договор + условия предоплаты фирмы),
      //    чтобы при следующем _rebuildSummaryTable данные перечитались.
      Offers.invalidateFooterCache();

      // Снимаем блокировку
      if (EditLock.current?.table === 'kp' && EditLock.current?.id === Offers._selectedKpId) {
        EditLock.release();
      }

      // Диспатч события для auto-lock.js (как в CrudModule)
      window.dispatchEvent(
        new CustomEvent('crud-completed', {
          detail: { action: 'save', entity: 'kp', entityId: Offers._selectedKpId },
        })
      );

      // Перезаполняем форму из актуальных данных (как _onSelect в CrudModule)
      const kpList = await api('GET', `/api/kom-predl?zaprosId=${Offers._selectedZaprosId}`);
      const updatedKp = (Array.isArray(kpList) ? kpList : []).find((k) => k.id === Offers._selectedKpId);
      if (updatedKp) {
        Offers._formStateManager.fillFromRow(updatedKp);
      }

      await Offers._refreshStatusAndKP();
    });
  },

  // ===== ЭКСПОРТ СВОДНОЙ ТАБЛИЦЫ В EXCEL (✅ НОВОЕ) =====
  // Отправляет на сервер уже подготовленные данные (rows + metadata),
  // сервер генерирует .xlsx и сохраняет в public/Заявки/{baseYear}/
  // Имя файла: «Выбор поставщика заявка№{n_zaprosa}.xlsx»
  async exportSummary() {
    if (!Offers._selectedZaprosId) {
      toast('Сначала выберите Запрос КП', 'warning');
      return;
    }
    if (!Offers._summaryTable || !Offers._summaryTable.data || Offers._summaryTable.data.length === 0) {
      toast('Сводная таблица пуста — нечего экспортировать', 'warning');
      return;
    }

    // Текущий запрос (для n_zaprosa и data_form)
    const zapros = Offers._allZaprosy.find(z => z.id === Offers._selectedZaprosId);
    const zaprosNumber = zapros?.n_zaprosa || Offers._selectedZaprosId;
    const zaprosDate   = zapros?.data_form || '';

    // Год для папки — берём из фильтра (или из даты запроса)
    const baseYear = parseInt(document.getElementById('fltGod')?.value, 10) ||
                     new Date().getFullYear();

    // Структура колонок (должна совпадать с _rebuildSummaryTable)
    const baseCols = [
      // ✅ НОВОЕ: первая колонка содержит текст 'ИТОГО:' в подвале колонок
      { key: 'nomer_chertezha',  label: '№ чертежа',   width: 110,
        footer: { type: 'text', value: 'ИТОГО:', style: { fontWeight: 700 } } },
      { key: 'osn_naimenovanie', label: 'Наименование', width: 180 },
      { key: 'plan_god_kolvo',   label: 'Кол-во, шт.',         width: 60  },
      { key: 'trud_pto',         label: 'Труд-ть на ед., н/ч',     width: 70  },
      // ✅ НОВОЕ: 'Цена н/ч' — цена нормо-часа ПТО (из plan.cena_pto)
      { key: 'cena_pto',         label: 'Цена н/ч, (руб. без НДС)',     width: 80  },
      // ✅ ИЗМЕНЕНО: 'Стоим ПТО' → 'Ст-ть ПТО, (руб. без НДС)' (= труд × цена × план)
      // ✅ НОВОЕ: добавлен footer sum для итога стоимости партии ПТО
      { key: 'cost_pto',         label: 'Стоим. ПТО, (руб. без НДС)', width: 100,
        footer: {
          type: 'sum',
          decimals: 2,
          emptyText: '',
          style: { color: '#0a5c26', fontWeight: 700 }
        }
      },
    ];
    // FIRM_COLUMNS определён на уровне модуля
    const firmColsTpl = FIRM_COLUMNS.map(c => ({ suffix: c.suffix, label: c.label, width: c.width }));
    // ✅ ИЗМЕНЕНО: добавлена best_stoim_partii (Стоим. (руб. без НДС))
    //   Порядок важен: best_stoim_partii идёт ПЕРЕД best_econom, т.к. в Excel
    //   формула Экономии ссылается на ячейку Стоим. (руб. без НДС).
    const resultCols = [
      { key: 'best_firma',          label: 'Фирма (Тип)',     width: 150 },
      { key: 'best_stoim_partii',   label: 'Стоим. (руб. без НДС)',    width: 100 },
      { key: 'best_econom',         label: 'Отклонение от целевой стоим. ПТО, руб.',          width: 90  },
      // ✅ НОВОЕ: колонка с комментарием выбранного лучшего КП (обоснование выбора)
      { key: 'best_primechanie_kp', label: 'Обоснование выбора', width: 200 },
    ];

    // Готовим rows из текущей сводной таблицы (там уже посчитано всё)
    const rows = Offers._summaryTable.data.map(r => ({ ...r }));

    // Готовим footerInfo — для каждой фирмы её soderzhanie.
    // _firmFooterCache уже заполнен при последнем _rebuildSummaryTable.
    // Если вдруг пуст — попробуем перезагрузить.
    let footerInfo = {};
    if (Offers._firmFooterCache && Offers._firmFooterCache.size > 0) {
      for (const [k, v] of Offers._firmFooterCache) footerInfo[k] = v;
    } else {
      const m = await Offers._loadFirmsFooterInfo(Offers._allFirmy);
      for (const [k, v] of m) footerInfo[k] = v;
    }

    toast('Генерация Excel-файла...', 'info');
    try {
      const r = await api('POST', '/api/kom-predl/export-summary', {
        zaprosNumber,
        zaprosDate,
        baseYear,
        baseCols,
        firmColsTpl,
        firmsList: Offers._allFirmy,
        resultCols,
        rows,
        footerInfo,
        bestEconomKey: 'best_econom'
      });

      if (r.error) {
        toast('Ошибка экспорта: ' + r.error, 'error');
        return;
      }

      toast(`Файл создан: ${r.fileName}`, 'success');

      // Если сервер вернул relativePath — открываем файл в новой вкладке
      if (r.relativePath) {
        window.open(r.relativePath, '_blank');
      }
    } catch (e) {
      console.error('[Offers.exportSummary]', e);
      toast('Ошибка сети при экспорте', 'error');
    }
  },

  // ===== ВЫБОР ЛУЧШИХ КП =====
  async selectBestKP() {
    if (!Offers._selectedZaprosId) return;
    if (
      !confirm(
        'Выбрать лучшие КП для этого запроса?\n' +
          'Алгоритм:\n' +
          '1. Группы: Полный цикл > Частичная обработка\n' +
          '2. Внутри группы: цена за 1 деталь → трудоёмкость → тип → срок\n' + // ✅ T77
          '3. Распределение по мощности фирм'
      )
    )
      return;

    await batchManager.withBatch('kp', async () => {
      const r = await api('POST', '/api/kom-predl/best', {
        zaprosId: Offers._selectedZaprosId,
      });
      if (r.error) {
        if (r.code === 'CHAIN_IN_ORDER') {
          alert(
            `🚫 Невозможно изменить КП!\n${r.error}\n💡 Решение:\n` +
              `1. Перейдите в раздел "Заказы по договорам".\n` +
              `2. Найдите заказ, в который включена эта деталь.\n` +
              `3. Удалите данную позицию из заказа.\n` +
              `После этого вы сможете изменить КП.`
          );
          return;
        }
        if (r.code === 'DEPENDENT_POSITIONS_EXIST') {
          const msg = r.error + '\nХотите удалить проблемные позиции из зависимых запросов?';
          if (confirm(msg)) {
            let deletedCount = 0;
            for (const zapros of r.dependentZaprosy) {
              for (const pos of zapros.positions) {
                const delResult = await api(
                  'DELETE',
                  `/api/zapros-kp/${zapros.zaprosId}/position/${pos.childPlanId}`
                );
                if (delResult.ok) deletedCount++;
              }
            }
            toast(`Удалено ${deletedCount} проблемных позиций`, 'success');
            return Offers.selectBestKP();
          }
          return;
        }
        toast('Ошибка: ' + r.error, 'error');
        return;
      }
      toast(r.message || 'Лучшие КП выбраны');
      document.getElementById('lblStatus').textContent = 'выбраны лучшие КП';
      await Offers._reloadKPAndSummary();
      Offers.updateButtonStates();
    });
  },

  // ============================================================
  // ✅ НОВОЕ: загрузка условий предоплаты фирм для подвала групп
  // ------------------------------------------------------------
  // Алгоритм (на сторону клиента):
  //   1. Один раз загружаем весь справочник sprav_uslov через
  //      GET /api/uslov → _uslovMapCache (Map<id_usloviya, soderzhanie>).
  //      Справочник маленький, кэшируем на всё время жизни модуля.
  //   2. Для каждой фирмы из списка через GET /api/dogovor?id_firmy=...
  //      получаем её договор (обычно он один) → берём из него
  //      id_predoplata_yclov.
  //   3. По id_predoplata_yclov из кэша sprav_uslov достаём soderzhanie.
  //   4. Лучшее ТКП кэшируем в _firmFooterCache с ключом, зависящим от
  //      zaprosId + набора firmaId — чтобы при смене запроса/фирм
  //      перезагружать только если реально нужно.
  //
  // Возвращает Map<firmaId, soderzhanie>.
  // Тихо проглатывает ошибки сети — подвал в худшем случае будет пустым,
  // но таблица продолжит работать.
  // ============================================================
  async _loadFirmsFooterInfo(firmyList) {
    if (!firmyList || firmyList.length === 0) {
      Offers._firmFooterCache = new Map();
      Offers._firmFooterCacheKey = null;
      return Offers._firmFooterCache;
    }

    // Ключ кэша: zaprosId + sorted firmaId
    const firmaIds = firmyList.map(f => String(f.id_firmy)).sort();
    const cacheKey = `${Offers._selectedZaprosId || '—'}|${firmaIds.join(',')}`;

    if (Offers._firmFooterCache && Offers._firmFooterCacheKey === cacheKey) {
      return Offers._firmFooterCache;
    }

    // 1) Глобальный кэш справочника условий (не зависит от запроса)
    if (!Offers._uslovMapCache) {
      try {
        // ✅ Эндпоинт: /api/uslov (см. routes.uslov в server.js)
        //   GET /api/uslov?kategoriya=... — фильтр по категории (необязательно)
        //   Возвращает массив: [{ id_usloviya, soderzhanie, kategoriya }, ...]
        const uslovs = await api('GET', '/api/uslov');
        const m = new Map();
        if (Array.isArray(uslovs)) {
          for (const u of uslovs) {
            if (u && u.id_usloviya != null) {
              m.set(String(u.id_usloviya), u.soderzhanie || '');
            }
          }
        }
        Offers._uslovMapCache = m;
      } catch (e) {
        console.warn('[Offers._loadFirmsFooterInfo] /api/uslov load failed:', e);
        Offers._uslovMapCache = new Map();
      }
    }
    const uslovMap = Offers._uslovMapCache;

    // 2) Для каждой фирмы — её договор (один, как правило)
    //    Берём первый договор с заполненным id_predoplata_yclov;
    //    если таких нет — первый попавшийся договор.
    //    Если у фирмы вообще нет договоров — пропускаем.
    // ✅ ИЗМЕНЕНО: кэшируем не только soderzhanie, но и nom_dogovor + data_dogovor.
    //   Это нужно для формирования текста подвала группы:
    //   'Договор №{nom_dogovor} от {data_dogovor}: {soderzhanie}'
    const result = new Map();
    await Promise.all(firmyList.map(async (firma) => {
      try {
        const data = await api('GET', `/api/dogovor?id_firmy=${firma.id_firmy}`);
        const dogovory = Array.isArray(data) ? data : [];
        if (dogovory.length === 0) return;
        const dog = dogovory.find(d => d.id_predoplata_yclov) || dogovory[0];
        if (!dog) return;
        const soderzhanie = dog.id_predoplata_yclov
          ? (uslovMap.get(String(dog.id_predoplata_yclov)) || '')
          : '';
        // ✅ НОВОЕ: сохраняем структуру с метаданными договора
        result.set(String(firma.id_firmy), {
          soderzhanie: soderzhanie,
          nom_dogovor: dog.nom_dogovor || '',
          data_dogovor: dog.data_dogovor || ''
        });
      } catch (e) {
        console.warn(`[Offers._loadFirmsFooterInfo] dogovor load failed for firma ${firma.id_firmy}:`, e);
      }
    }));

    Offers._firmFooterCache = result;
    Offers._firmFooterCacheKey = cacheKey;
    return result;
  },

  /** ✅ Принудительная инвалидация кэша условий предоплаты.
   *  Вызывать после saveSingleKP — на случай, если персонально изменённый
   *  договор позиции изменил условия предоплаты фирмы (soderzhanie). */
  invalidateFooterCache() {
    Offers._firmFooterCache = null;
    Offers._firmFooterCacheKey = null;
    // _uslovMapCache НЕ трогаем — справочник меняется редко.
  },

  // ===== ПЕРЕСТРОЕНИЕ СВОДНОЙ ТАБЛИЦЫ =====
  async _rebuildSummaryTable(allKP) {
    const container = document.getElementById('summaryTable');
    if (Offers._summaryTable) {
      Offers._summaryTable.destroy();
      Offers._summaryTable = null;
    }
    if (!allKP || allKP.length === 0) {
      container.innerHTML = '<div class="empty-state">Нет данных для отображения</div>';
      // ✅ T74: матрицу выбора тоже прячем — данных нет
      clearChoiceMatrix();
      return;
    }

    const byPlan = new Map();
    allKP.forEach((kp) => {
      if (!kp.id_plana) return;
      if (!byPlan.has(kp.id_plana)) {
        byPlan.set(kp.id_plana, { plan: kp, firms: new Map() });
      }
      if (kp.id_firma) byPlan.get(kp.id_plana).firms.set(kp.id_firma, kp);
    });

    const firmsList = Offers._allFirmy;

    const baseCols = [
      // ✅ НОВОЕ: первая колонка содержит текст 'ИТОГО:' в подвале колонок
      //   (как в exportSummary для Excel-экспорта)
      { key: 'nomer_chertezha',  label: '№ чертежа',   width: 110,
        footer: { type: 'text', value: 'ИТОГО:', style: { fontWeight: 700 } } },
      { key: 'osn_naimenovanie', label: 'Наименование', width: 180 },
      { key: 'plan_god_kolvo',   label: 'Кол-во, шт.',         width: 60  },
      { key: 'trud_pto',         label: 'Труд-ть на ед., н/ч',     width: 70  },
      // ✅ НОВОЕ: 'Цена н/ч' — цена нормо-часа ПТО (из plan.cena_pto)
      { key: 'cena_pto',         label: 'Цена н/ч',     width: 80  },
      // ✅ ИЗМЕНЕНО: 'Стоим ПТО' → 'Стоим партии ПТО' + footer sum
      { key: 'cost_pto',         label: 'Стоим. (руб. без НДС)', width: 100,
        footer: {
          type: 'sum',
          decimals: 2,
          emptyText: '',
          style: { color: '#0a5c26', fontWeight: 700 }
        }
      },
    ];

    const firmCols = [];
    firmsList.forEach((firma, firmaIdx) => {
      FIRM_COLUMNS.forEach((fc) => {
        const colDef = {
          key: `f_${firmaIdx}_${fc.suffix}`,
          label: fc.label,
          width: fc.width,
          firmaId: firma.id_firmy,
          firmaIdx: firmaIdx,
          suffix: fc.suffix,
        };
        // ✅ НОВОЕ: для колонки 'stoim_partii' — добавить footer sum
        //   (итог по стоимости партии для каждой фирмы)
        if (fc.suffix === 'stoim_partii') {
          colDef.footer = {
            type: 'sum',
            decimals: 2,
            emptyText: '',
            style: { color: '#0a5c26', fontWeight: 700 }
          };
        }
        firmCols.push(colDef);
      });
    });

    const resultCols = [
      { key: 'best_firma',        label: 'Фирма (Тип)',  width: 150 },
      // ✅ НОВОЕ: расчётная колонка «Стоим. (руб. без НДС)» для лучшего КП
      //   = cost (из лучшего КП) × mosh (из лучшего КП)
      //   В VirtualTable — посчитанное значение.
      //   В Excel — формула со ссылкой на ячейки (см. excel-service.js).
      // ✅ НОВОЕ: добавлен footer sum для итога стоимости партии лучшего КП
      { key: 'best_stoim_partii', label: 'Стоим. (руб. без НДС)', width: 100,
        footer: {
          type: 'sum',
          decimals: 2,
          emptyText: 'нет предл.',
          style: { color: '#0a5c26', fontWeight: 700 }
        }
      },
      // ✅ ИЗМЕНЕНО: «Экономия» теперь = (Стоим ПТО × План) − Стоим. (руб. без НДС) лучшего КП
      // ✅ ИЗМЕНЕНО: 'Экономия' теперь = Стоим. (руб. без НДС) лучшего КП − Стоим. (руб. без НДС) ПТО
      //   (поменяли местами — теперь положительное значение = Фирма (Тип) выгоднее ПТО)
      //   Раньше было: (trudPto × cenaPto) − stoimostDetali (только для одной детали)
      { key: 'best_econom', label: 'Экономия',     width: 90, colorize: true,
        // ✅ НОВОЕ: formatter для подсветки положительных значений красным жирным
        formatter: (val, item) => {
          if (val == null || val === '' || val === 'нет предл.') return val;
          const num = Number(String(val).replace(',', '.'));
          if (isNaN(num)) return val;
          if (num > 0) {
            // ✅ Положительное значение → красный жирный
            return { text: val, style: { color: '#cc0000', fontWeight: 700 } };
          }
          return val;
        },
        footer: {
          type: 'sum',
          decimals: 2,
          emptyText: 'нет предл.',
          style: { color: '#0a5c26', fontWeight: 700 }
        }
      },
      // ✅ НОВОЕ: колонка «Обоснование выбора» — комментарий выбранного лучшего КП.
      //   Содержит:
      //   • 'лучшее предложение по цене' — для авто-ЛКП
      //   • произвольный текст — для ручного ЛКП (обоснование выбора)
      //   • пусто, если ЛКП не выбрано
      //   width=200 — широкая, т.к. комментарий может быть длинным
      { key: 'best_primechanie_kp', label: 'Обоснование выбора', width: 200 },
    ];

    const allColumns = [...baseCols, ...firmCols, ...resultCols];

    // ============================================================
    // ✅ НОВОЕ: загрузка условий предоплаты фирм для подвала групп.
    // Загружаем ДО построения groups, т.к. значение soderzhanie
    // пойдёт в group.footer.value.
    // Метод использует кэш — реальный запрос идёт только при смене
    // запроса или набора фирм.
    // ============================================================
    const footerInfo = await Offers._loadFirmsFooterInfo(firmsList);

    let colIdx = 0;
    const groups = [];
    // ✅ ИЗМЕНЕНО: Группа "Деталь" — добавляем подвал с поясняющим текстом.
    //   Раньше подвал не задавался (считалось, что писать нечего).
    //   Теперь пишем 'Условия оплаты по договору' — это заголовок для строки
    //   подвалов групп (где ниже — условия каждой фирмы).
    groups.push({
      name: 'Деталь ПТО',
      startIdx: colIdx,
      colspan: baseCols.length,
      colorClass: 'base',
      footer: { value: 'Условия оплаты по договору' }
    });
    colIdx += baseCols.length;
    // Группы фирм — для каждой пишем в подвал договор + условия предоплаты.
    // ✅ ИЗМЕНЕНО: текст формируется как 'Договор №{N} от {D}: {soderzhanie}'
    firmsList.forEach((firma) => {
      const info = footerInfo.get(String(firma.id_firmy));
      let footerText = '';
      if (info) {
        const parts = [];
        if (info.nom_dogovor) {
          parts.push(`Договор №${info.nom_dogovor}`);
        }
        if (info.data_dogovor) {
          // ✅ НОВОЕ: форматируем дату в DD.MM.YYYY для UI
          parts.push(`от ${formatDateRu(info.data_dogovor)}`);
        }
        // Если есть номер и/или дата — добавляем разделитель ':'
        if (parts.length > 0 && info.soderzhanie) {
          parts.push(':');
        }
        if (info.soderzhanie) {
          parts.push(info.soderzhanie);
        }
        footerText = parts.join(' ');
      }
      groups.push({
        name: firma.naimenovanie,
        startIdx: colIdx,
        colspan: FIRM_COLUMNS.length,
        colorClass: 'firm',
        // ✅ НОВОЕ: подвал группы — 'Договор №N от D: условия предоплаты'
        footer: footerText
          ? { value: footerText }
          : { value: '— условие предоплаты не задано —' }
      });
      colIdx += FIRM_COLUMNS.length;
    });
    // Группа "Лучшее ТКП" — group.footer НЕ задаём (см. задачу: подвал
    // нужен только для групп фирм). Но у колонки 'best_econom' этой
    // группы есть column.footer (сумма экономии) — он отрисуется
    // отдельной строкой vtable-footer-sub над строкой групп.
    groups.push({ name: 'Лучшее ТКП', startIdx: colIdx, colspan: resultCols.length, colorClass: 'result' });

    const rows = [];
    byPlan.forEach((group, planId) => {
      const row = {
        id: planId,
        nomer_chertezha: group.plan.nomer_chertezha || '',
        osn_naimenovanie: group.plan.osn_naimenovanie || '',
        plan_god_kolvo: group.plan.plan_god_kolvo || '',
        trud_pto: group.plan.trudoemkost_pto || '',
        cena_pto: '',  // ✅ НОВОЕ: цена нормо-часа ПТО
        cost_pto: '',
      };
      const trudPto = parseFloat(group.plan.trudoemkost_pto) || 0;
      const cenaPto = parseFloat(group.plan.cena_pto) || 0;
      const planKolvo = parseFloat(group.plan.plan_god_kolvo) || 0;
      // ✅ НОВОЕ: цена нормо-часа ПТО (для отображения в колонке)
      row.cena_pto = cenaPto > 0 ? cenaPto.toFixed(2) : '';
      // ✅ ИЗМЕНЕНО: cost_pto теперь = Стоим партии ПТО = труд × цена × план
      //   (раньше было просто труд × цена — стоимость ПТО на 1 деталь)
      const costPartiiPto = trudPto * cenaPto * planKolvo;
      row.cost_pto = costPartiiPto.toFixed(2);

      firmsList.forEach((firma, firmaIdx) => {
          const kp = group.firms.get(firma.id_firmy);
          const prefix = `f_${firmaIdx}_`;
          if (kp) {
              const trud = parseFloat(kp.trudoemkost_postavshika) || 0;
              const stoimostDetali = parseFloat(kp.cena_postavshika) || 0;
              const mosh = parseFloat(kp.moshchnost_kolvo) || 0;
              const srok = kp.srok_vipolneniya || '';

              // ✅ НОВОЕ: расчётные колонки
              //   cena_nch     = Стоим / Труд      (цена нормо-часа)
              //   stoim_partii = Стоим * Кол-во    (стоимость партии детали)
              // В VirtualTable показываем посчитанные значения (для скорости).
              // В Excel-экспорте эти колонки будут пересчитаны формулами
              // (см. exportSummaryTableKP в excel-service.js).
              const cenaNch     = (trud > 0) ? (stoimostDetali / trud) : 0;
              const stoimPartii = stoimostDetali * mosh;

              row[prefix + 'trud']         = trud > 0 ? trud.toFixed(2) : '';
              row[prefix + 'cost']         = stoimostDetali > 0 ? stoimostDetali.toFixed(2) : '';
              row[prefix + 'cena_nch']     = cenaNch > 0 ? cenaNch.toFixed(2) : '';
              row[prefix + 'mosh']         = mosh > 0 ? mosh : '';
              row[prefix + 'stoim_partii'] = stoimPartii > 0 ? stoimPartii.toFixed(2) : '';
              row[prefix + 'srok']         = srok;
              row[prefix + 'tip']          = kp.tip_izgotovleniya || '';
          } else {
              row[prefix + 'trud']         = '';
              row[prefix + 'cost']         = '';
              row[prefix + 'cena_nch']     = '';
              row[prefix + 'mosh']         = '';
              row[prefix + 'stoim_partii'] = '';
              row[prefix + 'srok']         = '';
              row[prefix + 'tip']          = '';
          }
      });

      if (group.plan.id_kp) {
        const bestKP = allKP.find((k) => k.id === group.plan.id_kp);
        if (bestKP) {
          row.best_firma = `${bestKP.firma_nazvanie || ''} (${bestKP.tip_izgotovleniya || ''})`;
          // ✅ НОВОЕ: сохраняем reshenie и primechanie_kp для подсветки строки
          row.best_reshenie = bestKP.reshenie || '';
          row.best_primechanie_kp = bestKP.primechanie_kp || '';
          row.best_kp_id = bestKP.id;
          const trud = parseFloat(bestKP.trudoemkost_postavshika) || 0;
          const stoimostDetali = parseFloat(bestKP.cena_postavshika) || 0;
          const moshBest = parseFloat(bestKP.moshchnost_kolvo) || 0;
          if (trud > 0 && stoimostDetali > 0) {
            // ✅ ИЗМЕНЕНО: cost_pto теперь содержит стоимость партии ПТО
            //   (труд × цена × план), поэтому best_econom = cost_pto - best_stoim_partii
            //   (раньше было: costPto * planKolvo - bestStoimPartii)
            const bestStoimPartii = stoimostDetali * moshBest;
            row.best_stoim_partii = bestStoimPartii > 0 ? bestStoimPartii.toFixed(2) : '';
            // ✅ ИЗМЕНЕНО: best_econom = стоимость партии лучшего КП − стоимость партии ПТО
            //   (поменяли местами — теперь положительное значение означает,
            //    что Фирма (Тип) выгоднее ПТО)
            row.best_econom = (bestStoimPartii - costPartiiPto).toFixed(2);
          } else {
            row.best_stoim_partii = '';
            row.best_econom = 'нет предл.';
          }
        } else {
          row.best_firma = 'Не выбрано';
          row.best_stoim_partii = '';
          row.best_econom = 'нет предл.';
        }
      } else {
        row.best_firma = 'Не выбрано';
        row.best_stoim_partii = '';
        row.best_econom = 'нет предл.';
      }
      rows.push(row);
    });

    rows.sort((a, b) => (a.nomer_chertezha || '').localeCompare(b.nomer_chertezha || ''));

 Offers._summaryTable = new VirtualTable(container, allColumns, {
      idKey: 'id',
      groups: groups,
      rowHeight: 26,
      freezeFirstGroup: true,

      // ✅ НОВОЕ: схлопывание групп фирм (кнопка [+/−] в заголовке)
      //   При сворачивании остаются видимыми только ПОСЛЕДНИЕ N=1 колонки группы
      //   (по умолчанию — 'Стоим. (руб. без НДС)', т.к. она теперь последняя в FIRM_COLUMNS).
      //   collapsibleColorClasses: ['firm'] — только группы фирм (Деталь и Лучшее ТКП не трогаем).
      collapsibleGroups: true,
      collapsibleKeepLastN: 1,
      collapsibleColorClasses: ['firm'],
      // ✅ НОВОЕ: при первой инициализации — все группы фирм свёрнуты
      //   для восприятия общей картины выбора лучшего предложения.
      //   Пользователь может развернуть нужную группу кнопкой [+] или
      //   чекбоксом «Свернуть все группы» в toolbar.
      startCollapsed: true,

      // ✅ НОВОЕ: обработчик клика по заголовку группы.
      //   Для групп фирм (colorClass='firm') — выбирает фирму в #fltFirma
      //   и запускает onFirmaChange() (что также центрирует группу колонок).
      //   Для групп 'Деталь' и 'Лучшее ТКП' — игнор (ничего не делает).
      onGroupClick: (group, gIdx, event) => {
        if (!group) return;
        // Игнорируем группы не-фирмы (Деталь, Лучшее ТКП)
        if (group.colorClass !== 'firm') return;
        // Ищем фирму по названию группы
        const firmaName = group.name;
        const firma = Offers._allFirmy.find(f => f.naimenovanie === firmaName);
        if (!firma) {
          console.warn('[Offers.onGroupClick] фирма не найдена:', firmaName);
          return;
        }
        // Устанавливаем фирму в комбоксе
        const selFirma = document.getElementById('fltFirma');
        if (!selFirma) return;
        // Если фирма уже выбрана — ничего не делаем
        if (selFirma.value === String(firma.id_firmy)) return;
        selFirma.value = String(firma.id_firmy);
        // Запускаем стандартную логику смены фирмы
        // (загрузка деталей, центрирование группы и т.д.)
        Offers.onFirmaChange();
      },

      // ✅ НОВОЕ: подсветка строк с ручным назначением лучшего КП
      //   Возвращает массив подсветок для строки. Для ручного ЛКП —
      //   className='highlight-manual-best', icon='✋', title с комментарием.
      //   Строка идентифицируется как ручная по reshenie='лучшее предложение'
      //   И primechanie_kp не равно стандартному 'лучшее предложение по цене'.
      getRowHighlights: (item) => {
        if (!item) return [];
        const isBest = item.best_reshenie === 'лучшее предложение';
        const comment = item.best_primechanie_kp || '';
        const isManual = isBest && comment && comment !== 'лучшее предложение по цене';
        if (!isManual) return [];
        return [{
          className: 'highlight-manual-best',
          icon: '✋',
          title: `Ручное назначение: ${comment}`,
          badgeText: ''  // только иконка, без текста
        }];
      },

      // ✅ НОВОЕ: включаем подвал таблицы (sticky-bottom).
      // Две строки подвала:
      //   1) vtable-footer-sub   — подвал колонок (сумма экономии в группе "Лучшее ТКП")
      //   2) vtable-footer-group — подвал групп (soderzhanie для фирм, пусто для Деталь/Лучшее ТКП)
      footer: {
        sticky: true,
        emptyText: '—'
      },

      // ✅ НОВОЕ: Обработчик клика по сводной таблице
      onSelect: (row) => {
        // 1. Находим соответствующую деталь в массиве _allDetali по id (который равен id_plana)
        const detailRow = Offers._allDetali.find(d => d.id === row.id);
        
        if (detailRow) {
          // 2. Визуально выделяем строку в верхней таблице деталей
          state.tables.detali.selectById(row.id);
          
          // 3. Запускаем стандартную логику выбора (заполнение формы, обновление кнопок и т.д.)
          Offers.onDetalSelect(detailRow);
        } else {
          // Если деталь не найдена (например, фильтром скрыта), просто очищаем форму
          Offers.clearForm();
        }
      }
    });
    await Offers._summaryTable.setData(rows);

    // ✅ НОВОЕ: показываем чекбокс «Свернуть все группы» (если collapsible включён)
    //   и синхронизируем его состояние с таблицей
    Offers._syncCollapseAllCheckbox();

    // ✅ НОВОЕ: центрируем группу колонок выбранной в fltFirma фирмы.
    // Вызываем после setData (таблица отрисована) и в rAF (браузер
    // успел применить стили/ширины). Иначе scrollLeft посчитается
    // по неотрисованным колонкам и промахнётся.
    Offers._scrollToSelectedFirmaGroup();

    // ✅ T74: матрица выбора поставщика — обновляется вместе со сводной
    // таблицей из тех же данных (Offers._allKP)
    Offers._renderChoiceMatrix();
  },

  // ============================================================
  // ✅ T74: «Матрица выбора поставщика» — данные те же, что у сводной
  // таблицы (Offers._allKP). Рендер и интерактив — в отдельном модуле
  // js/modules/offers-matrix.js. Ошибка модуля не должна ломать страницу.
  // ============================================================
  _renderChoiceMatrix() {
    try {
      renderChoiceMatrix(Offers._allKP);
    } catch (e) {
      console.warn('[Offers._renderChoiceMatrix] ошибка матрицы выбора:', e);
    }
  },

  // ============================================================
  // ✅ НОВОЕ: центрирование группы колонок выбранной фирмы в сводной
  // таблице. Берёт firmaId из #fltFirma, находит индекс группы в
  // _summaryTable.groups по naimenovanie фирмы из _allFirmy и
  // вызывает _summaryTable.scrollToGroup(idx, { align: 'start' }).
  //
  // Логика соответствия группа ↔ фирма:
  //   • groups[0]              — «Деталь»      (colorClass='base')    — пропускаем
  //   • groups[1..N]           — фирмы          (colorClass='firm')    — ищем по name
  //   • groups[N+1]            — «Лучшее ТКП»    (colorClass='result')  — пропускаем
  //   Соответствие groups[i].name ↔ firma.naimenovanie однозначное,
  //   т.к. в _rebuildSummaryTable группы фирм строятся именно так.
  //
  // Режим выравнивания 'start' (а не 'center') выбран потому, что
  // первая группа «Деталь» закреплена (freezeFirstGroup=true) и
  // занимает frozenWidth px слева viewport. Поместить левую границу
  // группы фирмы к правой границе закреплённой группы — это самое
  // наглядное поведение: фирма сразу видна целиком после Детали.
  // ============================================================
  _scrollToSelectedFirmaGroup() {
    if (!Offers._summaryTable) return;
    const firmaId = document.getElementById('fltFirma')?.value;
    if (!firmaId) return;

    // Найдём название фирмы по id
    const firma = Offers._allFirmy.find(f => String(f.id_firmy) === String(firmaId));
    if (!firma || !firma.naimenovanie) return;

    // Ищем группу по имени (groups хранятся в _summaryTable.groups)
    const groups = Offers._summaryTable.groups;
    if (!Array.isArray(groups)) return;

    const groupIdx = groups.findIndex(g =>
      g && g.colorClass === 'firm' && g.name === firma.naimenovanie
    );
    if (groupIdx < 0) return;

    // Двойной rAF: первый — после apply styles, второй — после layout pass
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          // ✅ align='start' — левая граница группы фирмы
          // к правой границе закреплённой группы «Деталь».
          Offers._summaryTable.scrollToGroup(groupIdx, { align: 'start' });
        } catch (e) {
          console.warn('[Offers._scrollToSelectedFirmaGroup]', e.message);
        }
      });
    });
  },

  // ============================================================
  // ✅ НОВОЕ: ручное назначение лучшего КП для позиции
  // ------------------------------------------------------------
  // _updateManualBestKpCheckbox(currentKP) — показывает/скрывает чекбокс
  //   Условия показа:
  //     1) Статус запроса === 'выбраны лучшие КП' ИЛИ «отправлено Всем/не Всем»
  //     2) КП привязано к корневому плану (currentKP.plan_is_child !== 1)
  //     3) currentKP существует
  //     ✅ T19C: условие «позиция не в заказе» УБРАНО — блок показывается
  //        и для позиций в заказе (фирма согласовала заказ): пользователь
  //        видит галочку и может редактировать комментарий действующего
  //        ручного ЛКП. Само НАЗНАЧЕНИЕ по-прежнему запрещено и на сервере
  //        (CHAIN_IN_ORDER), и в UI (чекбокс disabled с подсказкой).
  //   Состояние галочки:
  //     checked = (currentKP.reshenie === 'лучшее предложение')
  // ============================================================
  _updateManualBestKpCheckbox(currentKP) {
    const fs = document.getElementById('manualBestKpFieldset');
    const chk = document.getElementById('chkManualBestKp');
    if (!fs || !chk) return;

    const status = (document.getElementById('lblStatus').textContent || '').trim();
    // ✅ T19-FIX: блок показываем и в статусах отправки — после отката при
    // отказе фирмы статус запроса откатывается («отправлено Всем/не Всем»),
    // но ручное назначение и редактирование комментария для позиций,
    // СОХРАВИВШИХ КП, должны оставаться доступны (регрессия: чекбокс и
    // комментарий исчезали для всех фирм — и победителей, и проигравших).
    const SENT_STATUSES = ['отправлено Всем контрагентам', 'отправлено не Всем контрагентам'];
    const isBestDone = status === 'выбраны лучшие КП';
    const isSent = SENT_STATUSES.includes(status);
    const inOrder = !!(currentKP && currentKP.in_order);
    const planIsChild = !!(currentKP && currentKP.plan_is_child);

    // ✅ T19C: !inOrder убрано из canShow — блок видим и для позиций в заказе
    const canShow = (isBestDone || isSent) && !planIsChild && !!currentKP;

    const commentBox = document.getElementById('manualBestKpCommentBox');
    const commentTa = document.getElementById('manualBestKpComment');
    const currentCommentBox = document.getElementById('manualBestKpCurrentComment');
    const currentCommentText = document.getElementById('manualBestKpCurrentCommentText');

    if (canShow) {
      fs.style.display = '';
      const isBest = !!(currentKP && currentKP.reshenie === 'лучшее предложение');
      const existingComment = (currentKP && currentKP.primechanie_kp) || '';
      // ✅ НОВОЕ: авто-ЛКП если reshenie='лучшее предложение' и комментарий
      //   равен стандартному 'лучшее предложение по цене'
      const isAutoBest = isBest && existingComment === 'лучшее предложение по цене';
      // ✅ НОВОЕ: ручное ЛКП если reshenie='лучшее предложение' и комментарий
      //   не равен стандартному (т.е. пользовательский текст)
      const isManualBest = isBest && existingComment && !isAutoBest;
      // ✅ T19-ISKLYUCHEN: исключённое КП нельзя назначить лучшим
      // (иначе оно не попадёт в заказ), но сам блок показываем — с подсказкой
      const isExcludedKp = String((currentKP && currentKP.isklyuchen) || '') === '1';
      // ✅ T19C: позиция в заказе — назначение/смена зафиксировано заказом.
      //   Чекбокс всегда disabled (сервер всё равно вернёт CHAIN_IN_ORDER),
      //   но галочка и комментарий ВИДНЫ; комментарий действующего ручного
      //   ЛКП можно редактировать (Enter — сохранить, onlyComment-режим).
      let chkDisabled, chkTitle;
      if (inOrder) {
        chkDisabled = true;
        chkTitle = isBest
          ? 'Позиция включена в заказ — назначение зафиксировано. Комментарий можно редактировать (Enter — сохранить).'
          : 'Позиция включена в заказ — смена лучшего КП невозможна. Сначала удалите позицию из заказа.';
      } else {
        chkDisabled = isExcludedKp;
        chkTitle = isExcludedKp ? 'КП исключено из расчётов — снимите флаг исключения выше' : '';
      }
      chk.disabled = chkDisabled;
      chk.title = chkTitle;
      chk.checked = isBest;

      // ✅ НОВОЕ: textarea показываем ВСЕГДА (если canShow=true) — пользователь
      //   сразу видит поле, заполняет его, потом ставит галочку.
      //   - Если КП не лучшее → поле активно, пустое, ждёт ввода
      //   - Если авто-ЛКП → поле disabled, в подсказке стандартный текст
      //   - Если ручное ЛКП → поле disabled, в подсказке текущий комментарий
      if (commentBox) {
        commentBox.style.display = '';
      }
      if (commentTa) {
        if (isAutoBest) {
          // ✅ Авто-ЛКП — поле disabled (нельзя редактировать стандартный комментарий)
          commentTa.disabled = true;
          commentTa.value = existingComment;
          commentTa.placeholder = '';
        } else if (isManualBest) {
          // ✅ НОВОЕ: Ручное ЛКП — поле РЕДАКТИРУЕМОЕ (можно изменить комментарий)
          //   Сохранение: Enter в textarea или клик по чекбоксу
          //   (без подтверждения и без сброса ЛКП)
          commentTa.disabled = false;
          commentTa.value = existingComment;
          commentTa.placeholder = 'Отредактируйте комментарий ручного назначения';
        } else if (inOrder) {
          // ✅ T19C: КП не лучшее, а позиция уже в заказе — назначить это КП
          //   нельзя (CHAIN_IN_ORDER). Поле блокируем с объяснением,
          //   чтобы не приглашать пользователя к бесполезному вводу.
          commentTa.disabled = true;
          commentTa.value = '';
          commentTa.placeholder = 'Позиция включена в заказ — назначение другого КП невозможно';
        } else if (isExcludedKp) {
          // ✅ T19C: КП исключено из расчётов и не назначено — назначить нельзя
          //   (сервер вернёт KP_ISKLYUCHEN). Поле блокируем с объяснением.
          commentTa.disabled = true;
          commentTa.value = '';
          commentTa.placeholder = 'КП исключено из расчётов — снимите флаг исключения выше, чтобы назначить лучшим';
        } else {
          // КП не назначено лучшим — поле активно, ждёт заполнения
          commentTa.disabled = false;
          commentTa.value = '';
          commentTa.placeholder = 'Объясните причину ручного выбора этого КП (обязательно)';
        }
      }
      // ✅ НОВОЕ: блок «Текущий комментарий» показываем только если КП уже лучшее
      //   и есть существующий комментарий (для информативности — что уже назначено)
      if (isBest && existingComment && currentCommentBox && currentCommentText) {
        const label = isAutoBest ? 'Автоназначение:' : 'Ручное назначение:';
        currentCommentText.textContent = `${label} ${existingComment}`;
        currentCommentBox.style.display = '';
      } else if (currentCommentBox) {
        currentCommentBox.style.display = 'none';
      }
    } else {
      fs.style.display = 'none';
      chk.checked = false;
      chk.disabled = false;
      chk.title = '';
      if (commentBox) commentBox.style.display = 'none';
      if (commentTa) {
        commentTa.value = '';
        commentTa.disabled = false;
      }
      if (currentCommentBox) currentCommentBox.style.display = 'none';
    }
  },

  // ============================================================
  // ✅ T19-ISKLYUCHEN: чекбокс «исключено из расчётов»
  //   Показывается всегда, когда выбрано КП: пользователь видит,
  //   исключено ли КП из расчётов, и может установить/снять флаг.
  //   Блокировка: КП включено в заказ (сначала удалите из заказа).
  // ============================================================
  _updateKpIsklyuchenCheckbox(currentKP) {
    const fs = document.getElementById('kpIsklyuchenFieldset');
    const chk = document.getElementById('chkKpIsklyuchen');
    if (!fs || !chk) return;

    if (!currentKP) {
      fs.style.display = 'none';
      chk.checked = false;
      chk.disabled = false;
      chk.title = '';
      return;
    }

    fs.style.display = '';
    chk.checked = String(currentKP.isklyuchen || '') === '1';
    const inOrder = !!currentKP.in_order;
    chk.disabled = inOrder;
    chk.title = inOrder ? 'КП включено в заказ — сначала удалите позицию из заказа' : '';
  },

  // ============================================================
  // ✅ T19-ISKLYUCHEN: переключение флага «исключено из расчётов»
  //   POST /api/kom-predl/set-isklyuchen { kpId, isklyuchen }
  //   Сервер сам освобождает позицию и откатывает статус запроса,
  //   если исключённое КП было назначено лучшим.
  // ============================================================
  async onKpIsklyuchenToggle(checked) {
    const chk = document.getElementById('chkKpIsklyuchen');
    if (!chk) return;

    if (!Offers._selectedKpId) {
      chk.checked = false;
      toast('Сначала выберите позицию КП', 'warning');
      return;
    }

    const kpId = Offers._selectedKpId;
    const currentKP = Offers._allKP.find(k => k.id === kpId);
    if (!currentKP) { chk.checked = false; return; }

    const newVal = checked ? '1' : '';
    if (String(currentKP.isklyuchen || '') === newVal) return; // уже в этом состоянии

    if (checked && !confirm(
      'Исключить это КП из расчётов?\n\n' +
      'Исключённое КП не участвует в выборе лучших КП и не попадает в заказы.\n' +
      'Если оно назначено лучшим — позиция будет освобождена, а статус запроса откатится для перерасчёта.'
    )) {
      chk.checked = false;
      return;
    }

    await batchManager.withBatch('kp', async () => {
      const r = await api('POST', '/api/kom-predl/set-isklyuchen', { kpId, isklyuchen: newVal });
      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        chk.checked = !checked;
        return;
      }
      if (r.noop) {
        toast(r.message || 'Состояние не изменилось', 'info');
        return;
      }

      // Обновляем локальную копию КП (до перезагрузки данных)
      currentKP.isklyuchen = r.isklyuchen || newVal;
      if (r.freed) {
        currentKP.reshenie = '';
        currentKP.primechanie_kp = '';
      }

      toast(r.message || (checked ? 'КП исключено из расчётов' : 'КП возвращено в расчёт'), 'success');

      // Статус запроса мог откатиться — обновляем лейбл и данные
      if (r.newStatus) {
        const lbl = document.getElementById('lblStatus');
        if (lbl) lbl.textContent = r.newStatus;
      }
      await Offers._reloadKPAndSummary();
      const fresh = Offers._allKP.find(k => k.id === kpId) || currentKP;
      Offers._updateKpIsklyuchenCheckbox(fresh);
      Offers._updateManualBestKpCheckbox(fresh);
      Offers.updateButtonStates();
    });
  },

  // ============================================================
  // ✅ НОВОЕ: обработчик клика по чекбоксу
  //   Если галочку СНИМАЮТ — ничего не делаем (состояние вернётся само
  //   после reload, т.к. КП уже было лучшим).
  //   Если галочку СТАВЯТ — подтверждение и вызов assignManualBestKP().
  // ============================================================
  async onManualBestKpToggle(checked) {
    const chk = document.getElementById('chkManualBestKp');
    if (!chk) return;

    if (!checked) {
      // Снятие галочки — откатываем её обратно: если КП уже было лучшим,
      // после reload галочка сама вернётся в checked.
      const currentKP = Offers._allKP.find(k => k.id === Offers._selectedKpId);
      if (currentKP && currentKP.reshenie === 'лучшее предложение') {
        chk.checked = true;
        toast('Это КП уже назначено лучшим. Для отмены используйте редактирование КП.', 'info');
      }
      return;
    }

    if (!Offers._selectedKpId) {
      toast('Сначала выберите позицию КП', 'warning');
      chk.checked = false;
      return;
    }

    // ✅ НОВОЕ: блок комментария уже показан в _updateManualBestKpCheckbox
    //   (textarea активна, т.к. КП не было лучшим). Просто читаем значение.
    const commentTa = document.getElementById('manualBestKpComment');
    const commentBox = document.getElementById('manualBestKpCommentBox');

    // ✅ НОВОЕ: если КП уже назначено лучшим ВРУЧНУЮ (а не автоназначением)
    //   → сохраняем только комментарий без сброса ЛКП
    const currentKP = Offers._allKP.find(k => k.id === Offers._selectedKpId);
    if (currentKP && currentKP.reshenie === 'лучшее предложение' &&
        currentKP.primechanie_kp && currentKP.primechanie_kp !== 'лучшее предложение по цене') {
      const primechanieKp = (commentTa?.value || '').trim();
      if (!primechanieKp) {
        toast('Комментарий не может быть пустым', 'warning');
        commentTa?.focus();
        return;
      }
      // Если комментарий не изменился — ничего не делаем
      if (primechanieKp === currentKP.primechanie_kp) {
        return;
      }
      // ✅ Сохраняем только комментарий (без confirm, без сброса ЛКП)
      await Offers.updateManualBestKPComment(primechanieKp);
      return;
    }

    // ✅ НОВОЕ: валидация — комментарий обязателен для ручного назначения
    const primechanieKp = (commentTa?.value || '').trim();
    if (!primechanieKp) {
      toast('Заполните обязательный комментарий к ручному назначению лучшего КП', 'warning');
      commentTa?.focus();
      // Галочку оставляем установленной — пользователь видит активное поле,
      // заполняет его и нажимает ещё раз на чекбокс (снять→поставить)
      // или Enter в textarea (см. ниже отдельный обработчик)
      return;
    }

    if (!confirm(
      'Назначить это КП как лучшее для данной позиции?\n\n' +
      'Будет выполнен сброс текущего лучшего КП (откат цепочки позиции) ' +
      'и установка выбранного КП как лучшего. Комментарий: «' + primechanieKp + '»'
    )) {
      chk.checked = false;
      // ✅ НОВОЕ: блок комментария НЕ скрываем — пользователь может
      //   передумать, отредактировать и снова поставить галочку
      return;
    }

    await Offers.assignManualBestKP(primechanieKp);
  },

  // ============================================================
  // ✅ НОВОЕ: обновление только комментария ручного ЛКП
  //   POST /api/kom-predl/manual-best { kpId, primechanieKp, onlyComment:true }
  //   Без подтверждения, без сброса ЛКП, без отката цепочки.
  //   Используется для редактирования комментария уже назначенного ручного ЛКП.
  // ============================================================
  async updateManualBestKPComment(primechanieKp = '') {
    if (!Offers._selectedKpId) return;
    if (!primechanieKp) {
      const commentTa = document.getElementById('manualBestKpComment');
      primechanieKp = (commentTa?.value || '').trim();
    }
    if (!primechanieKp) {
      toast('Комментарий не может быть пустым', 'warning');
      return;
    }

    await batchManager.withBatch('kp', async () => {
      const r = await api('POST', '/api/kom-predl/manual-best', {
        kpId: Offers._selectedKpId,
        primechanieKp: primechanieKp,
        onlyComment: true,
      });

      if (r.error) {
        toast('Ошибка: ' + r.error, 'error');
        return;
      }

      toast(r.message || 'Комментарий обновлён', 'success');

      // ✅ Лёгкая перезагрузка: только _allKP + форма + чекбокс
      //   (без полного пересоздания сводной таблицы, т.к. reshenie не изменился)
      await Offers._reloadKPAndSummary();

      // Обновляем форму + состояние чекбокса/textarea
      if (Offers._selectedKpId) {
        const updatedKp = Offers._allKP.find(k => k.id === Offers._selectedKpId);
        if (updatedKp) {
          Offers._formStateManager.fillFromRow(updatedKp);
          Offers._updateManualBestKpCheckbox(updatedKp);
        }
      }

      Offers.updateButtonStates();
    });
  },

  // ============================================================
  // ✅ НОВОЕ: вызов API ручного назначения лучшего КП
  //   POST /api/kom-predl/manual-best { kpId }
  //   На success: перезагрузка КП и сводной, восстановление выбора.
  //   На ошибку: снятие галочки и показ соответствующего сообщения.
  // ============================================================
  async assignManualBestKP(primechanieKp = '') {
    if (!Offers._selectedKpId) return;

    // ✅ НОВОЕ: если комментарий не передан (повторный вызов), читаем из textarea
    if (!primechanieKp) {
      const commentTa = document.getElementById('manualBestKpComment');
      primechanieKp = (commentTa?.value || '').trim();
    }
    if (!primechanieKp) {
      toast('Заполните обязательный комментарий к ручному назначению', 'warning');
      return;
    }

    await batchManager.withBatch('kp', async () => {
      const r = await api('POST', '/api/kom-predl/manual-best', {
        kpId: Offers._selectedKpId,
        primechanieKp: primechanieKp,
      });

      if (r.error) {
        if (r.code === 'CHAIN_IN_ORDER') {
          alert(
            '🚫 Невозможно назначить лучшее КП!\n' + r.error + '\n\n💡 Решение:\n' +
            '1. Перейдите в раздел "Заказы по договорам".\n' +
            '2. Найдите заказ, в который включена эта деталь.\n' +
            '3. Удалите данную позицию из заказа.\n' +
            'После этого вы сможете назначить лучшее КП вручную.'
          );
        } else if (r.code === 'KP_ON_CHILD_PLAN') {
          alert(r.error);
        } else if (r.code === 'BEST_KP_NOT_DONE') {
          toast(r.error, 'warning');
        } else if (r.code === 'PRIMECHANIE_REQUIRED') {
          toast(r.error, 'warning');
          const commentTa = document.getElementById('manualBestKpComment');
          commentTa?.focus();
        } else {
          toast('Ошибка: ' + r.error, 'error');
        }
        // Назначение не выполнено — снимаем галочку
        const chk = document.getElementById('chkManualBestKp');
        if (chk) chk.checked = false;
        return;
      }

      toast(r.message || 'Назначено лучшее КП вручную', 'success');

      // ✅ НОВОЕ: Перезагружаем КП и пересоздаём сводную таблицу
      //   (с актуальной подсветкой строк с ручным ЛКП)
      await Offers._reloadKPAndSummary();

      // ✅ НОВОЕ: Восстанавливаем выбор в верхней таблице деталей
      //   (по id_plana, т.к. после отката цепочки план мог смениться)
      const updatedKp = Offers._allKP.find(k => k.id === Offers._selectedKpId);
      if (updatedKp) {
        // Заполняем форму из свежих данных КП
        Offers._formStateManager.fillFromRow(updatedKp);
        Offers._updateManualBestKpCheckbox(updatedKp);

        // ✅ НОВОЕ: синхронизируем выбор в верхней таблице и сводной
        const detalRow = Offers._allDetali.find(d => d.id === updatedKp.id_plana);
        if (detalRow && state.tables.detali) {
          state.tables.detali.selectById(detalRow.id);
        }
        if (Offers._summaryTable) {
          Offers._summaryTable.selectById(updatedKp.id_plana);
        }
      }

      Offers.updateButtonStates();
    });
  },

  // ============================================================
  // ✅ НОВОЕ: свернуть/развернуть все группы фирм
  // ============================================================

  /** Обработчик изменения чекбокса «Свернуть все группы».
   *  checked=true  → свернуть все группы фирм
   *  checked=false → развернуть все группы фирм
   */
  async onCollapseAllGroupsChange(checked) {
    if (!Offers._summaryTable) return;
    if (checked) {
      Offers._summaryTable.collapseAllGroups();
    } else {
      Offers._summaryTable.expandAllGroups();
    }
    // После операции — синхронизируем чекбокс с актуальным состоянием
    Offers._syncCollapseAllCheckbox();
  },

  /** Синхронизация состояния чекбокса с актуальным состоянием таблицы.
   *  Показывает/скрывает label в зависимости от того, есть ли collapsible-группы.
   *  Устанавливает галочку в соответствии с areAllGroupsCollapsed().
   */
  _syncCollapseAllCheckbox() {
    const lbl = document.getElementById('lblCollapseAllGroups');
    const chk = document.getElementById('chkCollapseAllGroups');
    if (!lbl || !chk) return;

    if (!Offers._summaryTable || !Offers._summaryTable.collapsibleGroups) {
      lbl.style.display = 'none';
      return;
    }

    // Проверяем, есть ли в таблице хотя бы одна collapsible-группа
    const hasCollapsibleGroups = Array.isArray(Offers._summaryTable.groups) &&
      Offers._summaryTable.groups.some(g =>
        Offers._summaryTable.collapsibleColorClasses.includes(g.colorClass));

    if (!hasCollapsibleGroups) {
      lbl.style.display = 'none';
      return;
    }

    lbl.style.display = '';
    chk.checked = Offers._summaryTable.areAllGroupsCollapsed();
  },
};