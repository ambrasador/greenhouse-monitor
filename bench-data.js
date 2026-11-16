'use strict';
// Створює файл бази з двома роками вимірювань (1 хв, 1 051 200 рядків) для одного датчика
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const FILE = process.env.BENCH_DB ?? path.join(os.tmpdir(), 'series2y.db');
const START = Date.parse('2024-11-03T00:00:00Z');
const ROWS = 2 * 365 * 24 * 60 + 24 * 60 * 0;   // 730 діб × 1440

function build(file = FILE) {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');                 // лише для генерації тестових даних
  db.exec(fs.readFileSync(`${__dirname}/schema.sql`, 'utf8'));
  const ins = db.prepare('INSERT INTO telemetry VALUES (?, ?, ?, ?, ?)');
  let x = 12345;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  db.transaction(() => {
    for (let i = 0; i < ROWS; i++) {
      const ts = new Date(START + i * 60_000).toISOString();
      const day = Math.sin(((i % 1440) / 1440) * 2 * Math.PI - 2);          // добовий хід
      ins.run('gh1-s01', 'temperature', ts, ts, Math.round((21 + 4 * day + rnd() - 0.5) * 10) / 10);
    }
  })();
  db.close();
  return { file, rows: ROWS, bytes: fs.statSync(file).size };
}

if (require.main === module) console.log(build());
module.exports = { build, FILE, START, ROWS };
