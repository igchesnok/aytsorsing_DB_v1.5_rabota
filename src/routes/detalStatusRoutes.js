//src/routes/detalStatusRoutes.js
// ============================================================
// src/routes/detalStatusRoutes.js
// API для работы со статусами деталей ПТО
// Связь 1:1 с таблицей gryz_poz
// ============================================================
const { parseBody, send, generateId } = require('../utils');

module.exports = (db, wsManager) => ({
    // ========================================================================
    // GET — получить статус для грузовой позиции
    // GET /api/detal-status?id_gryz_poz=XXX
    // ========================================================================
    async GET(req, res, url) {
        try {
            const idGryzPoz = url.searchParams.get('id_gryz_poz');
            
            if (!idGryzPoz) {
                return send(res, 400, { error: 'id_gryz_poz обязателен' });
            }
            
            const status = await db.get(
                'SELECT * FROM detal_status_pto WHERE id_gryz_poz = ?',
                [idGryzPoz]
            );
            
            if (!status) {
                // Статус не создан — возвращаем пустой объект
                send(res, 200, { 
                    id_gryz_poz: idGryzPoz, 
                    exists: false,
                    message: 'Статус ещё не создан'
                });
            } else {
                send(res, 200, { ...status, exists: true });
            }
        } catch (e) {
            console.error('[detalStatusRoutes.GET] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // GET_ALL — получить все статусы для транспортной операции
    // GET /api/detal-status/all?id_transporta=XXX
    // ========================================================================
    async GET_ALL(req, res, url) {
        try {
            const idTransporta = url.searchParams.get('id_transporta');
            
            if (!idTransporta) {
                return send(res, 400, { error: 'id_transporta обязателен' });
            }
            
            const sql = `
                SELECT 
                    ds.*,
                    gp.id_plana,
                    gp.kolvo_no_br,
                    gp.kolvo_yes_br,
                    o.nomer_chertezha,
                    o.naimenovanie as osn_naimenovanie
                FROM detal_status_pto ds
                LEFT JOIN gryz_poz gp ON ds.id_gryz_poz = gp.id
                LEFT JOIN plan p ON gp.id_plana = p.id
                LEFT JOIN osnastka o ON p.id_osnastka = o.id
                WHERE gp.id_transporta = ?
                ORDER BY gp.id_plana
            `;
            
            const rows = await db.all(sql, [idTransporta]);
            send(res, 200, rows);
        } catch (e) {
            console.error('[detalStatusRoutes.GET_ALL] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST — создать или обновить статус (UPSERT)
    // POST /api/detal-status
    // ========================================================================
    async POST(req, res) {
        try {
            const d = await parseBody(req);
            
            if (!d.id_gryz_poz) {
                return send(res, 400, { error: 'id_gryz_poz обязателен' });
            }
            
            // Проверяем, существует ли грузовая позиция
            const gryzPoz = await db.get(
                'SELECT id FROM gryz_poz WHERE id = ?',
                [d.id_gryz_poz]
            );
            
            if (!gryzPoz) {
                return send(res, 404, { 
                    error: `Грузовая позиция ${d.id_gryz_poz} не найдена` 
                });
            }
            
            // Проверяем, существует ли уже статус
            const existing = await db.get(
                'SELECT id FROM detal_status_pto WHERE id_gryz_poz = ?',
                [d.id_gryz_poz]
            );
            
            if (existing) {
                // UPDATE
                await db.run(`
                    UPDATE detal_status_pto SET
                        data_otk=?,
                        data_peredano_tseh=?,
                        data_peredachi_to=?,
                        data_prohozhdeniya_to=?,
                        data_naneseniya_pokrytiya=?,
                        data_peredachi_sklad=?,
                        id_oplaty_rabot=?,
                        id_oplaty_avansa=?,
                        primechanie=?,
                        updated_at=CURRENT_TIMESTAMP
                    WHERE id_gryz_poz=?
                `, [
                    d.data_otk || '',
                    d.data_peredano_tseh || '',
                    d.data_peredachi_to || '',
                    d.data_prohozhdeniya_to || '',
                    d.data_naneseniya_pokrytiya || '',
                    d.data_peredachi_sklad || '',
                    d.id_oplaty_rabot || '',
                    d.id_oplaty_avansa || '',
                    d.primechanie || '',
                    d.id_gryz_poz
                ]);
                
                wsManager.notifyDataChange('detal_status_pto', 'update', existing.id);
                send(res, 200, { 
                    ok: true, 
                    id: existing.id, 
                    action: 'updated',
                    message: 'Статус обновлён'
                });
            } else {
                // INSERT
                const id = generateId('DSP');
                await db.run(`
                    INSERT INTO detal_status_pto (
                        id, id_gryz_poz,
                        data_otk, data_peredano_tseh, data_peredachi_to,
                        data_prohozhdeniya_to, data_naneseniya_pokrytiya,
                        data_peredachi_sklad, id_oplaty_rabot, id_oplaty_avansa,
                        primechanie
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                `, [
                    id,
                    d.id_gryz_poz,
                    d.data_otk || '',
                    d.data_peredano_tseh || '',
                    d.data_peredachi_to || '',
                    d.data_prohozhdeniya_to || '',
                    d.data_naneseniya_pokrytiya || '',
                    d.data_peredachi_sklad || '',
                    d.id_oplaty_rabot || '',
                    d.id_oplaty_avansa || '',
                    d.primechanie || ''
                ]);
                
                wsManager.notifyDataChange('detal_status_pto', 'add', id);
                send(res, 201, { 
                    ok: true, 
                    id, 
                    action: 'created',
                    message: 'Статус создан'
                });
            }
        } catch (e) {
            console.error('[detalStatusRoutes.POST] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // PUT — обновление существующего статуса
    // PUT /api/detal-status/:id
    // ========================================================================
    async PUT(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            
            if (!id) {
                return send(res, 400, { error: 'ID не указан' });
            }
            
            const d = await parseBody(req);
            
            // Проверяем существование
            const existing = await db.get(
                'SELECT id FROM detal_status_pto WHERE id = ?',
                [id]
            );
            
            if (!existing) {
                return send(res, 404, { error: 'Статус не найден' });
            }
            
            await db.run(`
                UPDATE detal_status_pto SET
                    data_otk=?,
                    data_peredano_tseh=?,
                    data_peredachi_to=?,
                    data_prohozhdeniya_to=?,
                    data_naneseniya_pokrytiya=?,
                    data_peredachi_sklad=?,
                    id_oplaty_rabot=?,
                    id_oplaty_avansa=?,
                    primechanie=?,
                    updated_at=CURRENT_TIMESTAMP
                WHERE id=?
            `, [
                d.data_otk || '',
                d.data_peredano_tseh || '',
                d.data_peredachi_to || '',
                d.data_prohozhdeniya_to || '',
                d.data_naneseniya_pokrytiya || '',
                d.data_peredachi_sklad || '',
                d.id_oplaty_rabot || '',
                d.id_oplaty_avansa || '',
                d.primechanie || '',
                id
            ]);
            
            wsManager.notifyDataChange('detal_status_pto', 'update', id);
            send(res, 200, { ok: true, message: 'Статус обновлён' });
        } catch (e) {
            console.error('[detalStatusRoutes.PUT] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // DELETE — удалить статус
    // DELETE /api/detal-status/:id
    // ========================================================================
    async DELETE(req, res, url) {
        try {
            const id = url.pathname.split('/')[3];
            
            if (!id) {
                return send(res, 400, { error: 'ID не указан' });
            }
            
            await db.run('DELETE FROM detal_status_pto WHERE id = ?', [id]);
            wsManager.notifyDataChange('detal_status_pto', 'delete', id);
            send(res, 200, { ok: true, message: 'Статус удалён' });
        } catch (e) {
            console.error('[detalStatusRoutes.DELETE] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    },

    // ========================================================================
    // POST_BATCH — массовое создание/обновление статусов
    // POST /api/detal-status/batch
    // ========================================================================
    async POST_BATCH(req, res) {
        try {
            const d = await parseBody(req);
            
            if (!d.items || !Array.isArray(d.items) || d.items.length === 0) {
                return send(res, 400, { error: 'Список статусов пуст' });
            }
            
            await db.run('BEGIN TRANSACTION');
            
            const results = {
                created: 0,
                updated: 0,
                errors: []
            };
            
            for (const item of d.items) {
                try {
                    if (!item.id_gryz_poz) {
                        results.errors.push({ item, error: 'id_gryz_poz обязателен' });
                        continue;
                    }
                    
                    const existing = await db.get(
                        'SELECT id FROM detal_status_pto WHERE id_gryz_poz = ?',
                        [item.id_gryz_poz]
                    );
                    
                    if (existing) {
                        await db.run(`
                            UPDATE detal_status_pto SET
                                data_otk=?, data_peredano_tseh=?, data_peredachi_to=?,
                                data_prohozhdeniya_to=?, data_naneseniya_pokrytiya=?,
                                data_peredachi_sklad=?, id_oplaty_rabot=?, id_oplaty_avansa=?,
                                primechanie=?, updated_at=CURRENT_TIMESTAMP
                            WHERE id_gryz_poz=?
                        `, [
                            item.data_otk || '', item.data_peredano_tseh || '',
                            item.data_peredachi_to || '', item.data_prohozhdeniya_to || '',
                            item.data_naneseniya_pokrytiya || '', item.data_peredachi_sklad || '',
                            item.id_oplaty_rabot || '', item.id_oplaty_avansa || '',
                            item.primechanie || '', item.id_gryz_poz
                        ]);
                        results.updated++;
                    } else {
                        const id = generateId('DSP');
                        await db.run(`
                            INSERT INTO detal_status_pto (
                                id, id_gryz_poz, data_otk, data_peredano_tseh,
                                data_peredachi_to, data_prohozhdeniya_to,
                                data_naneseniya_pokrytiya, data_peredachi_sklad,
                                id_oplaty_rabot, id_oplaty_avansa, primechanie
                            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                        `, [
                            id, item.id_gryz_poz,
                            item.data_otk || '', item.data_peredano_tseh || '',
                            item.data_peredachi_to || '', item.data_prohozhdeniya_to || '',
                            item.data_naneseniya_pokrytiya || '', item.data_peredachi_sklad || '',
                            item.id_oplaty_rabot || '', item.id_oplaty_avansa || '',
                            item.primechanie || ''
                        ]);
                        results.created++;
                    }
                } catch (err) {
                    results.errors.push({ 
                        id_gryz_poz: item.id_gryz_poz, 
                        error: err.message 
                    });
                }
            }
            
            await db.run('COMMIT');
            
            wsManager.notifyDataChange('detal_status_pto', 'batch_update', 'batch');
            
            send(res, 200, {
                ok: true,
                message: `Создано: ${results.created}, обновлено: ${results.updated}, ошибок: ${results.errors.length}`,
                results
            });
        } catch (e) {
            await db.run('ROLLBACK').catch(() => {});
            console.error('[detalStatusRoutes.POST_BATCH] Error:', e.message);
            send(res, 500, { error: e.message });
        }
    }
});