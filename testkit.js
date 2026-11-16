'use strict';
const fs = require('node:fs');
const Database = require('better-sqlite3');

const iso = (ms) => new Date(ms).toISOString();

function makeDb() {
  const db = new Database(':memory:');
  for (const f of ['schema.sql', 'schema-api.sql']) {
    db.exec(fs.readFileSync(`${__dirname}/${f}`, 'utf8'));
  }
  return db;
}

function addDevice(db, id, zone = 'north') {
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?)')
    .run(id, `Вузол ${id}`, zone, '2026-01-01T00:00:00.000Z');
}

// Серія вимірювань: values — масив або функція (i) => значення; крок step секунд
function seed(db, { device = 'gh1-s01', metric = 'temperature', start, count, step = 60, values }) {
  const ins = db.prepare('INSERT OR IGNORE INTO telemetry VALUES (?, ?, ?, ?, ?)');
  const up = db.prepare(`INSERT INTO latest VALUES (?, ?, ?, ?)
    ON CONFLICT (device_id, metric) DO UPDATE SET ts = excluded.ts, value = excluded.value
    WHERE excluded.ts > latest.ts`);
  const val = typeof values === 'function' ? values : (i) => values[i];
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const ts = iso(start + i * step * 1000);
      ins.run(device, metric, ts, ts, val(i));
      up.run(device, metric, ts, val(i));
    }
  })();
}

module.exports = { makeDb, addDevice, seed, iso };
