/**
 * ============================================================
 * ЗАГЛУШКИ API ДЛЯ РЕДАКТОРА МАРШРУТОВ
 * ============================================================
 */
const mock = require('./mockData');
const { send, parseBody } = require('../utils');

module.exports = () => {
  return async (req, res, url, method) => {
    const p = url.pathname;
    
    // ==================== ПЛАН ПРОИЗВОДСТВА ====================
    if (p === '/api/plan_proizvodstva' && method === 'GET') {
      return send(res, 200, mock.planProizvodstva);
    }

    // ==================== ТИПЫ ПЕРЕВОЗОК ====================
    if (p === '/api/transport_types' && method === 'GET') {
      return send(res, 200, mock.transportTypes);
    }

    // ==================== ОСНАСТКА (ХАРАКТЕРИСТИКИ ДЕТАЛИ) ====================
    if (p.match(/^\/api\/osnastka\/[^/]+$/) && method === 'GET') {
      const detId = p.split('/')[3];
      const osn = mock.osnastka[detId];
      if (!osn) {
        return send(res, 404, { error: 'Оснастка не найдена' });
      }
      return send(res, 200, osn);
    }

    // ==================== МАРШРУТ ДЕТАЛИ ====================
    if (p === '/api/routes' && method === 'GET') {
      const detId = url.searchParams.get('detId');
      if (!detId) {
        return send(res, 400, { error: 'Не указан detId' });
      }
      
      const steps = mock.shagiMarshruta
        .filter(s => s.idDet === detId)
        .sort((a, b) => a.nomShag - b.nomShag);
      
      // Собираем все ID операций из шагов
      const opIds = new Set();
      steps.forEach(s => {
        if (s.strIdOper) {
          s.strIdOper.split(';').filter(id => id).forEach(id => opIds.add(id));
        }
      });
      
      const operations = mock.operatsiiMarshruta.filter(o => opIds.has(o.ID));
      
      return send(res, 200, { steps, operations });
    }

    // ==================== CRUD ШАГОВ ====================
    if (p === '/api/steps' && method === 'POST') {
      const d = await parseBody(req);
      const id = mock.generateId('SH');
      const newShag = { ID: id, ...d };
      mock.addShag(newShag);
      console.log(`[MOCK] Добавлен шаг: ${id}`);
      return send(res, 201, { id });
    }

    if (p.match(/^\/api\/steps\/[^/]+$/) && method === 'PUT') {
      const id = p.split('/')[3];
      const d = await parseBody(req);
      mock.updateShag(id, d);
      console.log(`[MOCK] Обновлен шаг: ${id}`);
      return send(res, 200, { ok: true });
    }

    if (p.match(/^\/api\/steps\/[^/]+$/) && method === 'DELETE') {
      const id = p.split('/')[3];
      mock.deleteShag(id);
      console.log(`[MOCK] Удален шаг: ${id}`);
      return send(res, 200, { ok: true });
    }

    // ==================== CRUD ОПЕРАЦИЙ ====================
    if (p === '/api/operations' && method === 'POST') {
      const d = await parseBody(req);
      const id = mock.generateId('OP');
      const newOp = { ID: id, ...d };
      mock.addOper(newOp);
      console.log(`[MOCK] Добавлена операция: ${id}`);
      return send(res, 201, { id });
    }

    if (p.match(/^\/api\/operations\/[^/]+$/) && method === 'PUT') {
      const id = p.split('/')[3];
      const d = await parseBody(req);
      mock.updateOper(id, d);
      console.log(`[MOCK] Обновлена операция: ${id}`);
      return send(res, 200, { ok: true });
    }

    if (p.match(/^\/api\/operations\/[^/]+$/) && method === 'DELETE') {
      const id = p.split('/')[3];
      mock.deleteOper(id);
      console.log(`[MOCK] Удалена операция: ${id}`);
      return send(res, 200, { ok: true });
    }

    // Маршрут не найден — возвращаем null, чтобы основной роутер продолжил
    return null;
  };
};