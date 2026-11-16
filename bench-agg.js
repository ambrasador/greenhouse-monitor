'use strict';
// Агрегація на двох роках даних: інтервали з індексом, GROUP BY за префіксом тексту, агрегація в JS
const Database = require('better-sqlite3');
const { FILE, START } = require('./bench-data');
const { createAggregator } = require('./aggregate');
const { parseInterval } = require('./timeq');

const db = new Database(FILE, { readonly: true });
const aggregate = createAggregator(db);
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const D = 'gh1-s01', M = 'temperature';

function med(fn, runs = 15) {
  const t = [];
  let r;
  for (let i = 0; i < runs; i++) { const a = process.hrtime.bigint(); r = fn(); t.push(Number(process.hrtime.bigint() - a) / 1e6); }
  t.sort((x, y) => x - y);
  return { ms: +t[Math.floor(runs / 2)].toFixed(1), r };
}

const groupBy = (len) => db.prepare(`SELECT substr(ts, 1, ${len}) AS b, count(*) AS n, avg(value) AS avg,
  min(value) AS min, max(value) AS max FROM telemetry
  WHERE device_id = ? AND metric = ? AND ts >= ? AND ts < ? GROUP BY b`);
const scan = db.prepare('SELECT ts, value FROM telemetry WHERE device_id = ? AND metric = ? AND ts >= ? AND ts < ? ORDER BY ts');
function inJs(from, to, len) {
  const m = new Map();
  for (const { ts, value } of scan.iterate(D, M, iso(from), iso(to))) {
    const k = ts.slice(0, len);
    const b = m.get(k);
    if (!b) m.set(k, { n: 1, sum: value, min: value, max: value });
    else { b.n++; b.sum += value; if (value < b.min) b.min = value; if (value > b.max) b.max = value; }
  }
  return [...m.values()];
}

const cases = [
  { name: '7 діб, 1h', from: START + 100 * DAY, days: 7, interval: '1h', len: 13 },
  { name: '30 діб, 1h', from: START + 100 * DAY, days: 30, interval: '1h', len: 13 },
  { name: '30 діб, 15m', from: START + 100 * DAY, days: 30, interval: '15m', len: null },
  { name: '730 діб, 1d', from: START, days: 730, interval: '1d', len: 10 },
  { name: '730 діб, 1mo (UTC)', from: START, days: 730, interval: '1mo', len: 7 },
];
const out = [];
for (const c of cases) {
  const to = c.from + c.days * DAY;
  const rows = Math.round((to - c.from) / 60_000);
  const ours = med(() => aggregate({ device: D, metric: M, kind: 'gauge', from: c.from, to,
    interval: parseInterval(c.interval), tz: 'UTC', fill: 'none' }));
  const g = c.len ? med(() => groupBy(c.len).all(D, M, iso(c.from), iso(to))) : { ms: null };
  const j = c.len ? med(() => inJs(c.from, to, c.len)) : { ms: null };
  out.push({ case: c.name, rows, buckets: ours.r.length, per_bucket_ms: ours.ms, group_by_ms: g.ms, js_ms: j.ms,
    json_bytes: JSON.stringify(ours.r).length });
}
const kyiv = med(() => aggregate({ device: D, metric: M, kind: 'gauge', from: START, to: START + 730 * DAY,
  interval: parseInterval('1mo'), tz: 'Europe/Kyiv', fill: 'none' }));
out.push({ case: '730 діб, 1mo (Europe/Kyiv)', rows: 1051200, buckets: kyiv.r.length, per_bucket_ms: kyiv.ms,
  group_by_ms: null, js_ms: null, json_bytes: JSON.stringify(kyiv.r).length });
console.table(out);
const scanRate = out.find((o) => o.case === '730 діб, 1d');
console.log(JSON.stringify({ rows_per_s_ours: Math.round(scanRate.rows / (scanRate.per_bucket_ms / 1000)) }));
