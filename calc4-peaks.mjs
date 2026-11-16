// Розділ 4: що проріджування й агрегація роблять із піком. Тиждень температури теплиці
// (synth.js, зерно 42): 10 080 точок із кроком 60 с, інцидент 38,6 °C на 9 хв.
// node calc4-peaks.mjs > results/peaks.out; дані для рисунків — results/peaks.json
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { lttb, minMax, m4, everyNth } from './client/downsample.js';

const require = createRequire(import.meta.url);
const { greenhouseSeries, DAY, INCIDENT } = require('./synth.js');

const START = Date.UTC(2026, 9, 28);
const week = greenhouseSeries({ seed: 42, start: START, days: 7, stepSec: 60 }).temperature;
const truth = greenhouseSeries({ seed: 42, start: START, days: 7, stepSec: 60, noise: 0 }).temperature;
const THRESHOLD = 35;
const W = 1000;                                  // ширина графіка, пікселів
const H = 300;                                   // висота графіка, пікселів
const [T0, T1] = [week[0].t, week.at(-1).t];
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// Агрегація інтервалами за UTC, як у SQL розділу 2 (avg, min, max)
function buckets(points, stepMs) {
  const map = new Map();
  for (const p of points) {
    const k = Math.floor(p.t / stepMs) * stepMs;
    const b = map.get(k) ?? { t: k, n: 0, sum: 0, lo: Infinity, hi: -Infinity };
    b.n += 1; b.sum += p.v; b.lo = Math.min(b.lo, p.v); b.hi = Math.max(b.hi, p.v);
    map.set(k, b);
  }
  return [...map.values()].map((b) => ({ t: b.t, avg: b.sum / b.n, lo: b.lo, hi: b.hi, n: b.n }));
}

// Вертикальний діапазон ламаної в кожному стовпчику пікселів (точний, за відрізками)
function extents(points) {
  const vmin = Math.min(...week.map((p) => p.v));
  const vmax = Math.max(...week.map((p) => p.v));
  const X = (t) => ((t - T0) / (T1 - T0)) * W;
  const Y = (v) => ((v - vmin) / (vmax - vmin)) * H;
  const lo = new Float64Array(W).fill(Infinity);
  const hi = new Float64Array(W).fill(-Infinity);
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, y0, x1, y1] = [X(points[i].t), Y(points[i].v), X(points[i + 1].t), Y(points[i + 1].v)];
    for (let c = Math.floor(Math.min(x0, x1)); c <= Math.min(W - 1, Math.floor(Math.max(x0, x1))); c++) {
      const [a, b] = [Math.max(c, x0), Math.min(c + 1, x1)];
      const at = (x) => (x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
      const [ya, yb] = x1 === x0 ? [y0, y1] : [at(a), at(b)];
      lo[c] = Math.min(lo[c], ya, yb);
      hi[c] = Math.max(hi[c], ya, yb);
    }
  }
  return { lo, hi };
}
const ref = extents(week);
function pixelError(points) {
  const e = extents(points);
  let [max, sum, n, over] = [0, 0, 0, 0];
  for (let c = 0; c < W; c++) {
    if (!Number.isFinite(ref.lo[c]) || !Number.isFinite(e.lo[c])) continue;
    const err = Math.max(Math.abs(ref.lo[c] - e.lo[c]), Math.abs(ref.hi[c] - e.hi[c]));
    max = Math.max(max, err); sum += err; n += 1; over += err > 1 ? 1 : 0;
  }
  return { maxPx: max, meanPx: sum / n, colsOver1px: over };
}

// Відхилення ламаної від істинного сигналу (без шуму) у вузлах вихідного ряду
function fidelity(points) {
  let [j, sq, max] = [0, 0, 0];
  for (const tr of truth) {
    while (j + 2 < points.length && points[j + 1].t <= tr.t) j += 1;
    const [a, b] = [points[j], points[Math.min(j + 1, points.length - 1)]];
    const v = b.t === a.t ? a.v : a.v + ((b.v - a.v) * Math.min(1, Math.max(0, (tr.t - a.t) / (b.t - a.t))));
    sq += (v - tr.v) ** 2;
    max = Math.max(max, Math.abs(v - tr.v));
  }
  return { rmse: Math.sqrt(sq / truth.length), maxErr: max };
}

function time(fn, runs = 200) {
  for (let i = 0; i < 20; i++) fn();             // прогрів
  const t = [];
  for (let i = 0; i < runs; i++) { const s = process.hrtime.bigint(); fn(); t.push(Number(process.hrtime.bigint() - s) / 1e6); }
  return median(t);
}

// ---------- таблиця А: інтервал агрегації і пік
const tableA = [1, 5, 15, 30, 60].map((m) => {
  const b = buckets(week, m * 60_000);
  return { minutes: m, buckets: b.length, maxAvg: Math.max(...b.map((x) => x.avg)),
    maxOfMax: Math.max(...b.map((x) => x.hi)),
    avgCrossesThreshold: Math.max(...b.map((x) => x.avg)) > THRESHOLD };
});
console.log('A. Максимум серії залежно від інтервалу агрегації (поріг', THRESHOLD, '°C)');
console.table(tableA.map((r) => ({ 'інтервал, хв': r.minutes, 'інтервалів': r.buckets,
  'макс. avg': r.maxAvg.toFixed(2), 'макс. max': r.maxOfMax.toFixed(2), 'avg > 35': r.avgCrossesThreshold })));

// ---------- таблиця Б: методи зменшення до ≈ 500 точок
const avg30 = buckets(week, 30 * 60_000);
const avg60 = buckets(week, 3_600_000);
const mid = (bs, step, key) => bs.map((b) => ({ t: b.t + step / 2, v: b[key] }));
const methods = [
  ['168 точок', 'агрегація avg, 60 хв', () => mid(avg60, 3_600_000, 'avg')],
  ['168 точок', 'агрегація max, 60 хв', () => mid(avg60, 3_600_000, 'hi')],
  ['168 точок', 'LTTB', () => lttb(week, 168)],
  ['168 точок', 'min–max, 84 кошики', () => minMax(week, 84)],
  ['≈ 500 точок', 'кожна 21-ша точка', () => everyNth(week, 480)],
  ['≈ 500 точок', 'середнє кошика', () => {
    const size = week.length / 500;
    return Array.from({ length: 500 }, (_, i) => {
      const part = week.slice(Math.floor(i * size), Math.floor((i + 1) * size));
      return { t: part.reduce((s, p) => s + p.t, 0) / part.length, v: part.reduce((s, p) => s + p.v, 0) / part.length };
    });
  }],
  ['≈ 500 точок', 'агрегація avg, 30 хв', () => mid(avg30, 1_800_000, 'avg')],
  ['≈ 500 точок', 'агрегація max, 30 хв', () => mid(avg30, 1_800_000, 'hi')],
  ['≈ 500 точок', 'LTTB', () => lttb(week, 500)],
  ['≈ 500 точок', 'min–max, 250 кошиків', () => minMax(week, 250)],
  ['≤ 4 · 1000', `M4, ${W} стовпчиків`, () => m4(week, W)],
];
const tableB = methods.map(([budget, name, fn]) => {
  const out = fn();
  return { budget, name, points: out.length, ms: time(fn), max: Math.max(...out.map((p) => p.v)),
    ...fidelity(out), ...pixelError(out) };
});
console.log('\nБ. Методи зменшення ряду з', week.length, 'точок; графік', W, '×', H, 'пікселів');
console.table(tableB.map((r) => ({ бюджет: r.budget, метод: r.name, точок: r.points, 'час, мс': r.ms.toFixed(3),
  'максимум, °C': r.max.toFixed(2), 'похибка піку, °C': (INCIDENT.peak - r.max).toFixed(2),
  'СКВ від сигналу, °C': r.rmse.toFixed(2), 'макс. від сигналу, °C': r.maxErr.toFixed(2),
  'стовпчиків > 1 px': r.colsOver1px })));

// ---------- пік у LTTB: яку точку з вікна інциденту взято
const l500 = lttb(week, 500);
const incidentStart = START + INCIDENT.day * DAY + INCIDENT.minuteOfDay * 60_000;
const inWindow = l500.filter((p) => p.t >= incidentStart - 300_000 && p.t <= incidentStart + 300_000);
console.log('\nВ. Точки LTTB(500) у вікні ±5 хв від вершини інциденту:',
  inWindow.map((p) => `${new Date(p.t).toISOString().slice(11, 16)}=${p.v}`).join(', '));
const l168 = lttb(week, 168);
console.log('   LTTB(168): максимум', Math.max(...l168.map((p) => p.v)).toFixed(2),
  '; середнє годинне, макс.', tableA.find((r) => r.minutes === 60).maxAvg.toFixed(2));

fs.mkdirSync('results', { recursive: true });
fs.writeFileSync('results/peaks.json', JSON.stringify({
  start: START, threshold: THRESHOLD, W, H, tableA, tableB,
  series: { raw: week, hourly: buckets(week, 3_600_000), avg30, lttb168: l168, lttb500: l500,
    every21: everyNth(week, 480), minmax250: minMax(week, 250), m4: m4(week, W),
    incidentStart, peak: INCIDENT.peak },
}));
// Дві метрики за 3 доби з кроком 5 хв (до інциденту) — для рисунка про подвійну вісь
const two = greenhouseSeries({ seed: 42, start: START, days: 3, stepSec: 300 });
fs.writeFileSync('results/two-metrics.json', JSON.stringify({
  start: START,
  temperature: two.temperature, soil_moisture: two.soil_moisture,
}));
