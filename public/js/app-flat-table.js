// ============================================================
// public/js/app-flat-table.js
// ОТЧЁТ «Плоская таблица» (блок «Отчеты» главной страницы)
// При открытии страницы отчёт формируется автоматически и
// показывается предпросмотр Excel с запросом дальнейших действий:
// «Скачать Excel» или «Закрыть» (как у СЗ на транспорт / заказов).
// ============================================================
import { api, toast } from './common/utils.js';
import { auth } from './common/auth.js';

// Проверка авторизации (как на других страницах)
if (!auth.isAuthenticated()) {
    window.location.href = '/pages/login.html';
}

const selGod = document.getElementById('fltGod');
const selFirma = document.getElementById('fltFirma');
const btnGenerate = document.getElementById('btnGenerate');
const info = document.getElementById('reportInfo');

// ---------- фильтры ----------
async function loadFilters() {
    try {
        const r = await api('GET', '/api/reports/flat-table-filters');
        if (r.error) return; // не критично — отчёт можно строить и без фильтров

        (r.gody || []).forEach(g => {
            const o = document.createElement('option');
            o.value = g; o.textContent = g;
            selGod.appendChild(o);
        });
        (r.firmy || []).forEach(f => {
            const o = document.createElement('option');
            o.value = f.id_firmy; o.textContent = f.naimenovanie;
            selFirma.appendChild(o);
        });
    } catch (e) {
        console.error('[flat-table] loadFilters:', e);
    }
}

// ---------- формирование отчёта ----------
async function generate() {
    btnGenerate.disabled = true;
    info.className = 'ft-info';
    info.textContent = 'Формирование отчёта...';

    try {
        const params = new URLSearchParams();
        if (selGod.value) params.set('god', selGod.value);
        if (selFirma.value) params.set('id_firma', selFirma.value);

        const r = await api('GET', '/api/reports/flat-table?' + params.toString());
        if (r.error) {
            info.className = 'ft-info err';
            info.textContent = 'Ошибка: ' + r.error;
            toast('Ошибка формирования отчёта: ' + r.error, 'error');
            return;
        }

        info.className = 'ft-info ok';
        info.textContent = `Готово: строк в отчёте — ${r.rowCount}. Файл: ${r.fileName}`;

        showPreview(r);
    } catch (e) {
        info.className = 'ft-info err';
        info.textContent = 'Ошибка: ' + e.message;
        toast('Ошибка: ' + e.message, 'error');
    } finally {
        btnGenerate.disabled = false;
    }
}

// ---------- предпросмотр (модальное окно + запрос дальнейших действий) ----------
function showPreview(r) {
    // убираем предыдущее окно, если было
    document.querySelectorAll('.ft-overlay').forEach(o => o.remove());

    const overlay = document.createElement('div');
    overlay.className = 'ft-overlay';

    const modal = document.createElement('div');
    modal.className = 'ft-modal';

    const header = document.createElement('div');
    header.className = 'ft-modal-header';
    header.innerHTML = `
        <h2>📋 Предпросмотр: «Плоская таблица»
            <span>строк: ${r.rowCount} · ${r.fileName}</span></h2>
        <div class="ft-modal-btns">
            <a id="ftDownload" class="btn" href="${r.path}" download>⬇ Скачать Excel</a>
            <button id="ftClose">✖ Закрыть</button>
        </div>`;

    const body = document.createElement('div');
    body.className = 'ft-modal-body';
    const iframe = document.createElement('iframe');
    iframe.srcdoc = r.preview;
    body.appendChild(iframe);

    modal.appendChild(header);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const cleanup = () => {
        document.removeEventListener('keydown', escHandler);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    modal.querySelector('#ftClose').addEventListener('click', cleanup);
    const escHandler = (e) => { if (e.key === 'Escape') cleanup(); };
    document.addEventListener('keydown', escHandler);
}

// ---------- инициализация ----------
btnGenerate.addEventListener('click', generate);

// при открытии страницы — сразу сформировать и показать предпросмотр
loadFilters().then(generate).catch(e => {
    console.error('[flat-table] init:', e);
    info.className = 'ft-info err';
    info.textContent = 'Ошибка: ' + e.message;
});
