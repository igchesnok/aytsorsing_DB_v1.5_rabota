// ============================================================
// ✅ T37-B: helpers/szExcel.js — ПОЛНЫЙ ПОРТ VBA modExcelZavkaOtgryz
// (SaveShipmentFile) + ИСПРАВЛЕНИЕ ПОРЧИ ШАБЛОНА EXCEL.
//
// АЛГОРИТМ КАК В VBA: шаблон «Заявка на отгрузку.XLSX», лист
// «Заявка NEW!», B6:Resize(1,25) = DataArray1, AG6:Resize(1,24) =
// DataArray2 (элемент 56 «+», как и в VBA, НЕ вставляется),
// сохранение в папку «отгрузка» (веб-аналог: public/uploads/sz/).
//
// ПОЧЕМУ БЫЛ БАГ «Удаленные записи: Общая формула / calcChain»:
// в строке 6 шаблона часть ячеек — формулы, в т.ч. AM6 — МАСТЕР
// shared-формулы группы si=7 (AM6:AM32). При перезаписи AM6
// значением (а VBA пишет туда txtObemM3) клоны AM7..AM32
// оставались без мастера, а calcChain.xml ссылался на старые
// формулы — Excel восстанавливал файл с удалением записей.
// Excel при перезаписи мастера сам пере-разворачивает группу,
// поэтому в веб-версии делаем то же самое:
//   1) если заменяемая ячейка — мастер shared-группы, все её
//      клоны получают ПОЛНУЮ формулу с переносом ссылок
//      (аналог поведения Excel);
//   2) xl/calcChain.xml удаляется из файла (Excel пересобирает
//      его сам) вместе с записью в [Content_Types].xml и
//      workbook.xml.rels;
//   3) calcPr получает fullCalcOnLoad="1".
//
// ✅ T37-D: ОБЪЁМ В КОЛОНКУ AM НЕ ПИШЕТСЯ — в шаблоне там ФОРМУЛА
// (AM = ROUNDUP(длина*ширина*высота*места)), Excel посчитает объём сам
// (указание пользователя). Новое правило вставки AG6:BD6: элемент
// массива undefined -> ячейку шаблона НЕ трогаем вовсе (формула
// сохраняется 1:1); пустая строка '' по-прежнему очищает ячейку
// (как Range.Value = "" в VBA).
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

// --- Имя файла как в VBA SaveShipmentFile/TestUploadProduction ---------
// sSender=DataArray1(5), sReceiver=DataArray1(16), sDate=DataArray2(41);
// кавычки удаляются, «/» -> «-».
function buildFileName(sSender, sReceiver, sDate) {
  sSender = String(sSender == null ? '' : sSender).replace(/"/g, '');
  sReceiver = String(sReceiver == null ? '' : sReceiver).replace(/"/g, '');
  sDate = String(sDate == null ? '' : sDate).replace(/\//g, '-');
  // VBA оперировал именами файлов Windows; символы, запрещённые в имени
  // файла Windows (для writeFileSync сервера), безопасно заменяем на '_'
  // (на обычных данных замена не срабатывает — имя совпадает с VBA 1:1)
  const name = 'Заявка на отгрузку (' + sSender + '-' + sReceiver + ' от ' + sDate + ').xlsx';
  return name.replace(/[\\:*?<>|]/g, '_');
}

// --- Перенос ссылок в формуле (аналог относительной адресации Excel) ---
function colToNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// Сдвигает относительные ссылки формулы на dRow строк / dCol колонок.
// Строковые литералы не трогаются; абсолютные ($) сохраняются;
// за имением функций следует «(» — они не совпадают с ячейками.
function shiftFormula(f, dRow, dCol) {
  if (!dRow && !dCol) return f;
  const lits = [];
  let src = String(f).replace(/"(?:[^"]|"")*"/g, (m) => { lits.push(m); return '\u0001' + (lits.length - 1) + '\u0001'; });
  src = src.replace(/(?<![A-Za-z0-9_$'])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/g,
    (m, ca, col, ra, row) => {
      let c = col, r = row;
      if (!ca) {
        const n = colToNum(col.toUpperCase()) + dCol;
        if (n < 1 || n > 16384) return m;
        c = numToCol(n);
      }
      if (!ra) {
        const n = parseInt(row, 10) + dRow;
        if (n < 1 || n > 1048576) return m;
        r = String(n);
      }
      return ca + c + ra + r;
    });
  return src.replace(/\u0001(\d+)\u0001/g, (m, i) => lits[Number(i)]);
}

// Разворачивает shared-группу si: клоны получают полную формулу.
// masterFormula — текст формулы мастера; masterRef — "AM6:AM32".
function expandSharedGroup(xml, si, masterFormula, masterRef) {
  const refM = /^([A-Z]+)(\d+)/.exec(masterRef || '');
  if (!refM) return xml;
  const mCol = colToNum(refM[1]);
  const mRow = parseInt(refM[2], 10);
  const re = new RegExp('<c r="([A-Z]+)(\\d+)"([^>]*)>\\s*<f t="shared" si="' + si + '"\\s*/>', 'g');
  return xml.replace(re, (m, colL, rowS, attrs) => {
    const dRow = parseInt(rowS, 10) - mRow;
    const dCol = colToNum(colL) - mCol;
    const shifted = shiftFormula(masterFormula, dRow, dCol)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<c r="' + colL + rowS + '"' + attrs + '><f>' + shifted + '</f>';
  });
}

// Замена значения ячейки: t="inlineStr", СТИЛЬ ячейки (s=) сохраняется;
// пустое значение — пустая ячейка с тем же стилем (как Range.Value = "").
// Если ячейка — мастер shared-группы, группа сначала разворачивается
// (клоны получают полную формулу — как делает Excel при перезаписи мастера).
const escXml = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

function replaceCell(xml, ref, value) {
  const re = new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>(?:(?!</c>)[\\s\\S])*?</c>)');
  const m = xml.match(re);
  if (!m) return xml; // ячейки нет — Excel создаёт её пустой со стилем по умолчанию; в шаблоне строка 6 всегда есть
  // мастер shared-группы? -> сначала разворачиваем группу
  const sm = /<f t="shared" ref="([^"]+)" si="(\d+)">([\s\S]*?)<\/f>/.exec(m[0]);
  if (sm) {
    xml = expandSharedGroup(xml, sm[2], sm[3], sm[1]);
  }
  const sM = /s="(\d+)"/.exec(m[1]);
  const sPart = sM ? ` s="${sM[1]}"` : '';
  const newVal = (value === '' || value == null)
    ? `<c r="${ref}"${sPart}/>`
    : `<c r="${ref}"${sPart} t="inlineStr"><is><t xml:space="preserve">${escXml(value)}</t></is></c>`;
  return xml.replace(re, () => newVal);
}

// Удаление calcChain.xml (Excel пересоберёт его сам; иначе —
// «Удаленные записи: Формула из части /xl/calcChain.xml»).
// Убираются: сам part, Override в [Content_Types].xml и Relationship
// в xl/_rels/workbook.xml.rels.
async function removeCalcChain(zip) {
  zip.remove('xl/calcChain.xml');
  const ct = zip.file('[Content_Types].xml');
  if (ct) {
    let s = await ct.async('string');
    if (s && s.indexOf('calcChain') >= 0) {
      s = s.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>\s*/g, '');
      zip.file('[Content_Types].xml', s);
    }
  }
  const rels = zip.file('xl/_rels/workbook.xml.rels');
  if (rels) {
    let s = await rels.async('string');
    if (s && s.indexOf('calcChain') >= 0) {
      s = s.replace(/<Relationship [^>]*calcChain[^>]*\/>\s*/g, '');
      zip.file('xl/_rels/workbook.xml.rels', s);
    }
  }
}

// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ — порт VBA SaveShipmentFile(DataArray1, DataArray2)
// templatePath — «Заявка на отгрузку.XLSX»; outDir — папка «отгрузка».
// Возвращает { fileName, filePath, fileSize }.
// ============================================================
async function generateShipmentFile(dataArray1, dataArray2, templatePath, outDir, extraRows) {
  if (!fs.existsSync(templatePath)) {
    throw new Error('Шаблон заявки не найден: ' + templatePath);
  }
  // === ИМЯ ФАЙЛА (VBA: sSender=DataArray1(5), sReceiver=DataArray1(16), sDate=DataArray2(41)) ===
  const fileName = buildFileName(dataArray1[5], dataArray1[16], dataArray2[41]);

  // === ШАБЛОН -> XML (лист «Заявка NEW!») ===
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const mSheet = wbXml.match(/<sheet[^>]*name="Заявка NEW!"[^>]*r:id="(rId\d+)"/);
  if (!mSheet) throw new Error('В шаблоне нет листа «Заявка NEW!»');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const mTarget = relsXml.match(new RegExp('Id="' + mSheet[1] + '"[^>]*Target="([^"]+)"'));
  if (!mTarget) throw new Error('Лист «Заявка NEW!»: target не найден');
  const sheetPath = 'xl/' + mTarget[1].replace(/^\//, '').replace(/^xl\//, '');
  let sheetXml = await zip.file(sheetPath).async('string');

  // === ВСТАВКА МАССИВОВ (VBA: B6.Resize(1,25)=DataArray1; AG6.Resize(1,24)=DataArray2) ===
  const colLetter = (n) => {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  const cells = {};
  for (let i = 1; i <= 25; i++) cells[colLetter(i + 1) + '6'] = (dataArray1[i] === undefined ? '' : dataArray1[i]); // B..Z (кол. 2..26)
  const AG_COL = 33; // колонка AG
  // ✅ T37-D: отсутствующий элемент (undefined) оставляет в cells
  // undefined — такая ячейка НЕ заменяется (в шаблоне AM6 — формула
  // объёма); '' по-прежнему очищает ячейку. Элемент 56 («+») НЕ
  // вставляется — как в VBA.
  for (let i = 32; i <= 55; i++) cells[colLetter(AG_COL + (i - 32)) + '6'] = dataArray2[i]; // AG..BD (кол. 33..56)

  for (const ref of Object.keys(cells)) {
    if (cells[ref] === undefined) continue; // ✅ T37-D: undefined — ячейку шаблона не трогаем (формула сохраняется 1:1)
    sheetXml = replaceCell(sheetXml, ref, cells[ref]);
  }

  // === ✅ T57: СТРОКИ ТАБЛИЦА ТАБЛИЦА — тарные места перевозки (строки 7..32) ===
  // extraRows = [{ row: 7, cells: { AG: 'Пачки листов', AI: '2', AJ: '6', ... } }]
  // — одна строка на каждый ТИП тарного места (габарит Д×Ш×В, штабелируемость,
  // кол-во, вес); объём строки считает формула шаблона AM (Д×Ш×В×места).
  // Стили ячеек строки 7+ сохраняются (replaceCell переносит s=).
  // ✅ T57-e: в шаблоне строки 7..32 СКРЫТЫ (hidden="1") и забиты
  // примерами. Строка тарного места: раскрывается (hidden снимается —
  // иначе строка не видна в Excel и не печатается), примеры строки
  // очищаются (СТАТИЧЕСКИЕ значения; формулы — адресный блок AF и объём
  // AM — сохраняются), затем записываются данные места. Скрытые строки
  // без данных не трогаются (как в VBA).
  const unhideRow = (xml, rn) =>
    xml.replace(new RegExp('<row r="' + rn + '"([^>]*)>'), (m0, attrs) =>
      '<row r="' + rn + '"' + String(attrs).replace(/\s+hidden="(?:1|true)"/g, '') + '>');
  const clearRowValues = (xml, rn) => {
    const re = new RegExp('(<row r="' + rn + '"[^>]*>)([\\s\\S]*?)(</row>)');
    const m = xml.match(re);
    if (!m) return xml;
    // ✅ T57-f ФИКС ПОРЧИ XML («Ожидается знак ">"» в /xl/worksheets/sheet2.xml):
    // прежний шаблон <c r=".."([^>]*)>([\s\S]*?)</c> для САМОЗАКРЫТОЙ ячейки
    // <c r="A7" s="173"/> захватывал завершающий «/» в attrs и приклеивал
    // содержимое СЛЕДУЮЩЕЙ ячейки до её </c> — получался битый XML
    // <c r="A7" s="173"//> и терялись данные ячеек строки. Теперь регэксп
    // различает самозакрытые <c .../> (attrs БЕЗ «/») и контейнерные
    // <c ...>...</c> — каждая ячейка обрабатывается отдельно.
    const body = m[2].replace(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
      (c0, ref, attrs, inner) =>
        (inner != null && /<f[>\s]/.test(inner))
          ? c0 // формула (объём AM, адресные блоки, мастера shared-групп) — не трогаем
          : '<c r="' + ref + '"' + attrs.replace(/\s+t="[^"]*"/g, '') + '/>');
    return xml.replace(re, () => m[1] + body + m[3]);
  };
  (Array.isArray(extraRows) ? extraRows : []).forEach(er => {
    if (!er || !er.row) return;
    sheetXml = unhideRow(sheetXml, er.row);
    sheetXml = clearRowValues(sheetXml, er.row);
    Object.keys(er.cells || {}).forEach(col => {
      const ref = col + er.row;
      sheetXml = replaceCell(sheetXml, ref, er.cells[col]);
    });
  });
  zip.file(sheetPath, sheetXml);

  // === ИСПРАВЛЕНИЕ ПОРЧИ EXCEL: calcChain + пересчёт при открытии ===
  await removeCalcChain(zip);
  let wbXmlNew = wbXml.replace('<calcPr calcId="191029"/>', '<calcPr calcId="191029" fullCalcOnLoad="1"/>');
  if (wbXmlNew === wbXml) wbXmlNew = wbXml.replace(/<calcPr([^>]*?)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
  zip.file('xl/workbook.xml', wbXmlNew);

  // === СОХРАНЕНИЕ ===
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, fileName);
  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outPath, outBuf);
  return { fileName, filePath: outPath, fileSize: outBuf.length };
}

// ============================================================
// ✅ T59: БУФЕР XLSX ДЛЯ ПРЕДПРОСМОТРА В БРАУЗЕРЕ
// В сгенерированном файле формульные ячейки листа «Заявка NEW!»
// несут КЭШ шаблонных примеров (AB6 «ПТО; Чесноков…», AM6 0.8,
// VLOOKUP-ы перевозчика CJ6 «Тент», кэш строк 7..32). Excel
// пересчитает их при открытии (fullCalcOnLoad), но конвертер
// превью (ExcelJS) формулы НЕ вычисляет — в предпросмотре были
// бы устаревшие примеры. Здесь для строк 6..32 (строка данных +
// строки тарных мест):
//   1) кэш <v> снимается у ВСЕХ формульных ячеек (мастер
//      <f>..</f> и shared-славы <f si/>) — в превью они пустые;
//   2) объём AM пересчитывается по написанным AI..AL
//      (Д×Ш×В×места, ROUNDUP до 1 знака — как формула шаблона
//      IF(ROUNDUP(((AJ*AK*AL)*AI),1)=0,"",…)) и кэш AM
//      записывается — объём в превью виден.
// Возвращает Buffer (xlsx) — для generatePreviewHTML(buf, {sheet}).
// ============================================================
// ============================================================
// ✅ T59: МИНИ-ВЫЧИСЛИТЕЛЬ формул адресных блоков AB..AF (строки 6..32 —
// эти формулы ссылаются ТОЛЬКО на ячейки СВОЕЙ строки): IF(a,b,c) с
// разделителем «,», сравнение «=» (в т.ч. =""), конкатенация «&»,
// CHAR(n), строковые литералы "..." и ссылки A1. Всё остальное
// (VLOOKUP в CE..CJ и т.п.) не поддерживается — throw -> ячейка в
// предпросмотре остаётся пустой (Excel пересчитает её при открытии).
// ============================================================
function xmlUnesc(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}
function evalSheetFormula(f, getVal) {
  let i = 0;
  const s2 = (v) => (v === true ? 'TRUE' : v === false ? 'FALSE' : (v == null ? '' : String(v)));
  const skip = () => { while (i < f.length && /\s/.test(f[i])) i++; };
  function expr() {
    const left = concat();
    skip();
    if (f[i] === '=') { i++; return s2(left) === s2(concat()); } // сравнение «=»
    return left;
  }
  function concat() {
    let s = primary();
    for (;;) {
      skip();
      if (f[i] === '&' && f[i + 1] !== '=') { i++; s = s2(s) + s2(primary()); }
      else break;
    }
    return s;
  }
  function primary() {
    skip();
    if (f[i] === '"') { // литерал, "" — экранированная кавычка
      let j = i + 1, out = '';
      for (;;) {
        if (j >= f.length) throw new Error('unterminated string');
        if (f[j] === '"') { if (f[j + 1] === '"') { out += '"'; j += 2; continue; } break; }
        out += f[j]; j++;
      }
      i = j + 1;
      return out;
    }
    if (f[i] === '(') { i++; const v = expr(); skip(); if (f[i] === ')') i++; return v; }
    if (/^IF\(/i.test(f.slice(i, i + 4))) {
      i += 3;
      const cond = expr();
      skip(); if (f[i] === ',') i++; else throw new Error('IF: expected ,');
      const a = expr();
      skip(); if (f[i] === ',') i++; else throw new Error('IF: expected ,');
      const b = expr();
      skip(); if (f[i] === ')') i++; else throw new Error('IF: expected )');
      return cond === true ? a : b;
    }
    if (/^CHAR\(/i.test(f.slice(i, i + 6))) {
      i += 5;
      const n = parseInt(s2(expr()), 10) || 0;
      skip(); if (f[i] === ')') i++; else throw new Error('CHAR: expected )');
      return String.fromCharCode(n);
    }
    const nm = /^\d+(?:\.\d+)?/.exec(f.slice(i)); // числовой литерал (CHAR(10) и т.п.)
    if (nm) { i += nm[0].length; return parseFloat(nm[0]); }
    const rm = /^[A-Z]{1,3}\d+/.exec(f.slice(i));
    if (rm) { i += rm[0].length; return s2(getVal(rm[0])); }
    throw new Error('unexpected: ' + f.slice(i, i + 12));
  }
  return expr();
}

async function buildPreviewBuffer(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const mSheet = wbXml.match(/<sheet[^>]*name="Заявка NEW!"[^>]*r:id="(rId\d+)"/);
  if (!mSheet) throw new Error('В шаблоне нет листа «Заявка NEW!»');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const mTarget = relsXml.match(new RegExp('Id="' + mSheet[1] + '"[^>]*Target="([^"]+)"'));
  if (!mTarget) throw new Error('Лист «Заявка NEW!»: target не найден');
  const sheetPath = 'xl/' + mTarget[1].replace(/^\//, '').replace(/^xl\//, '');
  let xml = await zip.file(sheetPath).async('string');

  // «6» / «1,5» / «0,167» (текст с запятой — T47) -> число
  const num = (s) => {
    const m = /^-?\d+(?:[.,]\d+)?$/.exec(String(s == null ? '' : s).trim());
    return m ? parseFloat(m[0].replace(',', '.')) : NaN;
  };
  // значение ячейки в строке: inlineStr -> <is><t>, число/кэш -> <v>
  const cellVal = (rowXml, ref) => {
    const m = new RegExp('<c r="' + ref + '"[^>]*?(?:/>|>([\\s\\S]*?)</c>)').exec(rowXml);
    if (!m || m[1] == null) return '';
    const is = /<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(m[1]);
    if (is) return is[1];
    const v = /<v>([\s\S]*?)<\/v>/.exec(m[1]);
    return v ? v[1] : '';
  };
  // кэш master-формул shared-групп (si -> {row, f}) — поиск по листу
  const sharedMasters = new Map();

  for (let rn = 6; rn <= 32; rn++) {
    const rowRe = new RegExp('(<row r="' + rn + '"[^>]*>)([\\s\\S]*?)(</row>)');
    const m = xml.match(rowRe);
    if (!m) continue;
    let body = m[2];
    // 2) объём AM по написанным AI..AL (читаем ДО снятия кэша)
    let vol = null;
    const ai = num(cellVal(body, 'AI' + rn));
    const aj = num(cellVal(body, 'AJ' + rn));
    const ak = num(cellVal(body, 'AK' + rn));
    const al = num(cellVal(body, 'AL' + rn));
    if ([ai, aj, ak, al].every(Number.isFinite) && ai * aj * ak * al > 0) {
      vol = Math.ceil((aj * ak * al * ai) * 10 - 1e-9) / 10; // ROUNDUP(x;1)
    }
    // 1) снять кэш <v> у формульных ячеек. ⚠️ Т59: СТРОГО по-ячеечно —
    // общий регэксп <f[\s\S]*?</f> перелезает через границы ячеек
    // (мастер shared-группы AB7 «проглатывал» AI7..AO7 до чужого </f>)
    // и УНИЧТОЖАЛ данные строки. Различаем самозакрытые <c .../>
    // (attrs БЕЗ «/») и контейнерные <c ...>...</c> — как в clearRowValues.
    body = body.replace(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
      (c0, ref, attrs, inner) => {
        if (inner == null || !/<f[>\s/]/.test(inner)) return c0; // не формула — не трогаем
        const cleaned = inner.replace(/<v>[\s\S]*?<\/v>/, '');
        return '<c r="' + ref + '"' + attrs + '>' + cleaned + '</c>';
      });
    // кэш объёма AM — записать вычисленный (только в формульную ячейку AM)
    if (vol != null) {
      body = body.replace(new RegExp('<c r="AM' + rn + '"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)'),
        (c0, attrs, inner) => {
          if (inner == null || !/<f[>\s/]/.test(inner)) return c0; // нет формулы — не трогаем
          const withoutV = inner.replace(/<v>[\s\S]*?<\/v>/, '');
          return '<c r="AM' + rn + '"' + attrs + '>' + withoutV + '<v>' + vol + '</v></c>';
        });
    }
    // ✅ T59: вычислить адресные блоки AB..AF (единственные формулы строк
    // 6..32, ссылающиеся только на свою строку) — в предпросмотре видны
    // адреса/контакты, а не пустые ячейки. Slave-ячейки (без текста
    // формулы) — текст берётся у master по si со сдвигом строк
    // (штатный shiftFormula). Не смогли вычислить — ячейка остаётся пустой.
    body = body.replace(/<c r="(AB|AC|AD|AE|AF)(\d+)"([^>]*?)>([\s\S]*?)<\/c>/g,
      (c0, col, r, attrs, inner) => {
        const fm = /<f[^>]*>([\s\S]*?)<\/f>/.exec(inner);
        let fText;
        if (fm) {
          fText = fm[1];
        } else {
          const sm = /<f t="shared" si="(\d+)"\s*\/>/.exec(inner);
          if (!sm) return c0;                       // не shared-slave — не трогаем
          const si = sm[1];
          if (!sharedMasters.has(si)) {
            const mm = new RegExp('<f t="shared" ref="[A-Z]+(\\d+):[A-Z]+\\d+" si="' + si + '">([\\s\\S]*?)</f>').exec(xml);
            sharedMasters.set(si, mm ? { row: +mm[1], f: mm[2] } : null);
          }
          const master = sharedMasters.get(si);
          if (!master) return c0;
          try { fText = shiftFormula(master.f, rn - master.row, 0); }
          catch (e) { return c0; }
        }
        try {
          const val = evalSheetFormula(xmlUnesc(fText), (ref) => cellVal(body, ref));
          if (val == null || val === '') return c0;
          const cleaned = inner.replace(/<v>[\s\S]*?<\/v>/, '');
          return '<c r="' + col + r + '"' + attrs + '>' + cleaned + '<v xml:space="preserve">' + escXml(val) + '</v></c>';
        } catch (e) { return c0; }
      });
    xml = xml.replace(rowRe, () => m[1] + body + m[3]);
  }
  zip.file(sheetPath, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

module.exports = { buildFileName, shiftFormula, expandSharedGroup, replaceCell, escXml, removeCalcChain, generateShipmentFile, buildPreviewBuffer };
