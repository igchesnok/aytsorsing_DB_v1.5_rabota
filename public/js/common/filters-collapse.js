// ============================================================
// filters-collapse.js — t73: сворачиваемый блок фильтров,
// единая схема для всех страниц проекта.
// ✅ T93: обрабатывается и .filter-panel (контейнер фильтров
// «Заказов по договорам») — та же шапка .filters-header,
// треугольник ▲/▼ и localStorage.
//
// Схема (как на странице «Формирование плана производства», t72):
//   над контейнером .filter-section создаётся шапка .filters-header —
//   лейбл «Фильтры» слева, кнопка-треугольник справа (▲ свернуть /
//   ▼ развернуть). Шапка видна ВСЕГДА, сам .filter-section при
//   сворачивании скрывается ЦЕЛИКОМ. Состояние — в localStorage
//   ✅ T83: элемент [data-filters-status] внутри секции переносится
//   в шапку — статусные блоки (например, «Статус запроса» на
//   offers.html) остаются видимыми при свёрнутых фильтрах.
//   с ключом по странице (filters_collapsed:<pathname>[__<N>]),
//   переживает перезагрузку. Значения фильтров не сбрасываются —
//   FilterableTable читает DOM независимо от видимости.
//
// Правило включения: блок обрабатывается, только если фильтров
// БОЛЬШЕ 2 (текстовые input + select; чекбоксы не считаются).
// Модуль подключён из common/ui/index.js (единая точка входа),
// запускается сам один раз на страницу. Страницы без .filter-section
// и блоки с 2 фильтрами и меньше не затрагиваются.
// ============================================================

const MIN_FILTERS = 3;   // включать при количестве фильтров > 2

function countFilters(section) {
    return section.querySelectorAll(
        'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select'
    ).length;
}

function storageKey(index) {
    let key = 'filters_collapsed:' + location.pathname;
    if (index > 0) key += '__' + index;
    return key;
}

function initFiltersCollapse() {
    const sections = document.querySelectorAll('.filter-section, .filter-panel');
    sections.forEach((section, index) => {
        // уже обёрнут (повторный запуск) — пропускаем
        if (section.closest('.filters-block')) return;
        // правило включения: фильтров больше 2
        if (countFilters(section) < MIN_FILTERS) return;

        // обёртка + шапка: «Фильтры» слева, кнопка-треугольник справа
        const block = document.createElement('div');
        block.className = 'filters-block';
        const header = document.createElement('div');
        header.className = 'filters-header';
        const title = document.createElement('span');
        title.className = 'filters-title';
        title.textContent = 'Фильтры';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'filter-toggle-btn';
        btn.id = index > 0 ? 'btnFiltersToggle__' + index : 'btnFiltersToggle';
        header.appendChild(title);
        // ✅ T83: элемент с [data-filters-status] (например, «Статус запроса»
        //   на странице «Внесение коммерческих предложений») переносится
        //   из сворачиваемой секции В ШАПКУ — статус виден всегда,
        //   независимо от состояния фильтров. Механизм общий: страница
        //   включает его атрибутом data-filters-status на своём блоке.
        const statusEl = section.querySelector('[data-filters-status]');
        if (statusEl) header.appendChild(statusEl);
        header.appendChild(btn);

        section.parentNode.insertBefore(block, section);
        block.appendChild(header);
        block.appendChild(section);

        const apply = (collapsed) => {
            block.classList.toggle('collapsed', collapsed);
            btn.textContent = collapsed ? '▼' : '▲';
            btn.title = collapsed ? 'Развернуть фильтры' : 'Свернуть фильтры';
        };
        const key = storageKey(index);
        apply(localStorage.getItem(key) === '1');
        btn.addEventListener('click', () => {
            const collapsed = !block.classList.contains('collapsed');
            apply(collapsed);
            localStorage.setItem(key, collapsed ? '1' : '0');
        });
    });
}

// модуль исполняется один раз (кэш ES-модулей); DOM уже разобран —
// скрипты страниц подключаются как type="module" (отложенные)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFiltersCollapse);
} else {
    initFiltersCollapse();
}

export { initFiltersCollapse };
