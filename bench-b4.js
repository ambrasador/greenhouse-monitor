'use strict';
// Додатковий вимір: транзакція на 1, 4 і 500 рядків (WAL + FULL), по 3 прогони
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { createIngest } = require('./core');
const FILE = process.env.BENCH_DB;
const BASE = Date.now() - 3600e3;
const reading = (i) => ({ deviceId: `gh1-s${i % 2000}`, metric: 'temperature',
  value: 15 + (i % 100) / 10, ts: new Date(BASE + i).toISOString() });
function run(size, n, sync) {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE + s, { force: true });
  const db = new Database(FILE);
  db.pragma('journal_mode = WAL'); db.pragma(`synchronous = ${sync}`);
  db.exec(fs.readFileSync(`${__dirname}/schema.sql`, 'utf8'));
  const ing = createIngest(db);
  const batch = db.transaction((a, b) => { for (let i = a; i < b; i++) ing.accept(reading(i)); });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i += size) batch(i, Math.min(i + size, n));
  const sec = Number(process.hrtime.bigint() - t0) / 1e9;
  db.close();
  return Math.round(n / sec);
}
for (const size of [1, 4, 500]) {
  const res = [1, 2, 3].map(() => run(size, size === 1 ? 5000 : 40000, 'FULL'));
  console.log(`WAL+FULL, ${size} рядків/транзакцію:`, res.join(' | '), 'рядків/с');
}
