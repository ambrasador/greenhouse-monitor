'use strict';
// Сервер для вимірювань: файлова база, без брокера, ліміт запитів вимкнено
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { createServer } = require('./server');

const file = process.env.DB_FILE;
for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma(`synchronous = ${process.env.DB_SYNC ?? 'FULL'}`);
for (const f of ['schema.sql', 'schema-api.sql']) db.exec(fs.readFileSync(`${__dirname}/${f}`, 'utf8'));
const reg = db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?)');
for (let i = 0; i < 50; i++) reg.run(`gh${i}`, `Вузол ${i}`, 'north', '2026-01-01T00:00:00.000Z');
const app = createServer({ db, state: { mqttConnected: true, lastReadingAt: null },
  sink: { async send() {} }, limits: { rate: 1e9, burst: 1e9 } });
app.listen(Number(process.env.PORT), () => console.log('ready'));
