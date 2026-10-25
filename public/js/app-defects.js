// ============================================================
// js/app-defects.js — страница «Работа с браком» (defects.html)
// Очередь технолога: слева — браки (назначенные мне / все),
// справа — карточка брака: замеры, решение, история и файлы.
// Паттерн master-detail — как transport-ops.html.
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

export const Defects = {
  _selectedBrakaId: null,
  _fullCache: null,
  _rows: [],

  // ==================== ИНИЦИАЛИЗАЦИЯ ====================
  async init() {
    state.tables.braki_ochered = new VirtualTable(
      document.getElementById('ocheredTable'),
      [
        { key: 'data_peredachi_tehnologu', label: 'Передан', width: '92px' },
        { key: 'nomer_chertezha',          label: 'Чертеж',  width: '110px' },
        { key: 'osn_naimenovanie',         label: 'Деталь',  width: '130px' },
        { key: 'firm_name',                label: 'Фирма',   width: '120px' },
        { key: 'zabrakovano_sht',          label: 'Брак шт', width: '64px' },
        { key: 'status_workflow',          label: 'Статус',  width: '130px',
          formatter: v => ({ text: STATUS_RU[v] || v }) },
        { key: 'tehnolog_fio',             label: 'Технолог',width: '120px' }
      ],
      {
        idKey: 'id_braka',
        onSelect: r => Defects.onBrakSelect(r.id_braka),
        onHeaderClick: () => Defects.clearDetail(),
        rowClassName: r => ({
          vyavlen: 'wyavlen', peredan_tehnologu: 'peredan',
          reshenie_prinyato: 'reshenie', zakryt: 'zakryt'
        }[r.status_workflow] || '')
      }
    );

    document.getElementById('fltOchered').addEventListener('change', () => Defects.load());
    document.getElementById('fltStatus').addEventListener('change', () => Defects.applyFilter());
    document.getElementById('btnRefresh').onclick = () => Defects.load();

    // кнопки workflow
    document.getElementById('btnPrinyat').onclick = () => Defects.prinyatVRabotu();
    document.getElementById('btnSaveReshenie').onclick = () => Defects.saveReshenie();
    document.getElementById('btnZakryt').onclick = () => Defects.zakrytBrak();

    // переключение атрибутов решения по типу
    document.querySelectorAll('input[name="tipResh"]').forEach(r =>
      r.addEventListener('change', () => Defects.showAttrs()));

    // модалка фото
    document.getElementById('imgModal').onclick = (e) =>
      e.currentTarget.classList.remove('open');

    await Defects.loadRefs();
    await Defects.load();
    enableTabs(false);
  },

  getCurrentEditContext() {
    return { table: 'braki', id: Defects._selectedBrakaId };
  },

  // ==================== СПРАВОЧНИКИ ====================
  async loadRefs() {
    try {
      const refs = await api('GET', '/api/braki/refs');
      const sel = document.getElementById('fCex');
      sel.innerHTML = '<option value="">— Выберите цех —</option>' +
        (refs.cexi || []).map(c =>
          `<option value="${esc(c.id)}">${esc(c.ceh)} — ${esc(c.nazvanie)}</option>`).join('');
    } catch (e) { console.error('[Defects.loadRefs]', e); }
  },

  // ==================== MASTER: ОЧЕРЕДЬ ====================
  async load() {
    try {
      const all = document.getElementById('fltOchered').value === 'all' ? '1' : '0';
      const rows = await api('GET', `/api/tehnolog/ochered?all=${all}`);
      Defects._rows = rows || [];
      Defects.applyFilter();
    } catch (e) { toast('Ошибка загрузки очереди: ' + e.message, 'error'); }
  },

  applyFilter() {
    const st = document.getElementById('fltStatus').value;
    const rows = st ? Defects._rows.filter(r => r.status_workflow === st) : Defects._rows;
    state.tables.braki_ochered.setData(rows);
    document.getElementById('qCounter').textContent = ` Браков: ${rows.length}`;
    if (Defects._selectedBrakaId && !rows.find(r => r.id_braka === Defects._selectedBrakaId)) {
      Defects.clearDetail();
    }
  },

  clearDetail() {
    Defects._selectedBrakaId = null;
    Defects._fullCache = null;
    enableTabs(false);
    state.tables.braki_ochered.clearSelection();
    ['iChert','iNaim','iFirma','iStatus','iVsego','iZabr','iKontroler',
     'iDataZamera','iKom','iPered','iPrinyat']
      .forEach(id => document.getElementById(id).textContent = '—');
    document.getElementById('zamBodyView').innerHTML = '';
    document.getElementById('filesList').innerHTML = '';
    document.getElementById('historyList').innerHTML = '';
    document.getElementById('reshList').innerHTML = '— нет решений —';
    Defects.updateButtons();
  },

  // ==================== DETAIL: КАРТОЧКА ====================
  async onBrakSelect(idBraka) {
    Defects._selectedBrakaId = idBraka;
    enableTabs(true);
    Defects.resetReshenieForm();
    try {
      const full = await api('GET', `/api/braki/${encodeURIComponent(idBraka)}`);
      if (full.error) return toast(full.error, 'error');
      Defects._fullCache = full;
      Defects.fillInfo(full);
      Defects.renderZamery(full.zamery || []);
      Defects.renderFiles(full.files || []);
      Defects.renderHistory(full.history || []);
      Defects.renderResheniya(full.resheniya || []);
      Defects.updateButtons();
    } catch (e) { toast('Ошибка карточки брака: ' + e.message, 'error'); }
  },

  fillInfo(full) {
    const b = full.brak;
    const set = (id, v) =>
      document.getElementById(id).textContent = (v == null || v === '') ? '—' : v;
    set('iChert', b.nomer_chertezha);  set('iNaim', b.osn_naimenovanie);
    set('iFirma', b.firm_name);        set('iStatus', STATUS_RU[b.status_workflow] || b.status_workflow);
    set('iVsego', b.vsego_sht);        set('iZabr', b.zabrakovano_sht);
    set('iKontroler', b.kontroler_fio);set('iDataZamera', b.data_zamera);
    set('iKom', b.kommentariy_kontrolera);
    set('iPered', b.data_peredachi_tehnologu);
    set('iPrinyat', b.data_polucheniya_tehnologom);
  },

  renderZamery(zamery) {
    const tbody = document.getElementById('zamBodyView');
    tbody.innerHTML = zamery.map(z => `
      <tr class="${z.rezultat === 'brak' ? 'zam-brak' : 'zam-godno'}">
        <td>${esc(z.parametr)}</td><td>${z.nominal ?? ''}</td><td>${z.fakt ?? ''}</td>
        <td>${z.dopusk_verh ?? ''}</td><td>${z.dopusk_niz ?? ''}</td>
        <td>${z.sht_peredano ?? ''}</td><td>${z.sht_brakovannye ?? ''}</td>
        <td>${z.rezultat === 'brak' ? '🔴 Брак' : (z.rezultat === 'uslovno' ? '🟡 Условно' : '🟢 Годно')}</td>
        <td>${esc(z.kommentariy || '')}</td>
      </tr>`).join('') || '<tr><td colspan="9" style="color:var(--muted)">замеры не найдены</td></tr>';
  },

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
        <div style="color:var(--muted)">${esc(f.uploaded_by_fio || '')}</div>`;
      const img = card.querySelector('img');
      if (img) img.onclick = () => {
        document.getElementById('imgModalSrc').src = img.dataset.full;
        document.getElementById('imgModal').classList.add('open');
      };
      wrap.appendChild(card);
    });
  },

  renderHistory(history) {
    document.getElementById('historyList').innerHTML = (history || []).map(h => `
      <li><span class="hdate">${esc(h.created_at)}</span>
          <span class="hact">${esc(h.action)}</span>
          ${h.old_value ? `${esc(h.old_value)} → ` : ''}${esc(h.new_value || '')}
          <span style="color:var(--muted)">(${esc(h.user_login || '')})</span>
          ${h.kommentariy ? `<div style="color:var(--muted)">${esc(h.kommentariy)}</div>` : ''}</li>`).join('')
      || '<li style="color:var(--muted)">пусто</li>';
  },

  renderResheniya(resheniya) {
    const el = document.getElementById('reshList');
    if (!resheniya.length) { el.innerHTML = '— нет решений —'; return; }
    el.innerHTML = resheniya.map(r => `
      <div style="border:1px solid var(--border);border-radius:6px;padding:6px;margin-bottom:6px;
                  background:${r.status_resheniya==='aktivno' ? '#dafbe1' : '#f6f8fa'}">
        <b>${esc(TIP_RU[r.tip_resheniya] || r.tip_resheniya)}</b>
        <span class="status-badge sb-${r.status_resheniya==='aktivno'?'reshenie_prinyato':'zakryt'}">${esc(r.status_resheniya)}</span>
        <div>${esc(r.tehnolog_fio || '')} · ${esc(r.data_resheniya || '')}</div>
        ${r.kommentariy ? `<div>Коммент.: ${esc(r.kommentariy)}</div>` : ''}
        ${r.kto_oplachivaet_transport ? `<div>Транспорт: ${esc(r.kto_oplachivaet_transport)}, срок возврата: ${esc(r.srok_vozvrata || '—')}</div>` : ''}
        ${r.cex_name ? `<div>Цех переделки: ${esc(r.cex_name)}</div>` : ''}
        ${r.summa_uscherba ? `<div>Ущерб: ${esc(r.summa_uscherba)} ₽ (${esc(r.kto_neset_ubutki || '—')})</div>` : ''}
        ${r.nomer_pisma_kontragentu_o_brake ? `<div>Письмо: ${esc(r.nomer_pisma_kontragentu_o_brake)}</div>` : ''}
      </div>`).join('');
  },

  // ==================== КНОПКИ ПО СТАТУСУ ====================
  updateButtons() {
    const b = Defects._fullCache?.brak;
    const st = b?.status_workflow;
    document.getElementById('btnPrinyat').disabled = st !== 'peredan_tehnologu';
    document.getElementById('btnSaveReshenie').disabled =
      !(st === 'peredan_tehnologu' || st === 'reshenie_prinyato');
    document.getElementById('btnZakryt').disabled = st !== 'reshenie_prinyato';
  },

  showAttrs() {
    const tip = document.querySelector('input[name="tipResh"]:checked')?.value;
    document.getElementById('attrsPodryadchik').classList.toggle('visible', tip === 'otpravit_podryadchiku');
    document.getElementById('attrsCex').classList.toggle('visible', tip === 'peredelat_v_pto');
    document.getElementById('attrsSpisanie').classList.toggle('visible', tip === 'spisat_okonchatelno');
  },

  // ==================== ДЕЙСТВИЯ ТЕХНОЛОГА ====================
  async prinyatVRabotu() {
    if (!Defects._selectedBrakaId) return;
    try {
      const r = await api('PUT', `/api/braki/${encodeURIComponent(Defects._selectedBrakaId)}/prinyat`);
      if (r.error) return toast(r.error, 'error');
      toast('Брак принят в работу');
      await Defects.reload();
    } catch (e) { toast(e.message, 'error'); }
  },

  async saveReshenie() {
    if (!Defects._selectedBrakaId) return;
    const tipEl = document.querySelector('input[name="tipResh"]:checked');
    if (!tipEl) return toast('Выберите тип решения', 'warning');
    const body = {
      tip_resheniya: tipEl.value,
      kommentariy: document.getElementById('fReshKom').value,
      kto_oplachivaet_transport: document.getElementById('fKtoOplach').value,
      srok_vozvrata: document.getElementById('fSrokVozvrata').value,
      id_cex_izgotovitel: document.getElementById('fCex').value,
      summa_uscherba: document.getElementById('fSummaUshcherba').value,
      kto_neset_ubutki: document.getElementById('fKtoUbitki').value,
      nomer_pisma_kontragentu_o_brake: document.getElementById('fNomerPisma').value,
      chya_povtornaya_zagotovka: document.getElementById('fChyaZagUniv').value
        || document.getElementById('fChyaZagotovka').value
    };
    try {
      const r = await api('POST', `/api/braki/${encodeURIComponent(Defects._selectedBrakaId)}/reshenie`, body);
      if (r.error) return toast(r.error, 'error');
      toast('Решение технолога сохранено');
      await Defects.reload();
    } catch (e) { toast(e.message, 'error'); }
  },

  async zakrytBrak() {
    if (!Defects._selectedBrakaId) return;
    const kom = prompt('Комментарий при закрытии (можно пустое):') ?? '';
    try {
      const r = await api('PUT', `/api/braki/${encodeURIComponent(Defects._selectedBrakaId)}/zakryt`,
        { kommentariy: kom });
      if (r.error) return toast(r.error, 'error');
      toast('Брак закрыт — решение исполнено');
      await Defects.reload();
    } catch (e) { toast(e.message, 'error'); }
  },

  async reload() {
    await Defects.load();
    if (Defects._selectedBrakaId) await Defects.onBrakSelect(Defects._selectedBrakaId);
  }
};

// ==================== СТАРТ СТРАНИЦЫ ====================
document.addEventListener('DOMContentLoaded', async () => {
  connectWs();
  initCommonUI({ contextResolver: () => Defects.getCurrentEditContext() });
  setHandlers({
    onDataChanged: (msg) => {
      if (['braki', 'otk_zamery', 'braki_files', 'resheniya_tehnologa'].includes(msg.table)) {
        Defects.reload();
      }
    },
    updateButtons: () => Defects.updateButtons(),
    onLocksUpdate: () => {}
  });
  await Defects.init();
  initResizers();
  resetResizerStylesOnResize();
});
