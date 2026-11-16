'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInstant, parseInterval, bucketBounds } = require('./timeq');

const T = (s) => Date.parse(s);
const hours = ([a, b]) => (b - a) / 3_600_000;

test('parseInstant відхиляє 30 лютого, зсув пояса та текст без Z', () => {
  assert.equal(parseInstant('2026-02-30T10:00:00Z'), null);
  assert.equal(parseInstant('2026-11-03T12:00:00+02:00'), null);
  assert.equal(parseInstant('2026-11-03 12:00:00'), null);
  assert.equal(parseInstant('2026-11-03T12:00:00.5Z'), T('2026-11-03T12:00:00.500Z'));
});

test('parseInterval: лише інтервали, межі яких збігаються з годиною, добою чи місяцем', () => {
  for (const ok of ['1m', '15m', '30m', '1h', '6h', '12h', '1d', '1mo']) assert.ok(parseInterval(ok), ok);
  for (const bad of ['7m', '60m', '5h', '24h', '2d', '2mo', '0m', '1w', '']) assert.equal(parseInterval(bad), null, bad);
});

test('доба в Києві: 25 годин 25 жовтня 2026 і 23 години 29 березня 2026', () => {
  const day = parseInterval('1d');
  const oct = bucketBounds(T('2026-10-24T00:00:00Z'), T('2026-10-27T00:00:00Z'), day, 'Europe/Kyiv');
  assert.deepEqual(oct.map(hours), [24, 25, 24, 24]);
  const mar = bucketBounds(T('2026-03-28T00:00:00Z'), T('2026-03-31T00:00:00Z'), day, 'Europe/Kyiv');
  assert.deepEqual(mar.map(hours), [24, 23, 24, 24]);
});

test('календарний місяць має різну довжину, а в березні Києва — 743 години', () => {
  const m = bucketBounds(T('2026-01-10T00:00:00Z'), T('2026-04-02T00:00:00Z'), parseInterval('1mo'), 'Europe/Kyiv');
  assert.deepEqual(m.map(hours), [744, 672, 743, 720]);
});

test('фіксовані інтервали вирівняно за UTC, перелік обмежено', () => {
  const b = bucketBounds(T('2026-11-03T12:07:00Z'), T('2026-11-03T13:01:00Z'), parseInterval('15m'));
  assert.equal(new Date(b[0][0]).toISOString(), '2026-11-03T12:00:00.000Z');
  assert.equal(b.length, 5);
  assert.throws(() => bucketBounds(0, T('2026-11-03T00:00:00Z'), parseInterval('1m')), { name: 'RangeError' });
});
