'use strict';
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { createIngest } = require('./core');
const FILE = process.env.BENCH_DB;
for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE + s, { force: true });
const db = new Database(FILE);
db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL');
db.exec(fs.readFileSync(`${__dirname}/schema.sql`, 'utf8'));
const ing = createIngest(db);
const BASE = Date.now() - 3600e3;
const N = 1000000;
const batch = db.transaction((a, b) => {
  for (let i = a; i < b; i++) ing.accept({
    deviceId: `gh1-s${i % 2000}`, metric: 'temperature',
    value: 15 + (i % 100) / 10, ts: new Date(BASE + i).toISOString() });
});
for (let i = 0; i < N; i += 1000) batch(i, i + 1000);
db.pragma('wal_checkpoint(TRUNCATE)');
const bytes = fs.statSync(FILE).size;
console.log('rows', db.prepare('select count(*) n from telemetry').get().n,
  'file MB', (bytes / 1048576).toFixed(1), 'bytes/row', (bytes / N).toFixed(1),
  'page_size', db.pragma('page_size', { simple: true }));
