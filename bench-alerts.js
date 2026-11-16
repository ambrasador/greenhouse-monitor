'use strict';
// Вартість запиту сповіщень і ефект гістерезису на сигналі з шумом
const Database = require('better-sqlite3');
const fs = require('node:fs');
const { FILE, START } = require('./bench-data');
const { createAlertReader, findViolations } = require('./alerts');

const DAY = 86_400_000;
const db = new Database(FILE, { readonly: true });
const read = createAlertReader(db);

const out = [];
for (const days of [30, 92]) {
  const from = START + 100 * DAY, to = from + days * DAY;
  const t = [];
  let r;
  for (let i = 0; i < 15; i++) {
    const a = process.hrtime.bigint();
    r = read({ device: 'gh1-s01', metric: 'temperature', from, to },
      { op: 'lt', threshold: 18, hysteresis: 0.5, minDurationMs: 0, maxGapMs: 180_000 });
    t.push(Number(process.hrtime.bigint() - a) / 1e6);
  }
  t.sort((x, y) => x - y);
  out.push({ window_days: days, rows: days * 1440, periods: r.length, median_ms: +t[7].toFixed(1) });
}
console.table(out);

// Сигнал: плавне падіння з 20 до 16 °C за 4 години з шумом ±0,3 °C і порогом 18 °C
let x = 2024;
const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const N = 240;
const values = Array.from({ length: N }, (_, i) => Math.round((20 - 4 * (i / (N - 1)) + (rnd() - 0.5) * 0.6) * 100) / 100);
const rows = values.map((value, i) => ({ ms: i * 60_000, value }));
const res = {};
for (const h of [0, 0.25, 0.5, 1]) {
  const p = findViolations(rows, { op: 'lt', threshold: 18, hysteresis: h, maxGapMs: 180_000 });
  res[h] = p.map((q) => [q.startMs / 60_000, q.endMs / 60_000]);
}
console.log(JSON.stringify({ N, periods_by_hysteresis: Object.fromEntries(Object.entries(res).map(([h, p]) => [h, p.length])) }));
fs.writeFileSync(`${__dirname}/../calc2/hysteresis.json`, JSON.stringify({ values, res }));
