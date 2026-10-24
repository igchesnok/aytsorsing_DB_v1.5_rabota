// ============================================================
// js/modules/transportOpsCargo.js ВКЛАДКА: ДЕТАЛИ ГРУЗА
// С ЕДИНОЙ серверной фильтрацией через FilterableTable
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { FilterableTable } from '../common/filterable-table.js';
import { batchManager } from '../common/batch-update.js';
// ✅ T57: модальный диалог «Расчёт тарных мест»
import { TransportOpsTarn } from './transportOpsTarn.js';

export const TransportOpsCargo = {
  _pendingPositions: [],
  _coordinator: null,

  setCoordinator(coordinator) {
    this._coordinator = coordinator;
  },

  async init() {
    // ===== Таблица позиций операции =====
    const pozCols = [
      { key: 'nomer_chertezha', label: '№ чертежа', width: '120px' },
      { key: 'osn_naimenovanie', label: 'Наименование', width: '200px' },
      { key: 'tip_perevozki', label: 'Тип перевозки', width: '150px' },
      { key: 'nom_shag', label: '№ этапа', width: '60px' },
      { key: 'kolvo_no_br', label: 'Годн.', width: '70px' },
      { key: 'kolvo_yes_br', label: 'Брак', width: '70px' },
      { key: 'statys', label: 'Статус', width: '100px' },
      { key: 'plan_data', label: 'План дата', width: '90px' },
      // ✅ ЗАТРАТЫ + ручная проверка (колонки VBA lstPozTransportOper):
      // параметры каждой позиции берутся из оснастки и плана (сервер)
      { key: 'shpz_name', label: 'ШПЗ', width: '140px' },
      { key: 'peredel_poz', label: 'Передел', width: '80px' },
      { key: 'ceh_izg', label: 'Цех изг.', width: '80px' },
      { key: 'ves_det_tot', label: 'ВесДет', width: '80px' },
      { key: 'ves_zag_tot', label: 'ВесЗаг', width: '80px' },
      { key: 'obem_poz', label: 'Объем,м3', width: '80px' },
      { key: 'dlina', label: 'Длин,мм', width: '70px' },
      { key: 'shirina', label: 'Шир,мм', width: '70px' },
      { key: 'vysota', label: 'Выс,мм', width: '70px' },
      // ✅ ТИПЫ ГРУЗА: параметры раскроя заготовки (лист/пруток)
      { key: 'list_params', label: 'Лист Д×Ш×Т', width: '110px' },
      { key: 'prutok_dlina', label: 'Пруток, мм', width: '80px' },
      // ✅ T24B: кол-во заготовок ГРУЗОВОЙ ПОЗИЦИИ (у каждого рейса своё;
      // пусто = авто по раскрою; для штучных = кол-во деталей)
      { key: 'kolvo_zagotovok', label: 'Кол-во заг.', width: '80px' },
      // T56-b: марка материала — факт (или конструкторская, если факт пуст)
      { key: 'marka_eff', label: 'Марка мат.', width: '90px' }
    ];

    state.tables.poz = new FilterableTable(
      document.getElementById('pozTable'), pozCols,
      {
        idKey: 'id',
        apiUrl: '/api/transport-oper/poz',
        filterFields: {
          fltTransId: { dbField: 'transId', type: 'text' }
        },
        debounceMs: 300,
        multiSelect: true,
        onSelectionChange: () => this.updateMoveButtons()
      }
    );

    // ===== Таблица доступных позиций (НОВЫЙ АЛГОРИТМ: заявки на активном
    // шаге позиции плана; остаток = заявка минус уже загруженные партии) =====
    const availCols = [
      { key: 'nomer_chertezha', label: '№ чертежа', width: '120px' },
      { key: 'osn_naimenovanie', label: 'Наименование', width: '200px' },
      { key: 'nom_shag', label: '№ этапа', width: '60px' },
      { key: 'tip_perevozki', label: 'Тип перевозки', width: '150px' },
      { key: 'firma_name', label: 'Фирма', width: '120px' },
      { key: 'plan_kolvo_no_br', label: 'Заявка годн.', width: '80px' },
      { key: 'plan_kolvo_yes_br', label: 'Заявка брак', width: '80px' },
      { key: 'available_no_br', label: 'Остаток', width: '70px' },
      { key: 'available_yes_br', label: 'Остаток брак', width: '80px' },
      { key: 'nom_dogovor', label: 'Договор', width: '120px' },
      // ✅ ЗАТРАТЫ + ручная проверка (колонки VBA lstDostypPoz)
      { key: 'shpz_name', label: 'ШПЗ', width: '140px' },
      { key: 'peredel_poz', label: 'Передел', width: '80px' },
      { key: 'ceh_izg', label: 'Цех изг.', width: '80px' },
      { key: 'ves_det_tot', label: 'ВесДет', width: '80px' },
      { key: 'ves_zag_tot', label: 'ВесЗаг', width: '80px' },
      { key: 'obem_poz', label: 'Объем,м3', width: '80px' },
      { key: 'dlina', label: 'Длин,мм', width: '70px' },
      { key: 'shirina', label: 'Шир,мм', width: '70px' },
      { key: 'vysota', label: 'Выс,мм', width: '70px' },
      // ✅ ТИПЫ ГРУЗА: параметры раскроя заготовки (лист/пруток)
      { key: 'list_params', label: 'Лист Д×Ш×Т', width: '110px' },
      { key: 'prutok_dlina', label: 'Пруток, мм', width: '80px' }
      // T24B: «Кол-во заг.» здесь НЕТ — грузовой позиции ещё не существует,
      // значение появляется после добавления позиции в рейс
    ];

    state.tables.available = new FilterableTable(
      document.getElementById('availableTable'), availCols,
      {
        idKey: 'plan_perevozok_id',
        apiUrl: '/api/transport-oper/available',
        filterFields: {
          fltDirection: { dbField: 'direction', type: 'text' },
          fltFirma: { dbField: 'id_firma', type: 'text' },
          fltChertezh: { dbField: 'nomer_chertezha', type: 'text' },
          fltNaimenovanie: { dbField: 'naimenovanie', type: 'text' },
          fltDogovor: { dbField: 'nom_dogovor', type: 'text' }
        },
        debounceMs: 300,
        multiSelect: true,
        onSelectionChange: () => this.updateMoveButtons(),
         // ✅ ИСПРАВЛЕНИЕ: Клиентская фильтрация pending-позиций после ответа сервера
        postProcess: (data) => {
          const pendingIds = new Set(this._pendingPositions.map(p => p.id));
          return data.filter(item => !pendingIds.has(item.plan_perevozok_id));
        }
      }
    );

    // ===== Обработчики кнопок перемещения =====
    document.getElementById('btnMoveUp').onclick = () => this.movePositionsUp();
    document.getElementById('btnMoveDown').onclick = () => this.movePositionsDown();

    // ✅ ЕДИНЫЕ обработчики фильтров: вызывают одну и ту же функцию
    ['fltChertezh', 'fltNaimenovanie', 'fltDogovor'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => this.applyAvailableFilters());
    });

    // Кнопка очистки фильтров
    document.getElementById('btnClearFilters').onclick = () => {
      document.getElementById('fltChertezh').value = '';
      document.getElementById('fltNaimenovanie').value = '';
      document.getElementById('fltDogovor').value = '';
      this.applyAvailableFilters(); // Перезагружаем с очищенными текстовыми фильтрами
    };

    // Кнопка редактирования позиций
    const btnEditPoz = document.getElementById('btnEditPoz');
    if (btnEditPoz) {
      btnEditPoz.onclick = () => {
        window.open('../pages/plan-perevozok.html', '_blank', 'width=1400,height=900');
      };
    }

    // ✅ T57: модальный диалог «Расчёт тарных мест» (тип груза у каждой
    // позиции, укладка, авто-расчёт, группировка) — вместо «Параметров заготовки»
    const btnPozParams = document.getElementById('btnPozParams');
    if (btnPozParams) btnPozParams.onclick = () => TransportOpsTarn.open();
  },

  // ============================================================
  // ✅ ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ: сбор всех значений фильтров
  // ============================================================
  _getAvailableFilters() {
    return {
      fltDirection: this._coordinator?._direction || 'Исходящая',
      fltFirma: document.getElementById('toFirma')?.value || '',
      fltChertezh: document.getElementById('fltChertezh')?.value || '',
      fltNaimenovanie: document.getElementById('fltNaimenovanie')?.value || '',
      fltDogovor: document.getElementById('fltDogovor')?.value || ''
    };
  },

  // ============================================================
  // ✅ ПРИМЕНЕНИЕ ФИЛЬТРОВ (с debounce 300мс из FilterableTable)
  // ============================================================
  applyAvailableFilters() {
    const filters = this._getAvailableFilters();
    state.tables.available.applyFilters(filters);
  },

  // ============================================================
  // ✅ МГНОВЕННАЯ ЗАГРУЗКА (без debounce, после CRUD операций)
  // ============================================================
  async loadAvailablePositions() {
    const filters = this._getAvailableFilters();
    await state.tables.available.loadImmediate(filters);
  },

  // ===== Загрузка позиций операции =====
  async loadPositions() {
    const operId = this._coordinator?._selectedOperId;
    if (!operId) {
      state.tables.poz.setData([]);
      return;
    }
    await state.tables.poz.loadImmediate({ fltTransId: operId });
  },

  updateMoveButtons() {
    const btnUp = document.getElementById('btnMoveUp');
    const btnDown = document.getElementById('btnMoveDown');
    if (btnUp) btnUp.disabled = state.tables.available.getSelectedCount() === 0;
    if (btnDown) btnDown.disabled = state.tables.poz.getSelectedCount() === 0;
  },

  // ========================================================================
  // Добавление позиций в операцию (↑)
  // ========================================================================
  async movePositionsUp() {
    const selectedIds = state.tables.available.getSelectedIds();
    if (selectedIds.length === 0) {
      toast('Выберите позиции для добавления', 'warning');
      return;
    }

    const selectedOperId = this._coordinator?._selectedOperId;

    if (selectedOperId) {
      // === РЕЖИМ РЕДАКТИРОВАНИЯ: добавляем в БД ===
      let addedCount = 0;
      await batchManager.withBatch('gryz_poz', async () => {
        for (const planPerevozokId of selectedIds) {
          const avail = state.tables.available.data.find(a => a.plan_perevozok_id === planPerevozokId);
          if (!avail) continue;

          const item = {
            id_transporta: selectedOperId,
            id_plana: avail.plan_perevozok_id,
            // ✅ НОВЫЙ АЛГОРИТМ: грузим ОСТАТОК заявки (заявка минус партии других рейсов)
            kolvo_no_br: parseFloat(avail.available_no_br ?? avail.plan_kolvo_no_br) || 0,
            kolvo_yes_br: parseFloat(avail.available_yes_br ?? avail.plan_kolvo_yes_br) || 0,
            primechanie: ''
          };

          const r = await api('POST', '/api/transport-oper/poz', item);
          if (r.error) {
            toast(`Ошибка: ${r.error}`, 'error');
            continue;
          }
          addedCount++;
        }
        if (addedCount > 0) toast(`Добавлено позиций: ${addedCount}`, 'success');
      });

      await this.loadPositions();
      await this.loadAvailablePositions();
    } else {
      // === РЕЖИМ СОЗДАНИЯ: добавляем в pending буфер ===
      let addedCount = 0;
      for (const planPerevozokId of selectedIds) {
        const avail = state.tables.available.data.find(a => a.plan_perevozok_id === planPerevozokId);
        if (!avail) continue;

        // ✅ Проверяем дубликат по plan_perevozok_id (конкретная партия), а не по id_plana (деталь)
        const exists = this._pendingPositions.some(p => p.plan_perevozok_id === avail.plan_perevozok_id);
        if (exists) continue;

        this._pendingPositions.push({
          id: avail.plan_perevozok_id,       // ✅ Ключ для VirtualTable (idKey: 'id')
          id_plana: avail.plan_perevozok_id, // ✅ Поле для отправки на сервер (совпадает с колонкой в gryz_poz)
          plan_id: avail.plan_id,            // ✅ ТИПЫ ГРУЗА: позиция ПЛАНА (для параметров листа/прутка)
          nomer_chertezha: avail.nomer_chertezha,
          osn_naimenovanie: avail.osn_naimenovanie,
          tip_perevozki: avail.tip_perevozki,
          nom_shag: avail.nom_shag,
          // ✅ НОВЫЙ АЛГОРИТМ: грузим ОСТАТОК заявки, а не полный объём
          kolvo_no_br: parseFloat(avail.available_no_br ?? avail.plan_kolvo_no_br) || 0,
          kolvo_yes_br: parseFloat(avail.available_yes_br ?? avail.plan_kolvo_yes_br) || 0,
          statys: '',
          plan_data: avail.plan_data,
          // ✅ параметры позиции для ручной проверки и расчётов (VBA)
          // ✅ T64 (баг 1): zak_pto + единичные веса — нужны серверу
          // автозаполнения (ШПЗ по заказу ПТО, масса по ves_det/ves_zag);
          // без них в режиме создания авто-заполнение писало
          // «Нет данных для автозаполнения (у позиций не определён ШПЗ)»
          zak_pto: avail.zak_pto,
          shpz: avail.shpz,
          shpz_name: avail.shpz_name,
          ves_det: avail.ves_det,
          ves_zag: avail.ves_zag,
          peredel_poz: avail.peredel_poz,
          ceh_izg: avail.ceh_izg,
          ves_det_tot: avail.ves_det_tot,
          ves_zag_tot: avail.ves_zag_tot,
          obem_poz: avail.obem_poz,
          dlina: avail.dlina,
          shirina: avail.shirina,
          vysota: avail.vysota,
          // ✅ ТИПЫ ГРУЗА: параметры раскроя заготовки (лист/пруток)
          list_dlina: avail.list_dlina,
          list_shirina: avail.list_shirina,
          list_tolshina: avail.list_tolshina,
          prutok_dlina: avail.prutok_dlina,
          kolvo_zagotovok: '', // ✅ T24B: задаётся в модалке «Параметры заготовки» (грузовой позиции ещё нет)
          list_params: avail.list_params,
          // T56-b: марка материала — факт (по умолчанию конструкторская из оснастки)
          marka_materiala: avail.marka_materiala_osn || '',
          marka_materiala_osn: avail.marka_materiala_osn || '',
          marka_eff: avail.marka_materiala_osn || ''
        });
        addedCount++;
      }

      if (addedCount > 0) toast(`Добавлено позиций: ${addedCount}`, 'success');
      state.tables.poz.setData(this._pendingPositions);
      await this.loadAvailablePositions();
    }

    state.tables.available.clearSelection();
    this._coordinator?.updateButtonStates();
  },

  // ========================================================================
  // Удаление позиций из операции (↓)
  // ========================================================================
  async movePositionsDown() {
    const selectedIds = state.tables.poz.getSelectedIds();
    if (selectedIds.length === 0) {
      toast('Выберите позиции для удаления', 'warning');
      return;
    }

    const selectedOperId = this._coordinator?._selectedOperId;

    if (selectedOperId) {
      // === РЕЖИМ РЕДАКТИРОВАНИЯ: удаляем из БД ===
      const totalPositions = state.tables.poz.data.length;
      const remainingPositions = totalPositions - selectedIds.length;

      if (remainingPositions === 0) {
        const deleteOper = confirm(
          'Вы удаляете последнюю позицию из операции.\n' +
          'Транспортная операция не может существовать без позиций.\n' +
          'Удалить саму транспортную операцию?'
        );
        if (!deleteOper) {
          toast('Удаление отменено', 'info');
          return;
        }

        await batchManager.withBatch('transport_oper', async () => {
          const r = await api('DELETE', `/api/transport-oper/${selectedOperId}`);
          if (r.error) {
            toast(`Ошибка: ${r.error}`, 'error');
            return;
          }
          toast('Операция удалена', 'warning');
        });

        await this._coordinator.load();
        await this._coordinator.onHeaderClick();
        return;
      }

      // В методе movePositionsDown(), блок "РЕЖИМ РЕДАКТИРОВАНИЯ"
      let deletedCount = 0;
      await batchManager.withBatch('gryz_poz', async () => {
        // ✅ selectedIds содержит 'id' записей (GP_...), так как idKey: 'id'
        for (const pozId of selectedIds) {
          
          // ✅ ИСПРАВЛЕНО: ищем по p.id, а не по p.id_plana
          const poz = state.tables.poz.data.find(p => p.id === pozId);
          
          if (!poz) {
            console.warn('Позиция не найдена для удаления:', pozId);
            continue;
          }
          
          const r = await api('DELETE', `/api/transport-oper/poz/${poz.id}`);
          if (r.error) {
            toast(`Ошибка: ${r.error}`, 'error');
            continue;
          }
          deletedCount++;
        }
        if (deletedCount > 0) toast(`Удалено позиций: ${deletedCount}`, 'success');
      });
      await this.loadPositions();
      await this.loadAvailablePositions();
    } else {
      // === РЕЖИМ СОЗДАНИЯ: удаляем из pending буфера ===
      this._pendingPositions = this._pendingPositions.filter(p => !selectedIds.includes(p.id));
      toast(`Удалено позиций: ${selectedIds.length}`, 'success');
      state.tables.poz.setData(this._pendingPositions);
      await this.loadAvailablePositions();
    }

    state.tables.poz.clearSelection();
    this._coordinator?.updateButtonStates();
  },

  // ============================================================
  // ✅ T57: pending-тарные места НОВОЙ операции (режим создания):
  // группы из модалки «Расчёт тарных мест» уходят с POST операции.
  // ============================================================
  setPendingTarnMesta(groups) {
    this._pendingTarnMesta = groups;
  },

  getPendingTarnMesta() {
    return Array.isArray(this._pendingTarnMesta) && this._pendingTarnMesta.length
      ? JSON.stringify(this._pendingTarnMesta) : '';
  },

  clearForm() {
    this._pendingPositions = [];
    this._pendingTarnMesta = []; // ✅ T57
    state.tables.poz.setData([]);
    state.tables.available.setData([]);
    // При очистке формы сбрасываем и текстовые фильтры
    document.getElementById('fltChertezh').value = '';
    document.getElementById('fltNaimenovanie').value = '';
    document.getElementById('fltDogovor').value = '';
  },

  getPendingPositions() {
    return this._pendingPositions.map(p => ({
      id_plana: p.id_plana,
      kolvo_no_br: p.kolvo_no_br || 0,
      kolvo_yes_br: p.kolvo_yes_br || 0,
      kolvo_zagotovok: p.kolvo_zagotovok || '', // ✅ T24B
      marka_materiala: p.marka_materiala || '', // T56-b: марка-факт
      // ✅ T57: тип груза позиции + параметры по типу
      tip_gruza: p.tip_gruza || '',
      prutok_diametr: p.prutok_diametr || '',
      tara_dlina: p.tara_dlina || '',
      tara_shirina: p.tara_shirina || '',
      tara_vysota: p.tara_vysota || '',
      ukladka: p.ukladka || '',
      list_dlina: p.list_dlina || '',
      list_shirina: p.list_shirina || '',
      list_tolshina: p.list_tolshina || '',
      prutok_dlina: p.prutok_dlina || '',
      primechanie: p.primechanie || ''
    }));
  },

  hasPendingPositions() {
    return this._pendingPositions.length > 0;
  }
};