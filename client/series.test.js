import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeries, createStore } from './series.js';

const t = (n) => new Date(Date.UTC(2026, 10, 4, 12, 0, n)).toISOString();

// Детермінований генератор: тест відтворюється з тим самим числом
function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test('дубль за ts відхиляється, порядок надходження не впливає на порядок ряду', () => {
  const s = createSeries(10);
  assert.equal(s.add({ ts: t(3), value: 3 }), true);
  assert.equal(s.add({ ts: t(1), value: 1 }), true);
  assert.equal(s.add({ ts: t(3), value: 99 }), false);      // дубль: значення не змінюється
  assert.equal(s.add({ ts: t(2), value: 2 }), true);
  assert.deepEqual(s.points().map((p) => p.value), [1, 2, 3]);
  assert.equal(s.lastTs(), t(3));
});

test('вікно: найстарішу точку витісняє нова, точка старіша за вікно не додається', () => {
  const s = createSeries(3);
  for (const n of [1, 2, 3]) s.add({ ts: t(n), value: n });
  assert.equal(s.add({ ts: t(0), value: 0 }), false);       // старіша за вікно
  assert.equal(s.add({ ts: t(4), value: 4 }), true);
  assert.deepEqual(s.points().map((p) => p.value), [2, 3, 4]);
  assert.equal(s.add({ ts: t(1), value: 1 }), false);       // витіснену не воскрешаємо
});

test('властивість: довільний порядок і повтори дають ті самі останні max точок', () => {
  const rnd = prng(2026);
  for (let round = 0; round < 500; round++) {
    const n = Math.floor(rnd() * 60);
    const max = 1 + Math.floor(rnd() * 40);
    const all = [...Array(n).keys()];
    const stream = all.flatMap((k) => Array(1 + Math.floor(rnd() * 3)).fill(k));
    for (let i = stream.length - 1; i > 0; i--) {           // тасування Фішера — Єйтса
      const j = Math.floor(rnd() * (i + 1));
      [stream[i], stream[j]] = [stream[j], stream[i]];
    }
    const s = createSeries(max);
    for (const k of stream) s.add({ ts: t(k), value: k });
    assert.deepEqual(s.points().map((p) => p.value), all.slice(-max),
      `раунд ${round}: n=${n}, max=${max}`);
  }
});

test('сховище веде окремі ряди для кожної пари «пристрій/метрика»', () => {
  const st = createStore(5);
  st.apply({ device: 'a', metric: 'temperature', ts: t(1), value: 1 });
  st.apply({ device: 'a', metric: 'humidity', ts: t(1), value: 50 });
  st.apply({ device: 'b', metric: 'temperature', ts: t(1), value: 7 });
  assert.equal(st.apply({ device: 'a', metric: 'temperature', ts: t(1), value: 1 }), false);
  assert.deepEqual(Object.keys(st.snapshot()).sort(),
    ['a/humidity', 'a/temperature', 'b/temperature']);
  assert.equal(st.lastTs('a/humidity'), t(1));
});
