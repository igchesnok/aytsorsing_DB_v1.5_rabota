// ============================================================
// public/js/common/record-controller.js
// БАЗОВЫЙ ПРОТОКОЛ "ЗАПИСЬ + ФОРМА + БЛОКИРОВКА + WS"
//
// Не знает, из чего состоит форма — только то, что её можно
// заполнить/очистить и спросить, есть ли несохранённые изменения.
// Вся рутина (DirtyGuard перед сменой строки, снятие/синхронизация
// баннера блокировки, подписка на WebSocket) реализована здесь один раз.
//
// Подкласс/использующий модуль ОБЯЗАН предоставить:
//   - fillForm(row)     — заполнить форму данными строки
//   - clearForm()       — очистить форму (режим "новая запись")
//   - isDirty()         — есть ли несохранённые изменения
//   - getFormPanelEl()  — DOM-узел .form-panel (для баннера/класса editing)
//
// Опционально:
//   - afterSelect(row), afterHeaderClick()
//   - save(), del(), load()
// ============================================================

import { EditLock, isLocked, setHandlers } from './websocket.js';
import { DirtyGuard } from './dirty-guard.js';
import { batchManager } from './batch-update.js';
import { showLockBanner, removeLockBanner } from './ui/auto-lock.js';
import { initSyntheticSync, loadSubscriptions } from './synthetic-sync.js';

// Отдельный реестр — НЕ пересекается с реестром CrudModule (registerCrudModule),
// чтобы не ломать auto-lock.js, который ожидает от getCrudModuleByTable()
// именно экземпляр CrudModule с полем .form.
const _controllers = new Map();
export function registerRecordController(entity, ctrl) { _controllers.set(entity, ctrl); }
export function getRecordController(entity) { return _controllers.get(entity); }

export class RecordController {
  /**
   * @param {Object} config
   * @param {string} config.entity — имя таблицы БД (для WS/EditLock)
   * @param {Object} [config.syntheticHandlers] — если задано, WS настраивается
   *        через initSyntheticSync (сложные JOIN-таблицы)
   * @param {boolean} [config.wsSync=true] — простая WS-подписка, если
   *        syntheticHandlers не задан. false — WS настраивается вручную снаружи.
   */
  constructor({ entity, syntheticHandlers = null, wsSync = true }) {
    if (!entity) throw new Error('RecordController: entity обязателен');
    this.entity = entity;
    this._syntheticHandlers = syntheticHandlers;
    this._wsSync = wsSync;
    this.table = null;
    this._lastSelectedId = null;

    registerRecordController(entity, this);
  }

  // ============================================================
  // ОБЯЗАТЕЛЬНЫЕ ХУКИ — переопределяются использующим кодом
  // ============================================================
  fillForm(_row)   { throw new Error(`[RecordController:${this.entity}] fillForm() не реализован`); }
  clearForm()      { throw new Error(`[RecordController:${this.entity}] clearForm() не реализован`); }
  isDirty()        { return false; }
  getFormPanelEl() { return null; }

  // ============================================================
  // ОПЦИОНАЛЬНЫЕ ХУКИ
  // ============================================================
  async afterSelect(_row) {}
  async afterHeaderClick() {}
  async save() {}
  async del() {}
  async load() {}

  // ============================================================
  // ПУБЛИЧНОЕ API
  // ============================================================

  get selectedId() {
    return this._lastSelectedId ?? this.table?.selectedId ?? null;
  }

  /** Резолвер контекста для initCommonUI({ contextResolver }) */
  get contextResolver() {
    return () => (this.table ? { table: this.entity, id: this.table.selectedId } : null);
  }

  /**
   * Подключить уже созданную FilterableTable/VirtualTable к протоколу:
   * навешивает onBeforeSelect (DirtyGuard), onSelect, onHeaderClick,
   * getLockInfo (если ещё не задан).
   */
  attachTable(table) {
    this.table = table;

    const originalOnBeforeSelect = table.onBeforeSelect || null;
    table.onBeforeSelect = async () => {
      this._registerDirtyGuard();
      const proceed = await DirtyGuard.handleRecordChange();
      if (!proceed) return false;
      if (originalOnBeforeSelect) return await originalOnBeforeSelect();
      return true;
    };

    table.onSelect = (row) => this._onSelect(row);
    table.onHeaderClick = () => this._onHeaderClick();

    if (!table.getLockInfo) {
      table.getLockInfo = (item) => isLocked(this.entity, item[table.idKey]);
    }

    return this;
  }

  _registerDirtyGuard() {
    DirtyGuard.register(
      null,
      () => this.save(),
      () => this._onHeaderClick(),
      () => this.isDirty()
    );
  }

  async _onSelect(row) {
    this._registerDirtyGuard();
    this._lastSelectedId = row[this.table.idKey];
    this.fillForm(row);
    this._syncFormLockState(row);
    await this.afterSelect(row);
  }

  async _onHeaderClick() {
    this._registerDirtyGuard();

    const previousSelectedId = this._lastSelectedId;
    if (this.isDirty()) {
      const proceed = await DirtyGuard.handleRecordChange();
      if (!proceed) {
        if (previousSelectedId && this.table) this.table.selectById(previousSelectedId);
        return;
      }
    }

    this._lastSelectedId = null;
    this.clearForm();

    const panel = this.getFormPanelEl();
    if (panel) {
      removeLockBanner(panel);
      panel.classList.remove('editing');
    }

    await this.afterHeaderClick();
  }

  /** Синхронизировать баннер блокировки формы с isLocked() */
  _syncFormLockState(row = null) {
    const panel = this.getFormPanelEl();
    if (!panel) return;

    const id = row ? row[this.table?.idKey] : this.selectedId;
    if (!id) return;

    const locker = isLocked(this.entity, id);
    if (locker) {
      showLockBanner(panel, locker);
      panel.classList.remove('editing');
    } else {
      removeLockBanner(panel);
      if (!EditLock.current) panel.classList.remove('editing');
    }
  }

  /** Диспатч события после успешного CRUD — на него подписан auto-lock.js */
  dispatchCrudCompleted(action, entityId = null) {
    window.dispatchEvent(new CustomEvent('crud-completed', {
      detail: { action, entity: this.entity, entityId }
    }));
  }

  /**
   * Единая точка подключения WebSocket.
   * @param {Object} [extra]
   * @param {Function} [extra.updateButtons]
   * @param {Function} [extra.onDataChangedExtra] — только для синтетического режима
   */
  async initWsSync(extra = {}) {
    if (this._syntheticHandlers) {
      await loadSubscriptions();
      initSyntheticSync({
        pageKey: this.entity,
        syntheticHandlers: this._syntheticHandlers,
        updateButtons: extra.updateButtons,
        onLocksUpdate: () => this._syncFormLockState(),
        onDataChangedExtra: extra.onDataChangedExtra
      });
      return;
    }

    if (this._wsSync === false) return; // управляется вручную снаружи

    setHandlers({
      onDataChanged: (msg) => {
        if (batchManager.isProcessing(msg.table)) return;
        if (EditLock.current?.table === msg.table && EditLock.current?.id === msg.id) return;
        if (msg.table === this.entity) this.load();
      },
      updateButtons: extra.updateButtons,
      onLocksUpdate: () => this._syncFormLockState()
    });
  }

  /** Обёртка для массовых операций (подавляет собственное WS-эхо) */
  withBatch(fn) {
    return batchManager.withBatch(this.entity, fn);
  }
}