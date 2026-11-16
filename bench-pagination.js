'use strict';
// Вартість сторінки історії: OFFSET проти курсора на двох роках даних (1 051 200 рядків)
const Database = require('better-sqlite3');
const { FILE, START } = require('./bench-data');
const { createRawReader } = require('./pagination');

const db = new Database(FILE, { readonly: true });
const read = createRawReader(db);
const LIMIT = 500;
const base = { device: 'gh1-s01', metric: 'temperature', from: new Date(START).toISOString(),
  to: new Date(START + 730 * 86_400_000).toISOString(), order: 'asc', limit: LIMIT };

const offsetStmt = db.prepare(`SELECT ts, value FROM telemetry
  WHERE device_id = @device AND metric = @metric AND ts >= @from AND ts < @to
  ORDER BY ts LIMIT @limit OFFSET @offset`);
// хибний варіант: дві нижні межі на ts (from і after) — планувальник шукає за однією з них
const twoBoundsStmt = db.prepare(`SELECT ts, value FROM telemetry
  WHERE device_id = @device AND metric = @metric AND ts >= @from AND ts < @to AND ts > @after
  ORDER BY ts LIMIT @limit`);
// правильний варіант: курсор замінює нижню межу вікна
const keysetStmt = db.prepare(`SELECT ts, value FROM telemetry
  WHERE device_id = @device AND metric = @metric AND ts > @after AND ts < @to
  ORDER BY ts LIMIT @limit`);

function time(fn, runs = 30) {
  const t = [];
  for (let i = 0; i < runs; i++) { const a = process.hrtime.bigint(); fn(); t.push(Number(process.hrtime.bigint() - a) / 1e6); }
  t.sort((x, y) => x - y);
  return { med: t[Math.floor(runs / 2)], p95: t[Math.floor(runs * 0.95)] };
}

const rows = [];
for (const offset of [0, 1_000, 10_000, 100_000, 500_000, 1_000_000]) {
  const after = offset === 0 ? '' : new Date(START + (offset - 1) * 60_000).toISOString();
  const o = time(() => offsetStmt.all({ ...base, offset }));
  const k = time(() => keysetStmt.all({ ...base, after: after || base.from }));
  const w = time(() => twoBoundsStmt.all({ ...base, after: after || base.from }));
  rows.push({ offset, offset_ms: +o.med.toFixed(3), cursor_ms: +k.med.toFixed(3), two_bounds_ms: +w.med.toFixed(3) });
}
console.table(rows);

// повний вивантажувальний обхід усіх рядків сторінками по 500
const t0 = process.hrtime.bigint();
let pages = 0, total = 0, cursor;
do { const p = read({ ...base, cursor }); pages++; total += p.data.length; cursor = p.next; } while (cursor);
const keysetTotal = Number(process.hrtime.bigint() - t0) / 1e9;
const perSkipped = rows.at(-1).offset_ms / 1_000_000;          // мс на один пропущений рядок
const offsetTotal = (perSkipped * LIMIT * (pages * (pages - 1)) / 2 + pages * rows[0].offset_ms) / 1000;
console.log(JSON.stringify({ rows: total, pages, keysetTotal_s: +keysetTotal.toFixed(2),
  perSkipped_us: +(perSkipped * 1000).toFixed(3), offsetTotal_est_s: +offsetTotal.toFixed(0) }));
