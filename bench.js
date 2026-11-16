'use strict';
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { createIngest } = require('./core');

const FILE = process.env.BENCH_DB || './bench.db';
const BASE = Date.now() - 3600e3;             // усі мітки в допустимому вікні

function open(journal, sync) {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE + s, { force: true });
  const db = new Database(FILE);
  db.pragma(`journal_mode = ${journal}`);
  db.pragma(`synchronous = ${sync}`);
  db.exec(fs.readFileSync(`${__dirname}/schema.sql`, 'utf8'));
  return db;
}
const reading = (i) => ({
  deviceId: `gh1-s${i % 2000}`, metric: 'temperature',
  value: 15 + (i % 100) / 10, ts: new Date(BASE + i).toISOString(),
});

function rate(label, n, run) {
  const t0 = process.hrtime.bigint();
  run(n);
  const sec = Number(process.hrtime.bigint() - t0) / 1e9;
  console.log(label.padEnd(44), Math.round(n / sec), 'повідомлень/с');
}

function modes() {
  const cases = [
    ['1. DELETE+FULL, транзакція на повідомлення', 'DELETE', 'FULL', 1, 2000],
    ['2. WAL+FULL, транзакція на повідомлення', 'WAL', 'FULL', 1, 5000],
    ['3. WAL+NORMAL, транзакція на повідомлення', 'WAL', 'NORMAL', 1, 100000],
    ['4. WAL+FULL, транзакція на 500 повідомлень', 'WAL', 'FULL', 500, 100000],
    ['5. WAL+NORMAL, транзакція на 500 повідомлень', 'WAL', 'NORMAL', 500, 100000],
  ];
  for (const [label, journal, sync, size, n] of cases) {
    const db = open(journal, sync);
    const ing = createIngest(db);
    const batch = db.transaction((from, to) => {
      for (let i = from; i < to; i++) ing.accept(reading(i));
    });
    rate(label, n, () => {
      for (let i = 0; i < n; i += size) batch(i, Math.min(i + size, n));
    });
    db.close();
  }
}
modes();
