import test from 'node:test';
import assert from 'node:assert/strict';
import { lttb, minMax, m4, everyNth, simplifyTrack, distToSegment, toMeters } from './downsample.js';

// Синусоїда з одним різким піком: 10 080 точок з кроком 1 хв
const week = Array.from({ length: 10_080 }, (_, i) => ({
  t: i * 60_000,
  v: 25 + 4 * Math.sin((2 * Math.PI * i) / 1440) + (i >= 5000 && i < 5009 ? 12 : 0),
}));

test('lttb: n точок, перша й остання на місці, час зростає', () => {
  const out = lttb(week, 168);
  assert.equal(out.length, 168);
  assert.equal(out[0], week[0]);
  assert.equal(out.at(-1), week.at(-1));
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
});

test('lttb: пік тривалістю 9 хв потрапляє у вибірку, але не обов’язково його вершина', () => {
  const peak = Math.max(...week.map((p) => p.v));
  const kept = lttb(week, 168).filter((p) => p.t >= 5000 * 60_000 && p.t < 5009 * 60_000);
  assert.ok(kept.length >= 1);                      // точка з вікна інциденту
  const top = Math.max(...kept.map((p) => p.v));
  assert.ok(top > peak - 0.5 && top <= peak);       // близько до вершини, але може бути нижче
});

test('lttb: граничні значення n повертають копію', () => {
  assert.deepEqual(lttb(week, 2), week);
  assert.deepEqual(lttb(week, week.length), week);
  assert.notEqual(lttb(week, week.length), week);
  assert.deepEqual(lttb([], 10), []);
});

test('lttb: кожен кошик має хоча б одну точку навіть при n = len − 1', () => {
  for (const len of [10, 11, 100, 1001]) {
    const pts = Array.from({ length: len }, (_, i) => ({ t: i, v: (i * 7) % 5 }));
    const out = lttb(pts, len - 1);
    assert.equal(out.length, len - 1);
    for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
  }
});

test('minMax: зберігає найбільше й найменше значення ряду', () => {
  const out = minMax(week, 84);
  assert.ok(out.length <= 168);
  assert.equal(Math.max(...out.map((p) => p.v)), Math.max(...week.map((p) => p.v)));
  assert.equal(Math.min(...out.map((p) => p.v)), Math.min(...week.map((p) => p.v)));
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
});

test('m4: не більше 4 точок на стовпчик, екстремуми збережено', () => {
  const out = m4(week, 100);
  assert.ok(out.length <= 400);
  assert.equal(Math.max(...out.map((p) => p.v)), Math.max(...week.map((p) => p.v)));
  assert.equal(out[0], week[0]);
  assert.equal(out.at(-1), week.at(-1));
});

test('everyNth: пік завширшки 9 точок при кроці 60 може пропасти', () => {
  const spike = Array.from({ length: 6000 }, (_, i) => ({ t: i, v: i === 3001 ? 99 : 1 }));
  assert.equal(Math.max(...everyNth(spike, 100).map((p) => p.v)), 1);
  assert.equal(Math.max(...lttb(spike, 100).map((p) => p.v)), 99);
});

test('simplifyTrack: відхилення відкинутих точок не перевищує eps', () => {
  const pts = [];
  for (let i = 0; i < 2000; i++) {
    pts.push({ x: i * 10, y: 300 * Math.sin(i / 120) + ((i * 37) % 11) - 5 });
  }
  const eps = 8;
  const out = simplifyTrack(pts, eps);
  assert.ok(out.length < pts.length / 5);
  let worst = 0;
  let k = 0;
  for (const p of pts) {
    while (k < out.length - 2 && out[k + 1].x < p.x) k += 1;
    worst = Math.max(worst, distToSegment(p, out[k], out[k + 1]));
  }
  assert.ok(worst <= eps + 1e-9, `відхилення ${worst}`);
});

test('simplifyTrack: 10⁵ точок на прямій зводяться до двох', () => {
  const line = Array.from({ length: 200_000 }, (_, i) => ({ x: i, y: 2 * i }));
  assert.equal(simplifyTrack(line, 0.5).length, 2);
});

test('toMeters: 1° широти ≈ 111,2 км, 1° довготи на 50° ≈ 71,5 км', () => {
  const p = toMeters(51, 31, 50, 30);
  assert.ok(Math.abs(p.y - 111_195) < 50);
  assert.ok(Math.abs(p.x - 71_480) < 100);
});
