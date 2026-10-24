// ============================================================
// public/js/common/excel-preview.js
// ОБЩИЙ МОДУЛЬ: ПРЕВЬЮ EXCEL ПЕРЕД ОТПРАВКОЙ
// Переиспользуется в requests.js и orders.js
// ============================================================

import { esc } from './utils.js';   // ✅ T100: экранирование текста письма

/**
 * Показывает модальное окно с превью HTML-документов (Excel → HTML).
 * Пользователь может подтвердить отправку или отменить.
 *
 * @param {Object} previews - { key1: htmlString, key2: htmlString, ... }
 * @param {Object} [tabsConfig] - настройки вкладок
 *   { key: { label: '📄 Заявка', icon: '📄' } }
 *   Если не задан — вкладки называются по ключам
 * @returns {Promise<boolean>} true = пользователь подтвердил, false = отменил
 */
export function showExcelPreview(previews, tabsConfig = null, opts = {}) {
    // ✅ T59: настраиваемые заголовок и кнопки (предпросмотр СЗ на транспорт)
    // + необязательная ссылка «Скачать XLSX» рядом с кнопками.
    // Умолчания прежние — requests.js и orders.js работают без изменений.
    const title = opts.title || '📋 Предпросмотр документа перед отправкой';
    const cancelText = opts.cancelText || '✖ Отменить отправку';
    const confirmText = opts.confirmText || '✅ Подтвердить и отправить';
    return new Promise((resolve) => {
        const keys = Object.keys(previews || {}).filter(k => previews[k]);
        if (keys.length === 0) {
            resolve(true);
            return;
        }

        // Оверлей
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); z-index: 99999;
            display: flex; align-items: center; justify-content: center;
            animation: fadeIn 0.2s ease;
        `;

        // Модальное окно
        const modal = document.createElement('div');
        modal.style.cssText = `
            background: white; border-radius: 12px; width: 95%; max-width: 1400px;
            height: 90vh; display: flex; flex-direction: column; overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,0.4);
        `;

        // Шапка
        const header = document.createElement('div');
        header.style.cssText = `
            padding: 14px 24px; background: #f6f8fa; border-bottom: 1px solid #d0d7de;
            display: flex; justify-content: space-between; align-items: center;
            flex-shrink: 0;
        `;
        const downloadLink = opts.downloadUrl ? `
                <a id="previewDownload" href="${opts.downloadUrl}" download="${opts.downloadName || ''}" style="
                    display: inline-flex; align-items: center; padding: 8px 16px;
                    background: #0969da; color: white; border-radius: 6px;
                    cursor: pointer; font-size: 13px; font-weight: 600;
                    text-decoration: none;
                ">⬇ Скачать XLSX</a>` : '';
        header.innerHTML = `
            <h2 style="margin:0; font-size:15px; color:#1f2328;">
                ${title}
            </h2>
            <div style="display:flex; gap:10px; align-items:center;">${downloadLink}
                <button id="previewCancel" style="
                    padding: 8px 20px; background: #fff; border: 1px solid #d0d7de;
                    border-radius: 6px; cursor: pointer; font-size: 13px;
                    color: #cf222e; font-weight: 600;
                ">${cancelText}</button>
                <button id="previewConfirm" style="
                    padding: 8px 20px; background: #1a7f37; color: white; border: none;
                    border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;
                ">${confirmText}</button>
            </div>
        `;
        modal.appendChild(header);

        // Вкладки (если документов несколько)
        if (keys.length > 1) {
            const tabBar = document.createElement('div');
            tabBar.style.cssText = `
                display: flex; background: #fff; border-bottom: 1px solid #d0d7de;
                padding: 0 16px; flex-shrink: 0;
            `;
            keys.forEach((key, i) => {
                const cfg = tabsConfig?.[key] || {};
                const label = cfg.label || key;
                const tab = document.createElement('button');
                tab.className = 'preview-tab' + (i === 0 ? ' active' : '');
                tab.dataset.tab = key;
                tab.style.cssText = `
                    padding: 10px 20px; border: none;
                    background: ${i === 0 ? '#f6f8fa' : 'transparent'};
                    border-bottom: 2px solid ${i === 0 ? '#0969da' : 'transparent'};
                    cursor: pointer; font-size: 13px;
                    font-weight: ${i === 0 ? '600' : '400'};
                    color: ${i === 0 ? '#0969da' : '#656d76'};
                    border-radius: 6px 6px 0 0; margin-right: 4px;
                `;
                tab.textContent = label;
                tabBar.appendChild(tab);
            });
            modal.appendChild(tabBar);
        }

        // Контент: iframe'ы
        const content = document.createElement('div');
        content.style.cssText = `flex: 1; overflow: hidden; position: relative;`;

        keys.forEach((key, i) => {
            const iframe = document.createElement('iframe');
            iframe.className = 'preview-iframe';
            iframe.dataset.tab = key;
            iframe.srcdoc = previews[key];
            iframe.style.cssText = `
                width: 100%; height: 100%; border: none;
                display: ${i === 0 ? 'block' : 'none'};
                position: absolute; top: 0; left: 0;
            `;
            content.appendChild(iframe);
        });
        modal.appendChild(content);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Переключение вкладок
        modal.querySelectorAll('.preview-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                modal.querySelectorAll('.preview-tab').forEach(t => {
                    t.style.background = 'transparent';
                    t.style.borderBottomColor = 'transparent';
                    t.style.color = '#656d76';
                    t.style.fontWeight = '400';
                    t.classList.remove('active');
                });
                tab.style.background = '#f6f8fa';
                tab.style.borderBottomColor = '#0969da';
                tab.style.color = '#0969da';
                tab.style.fontWeight = '600';
                tab.classList.add('active');

                const targetTab = tab.dataset.tab;
                modal.querySelectorAll('.preview-iframe').forEach(iframe => {
                    iframe.style.display = iframe.dataset.tab === targetTab ? 'block' : 'none';
                });
            });
        });

        // Cleanup
        const cleanup = () => {
            document.removeEventListener('keydown', escHandler);
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        };

        modal.querySelector('#previewCancel').addEventListener('click', () => {
            cleanup();
            resolve(false);
        });
        modal.querySelector('#previewConfirm').addEventListener('click', () => {
            const emailBodies = collectEmailBodiesFrom(modal);   // ✅ T100: ДО cleanup
            cleanup();
            resolve({ ok: true, emailBodies });   // ✅ T100: + тексты писем (объект истинен)
        });

        const escHandler = (e) => {
            if (e.key === 'Escape') {
                cleanup();
                resolve(false);
            }
        };
        document.addEventListener('keydown', escHandler);
    });
}

// ============================================================
// ✅ T100: ОБЩИЙ РЕНДЕР ПИСЬМА ДЛЯ ПРЕДПРОСМОТРА (вкладка «✉ Письмо»).
// Письмо показывается так, как увидит контрагент: кому, копии, тема,
// текст, вложение. Рендер переехал сюда из orders.js (T98) и используется
// также requests.js (рассылка запросов ТКП, T100).
// Текст письма РЕДАКТИРУЕМ: кнопка «✏ Редактировать текст» переключает
// просмотр/textarea; финальный текст родительское окно забирает при
// подтверждении из textarea[data-email-body] (iframe same-origin).
// ============================================================
export function buildEmailPreviewHtml(p, attachName, attachSub) {
    const chips = (raw) => String(raw || '')
        .split(/[;,]+/).map(s => s.trim()).filter(Boolean)
        .map(a => `<span class="mail-chip">${esc(a)}</span>`).join(' ');
    const attach = attachName ? `
      <div class="mail-attach">
        <span class="mail-clip">📎</span>
        <div>
          <div class="mail-attach-name">${esc(attachName)}</div>
          <div class="mail-attach-sub">${esc(attachSub || 'вложение: заказ к договору (Excel)')}</div>
        </div>
      </div>` : '';
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 22px 18px; background: #f4f5f7;
         font-family: 'Segoe UI', Arial, sans-serif; color: #1f2328; }
  .mail { max-width: 860px; margin: 0 auto; background: #fff;
          border: 1px solid #d0d7de; border-radius: 10px; overflow: hidden;
          box-shadow: 0 2px 10px rgba(0,0,0,0.06); }
  .mail-subject { font-size: 16px; font-weight: 600; padding: 14px 22px;
                  border-bottom: 1px solid #eaeef2; background: #fbfcfd; }
  .mail-headers { padding: 12px 22px; background: #f6f8fa;
                  border-bottom: 1px solid #eaeef2; font-size: 13px; }
  .hrow { display: flex; margin: 4px 0; align-items: baseline; }
  .hlabel { width: 76px; color: #57606a; flex-shrink: 0; font-weight: 600; }
  .hval { word-break: break-all; }
  .mail-chip { display: inline-block; background: #ddf4ff; color: #0969da;
               border: 1px solid #b6e3ff; border-radius: 12px;
               padding: 1px 10px; margin: 1px 4px 1px 0; font-size: 12.5px; }
  .mail-editbar { padding: 10px 26px 0; display: flex; align-items: center;
                  gap: 12px; }
  .mail-editbtn { padding: 6px 14px; background: #0969da; color: white;
                  border: none; border-radius: 6px; cursor: pointer;
                  font-size: 12.5px; font-weight: 600; }
  .mail-editnote { font-size: 11.5px; color: #57606a; }
  .mail-body { padding: 20px 26px 8px; font-size: 13.5px; line-height: 1.55;
               white-space: pre-wrap; overflow-wrap: break-word; }
  #mailBodyEdit { display: none; margin: 12px 22px 4px; width: calc(100% - 44px);
                  min-height: 46vh; box-sizing: border-box; resize: vertical;
                  font-family: 'Segoe UI', Arial, sans-serif; font-size: 13.5px;
                  line-height: 1.5; border: 1px solid #0969da; border-radius: 8px;
                  padding: 12px; }
  .mail-attach { margin: 14px 22px 18px; display: inline-flex; gap: 10px;
                 align-items: center; border: 1px solid #d0d7de;
                 border-radius: 8px; padding: 9px 16px; background: #fff; }
  .mail-clip { font-size: 20px; }
  .mail-attach-name { font-size: 13px; font-weight: 600; color: #0969da; }
  .mail-attach-sub { font-size: 11.5px; color: #57606a; }
</style>
</head>
<body>
  <div class="mail">
    <div class="mail-subject">${esc(p.subject || '')}</div>
    <div class="mail-headers">
      <div class="hrow"><div class="hlabel">Кому:</div><div class="hval">${chips(p.to)}</div></div>
      <div class="hrow"><div class="hlabel">Копии:</div><div class="hval">${chips(p.cc)}</div></div>
    </div>
    <div class="mail-editbar">
      <button type="button" id="mailEditBtn" class="mail-editbtn">✏ Редактировать текст</button>
      <span class="mail-editnote">правки текста уйдут в письмо при подтверждении отправки</span>
    </div>
    <div class="mail-body" id="mailBodyView">${esc(p.body || '')}</div>
    <textarea id="mailBodyEdit" data-email-body="1" spellcheck="false"></textarea>
    ${attach}
  </div>
  <script>
    (function () {
      var btn = document.getElementById('mailEditBtn');
      var view = document.getElementById('mailBodyView');
      var ta = document.getElementById('mailBodyEdit');
      if (!btn || !view || !ta) return;
      ta.value = view.textContent;
      btn.addEventListener('click', function () {
        var editing = window.getComputedStyle(ta).display !== 'none';   // ✅ T100-fix2: скрытие задано CSS-правилом
        if (editing) {
          view.textContent = ta.value;
          ta.style.display = 'none';
          view.style.display = 'block';
          btn.textContent = '✏ Редактировать текст';
          btn.style.background = '#0969da';
        } else {
          ta.style.display = 'block';
          view.style.display = 'none';
          btn.textContent = '✔ Применить правку';
          btn.style.background = '#1a7f37';
        }
      });
    })();
  <\/script>
</body>
</html>`;
}

// ✅ T100: при ПОДТВЕРЖДЕНИИ собираем (возможно отредактированные) тексты
// писем из вкладок ДО удаления DOM — iframe same-origin, в письме есть
// textarea[data-email-body]. Ключ — data-firmKey вкладки (рассылка ТКП)
// или data-tab ('email' — согласование заказа). Возвращаем { ok, emailBodies }
// вместо true (объект истинен — все прежние проверки `if (!confirmed)`
// у вызывателей продолжают работать без изменений).
function collectEmailBodiesFrom(modal) {
    const map = {};
    try {
        modal.querySelectorAll('iframe.preview-iframe').forEach(fr => {
            let doc = null;
            try { doc = fr.contentDocument; } catch (_) { doc = null; }
            if (!doc) return;
            const ta = doc.querySelector('textarea[data-email-body]');
            if (ta && String(ta.value).trim()) {
                const key = fr.dataset.firmKey || fr.dataset.tab || 'email';
                map[String(key)] = ta.value;
            }
        });
    } catch (_) { /* нет доступа к iframe — игнорируем */ }
    return map;
}
