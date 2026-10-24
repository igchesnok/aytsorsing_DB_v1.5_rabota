/**
 * ============================================================
 * ТЕСТОВЫЕ ДАННЫЕ ДЛЯ РЕДАКТОРА МАРШРУТОВ
 * ============================================================
 */

// ==================== ПЛАН ПРОИЗВОДСТВА (ДЕТАЛИ) ====================
const planProizvodstva = [
  { ID: 'PP_001', NomerChertezha: 'Черт. 2024-001', Nazvanie: 'Вал приводной', God: '2024', Kolvo: 10 },
  { ID: 'PP_002', NomerChertezha: 'Черт. 2024-002', Nazvanie: 'Втулка направляющая', God: '2024', Kolvo: 25 },
  { ID: 'PP_003', NomerChertezha: 'Черт. 2024-003', Nazvanie: 'Шестерня Z=32', God: '2024', Kolvo: 8 },
  { ID: 'PP_004', NomerChertezha: 'Черт. 2024-004', Nazvanie: 'Корпус редуктора', God: '2024', Kolvo: 4 },
  { ID: 'PP_005', NomerChertezha: 'Черт. 2024-005', Nazvanie: 'Крышка подшипника', God: '2024', Kolvo: 12 },
  { ID: 'PP_006', NomerChertezha: 'Черт. 2024-006', Nazvanie: 'Ось промежуточная', God: '2024', Kolvo: 6 },
  { ID: 'PP_007', NomerChertezha: 'Черт. 2024-007', Nazvanie: 'Фланец соединительный', God: '2024', Kolvo: 15 },
  { ID: 'PP_008', NomerChertezha: 'Черт. 2024-008', Nazvanie: 'Палец опорный', God: '2024', Kolvo: 30 },
];

// ==================== ТИПЫ ПЕРЕВОЗОК ====================
const transportTypes = [
  { ID: 'TP_001', NazvanieOperatsii: 'Отправка контрагенту на мех. обработку', UchetVOstatke: '1' },
  { ID: 'TP_002', NazvanieOperatsii: 'Получение от контрагента после мех. обработки', UchetVOstatke: '-1' },
  { ID: 'TP_003', NazvanieOperatsii: 'Отправка на термообработку', UchetVOstatke: '1' },
  { ID: 'TP_004', NazvanieOperatsii: 'Получение после термообработки', UchetVOstatke: '-1' },
  { ID: 'TP_005', NazvanieOperatsii: 'Отправка на покрытие', UchetVOstatke: '1' },
  { ID: 'TP_006', NazvanieOperatsii: 'Получение после покрытия', UchetVOstatke: '-1' },
  { ID: 'TP_007', NazvanieOperatsii: 'Передача в ПТО', UchetVOstatke: '1' },
  { ID: 'TP_008', NazvanieOperatsii: 'Приемка ОТК', UchetVOstatke: '-1' },
];

// ==================== ОСНАСТКА (ХАРАКТЕРИСТИКИ ДЕТАЛЕЙ) ====================
const osnastka = {
  'PP_001': { ID: 'OSN_001', IDOsnastka: 'OSN_001', Zakalka: true,  Pokritie: true,  NomerChertezha: 'Черт. 2024-001' },
  'PP_002': { ID: 'OSN_002', IDOsnastka: 'OSN_002', Zakalka: true,  Pokritie: false, NomerChertezha: 'Черт. 2024-002' },
  'PP_003': { ID: 'OSN_003', IDOsnastka: 'OSN_003', Zakalka: true,  Pokritie: true,  NomerChertezha: 'Черт. 2024-003' },
  'PP_004': { ID: 'OSN_004', IDOsnastka: 'OSN_004', Zakalka: false, Pokritie: true,  NomerChertezha: 'Черт. 2024-004' },
  'PP_005': { ID: 'OSN_005', IDOsnastka: 'OSN_005', Zakalka: false, Pokritie: false, NomerChertezha: 'Черт. 2024-005' },
  'PP_006': { ID: 'OSN_006', IDOsnastka: 'OSN_006', Zakalka: true,  Pokritie: true,  NomerChertezha: 'Черт. 2024-006' },
  'PP_007': { ID: 'OSN_007', IDOsnastka: 'OSN_007', Zakalka: false, Pokritie: true,  NomerChertezha: 'Черт. 2024-007' },
  'PP_008': { ID: 'OSN_008', IDOsnastka: 'OSN_008', Zakalka: true,  Pokritie: false, NomerChertezha: 'Черт. 2024-008' },
};

// ==================== ШАГИ МАРШРУТА ====================
let shagiMarshruta = [
  // Маршрут для PP_001 (Вал приводной)
  { ID: 'SH_001', nomShag: 1, idDet: 'PP_001', strIdOper: 'OP_001;OP_002', execShag: 'Контрагент', commShag: 'Черновая обработка вала', idTP: 'TP_001' },
  { ID: 'SH_002', nomShag: 2, idDet: 'PP_001', strIdOper: 'OP_003',       execShag: 'ПТО',          commShag: 'Термообработка',         idTP: 'TP_003' },
  { ID: 'SH_003', nomShag: 3, idDet: 'PP_001', strIdOper: 'OP_004;OP_005', execShag: 'Контрагент', commShag: 'Чистовая обработка',     idTP: 'TP_001' },
  { ID: 'SH_004', nomShag: 4, idDet: 'PP_001', strIdOper: 'OP_006',       execShag: 'Контрагент', commShag: 'Покрытие хромом',        idTP: 'TP_005' },
  { ID: 'SH_005', nomShag: 5, idDet: 'PP_001', strIdOper: 'OP_007',       execShag: 'ПТО',          commShag: 'Контроль ОТК',           idTP: 'TP_007' },
  
  // Маршрут для PP_003 (Шестерня)
  { ID: 'SH_010', nomShag: 1, idDet: 'PP_003', strIdOper: 'OP_020;OP_021', execShag: 'Контрагент', commShag: 'Нарезка зубьев', idTP: 'TP_001' },
  { ID: 'SH_011', nomShag: 2, idDet: 'PP_003', strIdOper: 'OP_022',        execShag: 'ПТО',          commShag: 'Закалка',        idTP: 'TP_003' },
];

// ==================== ОПЕРАЦИИ МАРШРУТА ====================
let operatsiiMarshruta = [
  // Операции для PP_001
  { ID: 'OP_001', naimOper: 'Универсальная фрезерная', dtStartOper: '2024-03-01', dtEndOper: '2024-03-05', statOper: 'Выполнено' },
  { ID: 'OP_002', naimOper: 'Токарная',              dtStartOper: '2024-03-06', dtEndOper: '2024-03-10', statOper: 'Выполнено' },
  { ID: 'OP_003', naimOper: 'Объемная закалка',      dtStartOper: '2024-03-11', dtEndOper: '2024-03-13', statOper: 'В работе' },
  { ID: 'OP_004', naimOper: 'Чистовая 3D ЧПУ',       dtStartOper: '2024-03-14', dtEndOper: '2024-03-18', statOper: 'Планируется' },
  { ID: 'OP_005', naimOper: 'Чистовая шлифовальная', dtStartOper: '2024-03-19', dtEndOper: '2024-03-22', statOper: 'Планируется' },
  { ID: 'OP_006', naimOper: 'Хромирование',          dtStartOper: '2024-03-23', dtEndOper: '2024-03-25', statOper: 'Планируется' },
  { ID: 'OP_007', naimOper: 'Окончательная обработка', dtStartOper: '2024-03-26', dtEndOper: '2024-03-27', statOper: 'Планируется' },
  
  // Операции для PP_003
  { ID: 'OP_020', naimOper: '3D ЧПУ',                dtStartOper: '2024-04-01', dtEndOper: '2024-04-05', statOper: 'В работе' },
  { ID: 'OP_021', naimOper: 'Токарная',              dtStartOper: '2024-04-06', dtEndOper: '2024-04-08', statOper: 'Планируется' },
  { ID: 'OP_022', naimOper: 'Цементация',            dtStartOper: '2024-04-09', dtEndOper: '2024-04-11', statOper: 'Планируется' },
];

// ==================== СЧЁТЧИКИ ID ====================
let nextShId = 20;
let nextOpId = 30;

function generateId(prefix) {
  const now = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const ts = now.getFullYear().toString() +
    pad(now.getMonth() + 1) + pad(now.getDate()) +
    pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
  const rnd = Math.floor(Math.random() * 100000);
  return `${prefix}_${ts}_${rnd}`;
}

// ==================== ЭКСПОРТ ====================
module.exports = {
  planProizvodstva,
  transportTypes,
  osnastka,
  shagiMarshruta,
  operatsiiMarshruta,
  generateId,
  
  // Методы для изменения данных (эмуляция БД)
  addShag(shag) { shagiMarshruta.push(shag); },
  updateShag(id, data) {
    const idx = shagiMarshruta.findIndex(s => s.ID === id);
    if (idx >= 0) shagiMarshruta[idx] = { ...shagiMarshruta[idx], ...data };
  },
  deleteShag(id) {
    shagiMarshruta = shagiMarshruta.filter(s => s.ID !== id);
  },
  addOper(op) { operatsiiMarshruta.push(op); },
  updateOper(id, data) {
    const idx = operatsiiMarshruta.findIndex(o => o.ID === id);
    if (idx >= 0) operatsiiMarshruta[idx] = { ...operatsiiMarshruta[idx], ...data };
  },
  deleteOper(id) {
    operatsiiMarshruta = operatsiiMarshruta.filter(o => o.ID !== id);
  }
};