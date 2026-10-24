// ============================================================
// grafik-resizer.js — РЕСАЙЗ КОЛОНОК В ГРАФИКЕ ИЗГОТОВЛЕНИЯ
// ------------------------------------------------------------
// Ширины колонок задаются ЧЕРЕЗ CSS-ПЕРЕМЕННЫЕ на общем предке
// .grafik-scroll-content (--gc-name/--gc-zak/--gc-sum/--gc-trud).
// Заголовки (.grafik-col-*) и ячейки строк (.grafik-cell-*) читают
// одни и те же переменные (см. grafik.css), поэтому:
//   • перерисовка тела (renderBody: фильтры, «Обновить», смена года,
//     WebSocket) больше НЕ сбивает выравнивание строк с заголовком;
//   • ресайзеру не нужно обходить все ячейки — достаточно обновить
//     переменные, любые новые строки подхватят ширину автоматически;
//   • суммарная ширина фиксированных блоков и min-width контейнера
//     скролла пересчитываются каскадом (var(--gc-total) + var(--gc-months)).
// ============================================================

export function initGrafikResizer() {
    // Конфигурация: «CSS-переменная + заголовок», пределы и стартовая ширина.
    // Значения width ДОЛЖНЫ совпадать с дефолтами переменных в grafik.css.
    const columns = [
        { cssVar: '--gc-name', header: '.grafik-col-name', minWidth: 200, maxWidth: 600, width: 300 },
        { cssVar: '--gc-firma', header: '.grafik-col-firma', minWidth: 60, maxWidth: 350, width: 140 }, /* t66 */
        { cssVar: '--gc-zak',  header: '.grafik-col-zak',  minWidth: 50,  maxWidth: 150, width: 70 },
        { cssVar: '--gc-sum',  header: '.grafik-col-sum',  minWidth: 60,  maxWidth: 150, width: 80 },
        { cssVar: '--gc-trud', header: '.grafik-col-trud', minWidth: 60,  maxWidth: 150, width: 80 }
    ];

    const root = document.querySelector('.grafik-scroll-content');
    if (!root) return;

    // 1. Стартовые ширины: публикуем переменные (совпадают с дефолтами CSS)
    applyWidths();

    // 2. Ресайзеры между соседними колонками
    columns.forEach((col, index) => {
        if (index < columns.length - 1) {
            createResizer(col, columns[index + 1]);
        }
    });

    // --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

    function totalWidth() {
        return columns.reduce((sum, c) => sum + c.width, 0);
    }

    /**
     * Публикует ширины в CSS-переменные на общем предке.
     * Заголовки, ВСЕ ячейки строк (текущие и будущие), фиксированные
     * блоки и min-width скролл-контейнера пересчитываются каскадом.
     */
    function applyWidths() {
        columns.forEach(c => root.style.setProperty(c.cssVar, `${c.width}px`));
        root.style.setProperty('--gc-total', `${totalWidth()}px`);
    }

    function createResizer(col1, col2) {
        const headerEl1 = document.querySelector(col1.header);
        if (!headerEl1) return;

        // Защита от дублирования ресайзеров
        if (headerEl1.querySelector('.grafik-col-resizer')) return;

        const resizer = document.createElement('div');
        resizer.className = 'grafik-col-resizer';
        resizer.title = 'Перетащите для изменения ширины';
        headerEl1.appendChild(resizer);
        headerEl1.style.position = 'relative';

        let isResizing = false;
        let startX = 0;
        let startWidth1 = 0;
        let startWidth2 = 0;

        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isResizing = true;
            startX = e.clientX;
            startWidth1 = col1.width;
            startWidth2 = col2.width;
            resizer.classList.add('active');
            document.body.classList.add('grafik-resizing');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const dx = e.clientX - startX;

            col1.width = Math.max(col1.minWidth, Math.min(col1.maxWidth, startWidth1 + dx));
            col2.width = Math.max(col2.minWidth, Math.min(col2.maxWidth, startWidth2 - dx));

            applyWidths();
        });

        document.addEventListener('mouseup', () => {
            if (!isResizing) return;
            isResizing = false;
            resizer.classList.remove('active');
            document.body.classList.remove('grafik-resizing');
        });
    }
}
