#!/usr/bin/env javascript
/* eslint-disable */
// ============================================================================
// T77 — repair_t77.js: устранение последствий старого бага распределения КП.
//
// ПРОБЛЕМА (до t77): при нехватке мощности фирмы каскад назначал корневой
// позиции ПЛАНОВОЕ количество целиком ПОВЕРХ уже созданных дочерних позиций
// той же детали. Итог: суммарное количество по детали больше плана
// (пример: СТОЙКА 85104107014031 — план 4 шт, в базе корень 4 шт + ребёнок
// 2 шт = 6), а КП оказывались «не на тех» позициях плана.
//
// ЧТО ДЕЛАЕТ СКРИПТ (режим --fix):
//   1) удаляет все дочерние позиции запроса (и их КП) — в испорченных
//      цепочках корневая позиция УЖЕ несёт исходное плановое количество,
//      поэтому количество корня НЕ увеличивается;
//   2) снимает все назначения «лучшее предложение» запроса (kp.reshenie,
//      plan.id_kp корней);
//   3) возвращает запросу статус «отправлено Всем контрагентам».
// После этого откройте запрос и нажмите «🏆 КП» — с исправленным алгоритмом
// (t77) позиция будет разделена корректно: лучшая фирма получает свою
// мощность на корневой позиции, остаток — следующее лучшее КП на новой
// дочерней позиции.
//
// ВАЖНО: перед --fix скрипт проверяет, что ни одна удаляемая позиция не
// включена в заказ к договору — при наличии таких позиций фикс отменяется.
//
// ЗАПУСК (из корня проекта, рядом с server.js):
//   node repair_t77.js                 — диагностика всех запросов с выбором
//   node repair_t77.js 4               — диагностика запроса №4
//   node repair_t77.js 4 --fix         — исправить запрос №4
//   node repair_t77.js ZKP_xxx --fix   — исправить по ID запроса
// ============================================================================
const sqlite3 = require('sqlite3').verbose();
const DB_FILE = 'firmy.db';

const arg = process.argv[2] || '';
const doFix = process.argv.includes('--fix');

const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE, (e) => {
    if (e) { console.error('Не удалось открыть firmy.db:', e.message); process.exit(1); }
});

const get = (sql, args = []) => new Promise((res, rej) =>
    db.get(sql, args, (e, r) => e ? rej(e) : res(r)));
const all = (sql, args = []) => new Promise((res, rej) =>
    db.all(sql, args, (e, r) => e ? rej(e) : res(r)));
const run = (sql, args = []) => new Promise((res, rej) =>
    db.run(sql, args, function (e) { e ? rej(e) : res(this.changes); }));

function fmt(v) { return v === null || v === undefined ? '—' : String(v); }

async function chainsFor(zaprosId) {
    // Корневые позиции запроса (связь корня с запросом — через kp.id_plana)
    const roots = await all(`
        SELECT DISTINCT p.id, p.n_nazv_osnovn_det_zakaza AS det, p.plan_god_kolvo, p.id_kp
        FROM plan p
        WHERE p.id IN (SELECT id_plana FROM kp WHERE id_zaprosa_kp = ?)
          AND COALESCE(p.is_child_plan, 0) = 0
        ORDER BY p.n_nazv_osnovn_det_zakaza`, [zaprosId]);
    const out = [];
    for (const r of roots) {
        const children = await all(`
            WITH RECURSIVE sub AS (
                SELECT id, plan_god_kolvo, id_kp, parent_plan_id FROM plan WHERE parent_plan_id = @root
                UNION ALL
                SELECT p.id, p.plan_god_kolvo, p.id_kp, p.parent_plan_id FROM plan p JOIN sub s ON p.parent_plan_id = s.id)
            SELECT * FROM sub`, { '@root': r.id });
        const sum = Number(r.plan_god_kolvo || 0) +
            children.reduce((a, c) => a + Number(c.plan_god_kolvo || 0), 0);
        out.push({ root: r, children, sum });
    }
    return out;
}

async function diag(z) {
    console.log(`\n=== Запрос №${z.n_zaprosa} от ${z.data_form} (${z.id}), статус: «${z.statys}» ===`);
    const chains = await chainsFor(z.id);
    for (const c of chains) {
        const rootFirm = c.root.id_kp
            ? (await get(`SELECT f.naimenovanie AS n FROM kp LEFT JOIN firmy f ON kp.id_firma=f.id_firmy WHERE kp.id=?`, [c.root.id_kp]) || {}).n
            : null;
        const line = c.children.map(ch =>
            `ребёнок ${ch.id}: ${ch.plan_god_kolvo} шт.`).join('; ');
        console.log(`  ${c.root.det}`);
        console.log(`    корень ${c.root.id}: ${c.root.plan_god_kolvo} шт., КП: ${rootFirm || '—'}`);
        if (c.children.length) {
            console.log(`    ${line}`);
            console.log(`    СУММА по детали: ${c.sum} шт. ${c.children.length ? '(корень + дети)' : ''}`);
        }
    }
    return chains;
}

async function resolveZapros() {
    if (!arg || arg.startsWith('--')) {
        return all(`SELECT id, n_zaprosa, data_form, statys FROM zapros_kp
                    WHERE statys IN ('выбраны лучшие КП','отправлено Всем контрагентам','отправлено не Всем контрагентам')
                    ORDER BY CAST(n_zaprosa AS INTEGER)`);
    }
    const byId = await get(`SELECT id, n_zaprosa, data_form, statys FROM zapros_kp WHERE id = ?`, [arg]);
    if (byId) return [byId];
    const byNum = await all(`SELECT id, n_zaprosa, data_form, statys FROM zapros_kp WHERE CAST(n_zaprosa AS INTEGER) = CAST(? AS INTEGER)`, [arg]);
    if (!byNum.length) { console.error(`Запрос «${arg}» не найден`); process.exit(1); }
    return byNum;
}

async function fixZapros(z) {
    console.log(`\n=== FIX запроса №${z.n_zaprosa} (${z.id}) ===`);
    const chains = await chainsFor(z.id);
    const childIds = chains.flatMap(c => c.children.map(ch => ch.id));
    if (!childIds.length) {
        console.log('  Дочерних позиций нет — исправление не требуется.');
    }
    // Защита: удаляемые позиции не должны быть в заказе
    if (childIds.length) {
        const ph = childIds.map(() => '?').join(',');
        const inOrder = await get(`SELECT COUNT(*) AS cnt FROM poz_zakaz_dogovora WHERE id_plana IN (${ph})`, childIds);
        if (inOrder.cnt > 0) {
            console.error(`  🚫 ОТМЕНА: ${inOrder.cnt} дочерних позиций включены в заказ к договору. Сначала удалите их из заказа.`);
            return false;
        }
    }
    try {
        await run('BEGIN TRANSACTION');
        if (childIds.length) {
            const ph = childIds.map(() => '?').join(',');
            await run(`DELETE FROM grafik WHERE id_plana IN (${ph})`, childIds);
            await run(`DELETE FROM plan_perevozok WHERE id_plana IN (${ph})`, childIds);
            await run(`DELETE FROM shagi_marshruta WHERE id_det IN (${ph})`, childIds);
            await run(`DELETE FROM poz_zakaz_dogovora WHERE id_plana IN (${ph})`, childIds);
            await run(`DELETE FROM kp WHERE id_plana IN (${ph})`, childIds);
            await run(`UPDATE plan SET parent_plan_id = NULL WHERE id IN (${ph})`, childIds);
            const n = await run(`DELETE FROM plan WHERE id IN (${ph})`, childIds);
            console.log(`  ✅ Удалено дочерних позиций: ${n} (и их КП/графики). Количество корней сохранено как есть.`);
        }
        // Снять назначения лучших КП запроса
        const nKp = await run(`UPDATE kp SET reshenie = '', primechanie_kp = '' WHERE id_zaprosa_kp = ?`, [z.id]);
        const rootIds = chains.map(c => c.root.id);
        if (rootIds.length) {
            const rph = rootIds.map(() => '?').join(',');
            await run(`UPDATE plan SET id_kp = NULL WHERE id IN (${rph})`, rootIds);
        }
        await run(`UPDATE zapros_kp SET statys = 'отправлено Всем контрагентам' WHERE id = ?`, [z.id]);
        await new Promise((res, rej) => db.run('COMMIT', e => e ? rej(e) : res()));
        console.log(`  ✅ Снято назначений «лучшее предложение»: ${nKp}. Статус запроса: «отправлено Всем контрагентам».`);
        console.log('  👉 Откройте запрос на странице «Внесение КП» и нажмите «🏆 КП» — распределение будет выполнено заново (t77).');
        console.log('  ⚠ Проверьте на странице «План» количество корневых позиций: оно должно равняться плановому количеству детали.');
    } catch (e) {
        await new Promise(res => db.run('ROLLBACK', () => res()));
        console.error('  ❌ ОШИБКА, изменения отменены:', e.message);
        process.exitCode = 1;
        return false;
    }
    return true;
}

(async () => {
    const zaproses = await resolveZapros();
    for (const z of zaproses) {
        const chains = await diag(z);
        const corrupted = chains.some(c => c.children.length);
        if (doFix && !arg.startsWith('--')) {
            const done = await fixZapros(z);
            if (!done) process.exitCode = process.exitCode || 1;
        } else if (doFix) {
            console.log('  (--fix без номера запроса не применяется — укажите номер или ID)');
        } else {
            console.log(`  ${corrupted ? '⚠ Есть дочерние позиции — при подозрении на двойной счёт запустите: node repair_t77.js ' + z.n_zaprosa + ' --fix' : 'OK: дочерних позиций нет'}`);
        }
    }
    db.close();
})().catch(e => { console.error(e); process.exit(1); });
