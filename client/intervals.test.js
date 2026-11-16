import test from 'node:test';
import assert from 'node:assert/strict';
import { pickInterval, INTERVALS } from './intervals.js';

const H = 3_600_000;
const D = 24 * H;

test('година при T = 60 с: 60 точок, агрегація не потрібна', () => {
  assert.equal(pickInterval(H, 60_000), null);
});

test('доба й тиждень при T = 60 с: 3 хв (480 точок) і 30 хв (336 точок)', () => {
  assert.equal(pickInterval(D, 60_000), '3m');
  assert.equal(pickInterval(7 * D, 60_000), '30m');
});

test('місяць при T = 900 с (облік): 2 880 вимірювань, інтервал 2 год дає 360 точок', () => {
  assert.equal(pickInterval(30 * D, 900_000), '2h');
});

test('інтервал не коротший за період звітування', () => {
  const [name] = INTERVALS.find(([n]) => n === pickInterval(7 * D, 300_000));
  assert.ok(INTERVALS.find(([n]) => n === name)[1] >= 300_000);
});

test('рік при T = 60 с: доба; бюджет 500 перевищено, але інтервал найбільший з дозволених', () => {
  assert.equal(pickInterval(365 * D, 60_000), '1d');
  assert.equal(pickInterval(5000 * D, 60_000), '1d');
});
