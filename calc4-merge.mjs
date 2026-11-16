// Розділ 4: скільки коштує злиття живих точок у кеш (applyLive) за один кадр.
// node calc4-merge.mjs   (кадр приходить раз на секунду, у кадрі до 300 точок)
import { QueryClient } from '@tanstack/react-query';
import { applyLive } from './client/merge.js';

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const T0 = Date.parse('2026-11-04T12:00:00Z');
const mk = (n, stepMs, start = 0) => Array.from({ length: n }, (_, i) => ({ t: T0 + (start + i) * stepMs, v: 20 + (i % 7) * 0.1 }));
const iso = (rows) => rows.map((p) => ({ ts: new Date(p.t).toISOString(), value: p.v }));

const out = [];
for (const [label, n, stepMs] of [['теплиця, T = 60 с', 60, 60_000], ['парк, T = 5 с', 720, 5_000], ['межа LIVE_MAX', 3600, 1_000]]) {
  const old = { kind: 'raw', points: mk(n, stepMs), from: T0, to: T0 + n * stepMs };
  const m = Math.min(300, n);
  const tail = old.points.slice(-m);                      // кадр: останні m точок, усі вже в кеші
  const newer = [...tail, { t: tail.at(-1).t + stepMs, v: 21 }];   // кадр із однією новою точкою
  const parse = iso(tail);
  const bench = (fn, iters = 300, batches = 15) => {
    for (let i = 0; i < iters; i++) fn();                 // прогрів
    const times = [];
    for (let b = 0; b < batches; b++) {
      const t = performance.now();
      for (let i = 0; i < iters; i++) fn();
      times.push(((performance.now() - t) / iters) * 1000);
    }
    return median(times);
  };
  const opts = { windowMs: 3_600_000, max: 3600 };
  // кожен виклик додає ще одну нову точку, тож кеш справді змінюється
  const setCost = (config) => {
    const qc = new QueryClient(config);
    const key = ['telemetry', 'd', 'm', '1h'];
    let step = 0;
    return bench(() => {
      qc.setQueryData(key, (cur) => applyLive(cur ?? old, [...tail, { t: tail.at(-1).t + (++step) * stepMs, v: 21 }], opts));
    }, 200, 11).toFixed(1);
  };
  const same = applyLive(old, tail, opts);
  const grown = applyLive(old, newer, opts);
  out.push({
    сценарій: label, 'точок у кеші': n, 'точок у кадрі': m,
    'без змін, мкс': bench(() => applyLive(old, tail, opts)).toFixed(1),
    'нова точка, мкс': bench(() => applyLive(old, newer, opts)).toFixed(1),
    'розбір ts кадру, мкс': bench(() => parse.map((p) => ({ t: Date.parse(p.ts), v: p.value }))).toFixed(1),
    'setQueryData, мкс': setCost({}),
    'setQueryData без структурного обміну, мкс': setCost({ defaultOptions: { queries: { structuralSharing: false } } }),
    'без змін → undefined': same === undefined,
    'нова точка → точок': grown?.points.length,
  });
}
console.table(out);
