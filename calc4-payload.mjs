// Розділ 4: скільки запитів і байтів коштує історія сирими точками й агрегатами.
// node calc4-payload.mjs   (стенд dash-bed.js, пристрій gh1-s01, метрика temperature)
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
const require = createRequire(import.meta.url);
const { startDashboardBed } = require('./dash-bed');

const bed = await startDashboardBed();
const base = `http://127.0.0.1:${bed.httpPort}/api/v1/telemetry`;
const now = Date.now();
const get = async (params) => {
  const res = await fetch(`${base}?${params}`);
  const text = await res.text();
  return { json: JSON.parse(text), bytes: Buffer.byteLength(text), gz: zlib.gzipSync(text, { level: 6 }).length };
};
const win = (ms, step = 1) => {
  const from = Math.floor((now - ms) / step) * step;
  return { device: 'gh1-s01', metric: 'temperature', from: new Date(from).toISOString(), to: new Date(now).toISOString() };
};
async function raw(ms) {
  const q = new URLSearchParams(win(ms)); q.set('limit', '1000');
  let [req, bytes, gz, pts, cursor] = [0, 0, 0, 0, null];
  do {
    if (cursor) q.set('cursor', cursor);
    const r = await get(q);
    req += 1; bytes += r.bytes; gz += r.gz; pts += r.json.data.length; cursor = r.json.next;
  } while (cursor);
  return { requests: req, points: pts, bytes, gz };
}
async function agg(ms, interval, step) {
  const q = new URLSearchParams(win(ms, step)); q.set('agg', 'avg,min,max'); q.set('interval', interval);
  const r = await get(q);
  return { requests: 1, points: r.json.data.length, bytes: r.bytes, gz: r.gz, sample: JSON.stringify(r.json.data[1]) };
}
const H = 3_600_000, D = 24 * H;
const rows = [
  ['1 год, сирі', await raw(H)],
  ['24 год, сирі', await raw(D)],
  ['24 год, agg 3m', await agg(D, '3m', 180_000)],
  ['7 днів, сирі', await raw(7 * D)],
  ['7 днів, agg 30m', await agg(7 * D, '30m', 1_800_000)],
];
console.table(rows.map(([name, r]) => ({ вікно: name, запитів: r.requests, точок: r.points,
  'байт': r.bytes, 'КБ': (r.bytes / 1024).toFixed(1), 'gzip, КБ': (r.gz / 1024).toFixed(1), 'Б/точку': (r.bytes / r.points).toFixed(1) })));
console.log('приклад інтервалу:', rows[4][1].sample);
await bed.stop();
