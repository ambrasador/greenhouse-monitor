// Вектори для перевірки Dart-ядра: еталонні відповіді дає код JavaScript із
// розділу 4. Запуск: node tool/gen_vectors.mjs  (із каталогу mobile)
import { writeFileSync } from 'node:fs';
import { GREENHOUSE } from '../../client/domain.js';
import { evaluateStatus } from '../../client/status.js';
import { mergeSorted } from '../../client/merge.js';
import { delay } from '../../client/backoff.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- status ----
const { soil_moisture, temperature, humidity } = GREENHOUSE.metrics;
const rules = [soil_moisture.rule, temperature.rule, humidity.rule]; // humidity: null
const ages = [-5000, 0, 59_000, 180_000, 180_001, 600_000];
const values = [29.9, 30, 30.1, 31.9, 32, 32.1, 34.9, 35, 35.1, 36, 41, null];
const status = [];
for (const rule of rules) {
  for (const periodSec of [60, 300]) {
    for (const age of ages) {
      for (const value of values) {
        const ts = new Date(NOW - age).toISOString();
        const reading = { ts, value: value ?? NaN };
        status.push({ ts, now: new Date(NOW).toISOString(), value, rule,
          periodSec, expect: evaluateStatus(reading, rule, { now: NOW, periodSec }) });
      }
    }
  }
}
status.push({ ts: null, now: new Date(NOW).toISOString(), value: null,
  rule: rules[0], periodSec: 60, expect: evaluateStatus(null, rules[0], { now: NOW, periodSec: 60 }) });

// ---- merge ----
const rnd = mulberry32(2026);
const series = (n) => {
  const pts = [];
  let t = 1_000;
  for (let i = 0; i < n; i++) {
    t += 1 + Math.floor(rnd() * 3);
    pts.push({ t, v: Math.round(rnd() * 5) });
  }
  return pts;
};
const merge = [];
for (let k = 0; k < 300; k++) {
  const a = series(Math.floor(rnd() * 12));
  const b = series(Math.floor(rnd() * 12));
  const max = [undefined, 5, 10][k % 3];
  const out = mergeSorted(a, b, max ?? Infinity);
  merge.push({
    a: a.map((p) => [p.t, p.v]), b: b.map((p) => [p.t, p.v]),
    max: max ?? null, expect: out.map((p) => [p.t, p.v]), identical: out === a,
  });
}
// частий випадок живого потоку: b — підмножина a
const base = series(8);
merge.push({ a: base.map((p) => [p.t, p.v]), b: base.slice(2, 5).map((p) => [p.t, p.v]),
  max: null, expect: base.map((p) => [p.t, p.v]), identical: true });

// ---- backoff ----
const backoff = [];
for (const [baseMs, capMs] of [[1000, 30_000], [500, 8000]]) {
  for (let attempt = 1; attempt <= 12; attempt++) {
    for (const r of [0, 0.25, 0.5, 0.999]) {
      backoff.push({ attempt, baseMs, capMs, rnd: r,
        expectMs: delay(attempt, { base: baseMs, cap: capMs, rnd: () => r }) });
    }
  }
}

// ---- словник домену: Dart-версія має збігатися з client/domain.js ----
const domain = Object.fromEntries(Object.entries(GREENHOUSE.metrics).map(([key, m]) => [key,
  { label: m.label, unit: m.unit, decimals: m.decimals, periodSec: m.periodSec, rule: m.rule }]));

writeFileSync(new URL('../fixtures/vectors.json', import.meta.url),
  JSON.stringify({ generatedBy: 'tool/gen_vectors.mjs', status, merge, backoff, domain }));
console.log(JSON.stringify({ status: status.length, merge: merge.length, backoff: backoff.length }));
