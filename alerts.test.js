'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findViolations } = require('./alerts');

// рядки з кроком 60 с від умовного нуля; values — послідовність значень, null — пропуск показання
const MIN = 60_000;
const rows = (values, { start = 0, step = MIN } = {}) =>
  values.map((value, i) => ({ ms: start + i * step, value })).filter((r) => r.value !== null);
const rule = { op: 'lt', threshold: 18 };

test('період починається з першого значення нижче порога й закривається першим значенням вище', () => {
  const r = findViolations(rows([20, 17, 16, 17.5, 19, 20]), rule);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { startMs: MIN, endMs: 4 * MIN, durationMs: 3 * MIN, extreme: 16, samples: 3,
    endedBy: 'recovered', open: false });
});

test('значення, що дорівнює порогові, порушенням не є (суворе порівняння)', () => {
  assert.equal(findViolations(rows([20, 18, 20]), rule).length, 0);
});

test('шум навколо порога без гістерезису дробить подію на частини, з гістерезисом — ні', () => {
  const noisy = [19, 17.8, 18.2, 17.9, 18.3, 17.7, 18.1, 17.6, 17.4, 17.5, 19, 19.5];
  assert.equal(findViolations(rows(noisy), rule).length, 4);
  const calm = findViolations(rows(noisy), { ...rule, hysteresis: 1 });
  assert.equal(calm.length, 1);
  assert.equal(calm[0].extreme, 17.4);
});

test('розрив у даних закриває період, а не продовжує його', () => {
  const data = rows([20, 17, 16, null, null, null, null, null, null, null, null, null, 17, 16, 20]);
  const r = findViolations(data, { ...rule, maxGapMs: 3 * MIN });
  assert.deepEqual(r.map((p) => [p.endedBy, p.durationMs / MIN]), [['gap', 1], ['recovered', 2]]);
  // без обмеження розриву алгоритм «побачив би» одну подію тривалістю 13 хвилин
  assert.equal(findViolations(data, rule)[0].durationMs / MIN, 13);
});

test('період, що не завершився до кінця вікна, позначено open', () => {
  const r = findViolations(rows([20, 17, 16, 15]), rule);
  assert.deepEqual([r[0].endedBy, r[0].open, r[0].durationMs / MIN], ['window_end', true, 2]);
});

test('мінімальна тривалість відсікає короткі провали; op=gt шукає перевищення', () => {
  const data = rows([20, 17, 20, 17, 16, 15, 20]);
  assert.equal(findViolations(data, rule).length, 2);
  assert.equal(findViolations(data, { ...rule, minDurationMs: 2 * MIN }).length, 1);
  const hot = findViolations(rows([30, 36, 38, 30]), { op: 'gt', threshold: 35, hysteresis: 2 });
  assert.deepEqual([hot[0].extreme, hot[0].durationMs / MIN], [38, 2]);
});
