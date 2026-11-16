'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, addDevice, seed } = require('./testkit');
const { createAggregator } = require('./aggregate');
const { parseInterval } = require('./timeq');

const T = (s) => Date.parse(s);
const setup = () => { const db = makeDb(); addDevice(db, 'gh1-s01'); return db; };
const args = (o) => ({ device: 'gh1-s01', metric: 'temperature', kind: 'gauge', tz: 'UTC', fill: 'none',
  interval: parseInterval('1h'), ...o });

test('gauge: середнє, мінімум, максимум і кількість за годину; крайній інтервал обрізано вікном', () => {
  const db = setup();
  seed(db, { start: T('2026-11-03T10:00:00Z'), count: 180, values: (i) => i });   // 3 години, крок 1 хв
  const agg = createAggregator(db);
  const r = agg(args({ from: T('2026-11-03T10:30:00Z'), to: T('2026-11-03T12:00:00Z') }));
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { start: '2026-11-03T10:00:00.000Z', count: 30, avg: 44.5, min: 30, max: 59 });
  assert.deepEqual(r[1], { start: '2026-11-03T11:00:00.000Z', count: 60, avg: 89.5, min: 60, max: 119 });
});

test('середнє середніх хибне: інтервали зливають через count, а не через avg', () => {
  const db = setup();
  seed(db, { start: T('2026-11-03T10:00:00Z'), count: 1, values: [10] });          // 1 значення в першій годині
  seed(db, { start: T('2026-11-03T11:00:00Z'), count: 99, step: 30, values: () => 20 });  // 99 у другій
  const [a, b] = createAggregator(db)(args({ from: T('2026-11-03T10:00:00Z'), to: T('2026-11-03T12:00:00Z') }));
  assert.equal((a.avg + b.avg) / 2, 15);                                    // хибно
  const merged = (a.avg * a.count + b.avg * b.count) / (a.count + b.count);
  assert.equal(Math.round(merged * 10) / 10, 19.9);                         // правильно
});

test('доба за київським часом 25 жовтня 2026 містить 25 щогодинних показань, наступна — 24', () => {
  const db = setup();
  seed(db, { metric: 'rain', start: T('2026-10-23T00:00:00Z'), count: 96, step: 3600, values: () => 1 });
  const r = createAggregator(db)(args({ metric: 'rain', kind: 'delta', interval: parseInterval('1d'),
    tz: 'Europe/Kyiv', from: T('2026-10-24T21:00:00Z'), to: T('2026-10-26T22:00:00Z') }));
  assert.deepEqual(r.map((b) => [b.start, b.sum]),
    [['2026-10-24T21:00:00.000Z', 25], ['2026-10-25T22:00:00.000Z', 24]]);
});

test('counter: приріст — різниця з останнім показанням до інтервалу, сума по годинах = загальна різниця', () => {
  const db = setup();
  // накопичувальний індекс лічильника кожні 15 хв, приріст 0,1 за показання
  seed(db, { metric: 'water_index', start: T('2026-11-03T09:45:00Z'), count: 21, step: 900,
    values: (i) => Math.round((1000 + i * 0.1) * 100) / 100 });
  const agg = createAggregator(db);
  const hours = agg(args({ metric: 'water_index', kind: 'counter', interval: parseInterval('1h'),
    from: T('2026-11-03T10:00:00Z'), to: T('2026-11-03T14:00:00Z') }));
  const deltas = hours.map((b) => Math.round(b.delta * 100) / 100);
  assert.deepEqual(deltas, [0.4, 0.4, 0.4, 0.4]);
  // «останнє мінус перше в межах інтервалу» втрачає приріст між інтервалами: 0,3 замість 0,4
  const naive = db.prepare(`SELECT max(value) - min(value) AS d FROM telemetry
    WHERE metric = 'water_index' AND ts >= ? AND ts < ?`).get('2026-11-03T10:00:00.000Z', '2026-11-03T11:00:00.000Z');
  assert.equal(Math.round(naive.d * 100) / 100, 0.3);
});

test('fill=null повертає порожні інтервали з null, fill=none — пропускає їх', () => {
  const db = setup();
  seed(db, { start: T('2026-11-03T10:00:00Z'), count: 5, values: () => 20 });
  seed(db, { start: T('2026-11-03T12:00:00Z'), count: 5, values: () => 22 });
  const agg = createAggregator(db);
  const w = { from: T('2026-11-03T10:00:00Z'), to: T('2026-11-03T13:00:00Z') };
  assert.equal(agg(args({ ...w })).length, 2);
  const filled = agg(args({ ...w, fill: 'null' }));
  assert.deepEqual(filled[1], { start: '2026-11-03T11:00:00.000Z', count: 0, avg: null, min: null, max: null });
});
