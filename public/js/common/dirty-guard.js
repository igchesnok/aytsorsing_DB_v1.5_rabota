// ============================================================
// public/js/common/dirty-guard.js
// ЕДИНЫЙ ШЛЮЗ ВЫХОДА ИЗ РЕЖИМА РЕДАКТИРОВАНИЯ
// ============================================================
import { EditLock } from './websocket.js';

export const DirtyGuard = {
    _formStateManager: null,
    _saveCallback: null,
    _resetCallback: null,
    _customDirtyCheck: null,
    _isModalOpen: false,

    // дополнительные callbacks отката (для блоков DualListBlock)
    _additionalRevertCallbacks: [],

    register(formStateManager, saveCallback, resetCallback, customDirtyCheck = null) {
        this._formStateManager = formStateManager;
        this._saveCallback = saveCallback;
        this._resetCallback = resetCallback;
        this._customDirtyCheck = customDirtyCheck;
    },

    unregister() {
        this._formStateManager = null;
        this._saveCallback = null;
        this._resetCallback = null;
        this._customDirtyCheck = null;
    },

    _isDirty() {
        if (this._customDirtyCheck) return this._customDirtyCheck();
        if (this._formStateManager) return this._formStateManager.isDirty();
        return false;
    },

      // ✅ НОВОЕ: регистрация дополнительного callback отката
    registerRevertCallback(callback) {
        if (!this._additionalRevertCallbacks.includes(callback)) {
        this._additionalRevertCallbacks.push(callback);
        }
    },

    unregisterRevertCallback(callback) {
        this._additionalRevertCallbacks =
        this._additionalRevertCallbacks.filter(cb => cb !== callback);
    },

    // ============================================================
    // ✅ НОВАЯ ЛОГИКА: две разные функции
    // ============================================================

    /**
     * handleExit() — тихое освобождение ресурса (блокировки).
     * Вызывается при: blur, focusout, неактивности, клике вне формы.
     *
     * НИКОГДА не показывает модалку.
     * Снимает блокировку, но НЕ трогает форму — данные пользователя остаются.
     */
    async handleExit() {
        if (EditLock.current) EditLock.release();;
        document.querySelectorAll('.form-panel.editing')
            .forEach(p => p.classList.remove('editing'));
        return true; 
    },

    /**
     * handleRecordChange() — проверка перед сменой записи.
     * Вызывается при:
     *   - клике по ДРУГОЙ строке таблицы
     *   - клике по заголовку (новая запись)
     *   - переключении вкладки
     *   - beforeunload
     *
     * Показывает модалку ТОЛЬКО если форма грязная.
     * @returns {Promise<boolean>} true = можно менять запись, false = отмена
     */
    async handleRecordChange() {
        // Нет блокировки ИЛИ форма чистая — можно менять запись
        if (!EditLock.current && !this._isDirty()) return true;
        if (!this._isDirty()) {
            // Форма чистая — просто освобождаем ресурс
            await this.handleExit();
            return true;
        }
        // Форма грязная — показываем модалку
        if (this._isModalOpen) return false;
        const result = await this._showModal();

        switch (result.action) {
            case 'save':
                if (this._saveCallback) await this._saveCallback();
                await this.handleExit();
                return true;
            case 'discard':
                if (this._formStateManager && this._formStateManager._initialSnapshot) {
                    this._formStateManager.revertChanges();
                } else if (this._resetCallback) {
                    this._resetCallback();
                }
                //  откатываем связанные блоки
                for (const cb of this._additionalRevertCallbacks) {
                await cb();
                }

                await this.handleExit();
                return true;
            case 'stay':
                // Возвращаем фокус
                if (result.previouslyFocused && typeof result.previouslyFocused.focus === 'function') {
                    setTimeout(() => {
                        try { result.previouslyFocused.focus(); } catch(e) {}
                    }, 10);
                }
                return false;
        }
        return false;
    },

    /**
     * for beforeunload — нативный confirm
     */
    handleBeforeUnload(e) {
        if (!this._isDirty()) return;
        e.preventDefault();
        e.returnValue = 'В форме есть несохранённые изменения. Уйти без сохранения?';
        return e.returnValue;
    },

    _showModal() {
        return new Promise(resolve => {
        this._isModalOpen = true;
        const previouslyFocused = document.activeElement;

        // ✅ АБСОЛЮТНОЕ ПЕРЕКРЫТИЕ: 100vw, 100vh, максимальный z-index, размытие фона
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0;
            width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.85); /* Очень темный фон */
            backdrop-filter: blur(5px); /* Размытие всего, что под модалкой */
            z-index: 2147483647; /* Максимально возможный z-index в CSS */
            display: flex;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.3s ease-out;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: #ffffff;
            border-radius: 12px;
            padding: 28px 32px;
            max-width: 480px;
            width: 90%;
            box-shadow: 0 25px 80px rgba(0, 0, 0, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.1);
            text-align: center;
        `;

        modal.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:center; gap:12px; margin-bottom:16px;">
            <span style="font-size:32px;">⚠️</span>
            <h3 style="margin:0; font-size:18px; color:#1f2328; font-weight:700;">
                Обнаружены несохраненные данные
            </h3>
            </div>
            <p style="margin:0 0 24px; font-size:14px; color:#57606a; line-height:1.6;">
            Вы переключились на другую запись или заголовок таблици.<br>
            Чтобы не блокировать работу коллег, режим редактирования будет приостановлен.<br>
            <strong style="color:#cf222e;">Что сделать с несохранёнными изменениями?</ strong>
            </p>
            <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
            <button data-action="stay" style="
                padding:10px 20px; border:1px solid #d0d7de; border-radius:6px;
                background:#f6f8fa; cursor:pointer; font-size:14px; font-weight:600; color:#24292f;
                transition: all 0.2s;">
                ✏️ Остаться
            </button>
            <button data-action="discard" style="
                padding:10px 20px; border:1px solid #cf222e; border-radius:6px;
                background:#fff; cursor:pointer; font-size:14px; font-weight:600; color:#cf222e;
                transition: all 0.2s;">
                🗑 Сбросить
            </button>
            <button data-action="save" style="
                padding:10px 20px; border:none; border-radius:6px;
                background:#1a7f37; cursor:pointer; font-size:14px; font-weight:600; color:#fff;
                box-shadow: 0 4px 12px rgba(26, 127, 55, 0.3);
                transition: all 0.2s;">
                💾 Сохранить
            </button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Добавляем анимацию появления в стиль документа (если её нет)
        if (!document.getElementById('dirty-guard-anim')) {
            const style = document.createElement('style');
            style.id = 'dirty-guard-anim';
            style.textContent = `@keyframes fadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }`;
            document.head.appendChild(style);
            // Убираем стиль после использования, чтобы не засорять DOM
            setTimeout(() => style.remove(), 1000);
        }

        const cleanup = () => {
            this._isModalOpen = false;
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            document.removeEventListener('keydown', onKey);
        };

        // ✅ ОСТАНАВЛИВАЕМ ВСПЛЫТИЕ, чтобы клики по модалке не триггерили auto-lock
        overlay.addEventListener('click', e => e.stopPropagation());
        
        modal.addEventListener('click', e => {
            e.stopPropagation();
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            
            // Визуальный фидбек нажатия
            btn.style.transform = 'scale(0.95)';
            setTimeout(() => {
            const action = btn.dataset.action;
            cleanup();
            resolve({ action, previouslyFocused });
            }, 100);
        });

        const onKey = e => {
            if (e.key === 'Escape') {
            e.preventDefault(); // Запрещаем закрытие по Esc, чтобы заставить выбрать действие
            // Но для удобства считаем Esc как "Остаться"
            cleanup();
            resolve({ action: 'stay', previouslyFocused });
            }
        };
        document.addEventListener('keydown', onKey);
        });
    },

    /**
     * Обработка конфликта: данные на сервере изменились
     * с момента последнего fillFromRow().
     * 
     * @param {Object} result - результат checkForExternalChanges()
     * @param {Array} result.changes - массив изменений
     * @param {Object} result.serverData - актуальные данные с сервера
     */
    async handleExternalConflict(result) {
        if (this._isModalOpen) return;
        
        const action = await this._showConflictModal(result);
        
        switch (action) {
            case 'continue':
                // Продолжить редактирование (сохранить свои изменения)
                 if (this._formStateManager && result.serverData) {
                    this._formStateManager.acknowledgeExternalChanges(result.serverData);
                }
                break;
                
            case 'reload':
                // Перезагрузить данные с сервера (отказаться от своих изменений)
                // Вызываем fillFromRow с актуальными данными
                if (this._formStateManager && result.serverData) {
                    this._formStateManager.fillFromRow(result.serverData);
                }
                break;
                
            case 'cancel':
                // Отмена — остаться в форме, но не сохранять
                 if (this._formStateManager && result.serverData) {
                    this._formStateManager.acknowledgeExternalChanges(result.serverData);
                }
                break;
        }
    },

    /**
     * Модалка конфликта данных
     */
    _showConflictModal(result) {
        return new Promise(resolve => {
            this._isModalOpen = true;
            
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed; top: 0; left: 0;
                width: 100vw; height: 100vh;
                background: rgba(0, 0, 0, 0.85);
                backdrop-filter: blur(5px);
                z-index: 2147483647;
                display: flex; align-items: center; justify-content: center;
            `;
            
            const modal = document.createElement('div');
            modal.style.cssText = `
                background: #ffffff; border-radius: 12px;
                padding: 28px 32px; max-width: 600px; width: 90%;
                box-shadow: 0 25px 80px rgba(0, 0, 0, 0.6);
            `;
            
            // Формируем список изменений
            const changesList = result.changes.slice(0, 10).map(c =>
                `<li><b>${c.label || c.key}:</b> было ${c.snapshot}, стало ${c.server}</li>`
            ).join('');
            
            const moreCount = result.changes.length > 10 ? result.changes.length - 10 : 0;
            const moreText = moreCount > 0 ? `<li>... и ещё ${moreCount} изменений</li>` : '';
            
            modal.innerHTML = `
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
                    <span style="font-size:32px;">⚠️</span>
                    <h3 style="margin:0; font-size:18px; color:#cf222e; font-weight:700;">
                        Конфликт данных
                    </h3>
                </div>
                <p style="margin:0 0 16px; font-size:14px; color:#1f2328; line-height:1.6;">
                    <strong>Другой пользователь изменил эту запись!</strong><br>
                    Ваши несохранённые изменения могут конфликтовать с актуальными данными.
                </p>
                <div style="margin:0 0 20px; padding:12px; background:#fff3cd; border:1px solid #ffc107; border-radius:6px; font-size:12px;">
                    <strong>Изменения на сервере:</strong>
                    <ul style="margin:8px 0 0 20px; padding:0;">
                        ${changesList}
                        ${moreText}
                    </ul>
                </div>
                <p style="margin:0 0 20px; font-size:13px; color:#656d76;">
                    Что вы хотите сделать?
                </p>
                <div style="display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap;">
                    <button data-action="cancel" style="
                        padding:10px 20px; border:1px solid #d0d7de; border-radius:6px;
                        background:#fff; cursor:pointer; font-size:14px; font-weight:600;
                    ">Отмена</button>
                    <button data-action="reload" style="
                        padding:10px 20px; border:1px solid #0969da; border-radius:6px;
                        background:#fff; cursor:pointer; font-size:14px; font-weight:600; color:#0969da;
                    ">🔄 Перезагрузить</button>
                    <button data-action="continue" style="
                        padding:10px 20px; border:none; border-radius:6px;
                        background:#bf8700; cursor:pointer; font-size:14px; font-weight:600; color:#fff;
                    ">✏️ Продолжить редактирование</button>
                </div>
            `;
            
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            
            const cleanup = () => {
                this._isModalOpen = false;
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            };
            
            overlay.addEventListener('click', e => e.stopPropagation());
            modal.addEventListener('click', e => {
                e.stopPropagation();
                const btn = e.target.closest('button[data-action]');
                if (!btn) return;
                cleanup();
                resolve(btn.dataset.action);
            });
        });
    }

};
