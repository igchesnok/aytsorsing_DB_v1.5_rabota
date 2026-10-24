// src/routes/testVirtualSelectRoutes.js
// ТЕСТОВЫЙ РОУТ: генерация 50000 записей для проверки VirtualSelect
const { send } = require('../utils');

// Генерируем 50000 записей один раз при старте
let _cache = null;
function getData() {
  if (_cache) return _cache;
  _cache = [];
  for (let i = 1; i <= 50000; i++) {
    _cache.push({
      id: 'OSN_' + String(i).padStart(6, '0'),
      nomer_chertezha: 'ЧРТ-' + String(i).padStart(5, '0'),
      naimenovanie: `Деталь №${i} (${['Вал', 'Втулка', 'Шестерня', 'Корпус', 'Фланец', 'Ось', 'Палец', 'Крышка'][i % 8]})`,
      avto_mob_det: ['Авто', 'Моб', 'Дет'][i % 3],
      zakalka: i % 3 === 0 ? 1 : 0,
      ppd: i % 4 === 0 ? 1 : 0
    });
  }
  console.log(`[TestVS] ✅ Сгенерировано ${_cache.length} тестовых записей`);
  return _cache;
}

module.exports = () => ({
  async GET(req, res, url) {
    try {
      const data = getData();
      const search = (url.searchParams.get('nomer_chertezha') || '').toLowerCase();
      const id = url.searchParams.get('id');

      let filtered = data;
      if (id) {
        filtered = data.filter(r => r.id === id);
      } else if (search) {
        filtered = data.filter(r =>
          r.nomer_chertezha.toLowerCase().includes(search) ||
          r.naimenovanie.toLowerCase().includes(search)
        );
      }

      // ✅ ИСПРАВЛЕНО: отдаем ВСЕ отфильтрованные записи, без slice(limit)
      // Клиент сам отрендерит только видимые 30-40 строк благодаря виртуализации
      send(res, 200, filtered);
    } catch (e) {
      console.error('[TestVS] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  }
});