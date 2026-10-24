const { parseBody, send, generateId } = require('../utils');

module.exports = (db, wsManager) => ({
  async GET(req, res, url) {
    const kat = url.searchParams.get('kategoriya');
    const sql = kat ? 'SELECT * FROM sprav_uslov WHERE kategoriya=?' : 'SELECT * FROM sprav_uslov';
    const rows = await db.all(sql, kat ? [kat] : []);
    send(res, 200, rows);
  },

  async POST(req, res) {
    const d = await parseBody(req);
    const id = generateId('SDY');
    await db.run('INSERT INTO sprav_uslov VALUES(?,?,?)', [id, d.soderzhanie, d.kategoriya]);
    wsManager.notifyDataChange('sprav_uslov', 'add', id);
    send(res, 201, { id });
  },

  async PUT(req, res, url) {
    const id = url.pathname.split('/')[3];
    const d = await parseBody(req);
    await db.run('UPDATE sprav_uslov SET soderzhanie=?,kategoriya=? WHERE id_usloviya=?',
      [d.soderzhanie, d.kategoriya, id]);
    wsManager.notifyDataChange('sprav_uslov', 'update', id);
    send(res, 200, { ok: true });
  },

  async DELETE(req, res, url) {
    const id = url.pathname.split('/')[3];
    await db.run('DELETE FROM sprav_uslov WHERE id_usloviya=?', [id]);
    wsManager.notifyDataChange('sprav_uslov', 'delete', id);
    send(res, 200, { ok: true });
  }
});