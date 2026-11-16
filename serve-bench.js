'use strict';
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { createServer } = require('./server');
const db = new Database(process.env.BENCH_DB);
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(`${__dirname}/schema.sql`, 'utf8').replace(/CREATE TABLE/g, 'CREATE TABLE IF NOT EXISTS'));
const ins = db.prepare('INSERT OR REPLACE INTO latest VALUES (?,?,?,?)');
for (let d = 0; d < 500; d++) for (const m of ['temperature','humidity','soil_moisture','light'])
  ins.run(`gh1-s${d}`, m, '2026-11-03T12:00:00.000Z', 21.5);
const state = { mqttConnected: true, lastReadingAt: Date.now() };
createServer({ db, state }).listen(3111, () => console.log('listening'));
