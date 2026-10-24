// ============================================================
// js/common/ui/auto-lock.js
// МОДУЛЬ: АВТОМАТИЧЕСКАЯ БЛОКИРОВКА РЕДАКТИРУЕМЫХ ЗАПИСЕЙ
// ============================================================
// 
// 📋 НАЗНАЧЕНИЕ МОДУЛЯ:
// Данный модуль обеспечивает автоматическую блокировку записей при их 
// редактировании, предотвращая одновременное изменение одних и тех же 
// данных разными пользователями (оптимистичная блокировка через WebSocket).
//
// 🎯 КЛЮЧЕВЫЕ МЕХАНИЗМЫ:
// 1. Фокус на поле ввода → попытка заблокировать запись
// 2. Потеря фокуса → автоматическое снятие блокировки
// 3. Клик по строке таблицы или кнопке → блокировка связанной записи
//
// 🔐 ПРИНЦИП РАБОТЫ:
// - contextResolver: функция, возвращающая {table, id} текущей записи
// - EditLock: глобальный менеджер блокировок (WebSocket-based)
// - isLocked: проверка, заблокирована ли запись другим пользователем
// - Баннер: визуальная индикация блокировки в форме
//
// ⚠️ ВАЖНО ДЛЯ ИИ:
// - Модуль НЕ знает о конкретной бизнес-логике страниц
// - Вся специфика передаётся через contextResolver из app-*.js
// - Блокировка работает на уровне UI, не на уровне БД
// - WebSocket синхронизирует блокировки между всеми клиентами
//
// ============================================================
import { getLockAwareRecord } from '../lock-aware-registry.js';
import { EditLock, isLocked, getLockerName } from '../websocket.js';
import { toast } from '../utils.js';
import { DirtyGuard } from '../dirty-guard.js';
/**
 * Проверяет, является ли элемент кнопкой CRUD-действия
 * (Add/Save/Del/Paste) — такие кнопки НЕ должны вызывать
 * снятие блокировки, т.к. они работают с той же записью.
 */
function isCrudButton(el) {
  if (!el) return false;
  // Вариант 1: по data-атрибуту (рекомендуется)
  if (el.closest('[data-crud]')) return true;
  // Вариант 2: по id-паттерну (fallback для старых страниц)
  const btn = el.closest('button');
  if (btn && btn.id) {
    const id = btn.id.toLowerCase();
    // Паттерны: btnCexSave, btnCexAdd, btnCexDel, btnCexPaste,
    //           btnTechSave, btnOsnSave, btnPlanSave и т.д.
    if (/\b(add|save|del|delete|paste)\b/.test(id)) return true;
  }
  return false;
}
/**
 * Инициализирует автоматическую блокировку записей при редактировании.
 * 
 * @param {Function} contextResolver - функция, возвращающая объект {table: string, id: string}
 *                                     для определения текущей редактируемой записи.
 *                                     Должна возвращать null, если нет активной записи.
 * 
 * @example
 * // В app-plan.js:
 * initAutoLock(() => ({
 *     table: 'plan',
 *     id: state.tables.plan.selectedId
 * }));
 * 
 * @returns {void}
 */
export function initAutoLock(contextResolver) {
    // Защита от вызова без contextResolver
    if (!contextResolver) {
        console.warn('[AutoLock] contextResolver не передан — блокировка не будет работать');
        return;
    }

    // ============================================================
    // МЕХАНИЗМ 1: ФОКУС НА ПОЛЕ ВВОДА
    // ============================================================
    // Срабатывает при клике/табе на input, select, textarea
    // Попытка заблокировать запись, к которой относится поле
    // ============================================================
    document.addEventListener('focusin', async (e) => {
        const input = e.target;
        // Проверяем, что фокус на редактируемом элементе формы
        if (!input.matches?.('input, select, textarea')) return;
        // Находим родительскую форму
        const formPanel = input.closest('.form-panel');
        if (!formPanel) return;

        const ctx = contextResolver();
        const ctxTable = ctx?.table; // Имя таблицы текущей редактируемой записи (или undefined, если ctx нет)
        const ctxId = ctx?.id;       // ID текущей редактируемой записи (или undefined, если ctx нет)
        // Режим "новая запись" — блокировка не нужна
        if (!ctx || !ctxId) return;

        // ✅ НОВОЕ: Перерегистрируем DirtyGuard на форму, на которую кликнул пользователь
        // Перерегистрируем DirtyGuard на запись, на которую кликнул пользователь.
        const lockAware = getLockAwareRecord(ctx.table);
        if (lockAware) {
            DirtyGuard.register(
                lockAware.form || null,
                () => lockAware.save(),
                () => lockAware.onHeaderClick(),
                lockAware.isDirty || null // ✅ Передаём комбинированную проверку, если она есть
            );
        }
        // Текущий объект блокировки (если мы уже что-то редактируем)
        const currentLock = EditLock.current;
        const isSameTable = currentLock?.table === ctxTable;
        const isSameId = currentLock?.id === ctxId;
        // Если совпадают и таблица, и ID — значит, это наша блокировка, просто сбрасываем таймер
        if (isSameTable && isSameId)  return EditLock.resetInactivity(); 
        // ❌ ПРОВЕРКА: заблокирована другим пользователем
        const locker = isLocked(ctxTable, ctxId);
        if (locker) {
            toast(`🔒 Запись редактирует: ${locker}`, 'warning');
            showLockBanner(formPanel, locker); // Показываем баннер
            input.blur(); // Убираем фокус — поле недоступно
            return;
        }
        // 🔄 Снимаем предыдущую блокировку (если была на другой записи)
        if (currentLock) EditLock.release();
        // ✅ ПЫТАЕМСЯ ЗАБЛОКИРОВАТЬ
        const ok = await EditLock.acquire(ctxTable, ctxId);
        if (ok) {
            formPanel.classList.add('editing'); // Визуальный индикатор редактирования
            removeLockBanner(formPanel); // Убираем баннер, если был
            // ✅ Проверяем, не изменились ли данные на сервере
            // Если форма dirty — делаем запрос актуальных данных
            if (DirtyGuard._isDirty()) {
                // Получаем экземпляр CrudModule из контекста
                const lockAware = getLockAwareRecord(ctx.table);
                if (lockAware && typeof lockAware.checkForExternalChanges === 'function') {
                    const result = await lockAware.checkForExternalChanges();
                    if (result.changed) {
                    await DirtyGuard.handleExternalConflict(result);
                    } else if (result.deleted) {
                    toast('⚠️ Запись была удалена другим пользователем', 'warning');
                    lockAware.onHeaderClick();
                    }
                }
            }
        } else {
            input.blur(); // Не удалось — убираем фокус
        }
    });

    // ============================================================
    // МЕХАНИЗМ 2: ПОТЕРЯ ФОКУСА (ИСПРАВЛЕННЫЙ RACE CONDITIO)
    // ============================================================
    // Срабатывает при уходе фокуса с ЛЮБОГО элемента
    // Автоматически снимает блокировку, если пользователь ушёл из формы
    // ============================================================
    document.addEventListener('focusout', (e) => {
        // 1. Ищем форму, которая сейчас находится в режиме редактирования
        const formPanel = e.target.closest('.form-panel.editing');
        if (!formPanel) return; // Если нет формы в режиме editing — ничего не делаем
        // ✅ 2. ЗАПОМИНАЕМ контекст (таблицу и ID) на момент потери фокуса
        const ctx = contextResolver();
        const scheduledTable = ctx?.table;
        const scheduledId = ctx?.id;
        // ⏱️ ЗАДЕРЖКА 200мс: даём браузеру время передать фокус новому элементу
        setTimeout(async () => {
            const activeEl = document.activeElement;
            // 3. Если фокус перешёл на кнопку CRUD — НЕ снимаем блокировку
            if (isCrudButton(activeEl))    return EditLock.resetInactivity();
            // 4. Если фокус остался внутри редактируемой формы — НЕ снимаем
            if (formPanel.contains(activeEl))  return;
            // ✅ 5. КРИТИЧЕСКАЯ ПРОВЕРКА RACE CONDITION:
            // Если блокировка уже переоформлена на ДРУГУЮ (новую) запись, не трогаем её!
            if (EditLock.current && 
                (EditLock.current.table !== scheduledTable || EditLock.current.id !== scheduledId)) {
                console.log(`[AutoLock] ⏭ Блокировка уже переоформлена на ${EditLock.current.table}:${EditLock.current.id}, отмена снятия`);
                return;
            }
            // 6. Фокус ушёл за пределы формы для той же записи — запрашиваем действие
            await DirtyGuard.handleExit();
        }, 200);
    });
  // ============================================================
    // МЕХАНИЗМ 3: КЛИК ПО СТРОКЕ ТАБЛИЦЫ ИЛИ КНОПКЕ
    // ============================================================
    document.addEventListener('click', async (e) => {
        if (isCrudButton(e.target)) {
            if (EditLock.current) EditLock.resetInactivity();
            return;
        }

        const clickedFormPanel = e.target.closest('.form-panel');
        if (!clickedFormPanel) {
            if (EditLock.current) {
                // ✅ ПЕРЕДАЁМ целевой элемент (куда кликнул)
                await DirtyGuard.handleExit();
            }
            return;
        }

        if (e.target.closest('.vtable-header') ||
            e.target.closest('.vtable-header-grouped')) return;

        const isRowClick = !!e.target.closest('.vtable-row');
        const isButtonClick = !!e.target.closest('button');
        if (!isRowClick && !isButtonClick) return;

        const ctx = contextResolver();
        if (!ctx || !ctx.id) return;

        if (EditLock.current?.table === ctx.table && EditLock.current?.id === ctx.id) {
            EditLock.resetInactivity();
            return;
        }

        const locker = isLocked(ctx.table, ctx.id);
        if (locker) {
            toast(`🔒 Запись редактирует: ${locker}`, 'warning');
            showLockBanner(clickedFormPanel, locker);
            return;
        }

     

        const ok = await EditLock.acquire(ctx.table, ctx.id);
        if (ok) {
            clickedFormPanel.classList.add('editing');
            removeLockBanner(clickedFormPanel);
        }
    });

    
    // ============================================================
    // ✅ НОВЫЙ МЕХАНИЗМ 4: СБРОС РЕЖИМА ПОСЛЕ CRUD-ОПЕРАЦИИ
    // ============================================================
    // Слушаем кастомное событие 'crud-completed', которое диспатчит
    // CrudModule после успешного завершения add/save/del.
    //
    // Логика:
    //   - add: режим редактирования СБРАСЫВАЕТСЯ (операция завершена)
    //   - save: режим редактирования СБРАСЫВАЕТСЯ (операция завершена)
    //   - del: режим редактирования СБРАСЫВАЕТСЯ (запись удалена)
    // ============================================================
    window.addEventListener('crud-completed', async (e) => {
        const { action, entity, entityId } = e.detail;
        console.log(`[AutoLock] 🔔 CRUD completed: ${action} (${entity}, id=${entityId})`);

        switch (action) {
            case 'save': 
                await DirtyGuard.handleExit();
                break;
            case 'del':
                await DirtyGuard.handleExit();
                break;
            case 'add':
                await DirtyGuard.handleExit();
                break;
        }
    });
 
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ: УПРАВЛЕНИЕ БАННЕРОМ БЛОКИРОВКИ
// ============================================================

/**
 * Показывает баннер блокировки в форме и блокирует все поля.
 * 
 * @param {HTMLElement} formPanel - элемент формы (.form-panel)
 * @param {string} lockerName - имя пользователя, заблокировавшего запись
 * 
 * @example
 * showLockBanner(formPanel, 'Иванов И.И.');
 * // Результат: появляется жёлтый баннер с иконкой 🔒
 * // Все input/select/textarea становятся disabled
 */
function showLockBanner(formPanel, lockerName) {
    // Удаляем предыдущий баннер, если был
    removeLockBanner(formPanel);
    
    // Создаём новый баннер
    const banner = document.createElement('div');
    banner.className = 'lock-banner';
    banner.innerHTML = `
        <span class="lock-banner-icon">🔒</span>
        <span class="lock-banner-text">
            Запись редактирует: <strong>${escapeHtml(lockerName)}</strong>
        </span>
    `;
    
    // Вставляем баннер в начало формы
    formPanel.insertBefore(banner, formPanel.firstChild);
    
    // Блокируем все редактируемые поля
    formPanel.querySelectorAll('input, select, textarea').forEach(el => {
        if (!el.readOnly) {
            // Запоминаем исходное состояние disabled
            el.dataset.wasDisabled = el.disabled ? 'true' : 'false';
            el.disabled = true;
        }
    });
}

/**
 * Удаляет баннер блокировки и разблокирует все поля.
 * 
 * @param {HTMLElement} formPanel - элемент формы (.form-panel)
 * 
 * @example
 * removeLockBanner(formPanel);
 * // Результат: баннер удаляется, поля становятся доступными
 * // (если они не были disabled изначально)
 */
function removeLockBanner(formPanel) {
    // Удаляем баннер
    const banner = formPanel.querySelector('.lock-banner');
    if (banner) banner.remove();
    
    // Разблокируем поля, которые были заблокированы баннером
    formPanel.querySelectorAll('input, select, textarea').forEach(el => {
        // Разблокируем только если поле не было disabled изначально
        if (el.dataset.wasDisabled === 'false') {
            el.disabled = false;
        }
        delete el.dataset.wasDisabled; // Очищаем метаданные
    });
}

/**
 * Экранирует HTML-специальные символы для безопасного вывода в DOM.
 * 
 * @param {string} str - строка для экранирования
 * @returns {string} - экранированная строка
 * 
 * @example
 * escapeHtml('<script>alert("XSS")</script>');
 * // Результат: '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;'
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

// ============================================================
// ЭКСПОРТ ДЛЯ ВНЕШНЕГО ИСПОЛЬЗОВАНИЯ
// ============================================================
// Эти функции могут быть вызваны из других модулей для ручного
// управления баннером блокировки (например, при обновлении данных)
// ============================================================
export { showLockBanner, removeLockBanner, escapeHtml };