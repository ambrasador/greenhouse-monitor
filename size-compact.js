'use strict';
const fs = require('node:fs');
const Database = require('better-sqlite3');
const FILE = process.env.BENCH_DB;
for (const s of ['', '-wal', '-shm']) fs.rmSync(FILE + s, { force: true });
const db = new Database(FILE);
db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL');
db.exec(`CREATE TABLE telemetry (dev INTEGER NOT NULL, metric INTEGER NOT NULL,
  ts INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY (dev, metric, ts)) WITHOUT ROWID`);
const ins = db.prepare('INSERT INTO telemetry VALUES (?,?,?,?)');
const BASE = Date.now() - 3600e3, N = 1000000;
const batch = db.transaction((a, b) => { for (let i = a; i < b; i++) ins.run(i % 2000, 1, BASE + i, 15 + (i % 100) / 10); });
for (let i = 0; i < N; i += 1000) batch(i, i + 1000);
db.pragma('wal_checkpoint(TRUNCATE)');
const bytes = fs.statSync(FILE).size;
console.log('компактна схема: рядків', N, 'МБ', (bytes / 1048576).toFixed(1), 'байт/рядок', (bytes / N).toFixed(1));
