'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, addDevice, seed, iso } = require('./testkit');
const { createRawReader } = require('./pagination');

const START = Date.parse('2026-11-01T00:00:00Z');
const base = { device: 'gh1-s01', metric: 'temperature',
  from: iso(START), to: iso(START + 3600_000 * 24), order: 'asc', limit: 4 };

function setup(count = 10) {
  const db = makeDb();
  addDevice(db, 'gh1-s01');
  seed(db, { start: START, count, values: (i) => 20 + i });
  return db;
}

function walk(read, params) {
  const seen = [];
  let cursor;
  for (let guard = 0; guard < 100; guard++) {
    const page = read({ ...params, cursor });
    seen.push(...page.data.map((r) => r.ts));
    if (!page.next) return seen;
    cursor = page.next;
  }
  throw new Error('нескінченний обхід');
}

test('курсор обходить усі рядки рівно один раз, зайвої порожньої сторінки немає', () => {
  for (const [count, limit] of [[10, 4], [8, 4], [1, 4], [0, 4]]) {
    const read = createRawReader(setup(count));
    const seen = walk(read, { ...base, limit });
    assert.equal(seen.length, count);
    assert.equal(new Set(seen).size, count);
    assert.deepEqual(seen, [...seen].sort());
  }
});

test('нові дані між запитами сторінок: OFFSET дає дублікат, курсор — ні', () => {
  const db = setup(10);
  const desc = { ...base, order: 'desc', limit: 4 };

  // OFFSET: перша сторінка, потім надходить нове вимірювання, потім друга сторінка
  const sql = db.prepare(`SELECT ts FROM telemetry WHERE device_id = 'gh1-s01' AND metric = 'temperature'
                          ORDER BY ts DESC LIMIT 4 OFFSET ?`);
  const p1 = sql.all(0).map((r) => r.ts);
  const newTs = iso(START + 10 * 60_000);
  db.prepare('INSERT INTO telemetry VALUES (?, ?, ?, ?, ?)').run('gh1-s01', 'temperature', newTs, newTs, 30);
  const p2 = sql.all(4).map((r) => r.ts);
  assert.ok(p2.includes(p1.at(-1)), 'останній рядок сторінки 1 повторився на сторінці 2');

  // Курсор: те саме сканування, але з позицією замість номера рядка
  const db2 = setup(10);
  const read2 = createRawReader(db2);
  const c1 = read2({ ...desc });
  db2.prepare('INSERT INTO telemetry VALUES (?, ?, ?, ?, ?)').run('gh1-s01', 'temperature', newTs, newTs, 30);
  const c2 = read2({ ...desc, cursor: c1.next });
  assert.ok(!c2.data.some((r) => c1.data.some((x) => x.ts === r.ts)), 'повторів немає');
});

test('курсор не можна застосувати до іншого запиту', () => {
  const read = createRawReader(setup(10));
  const first = read({ ...base });
  assert.throws(() => read({ ...base, metric: 'humidity', cursor: first.next }), { status: 400, code: 'invalid-cursor' });
  assert.throws(() => read({ ...base, cursor: 'не-курсор' }), { status: 400, code: 'invalid-cursor' });
});

test('пастка: курсор за неунікальним ключем втрачає рядки з однаковим ts', () => {
  const db = makeDb();
  const ins = db.prepare('INSERT INTO telemetry VALUES (?, ?, ?, ?, ?)');
  const ts = '2026-11-01T00:00:00.000Z';
  for (const d of ['a', 'b', 'c']) ins.run(d, 'temperature', ts, ts, 20);   // три пристрої, один момент
  const page = (cond, args) => db.prepare(
    `SELECT device_id, ts FROM telemetry WHERE ${cond} ORDER BY ts, device_id LIMIT 2`).all(...args);
  // хибно: «ts > останній ts» пропускає третій рядок
  const p1 = page('1 = 1', []);
  const wrong = page('ts > ?', [p1.at(-1).ts]);
  assert.equal(wrong.length, 0, 'рядок c загублено');
  // правильно: порівняння пари (ts, device_id) — унікального ключа
  const right = page('(ts, device_id) > (?, ?)', [p1.at(-1).ts, p1.at(-1).device_id]);
  assert.deepEqual(right.map((r) => r.device_id), ['c']);
});
