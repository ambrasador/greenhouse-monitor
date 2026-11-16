// Розділ 4: спрощення GPS-траси методом Дугласа — Пекера. node calc4-track.mjs
// Траса — fleetTrack з synth.js: 8 год з кроком 5 с, шум GPS σ = 3 м по кожній осі.
// Той самий зерновий параметр із шумом 0 дає «істину», яку шум спотворює.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { simplifyTrack, distToSegment, toMeters, everyNth } from './client/downsample.js';

const require = createRequire(import.meta.url);
const { fleetTrack } = require('./synth');

const START = Date.UTC(2026, 9, 26, 5, 0, 0);          // 26.10.2026 08:00 за Києвом
const LAT0 = 46.64;
const LON0 = 32.62;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const time = (fn, runs = 9) => {
  fn();
  const t = [];
  for (let i = 0; i < runs; i++) { const s = process.hrtime.bigint(); fn(); t.push(Number(process.hrtime.bigint() - s) / 1e6); }
  return median(t);
};

const toXY = (track, lat0 = LAT0, lon0 = LON0) =>
  track.map((p, i) => ({ ...toMeters(p.lat, p.lon, lat0, lon0), i, t: p.t }));
const length = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return s; };

// Найбільше відхилення відкинутих точок від ламаної, що її замінює
function maxDeviation(all, kept) {
  let worst = 0;
  let k = 0;
  for (let j = 0; j < all.length; j++) {
    while (k < kept.length - 2 && kept[k + 1].i <= all[j].i) k++;
    worst = Math.max(worst, distToSegment(all[j], kept[k], kept[k + 1]));
  }
  return worst;
}

const noisy = fleetTrack({ seed: 7, start: START, hours: 8, stepSec: 5, noiseM: 3, lat0: LAT0, lon0: LON0 });
const truth = fleetTrack({ seed: 7, start: START, hours: 8, stepSec: 5, noiseM: 0, lat0: LAT0, lon0: LON0 });
const P = toXY(noisy);
const T = toXY(truth);
const moving = T.map((p, i) => i > 0 && (p.x !== T[i - 1].x || p.y !== T[i - 1].y));
const nMoving = moving.filter(Boolean).length;

const info = {
  points: P.length,
  movingShare: nMoving / P.length,
  extentKm: {
    x: (Math.max(...T.map((p) => p.x)) - Math.min(...T.map((p) => p.x))) / 1000,
    y: (Math.max(...T.map((p) => p.y)) - Math.min(...T.map((p) => p.y))) / 1000,
  },
  truthKm: length(T) / 1000,
  noisyKm: length(P) / 1000,
};
console.log('Траса:', JSON.stringify(info));

const rows = [];
for (const eps of [5, 10, 25, 50, 100]) {
  const out = simplifyTrack(P, eps);
  const ms = time(() => simplifyTrack(P, eps));
  const nth = everyNth(P, out.length);
  const keptMoving = out.filter((p) => moving[p.i]).length;
  rows.push({
    eps, kept: out.length, share: out.length / P.length, ms,
    maxDev: maxDeviation(P, out), lengthKm: length(out) / 1000,
    keptStill: out.length - keptMoving,
    nthDev: maxDeviation(P, nth), nthKm: length(nth) / 1000,
  });
}
console.table(rows.map((r) => ({
  'ε, м': r.eps, 'точок': r.kept, 'частка, %': (100 * r.share).toFixed(1), 'час, мс': r.ms.toFixed(2),
  'макс. відхилення, м': r.maxDev.toFixed(1), 'довжина, км': r.lengthKm.toFixed(1),
  'точок на стоянках': r.keptStill,
  'everyNth: відхилення, м': r.nthDev.toFixed(1), 'everyNth: довжина, км': r.nthKm.toFixed(1),
})));

// Тиждень поспіль: час на великому масиві
const week = toXY(fleetTrack({ seed: 11, start: START, hours: 168, stepSec: 5, noiseM: 3, lat0: LAT0, lon0: LON0 }));
const weekRows = [10, 25, 100].map((eps) => {
  const out = simplifyTrack(week, eps);
  return { eps, input: week.length, kept: out.length, ms: time(() => simplifyTrack(week, eps), 5) };
});
console.table(weekRows);

// Перевірка проєкції: той самий розрахунок відхилення, але для кожного відрізка проєкція
// будується навколо його середини, де спотворення масштабу практично нульове
function maxDeviationLocal(track, keptIdx) {
  let worst = 0;
  for (let s = 0; s + 1 < keptIdx.length; s++) {
    const [ia, ib] = [keptIdx[s], keptIdx[s + 1]];
    const mid = track[Math.floor((ia + ib) / 2)];
    const loc = (p) => toMeters(p.lat, p.lon, mid.lat, mid.lon);
    const [a, b] = [loc(track[ia]), loc(track[ib])];
    for (let j = ia + 1; j < ib; j++) worst = Math.max(worst, distToSegment(loc(track[j]), a, b));
  }
  return worst;
}
const proj = [];
for (const eps of [10, 25, 100]) {
  const out = simplifyTrack(P, eps);
  proj.push({ eps, planar: maxDeviation(P, out), local: maxDeviationLocal(noisy, out.map((p) => p.i)) });
}
const dLat = Math.max(...noisy.map((p) => Math.abs(p.lat - LAT0)));
const scaleErr = Math.max(...noisy.map((p) => Math.abs(Math.cos((LAT0 * Math.PI) / 180) / Math.cos((p.lat * Math.PI) / 180) - 1)));
console.log('Проєкція: макс. |Δφ| =', dLat.toFixed(4), '°; спотворення масштабу по паралелі до', (100 * scaleErr).toFixed(3), '%');
console.table(proj.map((r) => ({ 'ε, м': r.eps, 'у площині, м': r.planar.toFixed(3), 'місцева проєкція, м': r.local.toFixed(3) })));

// Дрейф на стоянках: довжина шляху за «одометром» по точках
const odo = { truthKm: info.truthKm, noisyKm: info.noisyKm, stillKm: 0 };
for (let i = 1; i < P.length; i++) if (!moving[i]) odo.stillKm += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y) / 1000;
console.log('Одометр:', JSON.stringify(odo));

const outFor = (eps) => simplifyTrack(P, eps).map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
fs.writeFileSync('results/track.json', JSON.stringify({
  info, rows, weekRows, proj, odo, scaleErrPct: 100 * scaleErr, dLat,
  raw: P.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
  truth: T.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
  s10: outFor(10), s25: outFor(25), s100: outFor(100),
}));
