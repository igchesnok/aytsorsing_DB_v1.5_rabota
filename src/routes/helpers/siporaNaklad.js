// ============================================================
// ✅ T38: helpers/siporaNaklad.js — ПОЛНЫЙ ПОРТ VBA modNaklad
// (создание накладных М-15 в системе ВАЗ — SIPORA
// tportal.vaz.ru/sipora/ou38, Basic-аутентификация).
//
// АЛГОРИТМ КАК В VBA (модифицированный Add — «СОЗДАНИЕ НАКЛАДНОЙ
// С ПОЗИЦИЯМИ (С УДАЛЕНИЕМ СУЩЕСТВУЮЩЕЙ)», ВОЗВРАЩАЕТ SB01_NOMWB):
//   1) lookup отправителя (LB), получателя (LC), поставщика (LD),
//      документа-основания (LA) и номенклатуры каждого артикула (KMPN);
//   2) поиск существующих накладных /load/mask/A (дата+отправитель+
//      получатель) и их удаление /del/mask/A?ids=KROWID;API_ROW_ID;
//   3) создание /ins/mask/A (заголовок: SB01_IDSENDER/IDRECEIVER/IDPOST/
//      IDBASIS/STATUS=0/DATEWB/SHIPPING/KPPUSE=1/SENDER…/BASISTXT/
//      THROUGH_WHOM/TYPEMOVE/TRANSNUM/TRAILNUM);
//   4) повторная загрузка /load/mask/A -> первая строка:
//      SB01_NOMWB (номер) + SB01_RECID;
//   5) позиции: /ins/mask/B (SB02_MPN/NAME/QTY/PRICE/EI + EINAME,
//      PRICE пустая — как в VBA: result.Price = "").
//
// ВСПОМОГАТЕЛЬНЫЕ ПАРСЕРЫ (JVal / ParseCells / ParseApiRows /
// DecodeUnicode) — ПОСИМВОЛЬНЫЕ ПОРТЫ VBA (SIPORA отвечает JSON с
// cell-массивами и \uXXXX для кириллицы — потому в VBA свой парсер).
// В VBА строки 1-базные (Mid), здесь 0-базные — логика та же.
//
// Учётные данные — config/edo.json (аналог листа «настройки» E4/E5,
// те же, что у ЭДО); адрес SIPORA — cfg.sipora_url, по умолчанию
// https://tportal.vaz.ru/sipora/ou38 (в VBA — Const BASE_URL).
// ============================================================
'use strict';

const edo = require('./edoPortal');

// --- VBA: Private Const BASE_URL = "https://tportal.vaz.ru/sipora/ou38" ---
function getBaseUrl(cfg) {
  const u = cfg && cfg.sipora_url ? String(cfg.sipora_url).replace(/\/+$/, '') : '';
  return u || 'https://tportal.vaz.ru/sipora/ou38';
}

// --- VBA: URLEncode = Application.WorksheetFunction.EncodeURL ---
const urlEncode = (v) => encodeURIComponent(String(v == null ? '' : v));

// --- VBA: IsApiError(json) = InStr(json, """ERR""") > 0 ---
function isApiError(json) {
  return String(json || '').indexOf('"ERR"') >= 0;
}

// --- VBA: JVal — одно-ключевой разбор JSON (посимвольный порт) ----------
// Возвращает значение ключа: строку без кавычек или примитив как текст;
// null -> "". Ключ ищется как "key" вхождение (binary compare).
function jval(json, key) {
  const s = String(json || '');
  let p = s.indexOf('"' + key + '"');
  if (p < 0) return '';
  p = s.indexOf(':', p + key.length + 2);
  if (p < 0) return '';
  p += 1;
  while (p < s.length && s.charAt(p) === ' ') p++;
  if (p >= s.length) return '';
  if (s.substr(p, 4) === 'null') return '';
  if (s.charAt(p) === '"') {
    p += 1;
    let e = p;
    while (e < s.length) {
      if (s.charAt(e) === '"' && s.charAt(e - 1) !== '\\') break;
      e++;
    }
    return s.slice(p, e);
  }
  let e = p;
  while (e < s.length) {
    const c = s.charAt(e);
    if (c === ',' || c === '}' || c === ']' || c === ' ' || c === '\n') break;
    e++;
  }
  return s.slice(p, e);
}

// --- VBA: DecodeUnicode — \uXXXX -> символ (порт) -----------------------
function decodeUnicode(s) {
  s = String(s == null ? '' : s);
  let i = 0, result = '';
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '\\' && i + 5 < s.length && s.charAt(i + 1) === 'u') {
      // VBA: Code = Val("&H" & Mid(s, i+2, 4)); берём, если Code > 0
      const code = parseInt(s.substr(i + 2, 4), 16);
      if (!isNaN(code) && code > 0) {
        result += String.fromCharCode(code);
        i += 6;
      } else {
        result += c;
        i += 1;
      }
    } else {
      result += c;
      i += 1;
    }
  }
  return result;
}

// --- VBA: ParseCells — разбор "cell":[ ... ] в словарь по карте полей ----
// fieldMap: { имяПоля: индексВМассиве }; вне массива/короче — "".
function parseCells(cellJson, fieldMap) {
  const s = String(cellJson || '');
  const dict = {};
  const arr = [];                       // VBA: arr(0 To 50)
  let p = s.indexOf('"cell":[');
  if (p < 0) { fillDict(); return dict; }
  p += 8;                               // VBA: p = p + 8 (после '[')
  let depth = 1, idx = 0;
  while (p < s.length && depth > 0 && idx <= 50) {
    const c = s.charAt(p);
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { p++; continue; }
    if (c === ',') { p++; continue; }
    if (c === ']') { depth--; p++; continue; }
    if (c === '[') { depth++; p++; continue; }
    if (c === '"') {
      p++;
      let e = p;
      while (e < s.length) {
        if (s.charAt(e) === '"' && s.charAt(e - 1) !== '\\') break;
        e++;
      }
      arr[idx] = decodeUnicode(s.slice(p, e));
      idx++; p = e + 1;
      continue;
    }
    if (c === 'n') { arr[idx] = ''; idx++; p += 4; continue; }          // null
    if (c === 't') { arr[idx] = 'true'; idx++; p += 4; continue; }      // true
    if (c === 'f') { arr[idx] = 'false'; idx++; p += 5; continue; }     // false
    // число/прочее: до ',', ']', ' ', '\n'
    let e = p;
    while (e < s.length) {
      const ce = s.charAt(e);
      if (ce === ',' || ce === ']' || ce === ' ' || ce === '\n') break;
      e++;
    }
    arr[idx] = decodeUnicode(s.slice(p, e));
    idx++; p = e;
  }
  function fillDict() {
    for (const key of Object.keys(fieldMap)) {
      const i = fieldMap[key];
      dict[key] = (i < arr.length && arr[i] !== undefined) ? arr[i] : '';
    }
  }
  fillDict();
  return dict;
}

// --- VBA: ParseApiRows — строки {"id":..,"cell":[..]} из ответа SIPORA ---
// total берётся JVal(json,"total"); строки — сбалансированные {...} после
// "rows":[; каждой добавляется API_ROW_ID (если нет). Возвращает массив.
function parseApiRows(json, fieldMap) {
  const s = String(json || '');
  const rows = [];
  let total = parseInt(jval(s, 'total'), 10);
  if (isNaN(total) || total <= 0) total = 0;
  if (total === 0) return rows;

  let p = s.indexOf('"rows":[');
  if (p < 0) return rows;
  p += 8;

  let rowIdx = 0;
  while (rowIdx < total) {
    const startBrace = s.indexOf('{', p);
    if (startBrace < 0) break;
    let depth = 1, q = startBrace + 1;
    while (q < s.length && depth > 0) {
      const cc = s.charAt(q);
      if (cc === '{') depth++;
      if (cc === '}') depth--;
      q++;
    }
    const rowJson = s.slice(startBrace, q);
    rowIdx++;
    const rowId = jval(rowJson, 'id');
    const cellDict = parseCells(rowJson, fieldMap);
    if (cellDict.API_ROW_ID === undefined) cellDict.API_ROW_ID = rowId;
    rows.push(cellDict);
    p = q;
  }
  return rows;
}

// --- Карты полей (VBA GetWaybillFieldMap / GetLookupFieldMap / ...) ------
function getWaybillFieldMap() {
  return {
    SB01_NOMWB: 0, SB01_DATEWB: 1, SB01_SHIPPING: 2,
    SB01_SENDER: 3, SB01_SENDERNAME: 4, SB01_RECEIVER: 5,
    SB01_RECEIVERNAME: 6, SB01_BASISTXT: 7, STATUSCOMM: 8,
    SB01_KPPUSE: 9, SB01_RECID: 10, SB01_IDSENDER: 11,
    SB01_IDRECEIVER: 12, SB01_IDPOST: 13, SB01_POST: 14,
    SB01_POSTNAME: 15, SB01_IDBASIS: 16, BASISNUM: 17,
    SB01_STATUS: 18, SB01_IDWB: 19, SB01_IDWARANT: 20,
    SB01_NOMWARANT: 21, SB01_THROUGH_WHOM: 22, SB01_DATEWARANT: 23,
    SB01_TRANSNUM: 24, SB01_TRAILNUM: 25, SB01_CREATED_WHEN: 26,
    SB01_CREATED_BY: 27, CREATED_BY_FIO: 28, SB01_ACCEPTED_WHEN: 29,
    SB01_ACCEPTED_BY: 30, ACCEPTED_BY_FIO: 31, SB01_TYPEMOVE: 32,
    KROWID: 33, READWHEN: 34
  };
}
const LOOKUP_MAP = { KOD: 0, NAME: 1, IDKOD: 2 };                 // cell: [KOD, NAME, IDKOD]
const BASIS_MAP = { SB01_BASISTXT: 0, SB01_IDBASIS: 1, BASISNUM: 2 }; // cell: [BASISTXT, IDBASIS, BASISNUM]
const PRODUCT_MAP = { SB02_MPN: 0, SB02_NAME: 1, SB02_EI: 2, EINAME: 3, SB02_PRICE: 4 };

// --- Общий GET (VBA SendGetRequest: WinHttp + Basic, не-200 -> ERR) ------
function sendGetRequest(cfg, url, opts) {
  return edo.sendGetRequest(cfg.username, cfg.password, url, {
    rejectUnauthorized: cfg.reject_unauthorized,
    timeoutMs: (opts && opts.timeoutMs) || 30000
  });
}

// --- VBA: LookupFirmData — ID + NAME фирмы по коду ----------------------
// url: /lookup?FIELD=<code>&__ML=A&__LL=<LB|LC|LD>&__TL=1
async function lookupFirmData(cfg, firmCode, fieldName, llParam) {
  const baseUrl = getBaseUrl(cfg);
  const url = baseUrl + '/lookup?' + fieldName + '=' + urlEncode(firmCode) +
    '&__ML=A&__LL=' + llParam + '&__TL=1';
  const response = await sendGetRequest(cfg, url);
  if (isApiError(response)) return { code: firmCode, id: '', name: '', found: false };
  const rows = parseApiRows(response, LOOKUP_MAP);
  if (rows.length > 0) {
    const firmData = rows[0];
    return {
      code: firmData.KOD || firmCode,
      name: firmData.NAME || '',
      id: firmData.IDKOD || '',
      found: true
    };
  }
  return { code: firmCode, id: '', name: '', found: false };
}

// VBA GetSenderInfo / GetReceiverInfo / GetSupplierInfo
const getSenderInfo = (cfg, code) => lookupFirmData(cfg, code, 'SB01_SENDER', 'LB');
const getReceiverInfo = (cfg, code) => lookupFirmData(cfg, code, 'SB01_RECEIVER', 'LC');
const getSupplierInfo = (cfg, code) => lookupFirmData(cfg, code, 'SB01_POST', 'LD');

// --- VBA: GetBasisInfo — документ-основание по получателю и номеру ------
// url: /lookup?SB01_RECEIVER=<rc>&BASISNUM=<num>&__ML=A&__LL=LA&__TL=1
async function getBasisInfo(cfg, receiverCode, basisNum) {
  const baseUrl = getBaseUrl(cfg);
  const url = baseUrl + '/lookup?' +
    'SB01_RECEIVER=' + urlEncode(receiverCode) +
    '&BASISNUM=' + urlEncode(basisNum) +
    '&__ML=A&__LL=LA&__TL=1';
  const response = await sendGetRequest(cfg, url);
  if (isApiError(response)) return { basisTxt: '', idBasis: '', basisNum, found: false };
  const rows = parseApiRows(response, BASIS_MAP);
  if (rows.length > 0) {
    const basisData = rows[0];
    return {
      basisTxt: basisData.SB01_BASISTXT || '',
      idBasis: basisData.SB01_IDBASIS || '',
      basisNum: basisData.BASISNUM || basisNum,
      found: true
    };
  }
  return { basisTxt: '', idBasis: '', basisNum, found: false };
}

// --- VBA: GetProductInfo — номенклатура по коду отправителя и артикулу ---
// url: /lookup?SB01_SENDER=<sc>&SB02_MPN=<mpn>&__ML=B&__LL=KMPN&__TL=1
// ВАЖНО (как в VBA): Price = "" (строка result.Price = "" закомментировала
// чтение SB02_PRICE из ответа).
async function getProductInfo(cfg, senderCode, mpn) {
  const baseUrl = getBaseUrl(cfg);
  const url = baseUrl + '/lookup?' +
    'SB01_SENDER=' + urlEncode(senderCode) +
    '&SB02_MPN=' + urlEncode(mpn) +
    '&__ML=B&__LL=KMPN&__TL=1';
  const response = await sendGetRequest(cfg, url);
  if (isApiError(response)) return { mpn, name: '', ei: '', eiName: '', price: '', found: false };
  const rows = parseApiRows(response, PRODUCT_MAP);
  if (rows.length > 0) {
    const productData = rows[0];
    return {
      mpn: productData.SB02_MPN || mpn,
      name: productData.SB02_NAME || '',
      ei: productData.SB02_EI || '',
      eiName: productData.EINAME || '',
      price: '',
      found: true
    };
  }
  return { mpn, name: '', ei: '', eiName: '', price: '', found: false };
}

// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ — порт VBA modNaklad.Add (возвращает номер
// накладной SB01_NOMWB; при ошибке — {error}, номер пустой).
// ============================================================
// opts: { senderCode, receiverCode, postCode, basisNum, shippingDate,
//         throughWhom, typeMove, transNum, trailNum,
//         pozArticuls: [], pozQuantities: [],
//         pozNames: [] }  // ✅ T55: наименования из БД (osnastka.naimenovanie
// по чертёжному номеру) — перезаписывают SB02_NAME из справочника
// номенклатуры SIPORA; пустое/отсутствующее — имя из lookup (как раньше)
async function add(cfg, opts) {
  try {
    const baseUrl = getBaseUrl(cfg);
    const arts = opts.pozArticuls || [];
    const qtys = opts.pozQuantities || [];
    if (arts.length !== qtys.length) {
      return { error: 'Ошибка: размеры массивов артикулов и количеств не совпадают' };
    }
    // ✅ T55: массив наименований параллелен артикулам; не передан/не совпал
    // длиной — работаем по-старому (имя из lookup KMPN)
    const names = (Array.isArray(opts.pozNames) && opts.pozNames.length === arts.length)
      ? opts.pozNames : null;

    // --- Получение справочных данных (VBA: sender/receiver/post/basis) ---
    const sendInfo = await getSenderInfo(cfg, opts.senderCode);
    const recvInfo = await getReceiverInfo(cfg, opts.receiverCode);
    const postInfo = await getSupplierInfo(cfg, opts.postCode);
    const basis = await getBasisInfo(cfg, opts.receiverCode, opts.basisNum);

    let errMsg = '';
    if (!sendInfo.found) errMsg += 'Не найден отправитель: ' + opts.senderCode + '\n';
    if (!recvInfo.found) errMsg += 'Не найден получатель: ' + opts.receiverCode + '\n';
    if (!postInfo.found) errMsg += 'Не найден поставщик: ' + opts.postCode + '\n';
    if (!basis.found) errMsg += 'Не найден документ-основание: ' + opts.basisNum + '\n';
    if (errMsg.length > 0) return { error: errMsg };

    // --- Проверка всех позиций (артикулов) ---
    const productInfos = [];
    for (let i = 0; i < arts.length; i++) {
      const prod = await getProductInfo(cfg, opts.senderCode, String(arts[i]));
      if (!prod.found) {
        return { error: "Не найдена номенклатура: артикул '" + arts[i] + "' для отправителя " + opts.senderCode };
      }
      productInfos.push(prod);
    }

    // --- Поиск и удаление существующих накладных (дата, отправитель, получатель) ---
    const loadUrl = baseUrl + '/load/mask/A?' +
      '_sc%5BSB01_NOMWB%5D=%3D&SB01_NOMWB=' +
      '&_sc%5BSB01_DATEWB%5D=%3D&SB01_DATEWB=' + urlEncode(opts.shippingDate) +
      '&_sc%5BSB01_SHIPPING%5D=%3D&SB01_SHIPPING=' + urlEncode(opts.shippingDate) +
      '&_sc%5BSB01_SENDER%5D=%3D&SB01_SENDER=' + urlEncode(opts.senderCode) +
      '&_sc%5BSB01_RECEIVER%5D=%3D&SB01_RECEIVER=' + urlEncode(opts.receiverCode) +
      '&SB01_KPPUSE=&__NF=&_sc%5B_has_B%5D=%3D&_has_B=0';

    const waybillMap = getWaybillFieldMap();
    let response = await sendGetRequest(cfg, loadUrl);

    if (!isApiError(response)) {
      const waybillRows = parseApiRows(response, waybillMap);
      for (const row of waybillRows) {
        const delUrl = baseUrl + '/del/mask/A?ids=' +
          urlEncode((row.KROWID || '') + ';' + (row.API_ROW_ID || ''));
        response = await sendGetRequest(cfg, delUrl);
        if (jval(response, 'oper') !== 'DEL') {
          return { error: 'Ошибка удаления существующей накладной: ' + response };
        }
      }
    }

    // --- Создание новой накладной (25 параметров, как в VBA paramParts) ---
    const paramParts = [
      'SB01_RECID=',
      'SB01_IDSENDER=' + sendInfo.id,
      'SB01_IDRECEIVER=' + recvInfo.id,
      'SB01_IDPOST=' + postInfo.id,
      'SB01_IDBASIS=' + basis.idBasis,
      'SB01_STATUS=0',
      'SB01_IDWB=',
      'SB01_IDWARANT=',
      'KROWID=',
      'SB01_NOMWB=',
      'SB01_DATEWB=' + urlEncode(opts.shippingDate),
      'SB01_SHIPPING=' + urlEncode(opts.shippingDate),
      'SB01_KPPUSE=1',
      'SB01_SENDER=' + urlEncode(opts.senderCode),
      'SB01_SENDERNAME=' + urlEncode(sendInfo.name),
      'SB01_RECEIVER=' + urlEncode(opts.receiverCode),
      'SB01_RECEIVERNAME=' + urlEncode(recvInfo.name),
      'SB01_POST=' + urlEncode(opts.postCode),
      'SB01_POSTNAME=' + urlEncode(postInfo.name),
      'SB01_BASISTXT=' + urlEncode(basis.basisTxt),
      'SB01_NOMWARANT=',
      'SB01_DATEWARANT=',
      'SB01_THROUGH_WHOM=' + urlEncode(opts.throughWhom),
      'SB01_TYPEMOVE=' + urlEncode(opts.typeMove),
      'SB01_TRANSNUM=' + urlEncode(opts.transNum),
      'SB01_TRAILNUM=' + urlEncode(opts.trailNum)
    ];
    const insUrl = baseUrl + '/ins/mask/A?' + paramParts.join('&');

    response = await sendGetRequest(cfg, insUrl);
    if (jval(response, 'oper') !== 'INS') {
      return { error: 'Ошибка создания накладной: ' + response };
    }

    // --- Получение созданной накладной (номер и RecId) ---
    response = await sendGetRequest(cfg, loadUrl);
    if (isApiError(response)) {
      return { error: 'Накладная создана, но не найдена при повторной загрузке' };
    }
    const newRows = parseApiRows(response, waybillMap);
    if (newRows.length === 0) {
      return { error: 'Накладная создана, но не найдена в списке' };
    }
    const newWaybill = newRows[0];
    const waybillNumber = newWaybill.SB01_NOMWB || '';
    const recId = newWaybill.SB01_RECID || '';
    if (waybillNumber === '' || recId === '') {
      return { error: 'Не удалось получить номер накладной или RecId созданной накладной' };
    }

    // --- Добавление позиций ---
    for (let i = 0; i < arts.length; i++) {
      const qty = String(qtys[i]);
      const prod = productInfos[i];
      // ✅ T55: наименование позиции — из БД (pozNames); пустое — из
      // справочника номенклатуры SIPORA (прежнее поведение)
      const nm = names ? String(names[i] == null ? '' : names[i]).trim() : '';
      const insPosUrl = baseUrl + '/ins/mask/B?' +
        'SB01_RECID=' + recId +
        '&SB02_MPN=' + urlEncode(prod.mpn) +
        '&SB02_NAME=' + urlEncode(nm || prod.name) +
        '&SB02_QTY=' + urlEncode(qty) +
        '&SB02_PRICE=' + urlEncode(prod.price) +
        '&SB02_EI=' + urlEncode(prod.ei) +
        '&EINAME=' + urlEncode(prod.eiName);
      response = await sendGetRequest(cfg, insPosUrl);
      if (jval(response, 'oper') !== 'INS') {
        return { error: 'Ошибка добавления позиции ' + (i + 1) + ' (артикул ' + prod.mpn + '): ' + response };
      }
    }

    // Успех: возвращаем номер накладной
    return { number: waybillNumber };
  } catch (e) {
    // VBA ErrorHandler: «Непредвиденная ошибка: " & Err.Description
    return { error: 'Непредвиденная ошибка: ' + e.message };
  }
}

module.exports = {
  getBaseUrl, urlEncode, isApiError, jval, decodeUnicode, parseCells, parseApiRows,
  getWaybillFieldMap, lookupFirmData, getSenderInfo, getReceiverInfo, getSupplierInfo,
  getBasisInfo, getProductInfo, add
};
