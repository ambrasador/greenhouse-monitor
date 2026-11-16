'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('./ratelimit');

function setup(opts = { rate: 1, burst: 10 }) {
  let now = 1_000_000;
  const limiter = createLimiter({ ...opts, clock: () => now });
  return { limiter, tick: (ms) => { now += ms; } };
}

test('місткість burst вичерпується, далі лишається швидкість rate', () => {
  const { limiter, tick } = setup();
  const burst = Array.from({ length: 12 }, () => limiter.take('k').ok);
  assert.deepEqual(burst, [...Array(10).fill(true), false, false]);
  tick(1000);                                         // за секунду поповнено один токен
  assert.equal(limiter.take('k').ok, true);
  assert.equal(limiter.take('k').ok, false);
});

test('Retry-After дорівнює часові до наступного токена', () => {
  const { limiter, tick } = setup({ rate: 0.5, burst: 1 });   // один токен за 2 с
  limiter.take('k');
  tick(500);
  assert.deepEqual(limiter.take('k'), { ok: false, retryAfterSec: 2 });
});

test('ключі незалежні; з часом токени не перевищують burst', () => {
  const { limiter, tick } = setup({ rate: 1, burst: 2 });
  assert.equal(limiter.take('a').ok && limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, false);
  assert.equal(limiter.take('b').ok, true);
  tick(3_600_000);
  assert.deepEqual([limiter.take('a').ok, limiter.take('a').ok, limiter.take('a').ok], [true, true, false]);
});

test('неактивні ключі вилучаються: пам’ять не росте з кількістю клієнтів', () => {
  const { limiter, tick } = setup({ rate: 1, burst: 5, idleMs: 60_000 });
  for (let i = 0; i < 1000; i++) limiter.take(`ip-${i}`);
  assert.equal(limiter.size(), 1000);
  tick(120_000);
  limiter.take('новий');
  assert.equal(limiter.size(), 1);
});
