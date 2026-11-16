'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeDb, addDevice, seed, iso } = require('./testkit');
const { createServer } = require('./server');

const NOW = Date.parse('2026-11-03T12:00:00Z');
const H = 3_600_000;
const START = NOW - 24 * H;

function setup({ limits = { rate: 1000, burst: 1000 } } = {}) {
  const db = makeDb();
  addDevice(db, 'gh1-s01', 'north');
  addDevice(db, 'gh1-s02', 'north');
  addDevice(db, 'gh2-s01', 'south');
  seed(db, { start: START, count: 24 * 60, values: (i) => 20 + (i % 60) / 10 });   // доба, крок 1 хв
  const sink = { sent: [], down: false,
    async send(deviceId, cmd) { if (this.down) throw new Error('брокер недоступний'); this.sent.push({ deviceId, ...cmd }); } };
  let now = NOW;
  const app = createServer({ db, state: { mqttConnected: true, lastReadingAt: null }, sink,
    clock: () => now, limits });
  return { app, db, sink, tick: (ms) => { now += ms; } };
}
const q = (o) => new URLSearchParams(o).toString();
const win = { from: iso(START), to: iso(START + 2 * H) };

test('список пристроїв: сторінки за курсором і фільтр за зоною', async () => {
  const { app } = setup();
  const p1 = (await request(app).get('/api/v1/devices?limit=2')).body;
  assert.deepEqual(p1.data.map((d) => d.id), ['gh1-s01', 'gh1-s02']);
  assert.ok(p1.next);
  const p2 = (await request(app).get(`/api/v1/devices?${q({ limit: 2, cursor: p1.next })}`)).body;
  assert.deepEqual([p2.data.map((d) => d.id), p2.next], [['gh2-s01'], null]);
  const south = (await request(app).get('/api/v1/devices?zone=south')).body;
  assert.deepEqual(south.data.map((d) => d.id), ['gh2-s01']);
  assert.equal(p1.data[0].last_seen, iso(START + (24 * 60 - 1) * 60_000));
  assert.equal(p1.data[1].last_seen, null);                       // пристрій без даних
});

test('невідомий пристрій — 404, пристрій без даних за вікно — 200 і порожній масив', async () => {
  const { app } = setup();
  const miss = await request(app).get(`/api/v1/telemetry?${q({ device: 'nope', metric: 'temperature', ...win })}`);
  assert.equal(miss.status, 404);
  assert.match(miss.headers['content-type'], /application\/problem\+json/);
  assert.equal(miss.body.type, 'https://greenhouse.example/problems/device-not-found');
  const empty = await request(app).get(`/api/v1/telemetry?${q({ device: 'gh1-s02', metric: 'temperature', ...win })}`);
  assert.deepEqual([empty.status, empty.body], [200, { data: [], next: null }]);
});

test('помилки параметрів повертаються всі одразу, а друкарська помилка не ігнорується', async () => {
  const { app } = setup();
  const r = await request(app).get(`/api/v1/telemetry?${q({ device: 'gh1-s01', metrics: 'temperature', from: 'вчора' })}`);
  assert.equal(r.status, 400);
  const byParam = Object.fromEntries(r.body.errors.map((e) => [e.param, e.message]));
  assert.deepEqual(Object.keys(byParam).sort(), ['from', 'metric', 'metrics', 'to']);
  assert.equal(byParam.metrics, 'невідомий параметр');
  const rev = await request(app).get(`/api/v1/telemetry?${q({ device: 'gh1-s01', metric: 'temperature', from: win.to, to: win.from })}`);
  assert.equal(rev.body.errors[0].message, 'from має бути раніше за to');
});

test('сирі дані: обхід сторінок, ETag і 304 за If-None-Match', async () => {
  const { app } = setup();
  const base = { device: 'gh1-s01', metric: 'temperature', from: iso(START), to: iso(START + 3 * H), limit: 100 };
  const seen = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const r = await request(app).get(`/api/v1/telemetry?${q({ ...base, ...(cursor ? { cursor } : {}) })}`);
    seen.push(...r.body.data);
    if (!(cursor = r.body.next)) break;
  }
  assert.equal(seen.length, 180);
  assert.equal(new Set(seen.map((x) => x.ts)).size, 180);
  const first = await request(app).get(`/api/v1/telemetry?${q({ ...base, limit: 5 })}`);
  const again = await request(app).get(`/api/v1/telemetry?${q({ ...base, limit: 5 })}`).set('If-None-Match', first.headers.etag);
  assert.deepEqual([first.status, again.status, again.text], [200, 304, '']);
  const big = await request(app).get(`/api/v1/telemetry?${q({ ...base, limit: 5000 })}`);
  assert.equal(big.body.errors[0].param, 'limit');
});

test('агрегація: вибрані поля, допустимість агрегату за типом метрики, обмеження кількості інтервалів', async () => {
  const { app } = setup();
  const base = { device: 'gh1-s01', metric: 'temperature', from: iso(START), to: iso(START + 3 * H), interval: '1h' };
  const ok = await request(app).get(`/api/v1/telemetry?${q({ ...base, agg: 'avg,max' })}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body.data[0]), ['start', 'count', 'avg', 'max']);
  assert.equal(ok.body.data.length, 3);
  const sum = await request(app).get(`/api/v1/telemetry?${q({ ...base, agg: 'sum' })}`);
  assert.deepEqual([sum.status, sum.body.code ?? sum.body.type.split('/').pop(), sum.body.allowed],
    [400, 'invalid-aggregate', ['avg', 'min', 'max', 'count']]);
  const wideAgg = await request(app).get(`/api/v1/telemetry?${q({ ...base, from: '2024-11-03T00:00:00Z', interval: '1mo', agg: 'avg' })}`);
  assert.equal(wideAgg.body.type.split('/').pop(), 'window-too-large');
  const many = await request(app).get(`/api/v1/telemetry?${q({ ...base, from: iso(Date.parse(base.to) - 100 * 24 * H), interval: '1m', agg: 'avg' })}`);
  assert.equal(many.body.type.split('/').pop(), 'too-many-buckets');
});

test('сповіщення: період нижче порога знайдено, надто широке вікно відхилено', async () => {
  const { app, db } = setup();
  seed(db, { device: 'gh1-s02', start: START, count: 60, values: (i) => (i >= 10 && i < 25 ? 15 : 22) });
  const r = await request(app).get(`/api/v1/alerts?${q({ device: 'gh1-s02', metric: 'temperature', op: 'lt',
    threshold: 18, hysteresis: 0.5, min_duration: 600, from: iso(START), to: iso(START + 2 * H) })}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, [{ start: iso(START + 10 * 60_000), end: iso(START + 25 * 60_000),
    duration_sec: 900, extreme: 15, samples: 15, ended_by: 'recovered', open: false }]);
  const wide = await request(app).get(`/api/v1/alerts?${q({ device: 'gh1-s02', metric: 'temperature', op: 'lt',
    threshold: 18, from: '2026-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' })}`);
  assert.equal(wide.status, 400);
  assert.equal(wide.body.type.split('/').pop(), 'window-too-large');
  assert.deepEqual([wide.body.estimated_rows > wide.body.max_rows, wide.body.max_rows], [true, 60000]);
});

test('webhook: пакет приймається однією відповіддю, повтор пакета не створює дублікатів', async () => {
  const { app, db } = setup();
  const ts = (m) => iso(NOW - m * 60_000);
  const ev = (m, extra = {}) => ({ device_id: 'gh1-s02', metric: 'humidity', value: 55, ts: ts(m), ...extra });
  const body = { events: [ev(5), ev(4), ev(4), ev(3, { value: 999 }), 'сміття'] };
  const r1 = await request(app).post('/api/v1/ingest/webhook').send(body);
  assert.deepEqual([r1.status, r1.body], [200, { stored: 2, duplicate: 1, rejected: 2 }]);
  const r2 = await request(app).post('/api/v1/ingest/webhook').send(body);       // повторна доставка платформою
  assert.deepEqual(r2.body, { stored: 0, duplicate: 3, rejected: 2 });
  assert.equal(db.prepare("SELECT count(*) n FROM telemetry WHERE device_id = 'gh1-s02'").get().n, 2);
  const bad = await request(app).post('/api/v1/ingest/webhook').send({ events: [] });
  assert.equal(bad.status, 400);
  const broken = await request(app).post('/api/v1/ingest/webhook').set('Content-Type', 'application/json').send('{oops');
  assert.deepEqual([broken.status, broken.body.status], [400, 400]);
  assert.match(broken.headers['content-type'], /problem\+json/);
});

test('команда: 202 і Location, повтор із тим самим ключем повертає ту саму команду, інше тіло — 422', async () => {
  const { app, sink } = setup();
  const post = (body, key) => request(app).post('/api/v1/devices/gh1-s01/commands')
    .set(key ? { 'Idempotency-Key': key } : {}).send(body);
  const a = await post({ name: 'irrigate', params: { duration_sec: 120 } }, 'retry-key-0001');
  assert.equal(a.status, 202);
  assert.equal(a.headers.location, `/api/v1/commands/${a.body.id}`);
  assert.equal(a.body.status, 'sent');
  const b = await post({ name: 'irrigate', params: { duration_sec: 120 } }, 'retry-key-0001');
  assert.deepEqual([b.status, b.body.id], [202, a.body.id]);
  assert.equal(sink.sent.length, 1, 'команда не надіслана вдруге');
  const c = await post({ name: 'irrigate', params: { duration_sec: 300 } }, 'retry-key-0001');
  assert.equal(c.status, 422);
  const bad = await post({ name: 'irrigate', params: { duration_sec: 99999 } });
  assert.equal(bad.status, 400);
});

test('життєвий цикл команди: недоступний брокер, повтор відправлення, підтвердження, спливання TTL', async () => {
  const { app, sink, tick } = setup();
  sink.down = true;
  const a = await request(app).post('/api/v1/devices/gh1-s01/commands').send({ name: 'irrigate', params: { duration_sec: 60 } });
  assert.equal(a.body.status, 'pending');
  sink.down = false;
  await app.commands.dispatchPending();
  assert.equal((await request(app).get(`/api/v1/commands/${a.body.id}`)).body.status, 'sent');
  assert.equal(app.commands.ack(a.body.id, true), true);
  assert.equal((await request(app).get(`/api/v1/commands/${a.body.id}`)).body.status, 'acked');
  assert.equal(app.commands.ack(a.body.id, false), false, 'остаточний стан не змінюється');

  const b = await request(app).post('/api/v1/devices/gh1-s01/commands').send({ name: 'irrigate', params: { duration_sec: 60 } });
  tick(61_000);
  assert.equal(app.commands.expireOverdue(), 1);
  assert.equal((await request(app).get(`/api/v1/commands/${b.body.id}`)).body.status, 'expired');
  assert.equal(app.commands.ack(b.body.id, true), true, 'пізнє підтвердження фіксує факт виконання');
});

test('webhook платформи має власний ліміт і не ділить його з клієнтами застосунку', async () => {
  const { app } = setup({ limits: { rate: 1, burst: 1, ingest: { rate: 1000, burst: 1000 } } });
  const user = [], hook = [];
  for (let i = 0; i < 3; i++) user.push((await request(app).get('/api/v1/devices')).status);
  for (let i = 0; i < 3; i++) {
    hook.push((await request(app).post('/api/v1/ingest/webhook')
      .send({ events: [{ device_id: 'gh1-s01', metric: 'humidity', value: 50, ts: iso(START + i * 1000 - 5000) }] })).status);
  }
  assert.deepEqual([user, hook], [[200, 429, 429], [200, 200, 200]]);
});

test('застарілий маршрут повертає Deprecation і Sunset', async () => {
  const { app } = setup();
  const r = await request(app).get('/api/v1/devices/gh1-s01/latest');
  assert.equal(r.status, 200);
  assert.equal(r.headers.deprecation, '@1793664000');
  assert.equal(r.headers.sunset, 'Mon, 03 May 2027 00:00:00 GMT');
  assert.equal((await request(app).get('/api/v1/devices/gh1-s01')).headers.deprecation, undefined);
});

test('підтвердження від іншого пристрою не змінює стан чужої команди', async () => {
  const { app } = setup();
  const a = await request(app).post('/api/v1/devices/gh1-s01/commands').send({ name: 'irrigate', params: { duration_sec: 60 } });
  assert.equal(app.commands.ack(a.body.id, true, 'gh1-s02'), false);
  assert.equal((await request(app).get(`/api/v1/commands/${a.body.id}`)).body.status, 'sent');
  assert.equal(app.commands.ack(a.body.id, true, 'gh1-s01'), true);
});

test('перевищення ліміту — 429 із Retry-After у форматі problem+json, службові маршрути не обмежуються', async () => {
  const { app } = setup({ limits: { rate: 1, burst: 3 } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await request(app).get('/api/v1/devices')).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const r = await request(app).get('/api/v1/devices');
  assert.equal(r.headers['retry-after'], '1');
  assert.match(r.headers['content-type'], /problem\+json/);
  assert.equal((await request(app).get('/healthz')).status, 200);
});

test('невідомий маршрут у /api/v1 — 404 problem+json', async () => {
  const { app } = setup();
  const r = await request(app).get('/api/v1/nothing');
  assert.deepEqual([r.status, r.body.status], [404, 404]);
});

test('налаштування: ETag і If-Match не дають другому диспетчеру мовчки затерти зміну першого', async () => {
  const { app } = setup();
  const url = '/api/v1/devices/gh1-s01/settings';
  const first = await request(app).get(url);
  assert.deepEqual([first.status, first.body, first.headers.etag], [200, {}, '"0"']);
  // обидва диспетчери прочитали версію 0
  const a = await request(app).put(url).set('If-Match', '"0"').send({ soil_moisture_min: 35 });
  assert.deepEqual([a.status, a.headers.etag, a.body], [200, '"1"', { soil_moisture_min: 35 }]);
  const b = await request(app).put(url).set('If-Match', '"0"').send({ soil_moisture_min: 20 });
  assert.equal(b.status, 412);
  assert.deepEqual([b.body.current, b.body.current_etag], [{ soil_moisture_min: 35 }, '"1"']);
  assert.equal((await request(app).put(url).send({ soil_moisture_min: 20 })).status, 428);
  const bad = await request(app).put(url).set('If-Match', '"1"').send({ soil_moisture_min: 500, color: 'red' });
  assert.deepEqual([bad.status, bad.body.errors.map((e) => e.param)], [400, ['soil_moisture_min', 'color']]);
  const c = await request(app).put(url).set('If-Match', '"1"').send({ soil_moisture_min: 20 });
  assert.deepEqual([c.status, c.headers.etag], [200, '"2"']);
  assert.equal((await request(app).get(url).set('If-None-Match', '"2"')).status, 304);
  assert.equal((await request(app).get('/api/v1/devices/nope/settings')).status, 404);
});
