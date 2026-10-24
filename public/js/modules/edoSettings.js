// ============================================================
// ✅ T52: modules/edoSettings.js — СТРАНИЦА «НАСТРОЙКИ ЭДО»
// Графическое редактирование ВСЕХ полей config/edo.json:
//   - подключение к порталу (url, docs_url, username, password,
//     reject_unauthorized);
//   - темы служебных записок (tema.*) с подстановками
//     {дата}/{отправитель}/{получатель} и {номер}/{дата}/{фирмы};
//   - шаблоны СЗ (shablon.*);
//   - подписывающие (podpisant.*: PODP, PODP_KOD, O_OTV_ISP).
// API: GET/POST /api/edo-settings, POST /api/edo-settings/test.
// Файл читается сервером при каждом создании СЗ — сохранение
// действует сразу, без перезапуска.
// ============================================================
import { api, toast } from '../common/utils.js';

// --- Все поля формы в одном списке (id -> путь в конфиге) ---
const FIELDS = [
  { id: 'cfgUrl',        get: (c) => c.url },
  { id: 'cfgDocsUrl',    get: (c) => c.docs_url },
  { id: 'cfgUsername',   get: (c) => c.username },
  { id: 'cfgPassword',   get: (c) => c.password },
  { id: 'cfgRejectUnauth', type: 'checkbox', get: (c) => c.reject_unauthorized },

  { id: 'temaTransport', get: (c) => c.tema && c.tema.sz_transport },
  { id: 'temaSb',        get: (c) => c.tema && c.tema.sz_sb },
  { id: 'temaSoglas',    get: (c) => c.tema && c.tema.sz_soglasovanie },

  { id: 'shablonTransport', get: (c) => c.shablon && c.shablon.sz_transport },
  { id: 'shablonSb',        get: (c) => c.shablon && c.shablon.sz_sb },
  { id: 'shablonSoglas',    get: (c) => c.shablon && c.shablon.sz_soglasovanie },

  { id: 'podpTransportP', get: (c) => c.podpisant && c.podpisant.sz_transport && c.podpisant.sz_transport.PODP },
  { id: 'podpTransportK', get: (c) => c.podpisant && c.podpisant.sz_transport && c.podpisant.sz_transport.PODP_KOD },
  { id: 'podpTransportI', get: (c) => c.podpisant && c.podpisant.sz_transport && c.podpisant.sz_transport.O_OTV_ISP },
  { id: 'podpSbP',        get: (c) => c.podpisant && c.podpisant.sz_sb && c.podpisant.sz_sb.PODP },
  { id: 'podpSbK',        get: (c) => c.podpisant && c.podpisant.sz_sb && c.podpisant.sz_sb.PODP_KOD },
  { id: 'podpSbI',        get: (c) => c.podpisant && c.podpisant.sz_sb && c.podpisant.sz_sb.O_OTV_ISP },
  { id: 'podpSoglasP',    get: (c) => c.podpisant && c.podpisant.sz_soglasovanie && c.podpisant.sz_soglasovanie.PODP },
  { id: 'podpSoglasK',    get: (c) => c.podpisant && c.podpisant.sz_soglasovanie && c.podpisant.sz_soglasovanie.PODP_KOD },
  { id: 'podpSoglasI',    get: (c) => c.podpisant && c.podpisant.sz_soglasovanie && c.podpisant.sz_soglasovanie.O_OTV_ISP }
];

export const EdosSettings = {

  _cfg: null,      // эффективные настройки, отданные сервером
  _dirty: false,

  init() {
    // --- кнопки ---
    document.getElementById('btnEdoSave').onclick = () => this.save();
    document.getElementById('btnEdoTest').onclick = () => this.testConnection();
    document.getElementById('btnEdoReload').onclick = () => this.load();
    document.getElementById('btnEdoPwd').onclick = () => {
      const inp = document.getElementById('cfgPassword');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    };

    // --- вставка токена в поле темы по месту курсора ---
    document.querySelectorAll('.edo-tokens .tok').forEach((tok) => {
      tok.onclick = () => {
        const inp = document.getElementById(tok.parentElement.dataset.target);
        if (!inp) return;
        const token = tok.dataset.token;
        const pos = inp.selectionStart == null ? inp.value.length : inp.selectionStart;
        const before = inp.value.slice(0, pos);
        const after = inp.value.slice(inp.selectionEnd == null ? pos : inp.selectionEnd);
        inp.value = before + token + after;
        inp.focus();
        const newPos = pos + token.length;
        try { inp.setSelectionRange(newPos, newPos); } catch (e) { /* ignore */ }
        this._markDirty();
      };
    });

    // --- индикатор несохранённых правок + предупреждение при уходе ---
    FIELDS.forEach((f) => {
      const el = document.getElementById(f.id);
      if (!el) return;
      el.addEventListener(f.type === 'checkbox' ? 'change' : 'input', () => this._markDirty());
    });
    window.addEventListener('beforeunload', (e) => {
      if (this._dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    // --- первичная загрузка ---
    return this.load();
  },

  async load() {
    try {
      const r = await api('GET', '/api/edo-settings');
      if (r.error) { toast('Ошибка загрузки настроек: ' + r.error, 'error'); return; }
      this._cfg = r.config || {};
      this._cfgDirty = false;
      FIELDS.forEach((f) => {
        const el = document.getElementById(f.id);
        if (!el) return;
        const v = f.get(this._cfg);
        if (f.type === 'checkbox') el.checked = !!v;
        else el.value = v == null ? '' : String(v);
      });
      // ✅ T55: тип присвоения номера СЗ в СБ (радио sz_nomer.sz_sb);
      // пусто/не задано — «otlozh» (дефолт loadEdoConfig)
      const szMode = (this._cfg.sz_nomer && this._cfg.sz_nomer.sz_sb) === 'avto' ? 'avto' : 'otlozh';
      const rb = document.querySelector('input[name="szNomerSb"][value="' + szMode + '"]');
      if (rb) rb.checked = true;
      this._dirty = false;
      this._refreshDirty();
      toast('Настройки загружены из config/edo.json', 'success');
    } catch (e) {
      toast('Сетевая ошибка: ' + e.message, 'error');
    }
  },

  // Собираем объект из формы (те же поля, что в FIELDS)
  collect() {
    const val = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : '';
    };
    const chk = (id) => {
      const el = document.getElementById(id);
      return !!(el && el.checked);
    };
    return {
      url: val('cfgUrl'),
      docs_url: val('cfgDocsUrl'),
      username: val('cfgUsername'),
      password: val('cfgPassword'),
      reject_unauthorized: chk('cfgRejectUnauth'),
      tema: {
        sz_transport: val('temaTransport'),
        sz_sb: val('temaSb'),
        sz_soglasovanie: val('temaSoglas')
      },
      shablon: {
        sz_transport: val('shablonTransport'),
        sz_sb: val('shablonSb'),
        sz_soglasovanie: val('shablonSoglas')
      },
      podpisant: {
        sz_transport: { PODP: val('podpTransportP'), PODP_KOD: val('podpTransportK'), O_OTV_ISP: val('podpTransportI') },
        sz_sb: { PODP: val('podpSbP'), PODP_KOD: val('podpSbK'), O_OTV_ISP: val('podpSbI') },
        sz_soglasovanie: { PODP: val('podpSoglasP'), PODP_KOD: val('podpSoglasK'), O_OTV_ISP: val('podpSoglasI') }
      },
      // ✅ T55: тип присвоения номера СЗ в СБ ('avto' | 'otlozh');
      // радио не выбрано (страница ещё не загружена) — дефолт «otlozh»
      sz_nomer: {
        sz_sb: (document.querySelector('input[name="szNomerSb"]:checked') || {}).value || 'otlozh'
      }
    };
  },

  async save() {
    const btn = document.getElementById('btnEdoSave');
    const d = this.collect();
    // лёгкая проверка ДО отправки (дубль серверной — ради быстрых тостов)
    if (!String(d.url || '').trim()) { toast('Не задан URL портала', 'error'); return; }
    if (!/^https?:\/\//i.test(String(d.url).trim())) {
      toast('URL портала должен начинаться с http:// или https://', 'error');
      return;
    }
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/edo-settings', d);
      if (r.error) { toast('Ошибка сохранения: ' + r.error, 'error'); return; }
      this._cfg = r.config || this._cfg;
      this._dirty = false;
      this._refreshDirty();
      toast('Настройки сохранены (config/edo.json) — применяются сразу, без перезапуска', 'success');
    } catch (e) {
      toast('Сетевая ошибка: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  async testConnection() {
    const btn = document.getElementById('btnEdoTest');
    btn.disabled = true;
    try {
      // тестируем значения ПРЯМО ИЗ ФОРМЫ — можно проверить несохранённые
      const r = await api('POST', '/api/edo-settings/test', this.collect());
      if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
      if (r.ok && r.status && r.status < 400) {
        toast('Соединение с порталом установлено (HTTP ' + r.status + ')', 'success');
      } else if (r.ok && r.status) {
        toast('Сервер отвечает (HTTP ' + r.status + ') — проверьте URL и учётные данные', 'warning');
      } else {
        toast('Соединение не установлено: ' + (r.error || 'нет ответа'), 'error');
      }
    } catch (e) {
      toast('Сетевая ошибка: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  // --- служебное: индикатор правок ---
  _markDirty() {
    if (!this._dirty) { this._dirty = true; }
    this._refreshDirty();
  },
  _refreshDirty() {
    const el = document.getElementById('edoDirty');
    if (el) el.style.display = this._dirty ? '' : 'none';
  }
};
