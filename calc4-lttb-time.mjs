// Розділ 4: час проріджування залежно від довжини ряду. node calc4-lttb-time.mjs
// Ряд — випадкове блукання з кроком 1 с; вихід — 500 точок (M4 — для 1000 стовпчиків).
// Кожен вимір: 3 прогрівальні виклики, далі 15 вимірів; наводяться медіана й розмах
import { lttb, minMax, m4, everyNth } from './client/downsample.js';

const SIZES = [10_080, 60_480, 604_800, 2_592_000];      // тиждень за 60 с; за 10 с; за 1 с; місяць за 1 с
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

function walk(n) {
  let v = 20;
  let a = 12345;
  const rand = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  return Array.from({ length: n }, (_, i) => ({ t: i * 1000, v: (v += rand() - 0.5) }));
}

const rows = [];
for (const n of SIZES) {
  const data = walk(n);
  for (const [name, fn] of [['everyNth', () => everyNth(data, 500)], ['minMax', () => minMax(data, 250)],
    ['lttb', () => lttb(data, 500)], ['m4', () => m4(data, 1000)]]) {
    const cold = (() => { const s = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - s) / 1e6; })();
    for (let i = 0; i < 3; i++) fn();
    const t = [];
    for (let i = 0; i < 15; i++) { const s = process.hrtime.bigint(); fn(); t.push(Number(process.hrtime.bigint() - s) / 1e6); }
    rows.push({ n, name, median: median(t), min: Math.min(...t), max: Math.max(...t), firstCall: cold,
      nsPerPoint: (median(t) * 1e6) / n });
  }
}
console.table(rows.map((r) => ({ 'точок на вході': r.n, метод: r.name,
  'перший виклик, мс': r.firstCall.toFixed(2), 'медіана, мс': r.median.toFixed(2),
  'мін–макс, мс': `${r.min.toFixed(2)}–${r.max.toFixed(2)}`, 'нс на точку': r.nsPerPoint.toFixed(1) })));
console.log(JSON.stringify(rows));
