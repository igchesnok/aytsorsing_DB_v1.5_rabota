// ============================================================
// МОДУЛЬ: ПРОТОКОЛ СОВЕЩАНИЙ (фирма-поставщик / ПТО)
// Совещание с исполнителем: перечень доставленных партий,
// по клику — карточка текущего шага с операциями: плановые и
// фактические даты, комментарий (fakt_marshruta.kommentariy),
// выполненные операции зеленеют; закрытие факта последней
// операции = партия готова к отправке. Здесь же — добавление
// операций в уже начатый шаг (с защитой целостности на сервере).
// v2: частичное (накопительное) выполнение — колонка «Выполнено, шт.»
// (fakt_marshruta.kolvo_vypolneno); клиент не пропустит факт-дату из
// будущего и количество больше объёма партии; в карточке видно, сколько
// шт. партии готово к отправке по шагу.
// v2.1: счётчик «в работе» — показывается при наличии партий в работе.
// v3: ГОТОВНОСТЬ ПО КОЛИЧЕСТВУ — шаг закрывается фактом последней
// операции ТОЛЬКО при полном выполненном количестве (50 из 100 — партия
// ещё «В работе»); ПРЕДЗАПОЛНЕНИЕ ДАТ: план/факт начала по умолчанию =
// дата получения партии из транспортной операции, план-окончание
// операции автоматически становится план- и факт-началом следующей
// операции; комментарий — textarea с переносом и вертикальной прокруткой.
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
import { VirtualTable } from '../common/virtual-table.js';

export const Meeting = {
  _positions: [],
  _batch: null,       // карточка текущей партии
  _ops: [],           // операции текущей партии (строки формы)
  _dirty: new Set(),  // индексы изменённых строк формы
  _mode: 'firm',
  selectedGpId: null,

  // ------------------------------------------------------------
  async init() {
    const cols = [
      { key: 'nomer_chertezha',   label: '№ чертежа',    width: '110px' },
      { key: 'osn_naimenovanie',  label: 'Наименование', width: '170px' },
      { key: 'firma_name',        label: 'Фирма',        width: '110px' },
      { key: 'nom_shag',          label: 'Шаг',          width: '50px' },
      { key: 'tip_perevozki',     label: 'Тип перевозки', width: '140px' },
      { key: 'nomer_reisa',       label: 'Рейс',         width: '90px' },
      { key: 'pribytie_data',     label: 'Прибытие',     width: '90px' },
      { key: 'qty',               label: 'Кол-во',       width: '60px' },
      { key: 'progress',          label: 'Операции',     width: '75px' },
      { key: 'status',            label: 'Статус',       width: '135px' }
    ];

    state.tables.meeting = new VirtualTable(
      document.getElementById('mtTable'), cols,
      { idKey: 'gp_id', onSelect: r => Meeting.onSelect(r) }
    );

    document.getElementById('btnMtReload').onclick = () => Meeting.loadAll();

    document.querySelectorAll('input[name="mtMode"]').forEach(radio => {
      radio.addEventListener('change', async e => {
        Meeting._mode = e.target.value;
        document.getElementById('mtFirmaFieldset').style.display =
          Meeting._mode === 'firm' ? '' : 'none';
        Meeting.clearForm();
        await Meeting.loadFirms();
        await Meeting.loadPositions();
      });
    });

    document.getElementById('mtFirma').addEventListener('change', async () => {
      Meeting.clearForm();
      await Meeting.loadPositions();
    });

    document.getElementById('mtStatus').addEventListener('change', async () => {
      Meeting.clearForm();
      await Meeting.loadPositions();
    });

    document.getElementById('btnMtSave').onclick = () => Meeting.save();
    document.getElementById('btnMtAddOp').onclick = () => Meeting.addOp();
  },

  // ------------------------------------------------------------
  async loadAll() {
    await Promise.all([Meeting.loadFirms(), Meeting.loadPositions()]);
    if (Meeting.selectedGpId) {
      const still = Meeting._positions.find(p => p.gp_id === Meeting.selectedGpId);
      if (!still) Meeting.clearForm();
    }
  },

  // ------------------------------------------------------------
  async loadFirms() {
    const sel = document.getElementById('mtFirma');
    const hint = document.getElementById('mtFirmaHint');
    if (Meeting._mode !== 'firm') { sel.innerHTML = ''; hint.textContent = ''; return; }

    const firms = await api('GET', '/api/meeting/firms');
    if (firms.error) { toast('Ошибка загрузки фирм: ' + firms.error, 'error'); return; }

    const prev = sel.value;
    sel.innerHTML = '<option value="">— Выберите фирму —</option>';
    firms.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id_firmy;
      const cnt = f.cnt_v_rabote || 0;
      // v3: «в работе: 0» не показываем — частично выполненные партии
      // остаются «В работе», так что ноль значит только «все готовы»
      opt.textContent = cnt > 0
        ? `${f.naimenovanie} — в работе: ${cnt}`
        : f.naimenovanie;
      opt.dataset.cnt = cnt;
      sel.appendChild(opt);
    });
    if (prev && firms.some(f => f.id_firmy === prev)) sel.value = prev;

    hint.textContent = 'Число — партии в работе у фирмы (доставлены, шаг не закрыт фактом)';
  },

  // ------------------------------------------------------------
  async loadPositions() {
    const params = new URLSearchParams({ mode: Meeting._mode });
    if (Meeting._mode === 'firm') {
      const idFirma = document.getElementById('mtFirma').value;
      if (!idFirma) {
        Meeting._positions = [];
        state.tables.meeting.setData([]);
        Meeting.updateCount();
        return;
      }
      params.set('id_firma', idFirma);
    }
    const st = document.getElementById('mtStatus').value;
    if (st) params.set('status', st);

    const data = await api('GET', `/api/meeting/positions?${params.toString()}`);
    if (data.error) { toast('Ошибка: ' + data.error, 'error'); return; }

    // прогресс операций для списка
    data.forEach(r => {
      r.progress = `${r.closed_cnt}/${r.ops_total}`;
    });

    Meeting._positions = data;
    state.tables.meeting.setData(data);
    Meeting.updateCount();
  },

  updateCount() {
    const work = Meeting._positions.filter(p => p.status === 'В работе').length;
    const ready = Meeting._positions.filter(p => p.status === 'Готова к отправке').length;
    document.getElementById('mtCount').textContent =
      `всего: ${Meeting._positions.length} · в работе: ${work} · готовы к отправке: ${ready}`;
  },

  // ------------------------------------------------------------
  async onSelect(row) {
    Meeting.selectedGpId = row.gp_id;

    const r = await api('GET', `/api/meeting/batch?id_gryz_poz=${encodeURIComponent(row.gp_id)}`);
    if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }

    Meeting._batch = r.batch;
    Meeting._ops = r.ops || [];
    Meeting._dirty = new Set();
    Meeting.renderForm(r.sled_reys_count || 0);
  },

  // ------------------------------------------------------------
  renderForm(sledReys) {
    const b = Meeting._batch;
    document.getElementById('mtFormEmpty').style.display = 'none';
    document.getElementById('mtFormBody').style.display = '';

    const statusCls = b.status === 'Готова к отправке' ? 'ready' : 'work';
    document.getElementById('mtFormTitle').textContent =
      `Партия: ${b.nomer_chertezha || '—'} · шаг №${b.nom_shag} (${b.exec_shag}) · рейс «${b.nomer_reisa || '—'}»`;

    const f = (label, val) => `<div><b>${label}:</b> ${val || '—'}</div>`;
    document.getElementById('mtInfo').innerHTML = [
      f('№ чертежа', b.nomer_chertezha) + f('Наименование', b.osn_naimenovanie),
      f('Фирма (КП)', b.firma_name) + f('Договор', b.nom_dogovor),
      f('Шаг', `№${b.nom_shag} · исполнитель: ${b.exec_shag}`) +
        f('Тип перевозки', `${b.tip_perevozki} (${b.napravlenie})`),
      f('Рейс', b.nomer_reisa) +
        f('Прибытие', b.pribytie_data),
      f('Кол-во в партии', `${b.qty} шт. (годные ${b.kolvo_no_br} / брак ${b.kolvo_yes_br})`) +
        f('Позиция плана', `план на год: ${b.plan_god_kolvo ?? '—'} шт.`),
      f('Операции шага', `закрыто ${b.closed_cnt} из ${b.ops_total}`) +
        f('Готово к отправке', `${b.done_qty || 0} из ${b.qty} шт.` +
          (b.status !== 'Готова к отправке' && (b.last_done || 0) > 0
            ? ` · выполнено по последней операции: ${b.last_done} шт. (шаг не закрыт — доделать)`
            : '') +
          ` — <span class="mt-status-badge ${statusCls}">${b.status}</span>`)
    ].join('');

    // предупреждения
    const warns = [];
    if (b.legacy) {
      warns.push('Партия в легаси-режиме: строки факта по операциям ещё не заведены. ' +
        'При первом сохранении будут созданы строки факта по ВСЕМ операциям шага, и ' +
        'готовность партии станет определяться закрытием факта последней операции ' +
        '(как у всех партий, загруженных в рейсы после обновления v8).');
    }
    if (sledReys > 0) {
      warns.push('Внимание: по следующим шагам этой позиции уже сформированы рейсы с партиями — ' +
        'возможно, часть количества уже уехала дальше.');
    }
    const warnBox = document.getElementById('mtLegacyWarn');
    warnBox.style.display = warns.length ? '' : 'none';
    warnBox.innerHTML = warns.map(w => '⚠ ' + w).join('<br>');

    Meeting.renderOps();
  },

  // ------------------------------------------------------------
  renderOps() {
    const tbody = document.getElementById('mtOpsBody');
    tbody.innerHTML = '';
    Meeting._ops.forEach((op, i) => {
      const isLast = i === Meeting._ops.length - 1;
      const tr = document.createElement('tr');
      tr.className = [
        op.data_fakt_end ? 'op-done' : (op.data_fakt_start ? 'op-inwork' : ''),
        isLast ? 'op-last' : '',
        op.fm_id ? '' : 'op-legacy'
      ].filter(Boolean).join(' ');

      const stText = op.data_fakt_end ? 'выполнена'
        : (op.data_fakt_start ? 'в работе' : 'ожидание');

      // v3 ПРЕДЗАПОЛНЕНИЕ ДАТ (минимум ручного ввода):
      // план/факт начала по умолчанию = дата получения партии из
      // транспортной операции; если у ПРЕДЫДУЩЕЙ операции заполнено
      // план-окончание — оно является план- и факт-началом следующей.
      // План/факт ОКОНЧАНИЯ всегда вводит пользователь.
      const prev = i > 0 ? Meeting._ops[i - 1] : null;
      const defStart = (prev && prev.data_plan_end) ||
        (Meeting._batch ? Meeting._batch.pribytie_data : '') || '';
      const planStart = op.data_plan_start || defStart;
      const faktStart = op.data_fakt_start || defStart;

      tr.innerHTML = `
        <td class="op-num">${i + 1}</td>
        <td class="op-name">${escapeHtml(op.naim_oper)}</td>
        <td><input type="date" data-i="${i}" data-f="data_plan_start" value="${attr(planStart)}"></td>
        <td><input type="date" data-i="${i}" data-f="data_plan_end"   value="${attr(op.data_plan_end)}"></td>
        <td><input type="date" data-i="${i}" data-f="data_fakt_start" value="${attr(faktStart)}"></td>
        <td><input type="date" data-i="${i}" data-f="data_fakt_end"   value="${attr(op.data_fakt_end)}"></td>
        <td><input type="number" min="1" step="1" data-i="${i}" data-f="kolvo_vypolneno"
                   value="${attr(op.kolvo_vypolneno ?? '')}"
                   placeholder="${Meeting._batch ? Meeting._batch.qty : '—'}"
                   title="Выполнено, шт. Пусто = всё количество (${Meeting._batch ? Meeting._batch.qty : '—'}). Шаг закрывается при полном количестве"></td>
        <td class="op-status">${stText}</td>
        <td class="op-komm"><textarea data-i="${i}" data-f="kommentariy"
                   placeholder="комментарий совещания">${escapeHtml(op.kommentariy || '')}</textarea></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('input, textarea').forEach(inp => {
      inp.addEventListener('input', () => {
        Meeting._dirty.add(Number(inp.dataset.i));
        const i = Number(inp.dataset.i);
        if (inp.tagName === 'TEXTAREA') autoGrow(inp);
        // v3 КАСКАД: план-окончание операции становится план- и факт-
        // началом следующей операции (автоматически, сохраняется вместе
        // со строкой)
        if (inp.dataset.f === 'data_plan_end' && inp.value && i + 1 < Meeting._ops.length) {
          ['data_plan_start', 'data_fakt_start'].forEach(f => {
            const el = tbody.querySelector(`input[data-i="${i + 1}"][data-f="${f}"]`);
            if (el && el.value !== inp.value) {
              el.value = inp.value;
              Meeting._dirty.add(i + 1);
            }
          });
        }
      });
    });
    tbody.querySelectorAll('textarea').forEach(autoGrow);
  },

  // ------------------------------------------------------------
  async save() {
    if (!Meeting._batch) return;
    const idxs = [...Meeting._dirty];
    if (idxs.length === 0) {
      toast('Нет изменений для сохранения', 'warning');
      return;
    }

    let saved = 0, errors = 0;
    let becameReady = false;
    let lastDone = null;
    const wasReady = Meeting._batch.status === 'Готова к отправке';

    for (const i of idxs) {
      const op = Meeting._ops[i];
      const tr = document.querySelector(`#mtOpsBody [data-i="${i}"]`)?.closest('tr');
      const get = f => tr?.querySelector(`[data-i="${i}"][data-f="${f}"]`)?.value || '';

      // v2 клиентские проверки (дублируют серверные для мгновенного фидбэка)
      const fS = get('data_fakt_start'), fE = get('data_fakt_end');
      const kolvoRaw = get('kolvo_vypolneno').trim();
      if (kolvoRaw) {
        const k = Number(kolvoRaw.replace(',', '.'));
        if (!isFinite(k) || k <= 0) {
          toast(`Операция «${op.naim_oper}»: количество выполненных должно быть положительным числом`, 'error');
          errors++; continue;
        }
        if (k > Meeting._batch.qty) {
          toast(`Операция «${op.naim_oper}»: выполнено (${k}) не может быть больше количества в партии (${Meeting._batch.qty} шт.)`, 'error');
          errors++; continue;
        }
      }
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if ((fS && fS > todayStr) || (fE && fE > todayStr)) {
        toast(`Операция «${op.naim_oper}»: фактическая дата не может быть больше текущей (${todayStr})`, 'error');
        errors++; continue;
      }

      const r = await api('PUT', '/api/meeting/fakt', {
        id_gryz_poz: Meeting._batch.gp_id,
        id_oper: op.id_oper,
        data_plan_start: get('data_plan_start'),
        data_plan_end: get('data_plan_end'),
        data_fakt_start: fS,
        data_fakt_end: fE,
        kommentariy: get('kommentariy'),
        kolvo_vypolneno: kolvoRaw
      });
      if (r.error) { toast(`Операция «${op.naim_oper}»: ${r.error}`, 'error'); errors++; continue; }
      saved++;
      if (r.readiness && r.readiness.done_qty != null) lastDone = r.readiness.done_qty;
      if (r.readiness?.status === 'Готова к отправке' && !wasReady) becameReady = true;
    }

    if (saved > 0) {
      toast(`Сохранено операций: ${saved}`);
    }
    if (becameReady) {
      toast('ПАРТИЯ ГОТОВА К ОТПРАВКЕ: факт последней операции шага закрыт' +
        (lastDone != null ? ` — готово ${lastDone} шт.` : ''), 'warning');
    }
    Meeting._dirty = new Set();
    await Meeting.loadPositions();
    // перечитываем карточку (статусы/легаси-флаг могли измениться)
    const row = Meeting._positions.find(p => p.gp_id === Meeting.selectedGpId);
    if (row) await Meeting.onSelect(row); else Meeting.clearForm();
    if (errors > 0) {
      document.getElementById('mtSaveInfo').textContent = `Ошибок: ${errors}`;
    } else {
      document.getElementById('mtSaveInfo').textContent =
        `Сохранено ${saved} оп. (${new Date().toLocaleTimeString('ru-RU')})`;
    }
  },

  // ------------------------------------------------------------
  // Добавление операции в начатый шаг (сначала сохраняем несохранённое)
  async addOp() {
    if (!Meeting._batch) return;
    const name = document.getElementById('mtNewOpName').value.trim();
    if (!name) { toast('Укажите наименование операции', 'warning'); return; }

    if (Meeting._dirty.size > 0) await Meeting.save();

    const r = await api('POST', '/api/meeting/op', {
      id_shag: Meeting._batch.id_shag,
      naim_oper: name
    });
    if (r.error) { toast(r.error, 'error'); return; }

    toast(`Операция добавлена в шаг №${Meeting._batch.nom_shag}` +
      (r.created_fakt > 0 ? `; строк факта создано: ${r.created_fakt}` : ''));
    document.getElementById('mtNewOpName').value = '';
    await Meeting.loadPositions();
    const row = Meeting._positions.find(p => p.gp_id === Meeting.selectedGpId);
    if (row) await Meeting.onSelect(row);
  },

  // ------------------------------------------------------------
  clearForm() {
    Meeting.selectedGpId = null;
    Meeting._batch = null;
    Meeting._ops = [];
    Meeting._dirty = new Set();
    document.getElementById('mtFormTitle').textContent = 'Партия не выбрана';
    document.getElementById('mtFormEmpty').style.display = '';
    document.getElementById('mtFormBody').style.display = 'none';
  }
};

// --- локальные помощники экранирования ---
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function attr(v) {
  return escapeHtml(v ?? '');
}
// v3: авто-высота комментария — текст виден целиком (перенос),
// при переполнении включается вертикальная прокрутка
function autoGrow(el) {
  const max = 96;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, max) + 'px';
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
}