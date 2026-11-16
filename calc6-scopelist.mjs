// M9: скільки коштує сторінка списку пристроїв із фільтром області доступу (VISIBLE_SQL) у базі з N пристроїв.
// Запит той самий, що в api.js (listDevices): сторінка з 51 рядка за ключем пристрою, підзапит «last_seen»
// і умова області доступу. Три користувачі: адміністратор (бачить усе), користувач зони (200 зон, тож бачить
// N/200 пристроїв) і користувач із трьома правами на окремі пристрої, останніми за порядком ключів:
// найгірший випадок, коли сторінку доводиться шукати серед усіх рядків.
// Другий варіант («розкриття»): права спершу розкриваються в множину ідентифікаторів (діапазон за індексом
// devices(zone) і прямі ключі), і лише потім читається сторінка. Результати обох варіантів збігаються.
//   node calc6-scopelist.mjs [out.json]
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { VISIBLE_SQL } = require('./scope');

const SIZES = [1_000, 10_000, 100_000];
const ZONES = 200;
const RUNS = 60;
const dir = mkdtempSync(path.join(tmpdir(), 'm9-'));
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const out = { node: process.version, zones: ZONES, runs: RUNS, rows: [] };

for (const n of SIZES) {
  const db = new Database(path.join(dir, `m9-${n}.db`));
  db.pragma('journal_mode = WAL');
  for (const f of ['schema.sql', 'schema-api.sql', 'schema-auth.sql']) {
    db.exec(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
  }
  const addUser = db.prepare(`INSERT INTO users (user_id, username, pw_hash, role, created_at) VALUES (?, ?, 'x', ?, '2026-01-01T00:00:00Z')`);
  const addGrant = db.prepare('INSERT INTO grants (user_id, scope) VALUES (?, ?)');
  const addDevice = db.prepare(`INSERT INTO devices (device_id, name, zone, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')`);
  const id = (i) => `d${String(i).padStart(6, '0')}`;
  db.transaction(() => {
    for (let i = 0; i < n; i++) addDevice.run(id(i), `Пристрій ${i}`, `z${i % ZONES}`);
    addUser.run('admin', 'admin', 'admin');
    addUser.run('zone', 'zone', 'operator');
    addGrant.run('zone', 'zone:z7');
    addUser.run('few', 'few', 'viewer');
    for (const i of [n - 3, n - 2, n - 1]) addGrant.run('few', `device:${id(i)}`);
  })();
  const list = db.prepare(
    `SELECT d.device_id AS id, d.name, d.zone, d.created_at,
            (SELECT max(ts) FROM latest l WHERE l.device_id = d.device_id) AS last_seen
       FROM devices d WHERE d.device_id > @after AND (@zone IS NULL OR d.zone = @zone)
        AND ${VISIBLE_SQL}
      ORDER BY d.device_id LIMIT @limit`);
  db.exec('CREATE INDEX devices_zone ON devices (zone)');
  const expanded = db.prepare(
    `WITH mine(device_id) AS (
       SELECT d.device_id FROM devices d
        WHERE d.zone IN (SELECT substr(scope, 6) FROM grants WHERE user_id = @user AND scope LIKE 'zone:%')
       UNION SELECT substr(scope, 8) FROM grants WHERE user_id = @user AND scope LIKE 'device:%')
     SELECT d.device_id AS id, d.name, d.zone, d.created_at,
            (SELECT max(ts) FROM latest l WHERE l.device_id = d.device_id) AS last_seen
       FROM devices d WHERE d.device_id > @after AND (@zone IS NULL OR d.zone = @zone)
        AND d.device_id IN (SELECT device_id FROM mine)
      ORDER BY d.device_id LIMIT @limit`);
  const who = { admin: { all: 1, user: 'admin' }, zone: { all: 0, user: 'zone' }, few: { all: 0, user: 'few' } };
  const row = { devices: n };
  for (const [name, vis] of Object.entries(who)) {
    const call = () => list.all({ after: '', zone: null, limit: 51, ...vis });
    for (let i = 0; i < 5; i++) call();
    const ms = [];
    let got = 0;
    for (let i = 0; i < RUNS; i++) {
      const t = process.hrtime.bigint();
      got = call().length;
      ms.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    row[name] = { medianMs: median(ms), maxMs: Math.max(...ms), rowsReturned: got };
    if (name !== 'admin') {
      const alt = () => expanded.all({ after: '', zone: null, limit: 51, user: vis.user });
      const same = JSON.stringify(alt()) === JSON.stringify(call());
      if (!same) throw new Error(`розкриття дає інший результат для ${name}, N=${n}`);
      for (let i = 0; i < 5; i++) alt();
      const ms2 = [];
      for (let i = 0; i < RUNS; i++) {
        const t = process.hrtime.bigint();
        alt();
        ms2.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      row[name].expandedMs = median(ms2);
    }
  }
  out.rows.push(row);
  db.close();
}
rmSync(dir, { recursive: true, force: true });
for (const r of out.rows) {
  console.log(`${String(r.devices).padStart(7)} пристроїв: адміністратор ${r.admin.medianMs.toFixed(3)} мс (${r.admin.rowsReturned} рядків), `
    + `зона ${r.zone.medianMs.toFixed(3)} мс (${r.zone.rowsReturned}; з розкриттям ${r.zone.expandedMs.toFixed(3)}), `
    + `три права ${r.few.medianMs.toFixed(3)} мс (${r.few.rowsReturned}; з розкриттям ${r.few.expandedMs.toFixed(3)})`);
}
writeFileSync(process.argv[2] ?? new URL('results/scopelist.json', import.meta.url), JSON.stringify(out, null, 2));
process.exit(0);
