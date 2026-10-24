// ============================================================
// js/modules/transportOpsDocs.js ВКЛАДКА: ДОКУМЕНТЫ
// ============================================================
import { api, toast } from '../common/utils.js';
import { state } from '../common/state.js';
// ✅ T59: модальное окно предпросмотра Excel (как «Отправить заказы
// контрагентам» на странице «Заказы по договорам»)
import { showExcelPreview } from '../common/excel-preview.js';

export const TransportOpsDocs = {
  async init() {
    // Кнопки действий с документами
    // ✅ T37-B + ✅ T59: «Создать СЗ в системе» — порт VBA CommandButton12_Click
    // (frmTransportOper) в ДВА ШАГА с предпросмотром файла (как «Отправить
    // заказы контрагентам» на странице «Заказы по договорам»):
    //   ШАГ 1: POST create-sz { preview:true } — сервер выполняет шаги 3-6
    //   VBA (документ в ЭДО АВТОВАЗа, карточка, файл заявки из шаблона), но
    //   НЕ грузит файл на портал и НЕ пишет sz_transport_* в БД — отвечает
    //   HTML-предпросмотром листа «Заявка NEW!» и жетонами (kod/номер/дата);
    //   ШАГ 2: файл показывается в модальном окне с запросом дальнейших
    //   действий: «Подтвердить и загрузить на портал» -> POST create-sz-confirm
    //   (ШАГ 7 загрузка на портал + ШАГ 8 UpdateIDTrOp) или «Отменить» ->
    //   create-sz-confirm { cancel:true } — локальный файл удаляется,
    //   sz_transport_* в БД НЕ пишутся (документ в ЭДО остаётся черновиком).
    document.getElementById('btnCreateDokSB').onclick = async () => {
      const btn = document.getElementById('btnCreateDokSB');
      const operId = state.tables.transport_oper ? state.tables.transport_oper.selectedId : null;
      // VBA: If Me.lstTransportOper.ListIndex <= 0 Then «Транспортная опреация не выбрана»
      if (!operId) { toast('Транспортная операция не выбрана', 'error'); return; }
      // VBA: If transOp.szTransportID <> "" Then «Письмо уже было создано»
      if (document.getElementById('toSzTransportID').value) {
        toast('Письмо уже было создано', 'error');
        return;
      }
      btn.disabled = true;
      try {
        // --- T59 ШАГ 1: документ в ЭДО + файл заявки + HTML-предпросмотр ---
        toast('Создание СЗ: документ в ЭДО и файл заявки...', 'warning');
        const r = await api('POST', '/api/transport-oper/create-sz', { id_transporta: operId, preview: true });
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
        // --- T59 ШАГ 2: предпросмотр файла с запросом дальнейших действий ---
        let confirmed = false;
        if (r.preview_html) {
          confirmed = await showExcelPreview(
            { sz: r.preview_html },
            { sz: { label: '📄 Заявка на отгрузку' } },
            {
              title: '📋 Предпросмотр СЗ перед загрузкой на портал',
              cancelText: '✖ Отменить создание СЗ',
              confirmText: '✅ Подтвердить и загрузить на портал',
              downloadUrl: r.file_url,
              downloadName: r.file_name
            }
          );
        } else {
          // конвертер предпросмотра не сработал — классический вопрос
          confirmed = window.confirm('Предпросмотр недоступен. Загрузить файл заявки на портал?');
        }
        if (!confirmed) {
          // отмена: сервер удаляет локальный файл заявки; sz_transport_* в БД
          // НЕ пишутся — СЗ можно создать заново
          await api('POST', '/api/transport-oper/create-sz-confirm', { id_transporta: operId, cancel: true, file_name: r.file_name });
          toast('Создание СЗ отменено — файл заявки удалён', 'warning');
          return;
        }
        // --- T59 ШАГ 3: подтверждение — ШАГ 7-8 VBA (портал + UpdateIDTrOp) ---
        toast('Загрузка файла на портал...', 'warning');
        const r2 = await api('POST', '/api/transport-oper/create-sz-confirm', {
          id_transporta: operId,
          kod: r.id_sz,
          sz_nomer: r.sz_transport_nomer,
          sz_data: r.sz_transport_data,
          sz_data_ru: r.sz_transport_data_ru,
          krat_sod: r.krat_sod,
          file_name: r.file_name
        });
        if (r2.error) { toast('Ошибка: ' + r2.error, 'error'); return; }
        // VBA: txtSzTransportNomer/Data <- карточка ЭДО (D_NOM/DATE_DOC);
        // sz_transport_id = d_kod документа (переход в ИДО, CommandButton9)
        document.getElementById('toSzTransportNomer').value = r2.sz_transport_nomer || '';
        document.getElementById('toSzTransportData').value = r2.sz_transport_data || '';
        document.getElementById('toSzTransportID').value = r2.id_sz || '';
        if (r2.file_url) TransportOpsDocs._showSzFileInfo({ file_name: r2.file_name, file_url: r2.file_url });
        else TransportOpsDocs._showSzFileInfo(null);
        // VBA: MsgBox «Файл успешно загружен на портал!» / «Ошибка при загрузке файла»
        const msg = `СЗ №${r2.sz_transport_nomer || ''} от ${r2.sz_transport_data_ru || ''} создана (ID ${r2.id_sz})`;
        if (r2.upload_ok === false) {
          toast(msg + '. Файл НЕ загружен на портал: ' + (r2.upload_error || ''), 'warning');
        } else {
          toast(msg + '. Файл загружен на портал', 'success');
        }
      } catch (e) {
        toast('Сетевая ошибка: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };

    // ✅ T43: «Создать СЗ в СБ об отгрузке» — ДВА ШАГА: (1) POST sz-sb-preview
    // — сервер собирает текст письма из БД (фирмы/заказы/договоры транспортных
    // позиций, фраза о таре — по типу груза листы/прутки) и список файлов
    // подписанных заказов (ssylka_reshenie); (2) текст открывается в
    // модальном окне WYSIWYG (T39-C) — пользователь правит его и кнопкой
    // «Создать СЗ в СБ» отправляет в create-sz-sb (letter). Подписант —
    // «Савченко В.М.» (16385) устанавливается на сервере. Результат: № СЗ
    // в СБ об отгрузке (номер), Дата и ID СЗ в СБ об отгрузке (sz_sb_id).
    document.getElementById('btnCreateSzSb').onclick = async () => {
      const btn = document.getElementById('btnCreateSzSb');
      const operId = state.tables.transport_oper ? state.tables.transport_oper.selectedId : null;
      // VBA: If Me.lstTransportOper.ListIndex <= 0 Then «Транспортная опреация не выбрана»
      if (!operId) { toast('Транспортная операция не выбрана', 'error'); return; }
      // аналог VBA «Письмо уже было создано» — у СБ-письма свой идентификатор
      if (document.getElementById('toSzSbId').value) {
        toast('СЗ в СБ уже была создана', 'error');
        return;
      }
      btn.disabled = true;
      try {
        // ✅ T43: предпросмотр письма (без обращения к порталу) -> модалка
        const p = await api('POST', '/api/transport-oper/sz-sb-preview', { id_transporta: operId });
        if (p.error) { toast('Ошибка: ' + p.error, 'error'); return; }
        openSzSbModal(operId, p);
      } catch (e) {
        toast('Сетевая ошибка: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };

    // ✅ T44: «Открыть сайт с документом» (СЗ на транспорт) — документ
    // открывается на сервере в браузере ПО УМОЛЧАНИЮ (Яндекс Браузер):
    // POST open-sz-browser (d_kod) — референс nak_M_15, VBA CommandButton9
    // (IE.Navigate "https://docs.vaz.ru/main.aspx?d_kod=" & szTransportID
    // + AuthPopup; Basic-аутентификация теперь подставляется в браузер).
    document.getElementById('btnGoIdoSB').onclick = async () => {
      const btn = document.getElementById('btnGoIdoSB');
      const szId = document.getElementById('toSzTransportID').value;
      // VBA: If transOp.szTransportID = "" Then «Письмо не создано»
      if (!szId) {
        toast('Письмо не создано', 'error');
        return;
      }
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/transport-oper/open-sz-browser', { d_kod: szId });
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
        if (r.warning) { toast('Открыто с предупреждением: ' + r.warning, 'warning'); return; }
        toast('СЗ на транспорт открыта на сайте ЭДО (Яндекс Браузер)', 'success');
      } catch (e) {
        toast('Сетевая ошибка: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };

    // ✅ T44: «Открыть сайт с документом» (СЗ в СБ об отгрузке) — тот же
    // механизм, d_kod = ID СЗ в СБ об отгрузке (toSzSbId).
    document.getElementById('btnGoIdoSb').onclick = async () => {
      const btn = document.getElementById('btnGoIdoSb');
      const szSbId = document.getElementById('toSzSbId').value;
      if (!szSbId) {
        toast('СЗ в СБ об отгрузке не создана', 'error');
        return;
      }
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/transport-oper/open-sz-browser', { d_kod: szSbId });
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
        if (r.warning) { toast('Открыто с предупреждением: ' + r.warning, 'warning'); return; }
        toast('СЗ в СБ об отгрузке открыта на сайте ЭДО (Яндекс Браузер)', 'success');
      } catch (e) {
        toast('Сетевая ошибка: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };
    // ✅ T47: «Удалить СЗ» (красный крестик, title «Удалить СЗ») — СЗ на
    // транспорт: POST delete-sz -> сервер делает GET document_delete.aspx?
    // d_kod= в системе ВАЗ и очищает sz_transport_id/nomer/data в БД;
    // клиент очищает поля строки. При ошибке портала база НЕ очищается.
    document.getElementById('btnDelSzTransport').onclick = async () => {
      const btn = document.getElementById('btnDelSzTransport');
      const operId = state.tables.transport_oper ? state.tables.transport_oper.selectedId : null;
      const szId = document.getElementById('toSzTransportID').value;
      // VBA: If transOp.szTransportID = "" Then «Письмо не создано»
      if (!szId) { toast('Письмо не создано', 'error'); return; }
      if (!operId) { toast('Транспортная операция не выбрана', 'error'); return; }
      if (!window.confirm('Удалить СЗ из системы ВАЗ и очистить номер/дату/ID? Действие необратимо.')) return;
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/transport-oper/delete-sz', { id_transporta: operId, d_kod: szId, tip: 'transport' });
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
        document.getElementById('toSzTransportNomer').value = '';
        document.getElementById('toSzTransportData').value = '';
        document.getElementById('toSzTransportID').value = '';
        toast('СЗ удалена из системы ВАЗ, поля и база очищены', 'success');
      } catch (e) {
        toast('Сетевая ошибка: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };

    // ✅ T47: «Удалить СЗ» — СЗ в СБ об отгрузке (sz_sb_id/nomer/data).
    document.getElementById('btnDelSzSb').onclick = async () => {
      const btn = document.getElementById('btnDelSzSb');
      const operId = state.tables.transport_oper ? state.tables.transport_oper.selectedId : null;
      const szSbId = document.getElementById('toSzSbId').value;
      if (!szSbId) { toast('СЗ в СБ об отгрузке не создана', 'error'); return; }
      if (!operId) { toast('Транспортная операция не выбрана', 'error'); return; }
      if (!window.confirm('Удалить СЗ в СБ из системы ВАЗ и очистить номер/дату/ID? Действие необратимо.')) return;
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/transport-oper/delete-sz', { id_transporta: operId, d_kod: szSbId, tip: 'sb' });
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
        document.getElementById('toSzSBOtgruzka').value = '';
        document.getElementById('toSzSBOtgruzkaD').value = '';
        document.getElementById('toSzSbId').value = '';
        toast('СЗ в СБ удалена из системы ВАЗ, поля и база очищены', 'success');
      } catch (e) {
        toast('Сетевая ошибка: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };

    // ✅ T38: «Добавить накладную М-15» — ПОЛНЫЙ ПОРТ VBA cmdAddNakl_M15_Click:
    // guard-и -> сервер группирует позиции по основанию (договору), оснастка
    // с «/» разделяется на две позиции -> по каждой группе modNaklad.Add в
    // системе ВАЗ (SIPORA tportal.vaz.ru/sipora/ou38) -> поля
    // txtFormM15UPD (номера через «, » или «0») / txtFormM15UPD_D (дата
    // отгрузки) -> итоговое сообщение как VBA finalMsg (ok/warning).
    document.getElementById('btnAddNaklM15').onclick = async () => {
      const btn = document.getElementById('btnAddNaklM15');
      const operId = state.tables.transport_oper ? state.tables.transport_oper.selectedId : null;
      if (!operId) { toast('Транспортная операция не выбрана', 'error'); return; }
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/transport-oper/create-m15', { id_transporta: operId });
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
        // VBA: txtFormM15UPD = номера через «, » (или «0»);
        // txtFormM15UPD_D = shippingDate (поле формы — input type=date, ISO)
        document.getElementById('toFormM15UPD').value = r.numbers || '0';
        document.getElementById('toFormM15UPD_D').value = r.data_iso || '';
        // VBA: finalMsg «Создано накладных: N из M …», ok/warning
        toast(r.message || ('Создано накладных: ' + (r.created || 0) + ' из ' + (r.total || 0)),
              r.message_type === 'warning' ? 'warning' : 'success');
      } catch (e) {
        toast('Сетевая ошибка: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };

    // ✅ T39-C: WYSIWYG-редактор текста СЗ (простой, как RTF): contenteditable
    // рендерит HTML LETTER — теги невидимы, пользователь правит только текст.
    // Панель форматирования на document.execCommand (bold/italic/underline/…),
    // кнопка «HTML» переключает в режим исходной разметки (теги видны).
    let szLetterSrcMode = false;
    const setSzLetterMode = (src) => {
      const ta = document.getElementById('szLetterText');
      const editor = document.getElementById('szLetterEditor');
      const toolbar = document.getElementById('szLetterToolbar');
      const btn = document.getElementById('szLetterSourceBtn');
      szLetterSrcMode = src;
      if (szLetterViewMode) setSzLetterViewMode(false); // ✅ T61: выход из просмотра
      editor.style.display = src ? 'none' : '';
      toolbar.style.display = src ? 'none' : '';
      ta.hidden = !src;
      if (src) {
        ta.value = editor.innerHTML;
      } else if (ta.value !== '') {
        editor.innerHTML = ta.value;
      }
      if (btn) btn.classList.toggle('szl-on', src);
    };
    // ✅ T61: режим «Только просмотр» (документ подписан на портале):
    // редактор contenteditable=false, панель форматирования и кнопки
    // сохранения/создания скрыты — письмо можно только посмотреть
    let szLetterViewMode = false;
    const setSzLetterViewMode = (view) => {
      szLetterViewMode = !!view;
      const editor = document.getElementById('szLetterEditor');
      const toolbar = document.getElementById('szLetterToolbar');
      const btnSave = document.getElementById('szLetterSave');
      const btnCreateSb = document.getElementById('szLetterCreateSb');
      if (!editor) return;
      if (view) {
        editor.contentEditable = 'false';
        editor.style.background = '#f6f7f9';
        toolbar.style.display = 'none';
        btnSave.style.display = 'none';
        btnCreateSb.style.display = 'none';
      } else {
        editor.contentEditable = 'true';
        editor.style.background = '#fff';
      }
    };
    document.querySelectorAll('#szLetterToolbar [data-cmd]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // выделение не сбрасывается
      b.addEventListener('click', () => {
        const editor = document.getElementById('szLetterEditor');
        editor.focus();
        document.execCommand(b.dataset.cmd, false, null);
      });
    });
    document.getElementById('szLetterSourceBtn').onclick = () => setSzLetterMode(!szLetterSrcMode);

    // ✅ T39: «Редактировать текст СЗ» — модальное окно редактирования тела
    // письма (LETTER) с сохранением через SaveTemplateToPortal (VBA modEDO,
    // POST SaveShablon.aspx). Открытие: guard-и «операция не выбрана» /
    // «Письмо не создано» (VBA CommandButton9) -> GET sz-letter — текст
    // загружается с портала (ViewShablon.aspx?mode=edit&d_kod=, закомм.
    // строка VBA frmTransportOper) -> textarea. Кнопка «Сохранить на
    // портал» -> POST save-sz-template (SaveShablon.aspx, как в VBA).
    document.getElementById('btnEditSzText').onclick = async () => {
      const operId = state.tables.transport_oper ? state.tables.transport_oper.selectedId : null;
      // VBA: If Me.lstTransportOper.ListIndex <= 0 Then «Транспортная опреация не выбрана»
      if (!operId) { toast('Транспортная операция не выбрана', 'error'); return; }
      // VBA (CommandButton9): If transOp.szTransportID = "" Then «Письмо не создано»
      if (!document.getElementById('toSzTransportID').value) {
        toast('Письмо не создано', 'error');
        return;
      }
      const modal = document.getElementById('szLetterModal');
      const info = document.getElementById('szLetterInfo');
      const ta = document.getElementById('szLetterText');
      const editor = document.getElementById('szLetterEditor');
      const btnSave = document.getElementById('szLetterSave');
      const btnCreateSb = document.getElementById('szLetterCreateSb');
      // ✅ T43: обычный режим модалки — «Сохранить на портал»; кнопка
      // «Создать СЗ в СБ» видна только в режиме предпросмотра нового письма
      btnSave.style.display = '';
      btnCreateSb.style.display = 'none';
      szSbDraftOperId = null;
      btnSave.disabled = true;
      info.textContent = 'Загрузка текста с портала…';
      ta.value = '';
      editor.innerHTML = '';
      setSzLetterMode(false); // ✅ T39-C: модалка всегда открывается в WYSIWYG
      modal.classList.remove('hidden');
      try {
        const r = await api('GET', '/api/transport-oper/sz-letter?id_transporta=' + encodeURIComponent(operId));
        if (r.error) {
          modal.classList.add('hidden');
          toast('Ошибка: ' + r.error, 'error');
          return;
        }
        // VBA: поле LETTER страницы ViewShablon.aspx?mode=edit (тело письма)
        // ✅ T39-C: HTML рендерится в contenteditable; исходник — в textarea
        ta.value = r.letter || '';
        editor.innerHTML = r.letter || '';
        if (r.signed) {
          // ✅ T61: документ подписан на портале — письмо только для просмотра
          setSzLetterViewMode(true);
          info.textContent = 'Документ ПОДПИСАН на портале — просмотр без редактирования. СЗ в СБ №' +
            (r.d_nom || '') + ' от ' + (r.date_doc || '') + ' (ID ' + (r.id_sz || '') + ')';
          return;
        }
        if (r.signed) {
          // ✅ T61: документ подписан на портале — письмо только для просмотра
          setSzLetterViewMode(true);
          info.textContent = 'Документ ПОДПИСАН на портале — просмотр без редактирования. СЗ №' +
            (r.d_nom || '') + ' от ' + (r.date_doc || '') + ' (ID ' + (r.id_sz || '') + ')';
          return;
        }
        info.textContent = 'СЗ №' + (r.d_nom || '') + ' от ' + (r.date_doc || '') +
          ' (ID ' + (r.id_sz || '') + ')';
        btnSave.disabled = false;
      } catch (e) {
        modal.classList.add('hidden');
        toast('Сетевая ошибка: ' + e.message, 'error');
      }
    };

    // ✅ T39: «Отмена» — закрыть окно без сохранения
    document.getElementById('szLetterCancel').onclick = () => {
      document.getElementById('szLetterModal').classList.add('hidden');
      szSbDraftOperId = null; // ✅ T43: предпросмотр СЗ в СБ отменён
    };

    // ✅ T39: «Сохранить на портал» — POST save-sz-template ->
    // VBA SaveTemplateToPortal (SaveShablon.aspx; результат = HTTP 200)
    document.getElementById('szLetterSave').onclick = async () => {
      const operId = state.tables.transport_oper ? state.tables.transport_oper.selectedId : null;
      if (!operId) { toast('Транспортная операция не выбрана', 'error'); return; }
      const modal = document.getElementById('szLetterModal');
      const btnSave = document.getElementById('szLetterSave');
      // ✅ T39-C: HTML берётся из активного режима (WYSIWYG innerHTML или исходник)
      const letter = szLetterSrcMode
        ? document.getElementById('szLetterText').value
        : document.getElementById('szLetterEditor').innerHTML;
      btnSave.disabled = true;
      try {
        const r = await api('POST', '/api/transport-oper/save-sz-template',
          { id_transporta: operId, letter: letter });
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
        // VBA: Debug.Print «[SAVE] Status: 200» -> окно закрывается
        modal.classList.add('hidden');
        toast('Текст СЗ сохранён на портале', 'success');
      } catch (e) {
        toast('Сетевая ошибка: ' + e.message, 'error');
      } finally {
        btnSave.disabled = false;
      }
    };

    // ✅ T43: предпросмотр/редактирование письма СЗ в СБ в модальном окне
    // (тот же WYSIWYG-редактор T39-C). Кнопка «Сохранить на портал» в этом
    // режиме скрыта — вместо неё «Создать СЗ в СБ», которая отправляет
    // отредактированный текст в create-sz-sb (letter) и закрывает окно.
    let szSbDraftOperId = null;
    const openSzSbModal = (operId, preview) => {
      szSbDraftOperId = operId;
      const modal = document.getElementById('szLetterModal');
      const info = document.getElementById('szLetterInfo');
      const ta = document.getElementById('szLetterText');
      const editor = document.getElementById('szLetterEditor');
      const btnSave = document.getElementById('szLetterSave');
      const btnCreate = document.getElementById('szLetterCreateSb');
      ta.value = preview.letter || '';
      editor.innerHTML = preview.letter || '';
      setSzLetterMode(false); // модалка открывается в WYSIWYG
      const files = preview.files || [];
      const filesOk = files.filter((f) => f.exists).length;
      // ✅ T52: показываем РЕАЛЬНУЮ тему письма (tema.sz_sb с подстановками)
      info.textContent = 'Тема: «' + (preview.tema || 'об отгрузке') + '». Текст письма СЗ в СБ об отгрузке — проверьте, исправьте и нажмите «Создать СЗ в СБ»' +
        ' (фирм: ' + (preview.firms || []).length + ', заказов: ' + (preview.orders || []).length +
        ', файлов решений: ' + filesOk + ' из ' + files.length + ')';
      btnSave.style.display = 'none';
      btnCreate.style.display = '';
      btnCreate.disabled = false;
      modal.classList.remove('hidden');
    };
    document.getElementById('szLetterCreateSb').onclick = async () => {
      const operId = szSbDraftOperId;
      if (!operId) { toast('Транспортная операция не выбрана', 'error'); return; }
      const modal = document.getElementById('szLetterModal');
      const btnCreate = document.getElementById('szLetterCreateSb');
      // ✅ T39-C: HTML берётся из активного режима (WYSIWYG innerHTML или исходник)
      const letter = szLetterSrcMode
        ? document.getElementById('szLetterText').value
        : document.getElementById('szLetterEditor').innerHTML;
      btnCreate.disabled = true;
      try {
        const r = await api('POST', '/api/transport-oper/create-sz-sb', { id_transporta: operId, letter: letter });
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; } // окно остаётся открытым — можно повторить
        modal.classList.add('hidden');
        szSbDraftOperId = null;
        document.getElementById('toSzSBOtgruzka').value = r.sz_sb_nomer || '';
        document.getElementById('toSzSBOtgruzkaD').value = r.sz_sb_data || '';
        document.getElementById('toSzSbId').value = r.id_sz_sb || '';
        const nFiles = (r.uploads || []).filter((u) => u.ok).length;
        const nFilesAll = (r.uploads || []).length;
        // ✅ T55: при отложенном присвоении номера (sz_nomer.sz_sb='otlozh')
        // портал может не вернуть номер/дату сразу — указываем это явно
        const szSbHead = (r.sz_sb_nomer || '')
          ? ('СЗ в СБ №' + r.sz_sb_nomer + ' от ' + (r.sz_sb_data_ru || ''))
          : (r.sz_nomer_mode === 'otlozh'
              ? 'СЗ в СБ создана (номер будет присвоен отложенно)'
              : 'СЗ в СБ №— от ' + (r.sz_sb_data_ru || ''));
        const msg = szSbHead + ' (ID ' + (r.id_sz_sb || '') + '); подписант: ' + (r.podp || '') +
          '; фирм: ' + (r.firms || []).length + ', заказов: ' + (r.orders || []).length;
        if (r.letter_saved === false) {
          toast(msg + '. ТЕКСТ письма НЕ сохранён: ' + (r.letter_error || ''), 'warning');
        } else if (nFiles < nFilesAll) {
          toast(msg + '. Файлы на портале: ' + nFiles + ' из ' + nFilesAll, 'warning');
        } else {
          toast(msg + '. Файлы заказов (' + nFiles + ') загружены на портал', 'success');
        }
      } catch (e) {
        toast('Сетевая ошибка: ' + e.message, 'error');
      } finally {
        btnCreate.disabled = false;
      }
    };

    // ✅ T44: «Редактировать» (СЗ в СБ об отгрузке) — то же модальное
    // окно WYSIWYG (T39-C), но текст загружается ПО d_kod = ID СЗ в СБ
    // (GET sz-letter?d_kod=), сохранение — POST save-sz-template {d_kod}.
    document.getElementById('btnEditSzTextSb').onclick = async () => {
      const operId = state.tables.transport_oper ? state.tables.transport_oper.selectedId : null;
      if (!operId) { toast('Транспортная операция не выбрана', 'error'); return; }
      if (!document.getElementById('toSzSbId').value) {
        toast('СЗ в СБ об отгрузке не создана', 'error');
        return;
      }
      const modal = document.getElementById('szLetterModal');
      const info = document.getElementById('szLetterInfo');
      const ta = document.getElementById('szLetterText');
      const editor = document.getElementById('szLetterEditor');
      const btnSave = document.getElementById('szLetterSave');
      const btnCreateSb = document.getElementById('szLetterCreateSb');
      // обычный режим модалки: «Сохранить на портал» (T43: «Создать СЗ в
      // СБ» видна только в предпросмотре нового письма)
      btnSave.style.display = '';
      btnCreateSb.style.display = 'none';
      szSbDraftOperId = null;
      btnSave.disabled = true;
      info.textContent = 'Загрузка текста с портала…';
      ta.value = '';
      editor.innerHTML = '';
      setSzLetterMode(false); // модалка открывается в WYSIWYG
      modal.classList.remove('hidden');
      try {
        const r = await api('GET', '/api/transport-oper/sz-letter?d_kod=' +
          encodeURIComponent(document.getElementById('toSzSbId').value));
        if (r.error) {
          modal.classList.add('hidden');
          toast('Ошибка: ' + r.error, 'error');
          return;
        }
        ta.value = r.letter || '';
        editor.innerHTML = r.letter || '';
        info.textContent = 'СЗ в СБ №' + (r.d_nom || '') + ' от ' + (r.date_doc || '') +
          ' (ID ' + (r.id_sz || '') + ')';
        btnSave.disabled = false;
      } catch (e) {
        modal.classList.add('hidden');
        toast('Сетевая ошибка: ' + e.message, 'error');
      }
    };

    // ✅ T44: «Открыть сайт с документом» (М-15/УПД) — портал SIPORA
    // открывается в Яндекс Браузере (референс nak_M_15 /api/open-in-yandex):
    // номер накладной вводится в поле A-F-SB01_NOMWB, клик «Поиск»
    // (_findsub). На форме номера через «, » (или «0») — берём первый;
    // пусто/«0» — сайт открывается без поиска (ручной поиск).
    document.getElementById('btnOpenNaklM15').onclick = async () => {
      const btn = document.getElementById('btnOpenNaklM15');
      const raw = (document.getElementById('toFormM15UPD').value || '').trim();
      const first = raw.split(',')[0].trim();
      const nomer = (first && first !== '0') ? first : '';
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/transport-oper/open-nakl-browser', { nomer: nomer });
        if (r.error) { toast('Ошибка: ' + r.error, 'error'); return; }
        if (r.warning) { toast('Открыто с предупреждением: ' + r.warning, 'warning'); return; }
        toast(nomer
          ? 'Накладная №' + nomer + ' открыта на сайте SIPORA (Яндекс Браузер)'
          : 'Сайт SIPORA открыт в Яндекс Браузере (накладная не создана)', 'success');
      } catch (e) {
        toast('Сетевая ошибка: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };

    document.getElementById('btnEmailSP').onclick = () => {
      toast('Отправка письма (в разработке)', 'warning');
      // TODO: открытие почтового клиента
    };
  },

  // ===== Заполнение формы из строки =====
  async fillFromRow(row) {
    // ✅ T38: композит form_m15upd = «номера от дата» — сплит как в VBA form
    // load (If InStr(.formM15UPD, " от ") > 0 Then parts = Split(...));
    // дата в композите ДД.ММ.ГГГГ -> ISO для input type=date
    const f15 = String(row.form_m15upd || '');
    if (f15.indexOf(' от ') !== -1) {
      const parts15 = f15.split(' от ');
      document.getElementById('toFormM15UPD').value = parts15[0] || '';
      const p15 = (parts15[1] || '').trim();
      const mru15 = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(p15);
      document.getElementById('toFormM15UPD_D').value =
        mru15 ? (mru15[3] + '-' + mru15[2] + '-' + mru15[1]) : p15;
    } else {
      document.getElementById('toFormM15UPD').value = f15;
      document.getElementById('toFormM15UPD_D').value = row.form_m15upd_data || '';
    }
    document.getElementById('toTnNomer').value = row.tn_nomer || '';
    document.getElementById('toTnNomerD').value = row.tn_nomer_data || '';
    document.getElementById('toSzTransportNomer').value = row.sz_transport_nomer || '';
    document.getElementById('toSzTransportData').value = row.sz_transport_data || '';
    document.getElementById('toSzSBOtgruzka').value = row.sz_sb_otgruzka || '';
    document.getElementById('toSzSBOtgruzkaD').value = row.sz_sb_otgruzka_data || '';
    document.getElementById('toSzTransportID').value = row.sz_transport_id || '';
    // ✅ T42: ID СЗ в СБ об отгрузке (d_kod письма в ЭДО)
    document.getElementById('toSzSbId').value = row.sz_sb_id || '';
    // ✅ T37-B: ссылка на файл заявки в папке «отгрузка» (public/uploads/sz),
    // если СЗ уже создавалась (имя файла вычисляет сервер по VBA)
    try {
      if (row.sz_transport_id) {
        const info = await api('GET', '/api/transport-oper/sz-info?id_transporta=' + encodeURIComponent(row.id));
        TransportOpsDocs._showSzFileInfo(info);
      } else {
        TransportOpsDocs._showSzFileInfo(null);
      }
    } catch (e) {
      TransportOpsDocs._showSzFileInfo(null);
    }
  },

  // ===== Очистка формы =====
  clearForm() {
    [
      'toFormM15UPD', 'toFormM15UPD_D',
      'toTnNomer', 'toTnNomerD',
      'toSzTransportNomer', 'toSzTransportData',
      'toSzSBOtgruzka', 'toSzSBOtgruzkaD',
      'toSzTransportID', 'toSzSbId'
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    TransportOpsDocs._showSzFileInfo(null);
  },

  // ===== ✅ T37-B: строка «Файл заявки» (аналог файла в папке «отгрузка» VBA;
  // предпросмотр результата, как форма frmURL после SaveShipmentFile) =====
  _showSzFileInfo(info) {
    const row = document.getElementById('szFileRow');
    if (!row) return;
    if (!info || !info.file_url) { row.style.display = 'none'; return; }
    const a = document.getElementById('szFileLink');
    a.textContent = info.file_name || 'Файл заявки';
    a.href = info.file_url;
    a.setAttribute('download', info.file_name || '');
    row.style.display = '';
  },

  // ===== Получение данных для payload =====
  getPayload() {
    return {
      // ✅ T38: композит как в VBA save (.formM15UPD = Trim(txt) &
      // IIf(Trim(d) <> "", " от " & Trim(d), "")); дата в композите —
      // ДД.ММ.ГГГГ (в VBA форма — текст), input type=date хранит ISO
      form_m15upd: (function () {
        const v15 = (document.getElementById('toFormM15UPD').value || '').trim();
        const dIso = (document.getElementById('toFormM15UPD_D').value || '').trim();
        const mI15 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dIso);
        const dRu = mI15 ? (mI15[3] + '.' + mI15[2] + '.' + mI15[1]) : dIso;
        return v15 + (dRu ? ' от ' + dRu : '');
      })(),
      form_m15upd_data: document.getElementById('toFormM15UPD_D').value,
      tn_nomer: document.getElementById('toTnNomer').value,
      tn_nomer_data: document.getElementById('toTnNomerD').value,
      sz_transport_nomer: document.getElementById('toSzTransportNomer').value,
      sz_transport_data: document.getElementById('toSzTransportData').value,
      sz_sb_otgruzka: document.getElementById('toSzSBOtgruzka').value,
      sz_sb_otgruzka_data: document.getElementById('toSzSBOtgruzkaD').value,
      // ✅ T86: ID редактируемые — документ мог быть создан в ЭДО вручную;
      // значения сохраняются через PUT /api/transport-oper/:id
      sz_transport_id: document.getElementById('toSzTransportID').value,
      sz_sb_id: document.getElementById('toSzSbId').value
    };
  }
};
