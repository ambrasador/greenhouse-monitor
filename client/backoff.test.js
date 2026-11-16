import test from 'node:test';
import assert from 'node:assert/strict';
import { delay } from './backoff.js';

test('стеля подвоюється до cap: 1, 2, 4, 8, 16, 30, 30 с', () => {
  const almost = () => 0.999999;                  // верхня межа розподілу
  const got = [1, 2, 3, 4, 5, 6, 7].map((n) => delay(n, { rnd: almost }));
  assert.deepEqual(got.map((ms) => Math.ceil(ms / 1000)), [1, 2, 4, 8, 16, 30, 30]);
});

test('затримка рівномірна в [0, стеля): середнє близько половини стелі', () => {
  let s = 7;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const xs = Array.from({ length: 20000 }, () => delay(4, { rnd }));   // стеля 8000
  const mean = xs.reduce((a, b) => a + b) / xs.length;
  assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) < 8000);
  assert.ok(Math.abs(mean - 4000) < 100, `середнє ${mean}`);
});
