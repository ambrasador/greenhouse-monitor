'use strict';
// Накладні витрати кошика токенів: той самий маршрут із лімітером і без нього
const { spawn } = require('node:child_process');
const autocannon = require('autocannon');

const run = (child) => new Promise((resolve) => child.stdout.once('data', resolve));

async function hit(port, path) {
  const r = await autocannon({ url: `http://127.0.0.1:${port}${path}`, connections: 64, duration: 5 });
  return Math.round(r.requests.average);
}

(async () => {
  const src = (limited) => `
    const express = require('express');
    const Database = require('better-sqlite3');
    const fs = require('node:fs');
    const { createApi, problemHandler } = require('./api');
    const { createIngest } = require('./core');
    const { createLimiter } = require('./ratelimit');
    const { createCommands } = require('./commands');
    const { GREENHOUSE } = require('./metrics');
    const db = new Database(':memory:');
    for (const f of ['schema.sql', 'schema-api.sql']) db.exec(fs.readFileSync('./' + f, 'utf8'));
    db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?)').run('gh1-s01', 'Вузол', 'north', '2026-01-01T00:00:00.000Z');
    db.prepare("INSERT INTO latest VALUES ('gh1-s01', 'temperature', '2026-11-03T12:00:00.000Z', 21.5)").run();
    const app = express();
    const mw = ${limited} ? [createLimiter({ rate: 1e9, burst: 1e9 }).middleware(() => 'k')] : [];
    app.use('/api/v1', ...mw, createApi({ db, ingest: createIngest(db), metrics: GREENHOUSE,
      commands: createCommands({ db, sink: { send: async () => {} } }) }));
    app.use(problemHandler());
    app.listen(${limited ? 3321 : 3322}, () => console.log('ready'));`;
  const a = spawn('node', ['-e', src(true)]), b = spawn('node', ['-e', src(false)]);
  await Promise.all([run(a), run(b)]);
  const rows = [];
  for (let i = 0; i < 5; i++) {            // порядок чергується, щоб прогрів не зміщував результат
    const order = i % 2 ? [3322, 3321] : [3321, 3322];
    const r = {};
    for (const port of order) r[port === 3321 ? 'with_limiter' : 'without'] = await hit(port, '/api/v1/devices/gh1-s01');
    rows.push({ run: i + 1, ...r });
  }
  const mean = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) / rows.length);
  rows.push({ run: 'середнє', with_limiter: mean('with_limiter'), without: mean('without') });
  console.table(rows);
  a.kill(); b.kill();
})();
