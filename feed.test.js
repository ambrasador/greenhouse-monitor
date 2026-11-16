'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./testkit');
const { createIngest } = require('./core');
const { createFeed } = require('./feed');

const NOW = Date.parse('2026-11-04T12:00:00Z');
const rd = (n, extra = {}) => ({
  deviceId: 'gh1-s01', metric: 'temperature', value: 20 + n,
  ts: new Date(NOW - 60_000 + n * 1000).toISOString(), ...extra });
const ev = (n, device = 'gh1-s01') => ({ device, metric: 'temperature',
  ts: rd(n).ts, value: 20 + n });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const db = makeDb();
  const seen = [];                       // кожен виклик підписника: [пристрій, вимірювання]
  const feed = createFeed();
  feed.subscribe('*', (device, readings) => seen.push([device, readings]));
  const ingest = createIngest(db, () => NOW, feed.publish);
  return { db, seen, feed, ingest };
}

test('подія виходить для нового вимірювання, але не для дубліката й не для відхиленого', () => {
  const { seen, feed, ingest } = setup();
  assert.equal(ingest.accept(rd(1)), 'stored');
  assert.equal(ingest.accept(rd(1)), 'duplicate');
  assert.equal(ingest.accept(rd(2, { value: 999 })), 'out_of_range');
  feed.flush();
  assert.deepEqual(seen, [['gh1-s01', [{ metric: 'temperature', ts: rd(1).ts, value: 21 }]]]);
});

test('у пакеті події виходять після COMMIT: у цей момент рядки вже читаються', () => {
  const db = makeDb();
  const visible = [];
  const feed = createFeed();
  const ing = createIngest(db, () => NOW, (e) => {
    visible.push(db.prepare('SELECT count(*) AS n FROM telemetry').get().n);
    feed.publish(e);
  });
  ing.batch([rd(1), rd(2), rd(3)]);
  assert.deepEqual(visible, [3, 3, 3]);        // усі три рядки вже зафіксовані
});

test('ROLLBACK пакета: подій немає ні в базі, ні в потоці', () => {
  const { db, seen, feed, ingest } = setup();
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON telemetry WHEN NEW.value = 77
           BEGIN SELECT RAISE(ABORT, 'диск заповнений'); END`);
  assert.throws(() => ingest.batch([rd(1), rd(2), rd(57)]), /диск заповнений/);
  feed.flush();
  assert.equal(seen.length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM telemetry').get().n, 0);
  // після збою ядро працює далі й не публікує залишків невдалого пакета
  assert.equal(ingest.accept(rd(4)), 'stored');
  feed.flush();
  assert.deepEqual(seen.flatMap(([, r]) => r.map((x) => x.value)), [24]);
});

test('контраст: публікація всередині транзакції показала б події, яких немає в базі', () => {
  const db = makeDb();
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON telemetry WHEN NEW.value = 77
           BEGIN SELECT RAISE(ABORT, 'диск заповнений'); END`);
  const seen = [];
  const ins = db.prepare('INSERT INTO telemetry VALUES (?, ?, ?, ?, ?)');
  const naive = db.transaction((items) => items.forEach((r) => {
    ins.run(r.deviceId, r.metric, r.ts, r.ts, r.value);
    seen.push(r.value);                         // публікація до COMMIT
  }));
  assert.throws(() => naive([rd(1), rd(2), rd(57)]));
  assert.deepEqual(seen, [21, 22]);             // підписник отримав два «привиди»
  assert.equal(db.prepare('SELECT count(*) AS n FROM telemetry').get().n, 0);
});

test('вікно: події одного пристрою доходять одним викликом, у порядку публікації', () => {
  const feed = createFeed();
  const all = [];
  const one = [];
  feed.subscribe('*', (d, r) => all.push([d, r.map((x) => x.value)]));
  feed.subscribe('gh1-s01', (d, r) => one.push([d, r.map((x) => x.value)]));
  feed.publish(ev(1));
  feed.publish(ev(2, 'gh1-s02'));
  feed.publish(ev(3));
  assert.equal(all.length, 0);                  // до кінця вікна нічого не видано
  feed.flush();
  assert.deepEqual(all, [['gh1-s01', [21, 23]], ['gh1-s02', [22]]]);
  assert.deepEqual(one, [['gh1-s01', [21, 23]]]);
  feed.flush();
  assert.equal(all.length, 2);                  // порожнє вікно нічого не видає
});

test('вікно закривається таймером; ручний flush скасовує таймер', async () => {
  const feed = createFeed({ windowMs: 30 });
  const calls = [];
  feed.subscribe('*', (d, r) => calls.push(r.length));
  feed.publish(ev(1));
  await pause(80);
  assert.deepEqual(calls, [1]);                 // вікно закрилося саме
  feed.publish(ev(2));
  feed.flush();
  await pause(80);
  assert.deepEqual(calls, [1, 1]);              // другий виклик лише один
});

test('збій підписника не зупиняє інших підписників і приймання', () => {
  const errors = [];
  const feed = createFeed({ onError: (e) => errors.push(e.message) });
  const got = [];
  feed.subscribe('*', () => { throw new Error('збій'); });
  feed.subscribe('gh1-s01', (d, r) => got.push(r[0].value));
  const ing = createIngest(makeDb(), () => NOW, feed.publish);
  assert.equal(ing.accept(rd(1)), 'stored');
  feed.flush();
  assert.deepEqual(got, [21]);
  assert.deepEqual(errors, ['збій']);
});

test('відписка прибирає підписника; size рахує підписки', () => {
  const feed = createFeed();
  const off = feed.subscribe('a', () => {});
  feed.subscribe('*', () => {});
  assert.equal(feed.size(), 2);
  off();
  assert.equal(feed.size(), 1);
});
