'use strict';
const { bucketBounds } = require('./timeq');

// Агрегація інтервалами: межі обчислено в JS (календар, часові зони),
// суми — в SQL за індексом
function createAggregator(db) {
  const stat = db.prepare(
    `SELECT count(*) AS n, sum(value) AS s,
            min(value) AS mn, max(value) AS mx
       FROM telemetry
      WHERE device_id = ? AND metric = ? AND ts >= ? AND ts < ?`);
  // останнє показання строго до моменту ts
  const edge = db.prepare(
    `SELECT value FROM telemetry
      WHERE device_id = ? AND metric = ? AND ts < ?
      ORDER BY ts DESC LIMIT 1`);
  const iso = (ms) => new Date(ms).toISOString();
  const EMPTY = {
    gauge: { avg: null, min: null, max: null },
    delta: { sum: null },
    counter: { delta: null },
  };

  return function aggregate(p) {
    const { device, metric, kind, from, to, interval, tz, fill } = p;
    const out = [];
    for (const [start, end] of bucketBounds(from, to, interval, tz)) {
      const lo = iso(Math.max(start, from));     // обрізання вікном
      const hi = iso(Math.min(end, to));
      const r = stat.get(device, metric, lo, hi);
      if (r.n === 0) {
        if (fill === 'null') {
          out.push({ start: iso(start), count: 0, ...EMPTY[kind] });
        }
        continue;
      }
      const b = { start: iso(start), count: r.n };
      if (kind === 'gauge') {
        Object.assign(b, { avg: r.s / r.n, min: r.mn, max: r.mx });
      }
      if (kind === 'delta') b.sum = r.s;
      // приріст = останнє значення в інтервалі − останнє значення до нього
      if (kind === 'counter') {
        const last = edge.get(device, metric, hi).value;
        const base = edge.get(device, metric, lo);
        b.delta = base ? last - base.value : null;
      }
      out.push(b);
    }
    return out;
  };
}

module.exports = { createAggregator };
