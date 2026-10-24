// ============================================================
// ✅ T57-d: js/modules/transportOpsTarn.js (полностью переработан)
// МОДАЛЬНЫЙ ДИАЛОГ «Расчёт тарных мест» редактора транспортных операций.
//
// ОБЩАЯ КОНЦЕПЦИЯ ИНТЕРФЕЙСА ПРОЕКТА (по замечаниям пользователя):
//   ВИРТУАЛЬНАЯ ТАБЛИЦА СЛЕВА + ФОРМА РЕДАКТИРОВАНИЯ СПРАВА,
//   нижняя часть «Группировка тарных мест» — через горизонтальный ресайз.
//
// ВЕРХ — грузовые позиции (виртуальная таблица, шапка по ТЗ пользователя):
//   № позиции; Наименование; Габарит Д×Ш×В, м; Колич. загот., шт;
//   Марка; Кол. годн+брак.
//   Редактируются в форме справа ТОЛЬКО: Габарит Д×Ш×В (параметры типа),
//   Колич. загот., шт (ручное перекрытие) и Марка; тип груза — селект.
//
// НИЗ — «Группировка тарных мест»: виртуальная таблица
//   Тип места | Габарит Д×Ш×В, м | Штабел. | Кол-во мест | Вес, кг |
//   Укладка | Позиции — РЕДАКТИРУЕТСЯ ВСЁ (форма справа + кнопки
//   «+ Добавить место» / «✖ Удалить»). Тип места и Укладка — строго
//   определённые селекты; Штабел. — селект Да/Нет; позиции выбираются
//   ТОЛЬКО из грузовых позиций, не включённых в другие группы.
//
// ПРАВИЛА РАСЧЁТА (движок src/routes/helpers/tarnCalc.js):
//   листы разных типоразмеров штабелируются в ОДНУ пачку (макс. Д×Ш);
//   деревянная тара НЕ штабелируется — каждый типоразмер отдельное место
//   и отдельная строка СЗ; укладка в таре — ручной параметр позиции;
//   вес тарного места = вес ДЕТАЛЕЙ позиций (ves_zag × кол-во), как
//   считал прежний алгоритм (~6.6 т), а не вес целых листов (~7.3 т);
//   правило «>N деталей → ящик» отменено.
// Кнопки: «⚙ Авто-расчёт» (валидация + подсветка незаполненного;
//   автозапуск при пустом результате), «✓ Применить и закрыть»
//   (tarn-apply / pending для новой операции).
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { VirtualTable } from '../common/virtual-table.js';

const num = (v) => parseFloat(String(v == null ? '' : v).replace(',', '.')) || 0;
const round3 = (v) => Math.round(v * 1000) / 1000;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TIP_NAMES = { listy: 'В листах', prutki: 'В прутках', zagotovki: 'Отдельные заготовки' };
const TIP_MESTO = { listy: 'Пачки листов', prutki: 'Связки прутков', zagotovki: 'Деревянная тара' };
const UKLADKA_LABEL = { sloy: 'один слой', piramida: 'пирамидкой', stoyma: 'стоймя' };
const UKLADKA_LIST = ['', 'sloy', 'piramida', 'stoyma'];
// ✅ T64 (баг 2): константы движка связок прутков (как в tarnCalc.js):
// сечение связки пересчитывается от КОЛИЧЕСТВА прутков места
const PRUTOK_PRIPUSK_MM = 5;       // припуск на рез при резке прутка
const PRUTOK_BUNDLE_SIDE_MM = 300; // сторона сечения полной связки

export const TransportOpsTarn = {
  _host: null,          // { cargo, params, coordinator } — ставит transportOps.js
  _positions: [],       // рабочая копия позиций модалки
  _groups: [],          // группы тарных мест
  _pozSel: null,        // key выбранной позиции
  _grpSel: null,        // gid выбранной группы
  _pozVT: null,
  _grpVT: null,
  _gidSeq: 0,

  setHost(host) { this._host = host; },

  init() {
    const $ = (id) => document.getElementById(id);
    if ($('tarnAutoCalc')) $('tarnAutoCalc').onclick = () => this.autoCalc(false);
    if ($('tarnApply')) $('tarnApply').onclick = () => this.apply();
    if ($('tarnCancel')) $('tarnCancel').onclick = () => this.close();
    if ($('tarnAddManual')) $('tarnAddManual').onclick = () => this.addManualGroup();
    if ($('tarnDelGroup')) $('tarnDelGroup').onclick = () => this.deleteSelectedGroup();
    // Esc закрывает окно
    document.addEventListener('keydown', (e) => {
      const m = $('tarnModal');
      if (e.key === 'Escape' && m && !m.classList.contains('hidden')) this.close();
    });
    // ✅ T57-e: ресайз — ШТАТНЫЙ resizer.js проекта (initResizers() в
    // app-transport-ops.js связывает .resizer модалки: вертикальные тянут
    // ширину зон форм, горизонтальный — высоту «Группировки тарных мест»).
    // Здесь только обновление виртуальных таблиц модалки после перетаскивания
    // (resizer.js обновляет state.tables, таблицы модалки живут локально).
    document.addEventListener('mouseup', (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains('resizer') &&
          t.closest && t.closest('#tarnModal')) {
        if (this._pozVT) this._pozVT.refresh();
        if (this._grpVT) this._grpVT.refresh();
      }
    });
  },

  close() {
    const m = document.getElementById('tarnModal');
    if (m) m.classList.add('hidden');
  },

  // ============================================================
  // ОТКРЫТИЕ: позиции операции + сохранённые группы (если есть)
  // ============================================================
  open() {
    const modal = document.getElementById('tarnModal');
    if (!modal) return;
    const rows = state.tables.poz?.data || [];
    if (!rows.length) {
      toast('Добавьте позиции в операцию — тарные места считаются по позициям', 'warning');
      return;
    }
    const operId = this._host?.coordinator?._selectedOperId || '';
    const operRow = state.tables.transport_oper?.data?.find(o => o.id === operId);
    let saved = [];
    try { saved = JSON.parse(operRow?.tarn_mesta || '[]') || []; } catch { saved = []; }

    this._positions = rows.map((p) => this._normPoz(p));
    this._groups = saved.map(g => ({
      ...g, pozcii: Array.isArray(g.pozcii) ? [...g.pozcii] : [], __gid: 'g' + (++this._gidSeq)
    }));
    this._pozSel = null;
    this._grpSel = null;

    document.getElementById('tarnInfo').textContent =
      `${this._positions.length} поз. · ${operRow?.firma_nazvanie || ''}` +
      (operId ? '' : ' · НОВАЯ операция (сохранится при «Добавить»)');
    this._renderWarn('');
    modal.classList.remove('hidden');

    this._ensurePozTable();
    this._ensureGroupTable();
    this._refreshPozTable();
    this._refreshGroupTable();
    this._renderPozForm();
    this._renderGroupForm();
    this._renderKpi();

    // ✅ авто-расчёт запускается сам, если результат пуст
    if (!this._groups.length) this.autoCalc(true);
  },

  // Нормализация строки позиции (GET_POZ или pending-буфер)
  _normPoz(p) {
    const hasList = num(p.list_dlina) > 0 && num(p.list_shirina) > 0 && num(p.list_tolshina) > 0;
    let tip = String(p.tip_gruza || '').trim();
    if (!['listy', 'prutki', 'zagotovki'].includes(tip)) {
      tip = hasList ? 'listy' : (num(p.prutok_dlina) > 0 ? 'prutki' : 'zagotovki');
    }
    return {
      key: String(p.id || p.plan_perevozok_id || Math.random().toString(36).slice(2)),
      id: p.id || '',
      id_plana: p.id_plana || p.plan_row_id || '',
      nomer_chertezha: p.nomer_chertezha || '',
      osn_naimenovanie: p.osn_naimenovanie || '',
      kolvo_no_br: p.kolvo_no_br || 0,
      kolvo_yes_br: p.kolvo_yes_br || 0,
      dlina: p.dlina || '',
      shirina: p.shirina || '',
      vysota: p.vysota || '',
      ves_zag: p.ves_zag || '',
      tip_perevozki: p.tip_perevozki || '',
      qty: Math.round(num(p.kolvo_no_br) + num(p.kolvo_yes_br)),
      tip_gruza: tip,
      list_dlina: p.list_dlina || '',
      list_shirina: p.list_shirina || '',
      list_tolshina: p.list_tolshina || '',
      prutok_dlina: p.prutok_dlina || '',
      prutok_diametr: p.prutok_diametr || '',
      tara_dlina: p.tara_dlina || '',
      tara_shirina: p.tara_shirina || '',
      tara_vysota: p.tara_vysota || '',
      ukladka: p.ukladka || '',
      marka_materiala: p.marka_materiala || p.marka_materiala_osn || '',
      kolvo_zagotovok: p.kolvo_zagotovok || '',
      kolvo_manual: 0,      // ✅ ручное перекрытие — только явное редактирование ячейки
      _calcKolvo: null
    };
  },

  // ============================================================
  // ВИРТУАЛЬНАЯ ТАБЛИЦА ПОЗИЦИЙ (шапка по ТЗ: № позиции; Наименование;
  // Габарит Д×Ш×В, м; Колич. загот., шт; Марка; Кол. годн+брак)
  // ============================================================
  _gabaritOf(p) {
    const m = (v) => v != null && num(v) > 0 ? round3(num(v) / 1000) : null;
    if (p.tip_gruza === 'listy') {
      const d = m(p.list_dlina), w = m(p.list_shirina), t = m(p.list_tolshina);
      return (d && w && t) ? `${d}×${w}×${t}` : '—';
    }
    if (p.tip_gruza === 'prutki') {
      const l = m(p.prutok_dlina), d = m(p.prutok_diametr);
      return (l && d) ? `${l}×${d}×${d}` : '—';
    }
    const d = m(p.tara_dlina), w = m(p.tara_shirina), h = m(p.tara_vysota);
    return (d && w && h) ? `${d}×${w}×${h}` : '—';
  },

  _ensurePozTable() {
    if (this._pozVT) return;
    const box = document.getElementById('tarnPozTable');
    if (!box) return;
    this._pozVT = new VirtualTable(box, [
      { key: 'np', label: '№ поз.', width: 55 },
      { key: 'naim', label: 'Наименование', width: 250 },
      { key: 'gabarit', label: 'Габарит Д×Ш×В, м', width: 130 },
      { key: 'kolvo_zag', label: 'Колич. загот., шт', width: 105 },
      { key: 'marka', label: 'Марка', width: 110 },
      { key: 'qty', label: 'Кол. годн+брак', width: 100 }
    ], {
      idKey: 'key',
      rowHeight: 26,
      autoRefreshForm: false,
      onSelect: (row) => {
        this._pozSel = row.key;
        this._renderPozForm();
      },
      onHeaderClick: () => { this._pozSel = null; this._renderPozForm(); }
    });
  },

  _pozRowOf(p, i) {
    return {
      key: p.key,
      np: i + 1,
      naim: `${p.nomer_chertezha}${p.osn_naimenovanie ? ' — ' + p.osn_naimenovanie : ''}`,
      gabarit: this._gabaritOf(p),
      kolvo_zag: p.kolvo_manual ? String(p.kolvo_zagotovok)
        : (p._calcKolvo != null ? String(p._calcKolvo) : (String(p.kolvo_zagotovok || '') || '—')),
      marka: p.marka_materiala || '—',
      qty: p.qty
    };
  },

  _refreshPozTable() {
    if (!this._pozVT) return;
    this._pozVT.setData(this._positions.map((p, i) => this._pozRowOf(p, i)));
    if (this._pozSel) this._pozVT.selectById(this._pozSel);
  },

  // ============================================================
  // ФОРМА ПОЗИЦИИ (справа): тип груза + параметры типа + марка +
  // кол-во заготовок. Редактирование — сразу в модель.
  // ============================================================
  _renderPozForm() {
    const box = document.getElementById('tarnPozForm');
    if (!box) return;
    const p = this._positions.find(x => x.key === this._pozSel);
    if (!p) {
      box.innerHTML = '<h4>Параметры позиции</h4><p class="tarn-note">Выберите строку в таблице слева.</p>';
      return;
    }
    const tipSel = ['listy', 'prutki', 'zagotovki'].map(t =>
      `<option value="${t}" ${p.tip_gruza === t ? 'selected' : ''}>${TIP_NAMES[t]}</option>`).join('');
    let fields = '';
    if (p.tip_gruza === 'listy') {
      fields = `
        <div class="tf-row">
          <label>Лист Д, мм<input id="tfPozListD" type="number" step="any" min="0" value="${esc(p.list_dlina)}"></label>
          <label>Лист Ш, мм<input id="tfPozListW" type="number" step="any" min="0" value="${esc(p.list_shirina)}"></label>
          <label>Толщина, мм<input id="tfPozListT" type="number" step="any" min="0" value="${esc(p.list_tolshina)}"></label>
        </div>
        <p class="tarn-note">Листы разных типоразмеров штабелируются в одну пачку (макс. Д×Ш).</p>`;
    } else if (p.tip_gruza === 'prutki') {
      fields = `
        <div class="tf-row">
          <label>Пруток Д, мм<input id="tfPozPrutD" type="number" step="any" min="0" value="${esc(p.prutok_dlina)}"></label>
          <label>Ø, мм (связка)<input id="tfPozPrutDia" type="number" step="any" min="0" value="${esc(p.prutok_diametr)}"></label>
        </div>
        <p class="tarn-note">Сечение связки считается по Ø прутка; штабелируются.</p>`;
    } else {
      const ukl = ['sloy', 'piramida', 'stoyma'].map(u =>
        `<option value="${u}" ${p.ukladka === u ? 'selected' : ''}>${UKLADKA_LABEL[u]}</option>`).join('');
      fields = `
        <div class="tf-row">
          <label>Тара Д, мм<input id="tfPozTaraD" type="number" step="any" min="0" value="${esc(p.tara_dlina)}"></label>
          <label>Ш, мм<input id="tfPozTaraW" type="number" step="any" min="0" value="${esc(p.tara_shirina)}"></label>
          <label>В, мм<input id="tfPozTaraH" type="number" step="any" min="0" value="${esc(p.tara_vysota)}"></label>
        </div>
        <label>Укладка в таре (ручной параметр)<select id="tfPozUkl">
          <option value="" ${!p.ukladka ? 'selected' : ''}>— не задана —</option>${ukl}
        </select></label>
        <p class="tarn-note">Каждый типоразмер тары — отдельное тарное место и строка в СЗ (не штабелируется).</p>`;
    }
    box.innerHTML = `
      <h4>Позиция ${esc(p.nomer_chertezha) || '—'}</h4>
      <label>Тип груза<select id="tfPozTip">${tipSel}</select></label>
      ${fields}
      <div class="tf-row">
        <label>Марка<input id="tfPozMarka" type="text" value="${esc(p.marka_materiala)}" placeholder="оснастка"></label>
        <label>Кол-во загот., шт<input id="tfPozKolvo" type="number" step="any" min="0" value="${esc(p.kolvo_manual ? p.kolvo_zagotovok : '')}" placeholder="авто"></label>
      </div>
      <p class="tarn-note">«Кол-во загот., шт» — ручное перекрытие расчёта (листов/прутков позиции). Пусто = авто-расчёт.</p>
      <div id="tfPozErr" style="color:#c62828; font-size:11.5px;"></div>`;
    const $id = (id) => document.getElementById(id);
    // тип груза -> перерисовать форму + таблицу
    $id('tfPozTip').addEventListener('change', (e) => {
      p.tip_gruza = e.target.value;
      this._refreshPozTable();
      this._renderPozForm();
      this._validateForm();
    });
    const bindNum = (id, field) => {
      const el = $id(id);
      if (!el) return;
      el.addEventListener('input', () => {
        p[field] = el.value;
        el.classList.remove('tf-invalid');
        this._refreshPozTable();
      });
    };
    bindNum('tfPozListD', 'list_dlina'); bindNum('tfPozListW', 'list_shirina'); bindNum('tfPozListT', 'list_tolshina');
    bindNum('tfPozPrutD', 'prutok_dlina'); bindNum('tfPozPrutDia', 'prutok_diametr');
    bindNum('tfPozTaraD', 'tara_dlina'); bindNum('tfPozTaraW', 'tara_shirina'); bindNum('tfPozTaraH', 'tara_vysota');
    const uklEl = $id('tfPozUkl');
    if (uklEl) uklEl.addEventListener('change', (e) => { p.ukladka = e.target.value; uklEl.classList.remove('tf-invalid'); });
    const mk = $id('tfPozMarka');
    if (mk) mk.addEventListener('input', () => { p.marka_materiala = mk.value; this._refreshPozTable(); });
    const kv = $id('tfPozKolvo');
    if (kv) kv.addEventListener('input', () => {
      p.kolvo_zagotovok = kv.value;
      // ✅ ручное перекрытие — только явный ввод (повторный авто-расчёт
      // записанные значения не «заминает» — баг «47 листов»).
      // Очистка поля возвращает последнее АВТО-значение (_lastAuto).
      if (String(kv.value).trim() !== '') {
        p.kolvo_manual = 1;
        p._calcKolvo = null;
      } else {
        p.kolvo_manual = 0;
        p._calcKolvo = (p._lastAuto != null ? p._lastAuto : null);
      }
      this._refreshPozTable();
    });
    this._validateForm();
  },

  _requiredFields(p) {
    if (p.tip_gruza === 'listy') return [['list_dlina', 'tfPozListD'], ['list_shirina', 'tfPozListW'], ['list_tolshina', 'tfPozListT']];
    if (p.tip_gruza === 'prutki') return [['prutok_dlina', 'tfPozPrutD'], ['prutok_diametr', 'tfPozPrutDia']];
    return [['tara_dlina', 'tfPozTaraD'], ['tara_shirina', 'tfPozTaraW'], ['tara_vysota', 'tfPozTaraH'], ['ukladka', 'tfPozUkl']];
  },

  // Подсветка незаполненных полей формы выбранной позиции
  _validateForm() {
    const p = this._positions.find(x => x.key === this._pozSel);
    const errBox = document.getElementById('tfPozErr');
    if (!p) return;
    const missing = this._requiredFields(p).filter(([f]) => !(num(p[f]) > 0 || (f === 'ukladka' && p.ukladka)));
    this._requiredFields(p).forEach(([f, id]) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('tf-invalid', missing.some(([mf]) => mf === f));
    });
    if (errBox) {
      errBox.textContent = missing.length
        ? `Не задано: ${missing.map(([f]) => f).join(', ')}` + (p.qty <= 0 ? ' · кол-во годн+брак = 0' : '')
        : (p.qty <= 0 ? 'Кол-во годн+брак = 0 — позиция не попадёт в расчёт' : '');
    }
  },

  // ============================================================
  // АВТО-РАСЧЁТ: POST /api/transport-oper/calc-tara (движок tarnCalc)
  // strict=false (автозапуск при открытии) — считает позиции с полными
  // параметрами; strict=true (кнопка) — требует ВСЕ параметры, без расчёта.
  // ============================================================
  autoCalc(silent) {
    const positions = this._positions;
    const missing = [];
    positions.forEach((p) => {
      this._requiredFields(p).forEach(([f]) => {
        if (!(num(p[f]) > 0 || (f === 'ukladka' && p.ukladka))) missing.push(p.key + ':' + f);
      });
    });
    const ready = positions.filter(p =>
      !missing.some(m => m.startsWith(p.key + ':')) && p.qty > 0);
    if (!ready.length) {
      const msg = 'Нет позиций с полными параметрами — задайте тип груза и параметры в форме справа';
      this._renderWarn(msg);
      if (!silent) toast(msg, 'warning');
      return;
    }
    if (missing.length) {
      const msg = `Не заданы параметры у ${new Set(missing.map(m => m.split(':')[0])).size} поз. — расчёт только по заполненным` +
        (silent ? '' : '. Остальные подсвечены в форме');
      this._renderWarn(msg);
      if (!silent) toast(msg, 'warning');
    }
    // сброс предыдущего авто-расчёта (ручные значения не трогаем)
    positions.forEach(p => { if (!p.kolvo_manual) p._calcKolvo = null; });

    return api('POST', '/api/transport-oper/calc-tara', { positions: ready }).then(r => {
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      (r.pozResults || []).forEach(pr => {
        const p = this._positions.find(x => x.key === pr.key);
        if (p && !p.kolvo_manual) { p._calcKolvo = pr.kolvo_zagotovok; p._lastAuto = pr.kolvo_zagotovok; }
      });
      // сохраняем привязку позиций к группам из авто-расчёта
      this._groups = (r.groups || []).map(g => ({
        ...g, pozcii: Array.isArray(g.pozcii) ? [...g.pozcii] : [], __gid: 'g' + (++this._gidSeq)
      }));
      this._grpSel = null;
      this._refreshPozTable();
      this._refreshGroupTable();
      this._renderGroupForm();
      this._renderKpi();
      const warns = [
        ...(r.warnings || []),
        ...(r.errors || []).map(e => `${e.message} (позиция не рассчитана)`)
      ];
      this._renderWarn(warns.join('\n'));
      if (r.summary) toast(r.summary);
    }).catch(e => toast('Ошибка: ' + e.message, 'error'));
  },

  // ============================================================
  // ВИРТУАЛЬНАЯ ТАБЛИЦА ГРУПП (Тип места | Габарит | Штабел. | Кол-во |
  // Вес | Укладка | Позиции) — редактируется ВСЁ (форма + кнопки)
  // ============================================================
  _ensureGroupTable() {
    if (this._grpVT) return;
    const box = document.getElementById('tarnGroupsTable');
    if (!box) return;
    this._grpVT = new VirtualTable(box, [
      { key: 'name', label: 'Тип места', width: 175 },
      { key: 'dims', label: 'Габарит Д×Ш×В, м', width: 120 },
      { key: 'shtabil', label: 'Штабел.', width: 65 },
      { key: 'kolvo', label: 'Кол-во мест', width: 80 },
      { key: 'ves_kg', label: 'Вес, кг', width: 90 },
      { key: 'ukladka', label: 'Укладка', width: 95 },
      { key: 'pozcii', label: 'Позиции', width: 190 }
    ], {
      idKey: 'gid',
      rowHeight: 26,
      autoRefreshForm: false,
      onSelect: (row) => {
        this._grpSel = row.gid;
        this._renderGroupForm();
      },
      onHeaderClick: () => { this._grpSel = null; this._renderGroupForm(); }
    });
  },

  _groupRowOf(g) {
    const pozNames = (g.pozcii || []).map(k => {
      const p = this._positions.find(x => x.key === k);
      return p ? p.nomer_chertezha : k;
    }).filter(Boolean).join(', ');
    const ukl = String(g.ukladka || '');
    return {
      gid: g.__gid,
      name: g.name || TIP_MESTO[g.tip] || '—',
      dims: `${g.dlina_m || '—'}×${g.shirina_m || '—'}×${g.vysota_m || '—'}`,
      shtabil: g.shtabil || '',
      kolvo: g.kolvo != null ? g.kolvo : '',
      ves_kg: g.ves_kg != null ? g.ves_kg : '',
      ukladka: ukl ? (UKLADKA_LABEL[ukl.split(',')[0].trim()] || ukl) : '',
      pozcii: pozNames || '— вручную —'
    };
  },

  _refreshGroupTable() {
    if (!this._grpVT) return;
    this._grpVT.setData(this._groups.map(g => this._groupRowOf(g)));
    if (this._grpSel) this._grpVT.selectById(this._grpSel);
    this._renderKpi();
  },

  // Пул позиций для выбора: грузовые позиции, НЕ включённые в другие группы
  _poolPositions(g) {
    const assigned = new Set();
    this._groups.forEach(o => {
      if (o === g) return;
      (o.pozcii || []).forEach(k => assigned.add(k));
    });
    return this._positions.filter(p => !assigned.has(p.key));
  },

  // ============================================================
  // ФОРМА ГРУППЫ (справа): ВСЕ поля редактируемые
  // ============================================================
  _renderGroupForm() {
    const box = document.getElementById('tarnGroupForm');
    if (!box) return;
    const g = this._groups.find(x => x.__gid === this._grpSel);
    if (!g) {
      box.innerHTML = '<h4>Параметры тарного места</h4><p class="tarn-note">Выберите строку в таблице или нажмите «+ Добавить место».</p>';
      return;
    }
    const tips = Object.keys(TIP_MESTO);
    const customName = g.name && !tips.some(t => TIP_MESTO[t] === g.name);
    const tipSel = tips.map(t =>
      `<option value="${t}" ${g.tip === t && !customName ? 'selected' : ''}>${TIP_MESTO[t]}</option>`).join('');
    const uklSel = UKLADKA_LIST.map(u =>
      `<option value="${u}" ${(g.ukladka || '') === u ? 'selected' : ''}>${u ? UKLADKA_LABEL[u] : '— не задана —'}</option>`).join('');
    // чек-лист позиций: пул (не включённые в другие группы) + свои (отмечены)
    const inGroup = new Set(g.pozcii || []);
    const pool = this._poolPositions(g);
    const pozItems = pool.map(p => `
      <label><input type="checkbox" data-key="${esc(p.key)}" ${inGroup.has(p.key) ? 'checked' : ''}>
        ${esc(p.nomer_chertezha)} <span style="color:#889">(${esc(p.osn_naimenovanie).slice(0, 28)})</span></label>`).join('');
    box.innerHTML = `
      <h4>Тарное место</h4>
      <label>Тип места<select id="tfGrpTip">${tipSel}${customName ? `<option value="__custom" selected>${esc(g.name)}</option>` : ''}</select></label>
      <div class="tf-row">
        <label>Длина, м<input id="tfGrpD" type="number" step="any" min="0" value="${esc(g.dlina_m)}"></label>
        <label>Ширина, м<input id="tfGrpW" type="number" step="any" min="0" value="${esc(g.shirina_m)}"></label>
        <label>Высота, м<input id="tfGrpH" type="number" step="any" min="0" value="${esc(g.vysota_m)}"></label>
      </div>
      <div class="tf-row">
        <label>Штабелируемость<select id="tfGrpSht">
          <option value="да" ${g.shtabil === 'да' ? 'selected' : ''}>да</option>
          <option value="нет" ${g.shtabil !== 'да' ? 'selected' : ''}>нет</option>
        </select></label>
        <label>Укладка<select id="tfGrpUkl">${uklSel}</select></label>
      </div>
      <div class="tf-row">
        <label>Кол-во мест<input id="tfGrpKolvo" type="number" step="1" min="0" value="${esc(g.kolvo)}"></label>
        <label>Вес, кг<input id="tfGrpVes" type="number" step="0.01" min="0" value="${esc(g.ves_kg)}"></label>
      </div>
      <label>Позиции (только не включённые в другие места):
        <div class="tarn-pozlist" id="tfGrpPozList">${pozItems || '<span style="color:#889">— все позиции уже распределены —</span>'}</div>
      </label>
      <p class="tarn-note">Вес тарного места авто-расчёта — вес ДЕТАЛЕЙ позиций; можно править вручную.</p>`;
    const $id = (id) => document.getElementById(id);
    $id('tfGrpTip').addEventListener('change', (e) => {
      if (e.target.value === '__custom') return;
      g.tip = e.target.value;
      g.name = TIP_MESTO[g.tip];
      // ✅ T58: при смене типа места штабелируемость — по правилу движка
      // (пачки листов/связки прутков — «да», деревянная тара — «нет»);
      // пользователь может переопределить селектом «Штабелируемость» ниже
      g.shtabil = (g.tip === 'zagotovki') ? 'нет' : 'да';
      this._refreshGroupTable();
      this._renderGroupForm();
    });
    const bind = (id, field, numeric) => {
      const el = $id(id);
      if (!el) return;
      el.addEventListener('input', () => {
        g[field] = numeric ? (el.value === '' ? '' : num(el.value)) : el.value;
        this._refreshGroupTable();
      });
    };
    // габарит: три отдельных поля (сохраняем число/строку как в группах движка)
    ['tfGrpD', 'tfGrpW', 'tfGrpH'].forEach((id, i) => {
      const el = $id(id);
      if (!el) return;
      el.addEventListener('input', () => {
        const v = el.value === '' ? '' : num(el.value);
        if (i === 0) g.dlina_m = v; else if (i === 1) g.shirina_m = v; else g.vysota_m = v;
        this._refreshGroupTable();
      });
    });
    bind('tfGrpKolvo', 'kolvo', true);
    bind('tfGrpVes', 'ves_kg', true);
    $id('tfGrpUkl').addEventListener('change', (e) => { g.ukladka = e.target.value; this._refreshGroupTable(); });
    // ✅ T58 БАГФИКС: селект «Штабелируемость» НЕ был привязан к g.shtabil —
    // в ручном режиме выбор «да/нет» никак не сохранялся (баг пользователя).
    // Теперь изменение селекта записывает признак в группу и обновляет таблицу.
    const shtSel = $id('tfGrpSht');
    if (shtSel) shtSel.addEventListener('change', (e) => {
      g.shtabil = e.target.value === 'да' ? 'да' : 'нет';
      this._refreshGroupTable();
    });
    const pozList = $id('tfGrpPozList');
    if (pozList) pozList.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      const key = cb.dataset.key;
      if (cb.checked) {
        if (!(g.pozcii || []).includes(key)) g.pozcii = [...(g.pozcii || []), key];
      } else {
        g.pozcii = (g.pozcii || []).filter(k => k !== key);
      }
      // ✅ T57-e: пересчёт веса и МАКС габаритов места при изменении состава
      // (и при добавлении, и при удалении позиции)
      this._recalcGroupAgg(g);
      const upd = (id, val) => { const el = $id(id); if (el) el.value = val; };
      upd('tfGrpD', g.dlina_m); upd('tfGrpW', g.shirina_m); upd('tfGrpH', g.vysota_m);
      upd('tfGrpVes', g.ves_kg);
      this._refreshGroupTable();
      // пул у других групп не менялся, но у текущей — да; форма актуальна
    });
  },

  addManualGroup() {
    const g = {
      tip: 'zagotovki', name: TIP_MESTO.zagotovki,
      dlina_m: '', shirina_m: '', vysota_m: '',
      shtabil: 'нет', kolvo: 1, ves_kg: '', ukladka: '', pozcii: [],
      __gid: 'g' + (++this._gidSeq)
    };
    this._groups.push(g);
    this._grpSel = g.__gid;
    this._refreshGroupTable();
    this._renderGroupForm();
    toast('Тарное место добавлено — заполните параметры в форме справа');
  },

  deleteSelectedGroup() {
    const i = this._groups.findIndex(x => x.__gid === this._grpSel);
    if (i < 0) { toast('Выберите тарное место в таблице', 'warning'); return; }
    this._groups.splice(i, 1);
    this._grpSel = null;
    this._refreshGroupTable();
    this._renderGroupForm();
  },

  // ============================================================
  // ✅ T57-e: ПЕРЕСЧЁТ ТАРНОГО МЕСТА ПО СОСТАВУ ПОЗИЦИЙ.
  // Вес = Σ (вес детали × кол-во годн+брак) по позициям места
  // (вес детали: ves_zag, иначе габарит × плотность стали).
  // Габарит = МАКС по позициям: лист — Д×Ш листа; пруток — длина × сечение связки
  // отдельные заготовки — габарит тары, иначе габарит детали. Пустые
  // измерения позиции место не обнуляют (высоту пачки листов задаёт
  // пользователь/авто-расчёт).
  // ============================================================
  _partWeightOf(p) {
    const vz = num(p.ves_zag);
    if (vz > 0) return vz;
    const DL = num(p.dlina), DW = num(p.shirina);
    let TH = num(p.vysota);
    if (!(TH > 0)) TH = num(p.list_tolshina);
    if (DL > 0 && DW > 0 && TH > 0) return DL * DW * TH * 7.85e-6;
    const DIA = num(p.prutok_diametr);
    if (DIA > 0) {
      const L = num(p.dlina) || num(p.prutok_dlina);
      if (L > 0) return Math.PI * (DIA / 2) * (DIA / 2) * L * 7.85e-6;
    }
    return 0;
  },

  // ✅ T57-e-2: габариты позиции в месте — по ТИПУ МЕСТА (gtip): листовые
  // позиции в «Деревянной таре» вносят габарит ДЕТАЛИ, а не листа.
  _pozPlaceDims(p, gtip) {
    const m = (v) => (num(v) > 0 ? num(v) / 1000 : 0);
    const tip = String(gtip || p.tip_gruza || '').trim();
    if (tip === 'listy') return { l: m(p.list_dlina), w: m(p.list_shirina), h: 0 };
    if (tip === 'prutki') {
      // ✅ T64 (баг 2): сечение связки — от КОЛИЧЕСТВА ПРУТКОВ позиции
      // (как в движке авто-расчёта): сторона квадрата ceil(sqrt(N)) × Ø,
      // но не более 300 мм; раньше здесь был Ø одиночного прутка —
      // ширина/высота места не менялись от количества прутков
      const dia = num(p.prutok_diametr);
      const side = dia > 0
        ? Math.min(PRUTOK_BUNDLE_SIDE_MM, Math.ceil(Math.sqrt(Math.max(this._rodsOf(p), 1))) * dia)
        : 0;
      return { l: m(p.prutok_dlina), w: side / 1000, h: side / 1000 };
    }
    const tl = m(p.tara_dlina), tw = m(p.tara_shirina), th = m(p.tara_vysota);
    if (tl > 0 && tw > 0 && th > 0) return { l: tl, w: tw, h: th };
    return { l: m(p.dlina), w: m(p.shirina), h: m(p.vysota) };
  },

  // ✅ T64 (баг 2): количество ПРУТКОВ позиции (как в движке):
  // «Кол-во заготовок» прутковой позиции = прутки (ручное > авто);
  // пусто — авто-расчёт ceil(кол-во деталей / штук в прутке)
  _rodsOf(p) {
    let bars = 0;
    if (p.kolvo_manual) bars = num(p.kolvo_zagotovok);
    else if (p._calcKolvo != null) bars = num(p._calcKolvo);
    else bars = num(p.kolvo_zagotovok);
    if (bars > 0) return Math.round(bars);
    const BL = num(p.prutok_dlina), DL = num(p.dlina);
    if (BL > 0 && DL > 0) {
      const perBar = Math.floor(BL / (DL + PRUTOK_PRIPUSK_MM));
      if (perBar > 0) return Math.ceil((p.qty || 0) / perBar);
    }
    return Math.max(1, p.qty || 0);   // крайний случай: 1 деталь = 1 пруток
  },

  _recalcGroupAgg(g) {
    const pozs = (g.pozcii || [])
      .map(k => this._positions.find(x => x.key === k)).filter(Boolean);
    if (!pozs.length) return;
    let ves = 0, L = 0, W = 0, H = 0;
    pozs.forEach((p) => {
      ves += this._partWeightOf(p) * (p.qty || 0);
      const d = this._pozPlaceDims(p, g.tip);
      L = Math.max(L, d.l); W = Math.max(W, d.w); H = Math.max(H, d.h);
    });
    g.ves_kg = Math.round(ves * 100) / 100;
    if (L > 0) g.dlina_m = Math.round(L * 1000) / 1000;
    if (W > 0) g.shirina_m = Math.round(W * 1000) / 1000;
    if (H > 0) g.vysota_m = Math.round(H * 1000) / 1000;
  },

  _renderKpi() {
    const el = document.getElementById('tarnKpi');
    if (!el) return;
    const mest = this._groups.reduce((s, g) => s + (num(g.kolvo) || 0), 0);
    const ves = this._groups.reduce((s, g) => s + (num(g.ves_kg) || 0), 0);
    el.textContent = this._groups.length
      ? `Итого: ${Math.round(mest)} мест · ${Math.round(ves * 100) / 100} кг · ${this._groups.length} типа(ов)`
      : 'Итого: —';
  },

  _renderWarn(text) {
    const el = document.getElementById('tarnWarn');
    if (el) el.textContent = text || '';
  },

  // ============================================================
  // ПРИМЕНИТЬ И ЗАКРЫТЬ:
  //  - группы -> tarn_mesta операции (JSON) + производные поля;
  //  - кол-во заготовок (авто-расчёт листов/прутков) -> позиции
  //    (gryz_poz.kolvo_zagotovok) и в «Заготовки» таблицы позиций;
  //  - наименование груза (скрытое поле) сохраняется как есть.
  // ============================================================
  async apply() {
    // проверки: группы без типа/количества — блокируем
    const bad = this._groups.filter(g => !String(g.name || '').trim() || num(g.kolvo) <= 0);
    if (bad.length) {
      toast('У тарных мест должны быть тип места и количество мест', 'warning');
      return;
    }
    const operId = this._host?.coordinator?._selectedOperId || '';
    const positions = this._positions.map(p => ({
      id: p.id, id_plana: p.id_plana,
      tip_gruza: p.tip_gruza,
      list_dlina: p.list_dlina, list_shirina: p.list_shirina, list_tolshina: p.list_tolshina,
      prutok_dlina: p.prutok_dlina, prutok_diametr: p.prutok_diametr,
      tara_dlina: p.tara_dlina, tara_shirina: p.tara_shirina, tara_vysota: p.tara_vysota,
      ukladka: p.ukladka,
      marka_materiala: p.marka_materiala,
      kolvo_zagotovok: p.kolvo_manual ? String(p.kolvo_zagotovok || '')
        : (p._calcKolvo != null ? String(p._calcKolvo) : String(p.kolvo_zagotovok || ''))
    }));
    const tarnJson = this._groups.map(g => {
      const { __gid, ...rest } = g;
      return rest;
    });
    // наименование груза — скрытое поле (на вкладке поля больше нет)
    const gn = document.getElementById('toGruzName');
    const gruzName = gn ? gn.value : '';

    if (operId) {
      const r = await api('POST', '/api/transport-oper/tarn-apply', {
        id_transporta: operId, tarn_mesta: tarnJson, gruz_name: gruzName, positions
      });
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
    } else {
      // НОВАЯ операция: в pending-буфер (уйдёт с POST /api/transport-oper)
      this._positions.forEach(p => {
        const row = state.tables.poz.data.find(x => String(x.id || x.plan_perevozok_id) === p.key);
        if (!row) return;
        row.tip_gruza = p.tip_gruza;
        row.prutok_diametr = p.prutok_diametr;
        row.tara_dlina = p.tara_dlina; row.tara_shirina = p.tara_shirina; row.tara_vysota = p.tara_vysota;
        row.ukladka = p.ukladka;
        if (p.kolvo_manual || p._calcKolvo != null) {
          row.kolvo_zagotovok = p.kolvo_manual ? String(p.kolvo_zagotovok || '') : String(p._calcKolvo);
        }
        row.marka_materiala = p.marka_materiala;
      });
      this._host?.cargo?.setPendingTarnMesta(tarnJson);
    }

    // локальный отклик UI
    if (this._host?.params) {
      this._host.params._currentTarnMesta = JSON.stringify(tarnJson);
      this._host.params.renderTarnTable(JSON.stringify(tarnJson));
    }
    // обновить таблицу позиций (кол-во заготовок, тип груза)
    this._positions.forEach(p => {
      const row = state.tables.poz.data.find(x => String(x.id || x.plan_perevozok_id) === p.key);
      if (!row) return;
      row.tip_gruza = p.tip_gruza;
      if (p.kolvo_manual) row.kolvo_zagotovok = String(p.kolvo_zagotovok || '');
      else if (p._calcKolvo != null) row.kolvo_zagotovok = String(p._calcKolvo);
    });
    state.tables.poz.render?.();
    this.close();
    toast(operId ? 'Тарные места применены' : 'Тарные места будут сохранены с операцией', 'success');
  }
};
