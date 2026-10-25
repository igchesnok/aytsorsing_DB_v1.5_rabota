// ============================================================
// js/app-quality.js — страница «Приёмка ОТК» (quality.html)
// Паттерн master-detail: слева — прибывшие грузовые позиции
// (Входящие transport_oper), справа — вкладки: замеры / журнал
// браков / передача технологу.
// ============================================================
import { api, toast, esc } from './common/utils.js';
import { state } from './common/state.js';
import { VirtualTable } from './common/virtual-table.js';
import { connectWs, setHandlers } from './common/websocket.js';
import { initResizers, resetResizerStylesOnResize } from './common/resizer.js';
import { initCommonUI, enableTabs } from './common/ui/index.js';

const STATUS_RU = {
  vyavlen: 'Выявлен', peredan_tehnologu: 'Передан технологу',
  reshenie_prinyato: 'Решение принято', zakryt: 'Закрыт'
};
const TIP_RU = {
  spisat_okonchatelno: '♻️ Списать окончательно',
  otpravit_podryadchiku: '🔄 Отправить подрядчику',
  peredelat_v_pto: '🛠 Переделать в цехе ПТО',
  dopustit_kak_godnoe: '✅ Допустить как годное'
};

export const Quality = {
  _selectedGp: null,       // выбранная грузовая позиция (строка master)
  _brakiRows: [],          // брак-журнал позиции
  _selectedBrakaId: null,  // выбранный брак (в журнале)
  _fullCache: null,        // GET /api/braki/<id>
  _zamDirty: false,

  // ==================== ИНИЦИАЛИЗАЦИЯ ====================
  async init() {
    // ---- MASTER: прибывшие позиции ----
    state.tables.otk_prikhod = new VirtualTable(
      document.getElementById('prikhodTable'),
      [
        { key: 'pribytie_data',   label: 'Прибытие',  width: '84px' },
        { key: 'nomer_chertezha', label: 'Чертеж',    width: '110px' },
        { key: 'osn_naimenovanie',label: 'Деталь',    width: '140px' },
        { key: 'firm_name',       label: 'Фирма',     width: '130px' },
        { key: 'vsego_sht',       label: 'Шт',        width: '50px' },
        { key: 'otk_status',      label: 'Этап ОТК',  width: '110px',
          formatter: v => ({ text: { pribylo:'📥 Прибыло', na_otk:'🔎 На ОТК', proshlo:'✅ Прошло' }[v] || v }) }
      ],
      {
        idKey: 'id_gp',
        onSelect: r => Quality.onGpSelect(r),
        onHeaderClick: () => Quality.clearDetail(),
        rowClassName: r => r.otk_status === 'na_otk' ? 'wyavlen' : (r.otk_status === 'proshlo' ? 'zakryt' : '')
      }
    );

    // ---- CHILD: журнал браков позиции ----
    state.tables.braki_list = new VirtualTable(
      document.getElementById('brakiTable'),
      [
        { key: 'data_zamera',       label: 'Замер',   width: '84px' },
        { key: 'zabrakovano_sht',   label: 'Брак шт', width: '70px' },
        { key: 'status_workflow',   label: 'Статус',  width: '130px',
          formatter: v => ({ text: STATUS_RU[v] || v }) },
        { key: 'kommentariy_kontrolera', label: 'Коммент. контролёра', width: '220px' }
      ],
      {
        idKey: 'id_braka',
        onSelect: r => Quality.onBrakSelect(r.id_braka),
        onHeaderClick: () => Quality.onBrakDeselect()
      }
    );

    // ---- фильтры ----
    document.getElementById('fltStatus').addEventListener('change', () => Quality.loadPrikhod());
    let qt;
    document.getElementById('fltQ').addEventListener('input', () => {
      clearTimeout(qt); qt = setTimeout(() => Quality.loadPrikhod(), 300);
    });
    document.getElementById('btnRefresh').onclick = () => Quality.loadPrikhod();
    document.getElementById('btnBrakReload').onclick = () => Quality.loadBraki(Quality._selectedGp?.id_gp);

    // ---- кнопки замеров ----
    document.getElementById('btnZamAdd').onclick  = () => Quality.addZamRow();
    document.getElementById('btnZamSave').onclick = () => Quality.saveZamery();
    document.getElementById('btnZamDelBrak').onclick = () => Quality.deleteDraftBrak();
    document.getElementById('fKomKontrolera').addEventListener('input', () => Quality.updateRulePreview());

    // ---- файлы ----
    document.getElementById('btnFileUpload').onclick = () => Quality.uploadFiles();

    // ---- передача технологу ----
    document.getElementById('btnPeredet').onclick = () => Quality.peredetTehnologu();

    // ---- модалка фото ----
    const modal = document.getElementById('imgModal');
    modal.onclick = () => modal.classList.remove('open');

    await Quality.loadRefs();
    await Quality.loadPrikhod();
    enableTabs(false);
  },

  getCurrentEditContext() {
    return { table: 'braki', id: Quality._selectedBrakaId };
  },

  // ==================== СПРАВОЧНИКИ ====================
  async loadRefs() {
    try {
      const refs = await api('GET', '/api/braki/refs');
      const sel = document.getElementById('fTehnolog');
      sel.innerHTML = '<option value="">— Выберите технолога —</option>' +
        (refs.technologs || []).map(t => `<option value="${esc(t.id)}">${esc(t.fio || t.login)}</option>`).join('');
    } catch (e) { console.error('[Quality.loadRefs]', e); }
  },

  // ==================== MASTER: ПРИХОД ====================
  async loadPrikhod() {
    try {
      const status = document.getElementById('fltStatus').value;
      const q = encodeURIComponent(document.getElementById('fltQ').value || '');
      const rows = await api('GET', `/api/otk/prikhod?status=${status}&q=${q}`);
      await state.tables.otk_prikhod.setData(rows || []);
      document.getElementById('qCounter').textContent = `Позиций: ${(rows||[]).length}`;
      if (Quality._selectedGp) {
        const still = (rows||[]).find(r => r.id_gp === Quality._selectedGp.id_gp);
        if (!still) Quality.clearDetail(); else Quality._selectedGp = still;
      }
    } catch (e) { toast('Ошибка загрузки прихода: ' + e.message, 'error'); }
  },

  async onGpSelect(row) {
    Quality._selectedGp = row;
    enableTabs(true);
    Quality.fillGpInfo(row);
    await Quality.loadBraki(row.id_gp);
    Quality.resetZamEditor();
  },

  fillGpInfo(r) {
    const set = (id, v) => document.getElementById(id).textContent = (v ?? '') !== '' && v != null ? v : '—';
    set('iChert', r.nomer_chertezha); set('iNaim', r.osn_naimenovanie);
    set('iFirma', r.firm_name);       set('iReis', r.nomer_reisa);
    set('iPribytie', [r.pribytie_data, r.pribytie_vremya].filter(Boolean).join(' '));
    set('iNoBr', r.kolvo_no_br);      set('iYesBr', r.kolvo_yes_br);
    set('iVsego', r.vsego_sht);
  },

  clearDetail() {
    Quality._selectedGp = null;
    Quality.onBrakDeselect();
    Quality.resetZamEditor();
    state.tables.braki_list.setData([]);
    enableTabs(false);
    ['iChert','iNaim','iFirma','iReis','iPribytie','iNoBr','iYesBr','iVsego']
      .forEach(id => document.getElementById(id).textContent = '—');
    document.getElementById('filesList').innerHTML = '';
    document.getElementById('reshenieView').textContent = '— выберите брак —';
  },

  // ==================== CHILD: ЖУРНАЛ БРАКОВ ====================
  async loadBraki(idGp) {
    if (!idGp) return;
    try {
      const rows = await api('GET', `/api/braki?id_gp=${encodeURIComponent(idGp)}`);
      Quality._brakiRows = rows || [];
      await state.tables.braki_list.setData(Quality._brakiRows);
      document.getElementById('brakiTitle').textContent =
        `Браки позиции ${rows?.length ? rows[0].nomer_chertezha || '' : ''} (${(rows||[]).length})`;
      // если есть единственный открытый брак — выбрать его автоматически
      const open = (rows || []).find(b => b.status_workflow !== 'zakryt');
      if (open) Quality.onBrakSelect(open.id_braka);
    } catch (e) { toast('Ошибка журнала браков: ' + e.message, 'error'); }
  },

  onBrakDeselect() {
    Quality._selectedBrakaId = null;
    Quality._fullCache = null;
    document.getElementById('btnFileUpload').disabled = true;
    document.getElementById('btnPeredet').disabled = true;
    document.getElementById('filesList').innerHTML = '';
    document.getElementById('historyList').innerHTML = '';
    document.getElementById('reshenieView').textContent = '— выберите брак —';
    document.getElementById('peredachaBrakInfo').innerHTML = '';
  },

  async onBrakSelect(idBraka) {
    Quality._selectedBrakaId = idBraka;
    try {
      const full = await api('GET', `/api/braki/${encodeURIComponent(idBraka)}`);
      Quality._fullCache = full;
      Quality.renderFiles(full.files || []);
      Quality.renderHistory(full.history || []);
      Quality.renderReshenie(full);
      Quality.fillPeredachaInfo(full);
      // редактирование замеров: только статус vyavlen
      const editable = full.brak.status_workflow === 'vyavlen';
      document.getElementById('btnZamAdd').disabled = !editable || !Quality._selectedGp;
      document.getElementById('btnZamSave').disabled = !editable;
      document.getElementById('btnZamDelBrak').disabled = !editable;
      document.getElementById('btnFileUpload').disabled = false;
      document.getElementById('btnPeredet').disabled = !editable;
      document.getElementById('fKomKontrolera').value = full.brak.kommentariy_kontrolera || '';
      await Quality.loadZameryForBrak(idBraka);
    } catch (e) { toast('Ошибка карточки брака: ' + e.message, 'error'); }
  },

  // ==================== РЕДАКТОР ЗАМЕРОВ ====================
  resetZamEditor() {
    document.getElementById('zamBody').innerHTML = '';
    document.getElementById('fKomKontrolera').value = '';
    document.getElementById('brakRulePreview').style.display = 'none';
    document.getElementById('btnZamAdd').disabled = !Quality._selectedGp;
    document.getElementById('btnZamSave').disabled = true;
    document.getElementById('btnZamDelBrak').disabled = true;
    Quality._zamDirty = false;
  },

  async loadZameryForBrak(idBraka) {
    try {
      const zamery = await api('GET', `/api/otk/zamery?id_braka=${encodeURIComponent(idBraka)}`);
      const body = document.getElementById('zamBody');
      body.innerHTML = '';
      (zamery || []).forEach(z => Quality.addZamRow(z));
      Quality.updateRulePreview();
    } catch (e) { console.error('[Quality.loadZameryForBrak]', e); }
  },

  addZamRow(z = {}) {
    const tbody = document.getElementById('zamBody');
    const tr = document.createElement('tr');
    tr.className = z.rezultat === 'brak' ? 'zam-brak' : 'zam-godno';
    tr.innerHTML = `
      <td><input class="z-param" value="${esc(z.parametr || '')}" placeholder="Ø отверстия"></td>
      <td><input class="z-nom" type="number" step="any" value="${z.nominal ?? ''}"></td>
      <td><input class="z-fakt" type="number" step="any" value="${z.fakt ?? ''}"></td>
      <td><input class="z-dv" type="number" step="any" value="${z.dopusk_verh ?? ''}"></td>
      <td><input class="z-dn" type="number" step="any" value="${z.dopusk_niz ?? ''}"></td>
      <td><input class="z-per" type="number" step="any" min="0" value="${z.sht_peredano ?? ''}" placeholder="шт"></td>
      <td><input class="z-brk" type="number" step="any" min="0" value="${z.sht_brakovannye ?? ''}" placeholder="шт"></td>
      <td><select class="z-res">
        <option value="godno"${z.rezultat==='godno'?' selected':''}>Годно</option>
        <option value="brak"${z.rezultat==='brak'?' selected':''}>Брак</option>
        <option value="uslovno"${z.rezultat==='uslovno'?' selected':''}>Условно</option>
      </select></td>
      <td><input class="z-kom" value="${esc(z.kommentariy || '')}"></td>
      <td>${z.id && String(z.id).startsWith('ZAM') ? `<button class="zam-del-btn" title="Удалить строку">×</button>` : ''}</td>`;

    const markDirty = () => { Quality._zamDirty = true; Quality.updateRulePreview(); };
    tr.querySelectorAll('input,select').forEach(inp => inp.addEventListener('input', markDirty));
    tr.querySelector('.z-res').addEventListener('change', () => {
      tr.className = tr.querySelector('.z-res').value === 'brak' ? 'zam-brak' : 'zam-godno';
      markDirty();
    });
    const del = tr.querySelector('.zam-del-btn');
    if (del) del.onclick = async () => {
      const id = z.id;
      if (id && String(id).startsWith('ZAM')) {
        try { await api('DELETE', `/api/otk/zamery/${encodeURIComponent(id)}`); } catch (e) {}
      }
      tr.remove(); Quality.updateRulePreview();
    };
    tbody.appendChild(tr);
    Quality.updateRulePreview();
  },

  collectZamery() {
    return [...document.querySelectorAll('#zamBody tr')].map(tr => ({
      parametr:        tr.querySelector('.z-param').value.trim(),
      nominal:         tr.querySelector('.z-nom').value,
      fakt:            tr.querySelector('.z-fakt').value,
      dopusk_verh:     tr.querySelector('.z-dv').value,
      dopusk_niz:      tr.querySelector('.z-dn').value,
      sht_peredano:    parseFloat(tr.querySelector('.z-per').value) || 0,
      sht_brakovannye: parseFloat(tr.querySelector('.z-brk').value) || 0,
      rezultat:         tr.querySelector('.z-res').value,
      kommentariy:     tr.querySelector('.z-kom').value
    })).filter(z => z.parametr);
  },

  // живое отображение правила браковки
  updateRulePreview() {
    const el = document.getElementById('brakRulePreview');
    if (!Quality._selectedGp) { el.style.display = 'none'; return; }
    const vsego = parseFloat(Quality._selectedGp.vsego_sht) || 0;
    const zs = Quality.collectZamery();
    const braka = zs.filter(z => z.rezultat === 'brak').reduce((s, z) => s + z.sht_brakovannye, 0);
    const pered = Math.max(0, ...zs.map(z => z.sht_peredano || 0));
    if (!zs.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    if (braka <= 0) {
      el.innerHTML = `Брак не выявлен → партия проходит приёмку (<b class="brk-part">забраковано 0 шт</b>).`;
    } else if (pered >= vsego && vsego > 0) {
      el.innerHTML = `На замеры переданы ВСЕ детали партии (${pered}/${vsego}) → ` +
        `<b class="brk-part">бракуется только выявленный брак: ${braka} шт</b>.`;
    } else {
      el.innerHTML = `На замеры передана ЧАСТЬ партии (${pered}/${vsego}), брак ≥ 1 шт → ` +
        `<b class="brk-all">бракуется ВСЯ партия: ${vsego} шт</b>.`;
    }
  },

  async saveZamery() {
    if (!Quality._selectedGp) return;
    const zamery = Quality.collectZamery();
    if (!zamery.length) return toast('Добавьте хотя бы одну карту замеров', 'warning');
    try {
      const body = {
        id_gp: Quality._selectedGp.id_gp,
        id_braka: (Quality._fullCache?.brak?.status_workflow === 'vyavlen')
          ? Quality._selectedBrakaId : null,
        zamery,
        kommentariy_kontrolera: document.getElementById('fKomKontrolera').value
      };
      const r = await api('POST', '/api/otk/zamery', body);
      if (r.error) return toast(r.error, 'error');
      toast(`Замеры сохранены. Забраковано: ${r.zabrakovano_sht} шт`);
      Quality._zamDirty = false;
      await Quality.loadBraki(Quality._selectedGp.id_gp);
      await Quality.onBrakSelect(r.id_braka);
      await Quality.loadPrikhod();
    } catch (e) { toast('Ошибка сохранения замеров: ' + e.message, 'error'); }
  },

  async deleteDraftBrak() {
    if (!Quality._selectedBrakaId) return;
    if (!confirm('Удалить черновик брака вместе с замерами?')) return;
    try {
      const r = await api('DELETE', `/api/braki/${encodeURIComponent(Quality._selectedBrakaId)}`);
      if (r.error) return toast(r.error, 'error');
      toast('Черновик брака удалён');
      Quality.onBrakDeselect();
      Quality.resetZamEditor();
      await Quality.loadBraki(Quality._selectedGp?.id_gp);
      await Quality.loadPrikhod();
    } catch (e) { toast(e.message, 'error'); }
  },

  // ==================== ФАЙЛЫ ====================
  renderFiles(files) {
    const wrap = document.getElementById('filesList');
    wrap.innerHTML = files.length ? '' : '<span style="font-size:12px;color:var(--muted)">нет файлов</span>';
    files.forEach(f => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const isImg = /png|jpe?g|gif|webp|bmp/i.test(f.file_type || '');
      card.innerHTML = `
        ${isImg ? `<img src="${esc(f.file_path)}" data-full="${esc(f.file_path)}" alt="">`
                : `<div style="height:80px;display:flex;align-items:center;justify-content:center;font-size:26px;">📄</div>`}
        <div class="fname" title="${esc(f.file_name)}">${esc(f.file_name)}</div>
        <div style="color:var(--muted)">${esc(f.uploaded_by_fio || '')}</div>
        <button class="fdel" title="Удалить файл">×</button>`;
      card.querySelector('.fdel').onclick = async () => {
        if (!confirm(`Удалить файл «${f.file_name}»?`)) return;
        const r = await api('DELETE', `/api/braki/files/${encodeURIComponent(f.id)}`);
        if (r.error) return toast(r.error, 'error');
        Quality.reloadFull();
      };
      const img = card.querySelector('img');
      if (img) img.onclick = () => {
        document.getElementById('imgModalSrc').src = img.dataset.full;
        document.getElementById('imgModal').classList.add('open');
      };
      wrap.appendChild(card);
    });
  },

  async uploadFiles() {
    const inp = document.getElementById('fFileInput');
    if (!Quality._selectedBrakaId || !inp.files.length) return toast('Выберите файлы', 'warning');
    for (const file of inp.files) {
      try {
        const token = localStorage.getItem('auth_token') || '';
        const r = await fetch(
          `/api/braki/files/upload?id_braka=${encodeURIComponent(Quality._selectedBrakaId)}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: file });
        const j = await r.json();
        if (j.error) toast(`«${file.name}»: ${j.error}`, 'error');
      } catch (e) { toast(`«${file.name}»: ${e.message}`, 'error'); }
    }
    inp.value = '';
    toast('Файлы загружены');
    Quality.reloadFull();
  },

  async reloadFull() {
    if (Quality._selectedBrakaId) await Quality.onBrakSelect(Quality._selectedBrakaId);
  },

  // ==================== ПЕРЕДАЧА ТЕХНОЛОГУ ====================
  fillPeredachaInfo(full) {
    const b = full.brak;
    const el = document.getElementById('peredachaBrakInfo');
    el.innerHTML = `
      <div><span class="k">Номер брака:</span> <span class="v">${esc(b.id_braka)}</span></div>
      <div><span class="k">Статус:</span> <span class="v">${esc(STATUS_RU[b.status_workflow] || b.status_workflow)}</span></div>
      <div><span class="k">Забраковано:</span> <span class="v">${esc(b.zabrakovano_sht)} шт</span></div>
      <div><span class="k">Деталь:</span> <span class="v">${esc(full.brak.nomer_chertezha || '')} ${esc(full.brak.osn_naimenovanie || '')}</span></div>`;
  },

  async peredetTehnologu() {
    if (!Quality._selectedBrakaId) return;
    const idTehnologa = document.getElementById('fTehnolog').value;
    if (!idTehnologa) return toast('Выберите технолога', 'warning');
    try {
      const r = await api('POST', `/api/braki/${encodeURIComponent(Quality._selectedBrakaId)}/peredat-tehnologu`,
        { id_tehnologa: idTehnologa, kommentariy: document.getElementById('fPeredKom').value });
      if (r.error) return toast(r.error, 'error');
      toast('Брак передан технологу');
      document.getElementById('fPeredKom').value = '';
      await Quality.reloadFull();
      await Quality.loadBraki(Quality._selectedGp?.id_gp);
      await Quality.loadPrikhod();
    } catch (e) { toast(e.message, 'error'); }
  },

  // ==================== ОТОБРАЖЕНИЕ РЕШЕНИЯ / ИСТОРИИ ====================
  renderReshenie(full) {
    const active = (full.resheniya || []).find(r => r.status_resheniya === 'aktivno')
                || (full.resheniya || [])[0];
    const el = document.getElementById('reshenieView');
    if (!active) { el.textContent = 'Решение ещё не принято'; return; }
    el.innerHTML = `
      <div><b>${esc(TIP_RU[active.tip_resheniya] || active.tip_resheniya)}</b>
        <span class="status-badge sb-${esc(active.status_resheniya==='aktivno'?'reshenie_prinyato':'zakryt')}">${esc(active.status_resheniya)}</span></div>
      <div>Технолог: ${esc(active.tehnolog_fio || '')}, дата: ${esc(active.data_resheniya || '')}</div>
      ${active.kto_oplachivaet_transport ? `<div>Транспорт оплачивает: <b>${esc(active.kto_oplachivaet_transport)}</b>, срок возврата: ${esc(active.srok_vozvrata || '—')}</div>` : ''}
      ${active.id_cex_izgotovitel ? `<div>Переделка в цехе: <b>${esc(active.cex_name || active.id_cex_izgotovitel)}</b></div>` : ''}
      ${active.summa_uscherba ? `<div>Ущерб: <b>${esc(active.summa_uscherba)} ₽</b>, несёт: ${esc(active.kto_neset_ubutki || '—')}</div>` : ''}
      ${active.kommentariy ? `<div>Заключение: ${esc(active.kommentariy)}</div>` : ''}
      ${active.nomer_pisma_kontragentu_o_brake ? `<div>Письмо контрагенту: ${esc(active.nomer_pisma_kontragentu_o_brake)}</div>` : ''}`;
  },

  renderHistory(history) {
    const ul = document.getElementById('historyList');
    ul.innerHTML = (history || []).map(h => `
      <li><span class="hdate">${esc(h.created_at)}</span>
          <span class="hact">${esc(h.action)}</span>
          ${h.old_value ? `${esc(h.old_value)} → ` : ''}${esc(h.new_value || '')}
          <span style="color:var(--muted)">(${esc(h.user_login || '')})</span>
          ${h.kommentariy ? `<div style="color:var(--muted)">${esc(h.kommentariy)}</div>` : ''}</li>`).join('')
      || '<li style="color:var(--muted)">пусто</li>';
  }
};

// ==================== СТАРТ СТРАНИЦЫ ====================
document.addEventListener('DOMContentLoaded', async () => {
  connectWs();
  initCommonUI({ contextResolver: () => Quality.getCurrentEditContext() });
  setHandlers({
    onDataChanged: (msg) => {
      if (['braki', 'otk_zamery', 'braki_files', 'resheniya_tehnologa'].includes(msg.table)) {
        Quality.loadPrikhod();
        if (Quality._selectedGp) Quality.loadBraki(Quality._selectedGp.id_gp);
        Quality.reloadFull();
      }
    },
    updateButtons: () => {},
    onLocksUpdate: () => {}
  });
  await Quality.init();
  initResizers();
  resetResizerStylesOnResize();
});
