// src/routes/syntheticRoutes.js
const { send } = require('../utils');
const { buildSubscriptionsFromSyntheticTables } = require('./helpers/syntheticTables');

module.exports = (db, wsManager) => ({
  /**
   * GET /api/synthetic/dependencies
   * ¬озвращает глобальный маппинг зависимостей дл€ всех синтетических таблиц проекта.
   */
  async GET_DEPENDENCIES(req, res) {
    try {
      const subscriptions = buildSubscriptionsFromSyntheticTables();
      send(res, 200, { subscriptions });
    } catch (e) {
      console.error('[syntheticRoutes.GET_DEPENDENCIES] Error:', e.message);
      send(res, 500, { error: e.message });
    }
  }
});