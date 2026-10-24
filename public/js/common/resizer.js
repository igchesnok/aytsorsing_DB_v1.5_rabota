// ============================================================
// РЕСАЙЗ ПАНЕЛЕЙ
// ============================================================
import { state } from './state.js';

export function initResizers() {
  document.querySelectorAll('.resizer').forEach(resizer => {
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const panel = resizer.closest('.panel');
      const formPanel = resizer.nextElementSibling;
      if (!panel || !formPanel) return;

      const isVertical = getComputedStyle(panel).flexDirection === 'column';
      resizer.classList.add('active');

      if (isVertical) {
        document.body.classList.add('resizing-vertical');
        formPanel.style.width = '';
        formPanel.style.minWidth = '';
        formPanel.style.maxWidth = '';

        const startY = e.clientY;
        const startHeight = formPanel.offsetHeight;

        const onMove = (ev) => {
          const dy = ev.clientY - startY;
          let newHeight = startHeight - dy;
          const min = 150;
          const max = Math.max(200, window.innerHeight * 0.75);
          newHeight = Math.max(min, Math.min(max, newHeight));
          formPanel.style.height = newHeight + 'px';
          formPanel.style.minHeight = newHeight + 'px';
          formPanel.style.maxHeight = newHeight + 'px';
          Object.values(state.tables).forEach(tb => tb && tb.refresh());
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          resizer.classList.remove('active');
          document.body.classList.remove('resizing-vertical');
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      } else {
        document.body.classList.add('resizing');
        formPanel.style.height = '';
        formPanel.style.minHeight = '';
        formPanel.style.maxHeight = '';

        const startX = e.clientX;
        const startWidth = formPanel.offsetWidth;
        const panelWidth = panel.clientWidth;

        const onMove = (ev) => {
          const dx = startX - ev.clientX;
          let newWidth = startWidth + dx;
          const min = 280;
          const max = Math.max(300, panelWidth * 0.65);
          newWidth = Math.max(min, Math.min(max, newWidth));
          formPanel.style.width = newWidth + 'px';
          formPanel.style.minWidth = newWidth + 'px';
          formPanel.style.maxWidth = newWidth + 'px';
          Object.values(state.tables).forEach(tb => tb && tb.refresh());
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          resizer.classList.remove('active');
          document.body.classList.remove('resizing');
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }
    });
  });
}

export function resetResizerStylesOnResize() {
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      document.querySelectorAll('.panel').forEach(panel => {
        const formPanel = panel.querySelector('.form-panel');
        if (!formPanel) return;
        const isVertical = getComputedStyle(panel).flexDirection === 'column';
        if (isVertical) {
          formPanel.style.width = '';
          formPanel.style.minWidth = '';
          formPanel.style.maxWidth = '';
        } else {
          formPanel.style.height = '';
          formPanel.style.minHeight = '';
          formPanel.style.maxHeight = '';
        }
        Object.values(state.tables).forEach(tb => tb && tb.refresh());
      });
    }, 100);
  });
}