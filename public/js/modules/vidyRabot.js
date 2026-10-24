// public/js/modules/vidyRabot.js
// МОДУЛЬ: ВИДЫ РАБОТ ПО ДОГОВОРАМ
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { VirtualTable } from '../common/virtual-table.js';
import { EditLock, isLocked } from '../common/websocket.js';
import { batchManager } from '../common/batch-update.js';
import { DirtyGuard } from '../common/dirty-guard.js';

export const VidyRabot = {
  _allFirmy: [],
  _allDogovory: [],
  _allSpravVidy: [],
  _selectedFirmaId: null,
  _selectedDogovorId: null,
  _selectedVrId: null,
  _isDirty: false,
  _initialSnapshot: null,

  // ============================================================
  // ИНИЦИАЛИЗАЦИЯ
  // ============================================================
  async init() {
    // Таблица видов работ
    const cols = [
      { key: 'naimenovanie', label: 'Наименование работ', width: '480px' },
      {
        key: 'stoimost',
        label: 'Стоимость н/ч, ₽',
        width: '160px',
        formatter: (v) => ({
          text: v != null && v !== '' ? Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '',
          style: { textAlign: 'right', fontFamily: 'Consolas, monospace' }
        })
      },
    ];

    state.tables.vidy_rabot = new VirtualTable(
      document.getElementById('vrTable'), cols,
      {
        idKey: 'id',
        onSelect: (r) => VidyRabot.onSelect(r),
        onHeaderClick: () => VidyRabot.onHeaderClick(),
        getLockInfo: (item) => isLocked('vidy_rabot_dogovor', item.id),
      }
    );

    // Кнопки CRUD
    document.getElementById('btnVrAdd').onclick = () => VidyRabot.add();
    document.getElementById('btnVrSave').onclick = () => VidyRabot.save();
    document.getElementById('btnVrDel').onclick = () => VidyRabot.del();

    // Групповая операция
    document.getElementById('btnApplyCopy').onclick = () => VidyRabot.applyCopy();

    // Каскадные комбобоксы
    document.getElementById('vrFirma').addEventListener('change', () => VidyRabot.onFirmaChange());
    document.getElementById('vrDogovor').addEventListener('change', () => VidyRabot.onDogovorChange());
    document.getElementById('vrSourceDogovor').addEventListener('change', () => VidyRabot.updateCopyButton());

    // Справочник → наименование
    document.getElementById('vrSpravVid').addEventListener('change', () => VidyRabot.onSpravVidChange());

    // Dirty-трекинг формы
    ['vrNaimenovanie', 'vrStoimost'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        VidyRabot._recalcDirty();
        VidyRabot.updateButtonStates();
      });
    });

    // Загрузка справочников
    await VidyRabot.loadReferences();
  },

  // ============================================================
  // СПРАВОЧНИКИ
  // ============================================================
  async loadReferences() {
    try {
      // Фирмы
      VidyRabot._allFirmy = await api('GET', '/api/firmy');
      const selFirma = document.getElementById('vrFirma');
      selFirma.innerHTML = '<option value="">— Выберите фирму —</option>';
      VidyRabot._allFirmy.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.id_firmy;
        opt.textContent = f.naimenovanie;
        selFirma.appendChild(opt);
      });

      // Справочник видов работ
      VidyRabot._allSpravVidy = await api('GET', '/api/sprav-vidy-rabot');
      const selSprav = document.getElementById('vrSpravVid');
      selSprav.innerHTML = '<option value="">— Ввести вручную или выбрать из списка —</option>';
      VidyRabot._allSpravVidy.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.naimenovanie;
        selSprav.appendChild(opt);
      });
    } catch (e) {
      console.error('[VidyRabot.loadReferences]', e);
    }
  },

  // ============================================================
  // КАСКАДНАЯ ЗАГРУЗКА: фирма → договор
  // ============================================================
  async onFirmaChange() {
    const firmaId = document.getElementById('vrFirma').value;
    VidyRabot._selectedFirmaId = firmaId;
    const selDog = document.getElementById('vrDogovor');
    const selSrc = document.getElementById('vrSourceDogovor');

    // Сброс
    selDog.innerHTML = '<option value="">— Выберите договор —</option>';
    selSrc.innerHTML = '<option value="">— Источник —</option>';
    VidyRabot._selectedDogovorId = null;
    VidyRabot._selectedVrId = null;
    state.tables.vidy_rabot.setData([]);
    VidyRabot.clearForm();
    VidyRabot.updateButtonStates();

    if (!firmaId) {
      VidyRabot._allDogovory = [];
      return;
    }

    try {
      VidyRabot._allDogovory = await api('GET', `/api/dogovor?id_firmy=${encodeURIComponent(firmaId)}`);
      const firma = VidyRabot._allFirmy.find(f => f.id_firmy === firmaId);

      VidyRabot._allDogovory.forEach(d => {
        const opt1 = document.createElement('option');
        opt1.value = d.id_dogovor;
        opt1.textContent = `№ ${d.nom_dogovor} от ${d.data_dogovor || '—'}`;
        selDog.appendChild(opt1);

        const opt2 = opt1.cloneNode(true);
        selSrc.appendChild(opt2);
      });

      // Обновляем инфо-блок
      document.getElementById('infoFirma').textContent = firma?.naimenovanie || '—';
    } catch (e) {
      console.error('[VidyRabot.onFirmaChange]', e);
    }
  },

  // ============================================================
  // ВЫБОР ДОГОВОРА — загрузка видов работ
  // ============================================================
  async onDogovorChange() {
    const dogovorId = document.getElementById('vrDogovor').value;
    VidyRabot._selectedDogovorId = dogovorId;
    VidyRabot._selectedVrId = null;

    if (!dogovorId) {
      state.tables.vidy_rabot.setData([]);
      VidyRabot.clearForm();
      VidyRabot.updateButtonStates();
      return;
    }

    const dogovor = VidyRabot._allDogovory.find(d => d.id_dogovor === dogovorId);
    document.getElementById('infoNomDogovor').textContent = dogovor?.nom_dogovor || '—';
    document.getElementById('infoDataDogovor').textContent = dogovor?.data_dogovor || '—';
    document.getElementById('vrTitleSuffix').textContent = dogovor
      ? `— № ${dogovor.nom_dogovor} от ${dogovor.data_dogovor || '—'}`
      : '';

    await VidyRabot.load();
    VidyRabot.updateCopyButton();
  },

  // ============================================================
  // ЗАГРУЗКА ВИДОВ РАБОТ ТЕКУЩЕГО ДОГОВОРА
  // ============================================================
  async load() {
    if (!VidyRabot._selectedDogovorId) return;
    const data = await api('GET', `/api/vidy-rabot?id_dogovor=${encodeURIComponent(VidyRabot._selectedDogovorId)}`);
    state.tables.vidy_rabot.setData(Array.isArray(data) ? data : []);
    document.getElementById('vrCounter').textContent = `Видов работ: ${state.tables.vidy_rabot.data.length}`;
    VidyRabot._isDirty = false;
    VidyRabot._initialSnapshot = null;
    VidyRabot.updateButtonStates();
  },

  // ============================================================
  // ВЫБОР СТРОКИ
  // ============================================================
  async onSelect(row) {
    // DirtyGuard перед сменой записи
    if (VidyRabot._selectedVrId && VidyRabot._selectedVrId !== row.id && VidyRabot._isDirty) {
      const proceed = await DirtyGuard.handleRecordChange();
      if (!proceed) {
        // Возвращаем выбор
        state.tables.vidy_rabot.selectById(VidyRabot._selectedVrId);
        return;
      }
    }

    VidyRabot._selectedVrId = row.id;
    document.getElementById('vrNaimenovanie').value = row.naimenovanie || '';
    document.getElementById('vrStoimost').value = row.stoimost != null ? row.stoimost : '';
    document.getElementById('infoId').textContent = row.id || '—';

    // Синхронизация со справочником
    const spravSel = document.getElementById('vrSpravVid');
    if (row.id_sprav_vid) {
      spravSel.value = row.id_sprav_vid;
      const sprav = VidyRabot._allSpravVidy.find(v => v.id === row.id_sprav_vid);
      document.getElementById('vrSpravVidInfo').value = sprav?.naimenovanie || '';
    } else {
      spravSel.value = '';
      document.getElementById('vrSpravVidInfo').value = '';
    }

    // Снимок для dirty-трекинга
    VidyRabot._initialSnapshot = {
      naimenovanie: row.naimenovation || row.naimenovanie || '',
      stoimost: row.stoimost != null ? row.stoimost : '',
      id_sprav_vid: row.id_sprav_vid || '',
    };
    VidyRabot._isDirty = false;

    document.getElementById('vrFormTitle').textContent = `Вид работ: ${row.naimenovanie || '—'}`;
    VidyRabot.updateButtonStates();
  },

  // ============================================================
  // КЛИК ПО ЗАГОЛОВКУ — новая запись
  // ============================================================
  async onHeaderClick() {
    if (VidyRabot._isDirty) {
      const proceed = await DirtyGuard.handleRecordChange();
      if (!proceed) return;
    }
    VidyRabot._selectedVrId = null;
    VidyRabot.clearForm();
    VidyRabot.updateButtonStates();
  },

  clearForm() {
    document.getElementById('vrNaimenovanie').value = '';
    document.getElementById('vrStoimost').value = '';
    document.getElementById('vrSpravVid').value = '';
    document.getElementById('vrSpravVidInfo').value = '';
    document.getElementById('infoId').textContent = '—';
    document.getElementById('vrFormTitle').textContent = 'Новый вид работ';
    VidyRabot._initialSnapshot = null;
    VidyRabot._isDirty = false;
  },

  // ============================================================
  // ВЫБОР ИЗ СПРАВОЧНИКА → автозаполнение наименования
  // ============================================================
  onSpravVidChange() {
    const spravId = document.getElementById('vrSpravVid').value;
    const sprav = VidyRabot._allSpravVidy.find(v => v.id === spravId);
    if (sprav) {
      document.getElementById('vrNaimenovanie').value = sprav.naimenovanie;
      document.getElementById('vrSpravVidInfo').value = sprav.naimenovanie;
    } else {
      document.getElementById('vrSpravVidInfo').value = '';
    }
    VidyRabot._recalcDirty();
    VidyRabot.updateButtonStates();
  },

  // ============================================================
  // DIRTY-ТРЕКИНГ
  // ============================================================
  _recalcDirty() {
    if (!VidyRabot._initialSnapshot) {
      // Новая запись — dirty если заполнены поля
      const n = document.getElementById('vrNaimenovanie').value.trim();
      const s = document.getElementById('vrStoimost').value.trim();
      VidyRabot._isDirty = !!(n || s);
      return;
    }
    const curN = document.getElementById('vrNaimenovanie').value.trim();
    const curS = document.getElementById('vrStoimost').value.trim();
    const curSprav = document.getElementById('vrSpravVid').value || '';
    VidyRabot._isDirty =
      curN !== (VidyRabot._initialSnapshot.naimenovanie || '') ||
      String(curS) !== String(VidyRabot._initialSnapshot.stoimost ?? '') ||
      curSprav !== (VidyRabot._initialSnapshot.id_sprav_vid || '');
  },

  isDirty() { return VidyRabot._isDirty; },

  // ============================================================
  // СОСТОЯНИЕ КНОПОК
  // ============================================================
  updateButtonStates() {
    const hasDogovor = !!VidyRabot._selectedDogovorId;
    const hasSelection = !!VidyRabot._selectedVrId;
    const locker = hasSelection ? isLocked('vidy_rabot_dogovor', VidyRabot._selectedVrId) : null;

    const naim = document.getElementById('vrNaimenovanie').value.trim();
    const stoim = document.getElementById('vrStoimost').value.trim();

    // Add: доступен если выбран договор И форма заполнена (новая запись)
    document.getElementById('btnVrAdd').disabled =
      !hasDogovor || hasSelection || !naim || stoim === '';

    // Save: доступен если выбрана запись, она dirty и не заблокирована
    document.getElementById('btnVrSave').disabled =
      !hasSelection || !VidyRabot._isDirty || !!locker;

    // Del: доступен если выбрана запись и не заблокирована
    document.getElementById('btnVrDel').disabled = !hasSelection || !!locker;
  },

  updateCopyButton() {
    const src = document.getElementById('vrSourceDogovor').value;
    const canCopy = !!VidyRabot._selectedDogovorId && !!src && src !== VidyRabot._selectedDogovorId;
    document.getElementById('btnApplyCopy').disabled = !canCopy;
  },

  // ============================================================
  // CRUD
  // ============================================================
  async add() {
    if (!VidyRabot._selectedDogovorId) return;
    const payload = VidyRabot._buildPayload();
    if (!payload.naimenovanie) { toast('Заполните наименование', 'warning'); return; }

    await batchManager.withBatch('vidy_rabot_dogovor', async () => {
      const r = await api('POST', '/api/vidy-rabot', {
        ...payload,
        id_dogovor: VidyRabot._selectedDogovorId,
      });
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      toast('Вид работ добавлен');
      await VidyRabot.load();
      state.tables.vidy_rabot.selectById(r.id);
      const row = state.tables.vidy_rabot.data.find(x => x.id === r.id);
      if (row) VidyRabot.onSelect(row);
    });
  },

  async save() {
    if (!VidyRabot._selectedVrId) return;
    const payload = VidyRabot._buildPayload();
    if (!payload.naimenovanie) { toast('Заполните наименование', 'warning'); return; }

    await batchManager.withBatch('vidy_rabot_dogovor', async () => {
      const r = await api('PUT', `/api/vidy-rabot/${VidyRabot._selectedVrId}`, payload);
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      toast('Вид работ сохранён');
      if (EditLock.current?.id === VidyRabot._selectedVrId) EditLock.release();
      await VidyRabot.load();
      state.tables.vidy_rabot.selectById(VidyRabot._selectedVrId);
      const row = state.tables.vidy_rabot.data.find(x => x.id === VidyRabot._selectedVrId);
      if (row) VidyRabot.onSelect(row);
    });
  },

  async del() {
    if (!VidyRabot._selectedVrId) return;
    const row = state.tables.vidy_rabot.data.find(r => r.id === VidyRabot._selectedVrId);
    if (!confirm(`Удалить вид работ «${row?.naimenovanie || ''}»?`)) return;

    await batchManager.withBatch('vidy_rabot_dogovor', async () => {
      if (EditLock.current?.id === VidyRabot._selectedVrId) EditLock.release();
      const r = await api('DELETE', `/api/vidy-rabot/${VidyRabot._selectedVrId}`);
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      toast('Вид работ удалён', 'warning');
      await VidyRabot.load();
      VidyRabot.onHeaderClick();
    });
  },

  _buildPayload() {
    return {
      naimenovanie: document.getElementById('vrNaimenovanie').value.trim(),
      stoimost: parseFloat(String(document.getElementById('vrStoimost').value).replace(',', '.')) || 0,
      id_sprav_vid: document.getElementById('vrSpravVid').value || null,
    };
  },

  // ============================================================
  // ГРУППОВАЯ ОПЕРАЦИЯ: копирование видов работ из другого договора
  // (аналог "Применить маршрут" в Редакторе маршрутов)
  // ============================================================
  async applyCopy() {
    const srcId = document.getElementById('vrSourceDogovor').value;
    const tgtId = VidyRabot._selectedDogovorId;
    if (!srcId || !tgtId) { toast('Выберите договор-источник', 'warning'); return; }
    if (srcId === tgtId) { toast('Источник и приёмник — один договор', 'warning'); return; }

    const srcDog = VidyRabot._allDogovory.find(d => d.id_dogovor === srcId);
    const tgtDog = VidyRabot._allDogovory.find(d => d.id_dogovor === tgtId);
    const srcLabel = srcDog ? `№ ${srcDog.nom_dogovor}` : srcId;
    const tgtLabel = tgtDog ? `№ ${tgtDog.nom_dogovor}` : tgtId;

    if (!confirm(`Скопировать все виды работ из договора ${srcLabel} в договор ${tgtLabel}?\nДубликаты будут пропущены.`)) return;

    await batchManager.withBatch('vidy_rabot_dogovor', async () => {
      const r = await api('POST', '/api/vidy-rabot/copy', {
        source_dogovor_id: srcId,
        target_dogovor_id: tgtId,
      });
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      toast(r.message || `Скопировано: ${r.copied}`, 'success');
      await VidyRabot.load();
    });
  },
   // ============================================================
  // ВСТАВКА ИЗ БУФЕРА ОБМЕНА (через универсальный модуль)
  // Формат: Наименование[Tab]Стоимость
  // ============================================================
  async pasteFromClipboard() {
    if (!VidyRabot._selectedDogovorId) {
      toast('Сначала выберите договор в верхней панели', 'warning');
      return;
    }

    // Динамический импорт универсального модуля
    const { importFromClipboard } = await import('../common/clipboard-import.js');

    await importFromClipboard({
      tableName: 'vidy_rabot_dogovor',
      apiUrl: '/api/vidy-rabot',
      fields: ['naimenovanie', 'stoimost'],
      columnHints: ['Наименование работ', 'Стоимость н/ч, ₽'], 
      requiredFields: ['naimenovanie'],
      numericFields: ['stoimost'], // Модуль сам заменит ',' на '.' и сделает parseFloat
      
      getData: () => state.tables.vidy_rabot?.data || [],
      load: () => VidyRabot.load(),
      clearForm: () => VidyRabot.onHeaderClick(),
      updateButtons: () => VidyRabot.updateButtonStates(),

      // 1. Предобработка строки: убираем пробелы из стоимости и добавляем FK
      preprocessRow: (obj, cols) => {
        const naim = (obj.naimenovanie || '').trim();
        if (!naim) return null; // Пропустить полностью пустые строки

        if (obj.stoimost) {
          // Убираем пробелы ("2 485,00" -> "2485,00"), 
          // а numericFields в модуле сам сделает "2485.00" и parseFloat
          obj.stoimost = String(obj.stoimost).replace(/\s/g, '');
        }

        obj.id_dogovor = VidyRabot._selectedDogovorId;
        return obj;
      },

      // 2. Кастомная проверка дубликата: по наименованию (case-insensitive)
      isDuplicate: (existingRow, newObj) => {
        const existingName = (existingRow.naimenovanie || '').trim().toLowerCase();
        const newName = (newObj.naimenovanie || '').trim().toLowerCase();
        return existingName === newName;
      },

      // 3. Действие при обнаружении дубликата: обновляем стоимость через PUT
      onDuplicate: async (existingRow, newObj) => {
        const r = await api('PUT', `/api/vidy-rabot/${existingRow.id}`, {
          ...existingRow,          // сохраняем все старые поля (id_sprav_vid и т.д.)
          stoimost: newObj.stoimost // обновляем только стоимость
        });
        if (r.error) {
          throw new Error(r.error);
        }
      }
    });
  }
};