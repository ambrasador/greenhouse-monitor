'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { createApp } = require('./app');
const { createFakeSource } = require('./fake-source');
const { decode } = require('./mqtt-source');

const NOW = Date.parse('2026-11-03T12:00:00Z');

function setup() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(`${__dirname}/schema.sql`, 'utf8'));
  const source = createFakeSource();
  const app = createApp({ db, source, clock: () => NOW });
  return { db, source, app };
}
const reading = (ts, value = 20) =>
  ({ deviceId: 'gh1-s01', metric: 'temperature', value, ts });
const count = (db, table) =>
  db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('дублікат (навіть з іншим записом мс) не додає рядок', () => {
  const { db, source } = setup();
  const first = source.push(reading('2026-11-03T11:59:00.000Z'));
  const again = source.push(reading('2026-11-03T11:59:00Z'));
  assert.deepEqual([first, again], ['stored', 'duplicate']);
  assert.equal(count(db, 'telemetry'), 1);
});

test('запізніле значення зберігається, але не затирає latest', () => {
  const { db, source } = setup();
  source.push(reading('2026-11-03T11:59:00Z', 22));
  source.push(reading('2026-11-03T11:58:00Z', 21));   // прийшло пізніше
  assert.equal(count(db, 'telemetry'), 2);
  const last = db.prepare('SELECT ts, value FROM latest').get();
  assert.deepEqual(last, { ts: '2026-11-03T11:59:00.000Z', value: 22 });
});

test('некоректні повідомлення потрапляють у rejected', () => {
  const { db, source, app } = setup();
  const push = (ts, value) => source.push(reading(ts, value));
  assert.equal(push('2026-11-03T12:30:00Z'), 'ts_in_future');
  assert.equal(push('1970-01-01T00:00:05Z'), 'ts_too_old');
  assert.equal(push('2026-11-03T11:00:00Z', 300), 'out_of_range');
  source.pushBad('bad_json', 'greenhouse/gh1-s01/telemetry {oops');
  assert.equal(count(db, 'telemetry'), 0);
  assert.equal(count(db, 'rejected'), 4);
  assert.equal(app.stats.rejected, 4);
});

test('вхід, що міг би зупинити процес, відхиляється', () => {
  const { db, source } = setup();
  const push = (patch) =>
    source.push({ ...reading('2026-11-03T11:00:00Z'), ...patch });
  assert.equal(push({ ts: '2026-13-45T99:99:99Z' }), 'bad_ts');
  assert.equal(push({ ts: '2026-02-30T10:00:00Z' }), 'bad_ts');
  assert.equal(push({ metric: 'constructor' }), 'unknown_metric');
  assert.equal(push({ metric: ['temperature'] }), 'unknown_metric');
  for (const body of ['null', '42', '"x"']) {
    assert.throws(() => decode('greenhouse/gh1-s01/telemetry',
      Buffer.from(body)), { message: 'bad_json' });
  }
  assert.equal(count(db, 'telemetry'), 0);
});
