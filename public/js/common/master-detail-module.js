// common/master-detail-module.js
import { CrudModule } from './crud-module.js';
import { state } from './state.js';

export class MasterDetailModule {
  constructor(config) {
    this.config = config;
    this.master = null;
    this.children = {};
    this.standalone = {};
    this.selectedMasterId = null;
  }

  async init() {
    // 1. Создаём мастер-модуль
    this.master = new CrudModule(this.config.master, {
      tableContainerId: this.config.master.tableContainerId,
      formTitleId: this.config.master.formTitleId,
      buttons: this.config.master.buttons,
      importConfig: this.config.master.importConfig, // ✅ прокинули
      hooks: {
        onSelect: (row) => this._onMasterSelect(row),
        onHeaderClick: () => this._onMasterHeaderClick(),
        afterLoad: () => {
          state._allFirms = this.master.table?.data || [];
        }
      }
    });

    // 2. Создаём дочерние модули с parentEntity
    for (const childCfg of this.config.children) {
      const child = new CrudModule(childCfg, {
        tableContainerId: childCfg.tableContainerId,
        formTitleId: childCfg.formTitleId,
        buttons: childCfg.buttons,
        importConfig: childCfg.importConfig, // ✅ прокинули
        getParentId: () => this.selectedMasterId,
        hooks: {
          onSelect: () => this._updateChildTitles(),
          onHeaderClick: () => this._updateChildTitles(),
          // Инжектим id мастера перед сохранением
          beforeSave: (payload) => {
            payload[childCfg.fkField] = this.selectedMasterId;
            return payload;
          }
        }
      });
      this.children[childCfg.entity] = child;
    }

    // 3. Создаём standalone модули
    for (const cfg of (this.config.standalone || [])) {
      this.standalone[cfg.entity] = new CrudModule(cfg, {
        tableContainerId: cfg.tableContainerId,
        formTitleId: cfg.formTitleId,
        buttons: cfg.buttons,
        importConfig: cfg.importConfig, // ✅ прокинули
      });
    }

    // 4. Инициализируем всё
    await this.master.init();
    for (const child of Object.values(this.children)) {
      await child.init();
      child.setEnabled(false); // блокируем до выбора мастера
    }
    for (const std of Object.values(this.standalone)) {
      await std.init();
    }

    // Кастомная валидация ИНН
    this._initInnValidation();

    // 5. Обновляем заголовки и блокируем дочерние вкладки
    this._updateChildTitles();
    this._updateTabsState(false);
  }

  _initInnValidation() {
    const innInput = document.getElementById('fInn');
    if (!innInput) return;

    innInput.addEventListener('input', () => {
      const val = innInput.value.replace(/\D/g, '');
      const isValid = val.length === 10 || val.length === 12;
      const hint = document.getElementById('innHint');
      if (hint) hint.textContent = (innInput.value && !isValid) ? 'ИНН: 10 или 12 цифр' : '';
      innInput.className = innInput.value ? (isValid ? 'valid' : 'invalid') : '';
      this.master.updateButtonStates();
    });
  }

  _onMasterSelect(row) {
    this.selectedMasterId = row[this.config.master.idKey];
    state.selectedFirmaId = this.selectedMasterId; // Обратная совместимость

    this._updateTabsState(true);

    for (const child of Object.values(this.children)) {
      child.setEnabled(true);
      child.load();
    }
    this._updateChildTitles();
  }

  _onMasterHeaderClick() {
    this.selectedMasterId = null;
    state.selectedFirmaId = null;

    this._updateTabsState(false);

    for (const child of Object.values(this.children)) {
      child.setEnabled(false);
      child.clear();
    }
    this._updateChildTitles();
  }

  _updateTabsState(hasSelection) {
    document.querySelectorAll('.tab').forEach(tab => {
      const tabId = tab.dataset.tab;
      const isMaster = tabId === this.config.master.tabId;
      const isStandalone = this.config.standalone?.some(s => s.tabId === tabId);

      if (!isMaster && !isStandalone) {
        tab.disabled = !hasSelection;
      }
    });
  }

  _updateChildTitles() {
    const masterName = this.selectedMasterId
      ? (this.master.form?.buildPayload()?.naimenovanie || '')
      : '';

    for (const childCfg of this.config.children) {
      if (childCfg.titleId) {
        const el = document.getElementById(childCfg.titleId);
        if (el) {
          el.textContent = childCfg.tableTitle + (masterName ? ` — ${masterName}` : '');
        }
      }
    }
  }

  async loadMaster() { await this.master.load(); }
  async loadStandalone() {
    for (const module of Object.values(this.standalone)) {
      await module.load();
    }
  }

  getMaster() { return this.master; }
  getChild(entity) { return this.children[entity]; }
  getStandalone(entity) { return this.standalone[entity]; }
}
