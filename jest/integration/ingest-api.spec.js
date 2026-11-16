'use strict';
const request = require('supertest');
const mqtt = require('mqtt');
const { makeDb, addDevice } = require('../../testkit');
const { createApp } = require('../../app');
const { createMqttSource } = require('../../mqtt-source');
const { createServer } = require('../../server');
const { createHealthState, trackBroker } = require('../../health');
const { createOpsMetrics } = require('../../ops-metrics');
const { startBroker } = require('../helpers/broker');
const { waitFor } = require('../helpers/wait');

let broker, db, ingest, api, ops, device;
const state = createHealthState();

beforeAll(async () => {
  broker = await startBroker();          // брокер Aedes у цьому ж процесі
  db = makeDb();                         // SQLite у пам’яті
  addDevice(db, 'gh1-s01', 'north');
  ops = createOpsMetrics({ state, defaults: false });
  const source = createMqttSource({ url: broker.url,
    clientId: 'ingest-jest', filter: 'greenhouse/+/telemetry' });
  ingest = createApp({ db, source, observe: ops.recordIngest });
  await ingest.start();
  trackBroker(source.client, state);
  const open = { rate: 1e4, burst: 1e4 };       // ліміти не заважають
  api = createServer({ db, state, ops, sink: { async send() {} },
    limits: { ...open, ingest: open } });
  // «пристрій» — другий клієнт MQTT, що публікує як справжній
  device = mqtt.connect(broker.url, { clientId: 'sim-gh1-s01' });
  await new Promise((resolve) => device.once('connect', resolve));
});

afterAll(async () => {
  await new Promise((resolve) => device.end(false, {}, resolve));
  await ingest.stop();
  await broker.stop();
  db.close();
});

beforeEach(() => {
  db.exec(`DELETE FROM telemetry; DELETE FROM latest;
           DELETE FROM rejected`);
  Object.assign(ingest.stats, { stored: 0, duplicate: 0, rejected: 0 });
});

const publish = (body) => new Promise((resolve, reject) => device.publish(
  'greenhouse/gh1-s01/telemetry', JSON.stringify(body), { qos: 1 },
  (e) => (e ? reject(e) : resolve())));
const DEVICE = '/api/v1/devices/gh1-s01';
const get = (path) => request(api).get(path).expect(200);
const latest = async () => (await get(DEVICE)).body.latest;
// Метрики читаємо тим самим запитом, що й Prometheus
const scrape = async () => (await get('/metrics')).text;
const counter = async (re) => Number((await scrape()).match(re)?.[1] ?? 0);

test('показання, надіслане через брокер, видно в REST API', async () => {
  const stored = /greenhouse_readings_total\{result="stored"\} (\d+)/;
  const before = await counter(stored);
  const ts = new Date().toISOString();
  await publish({ metric: 'temperature', value: 24.5, ts });
  await waitFor(async () => (await latest()).length === 1,
    { what: 'показання в latest' });
  expect(await latest()).toEqual(
    [{ metric: 'temperature', ts, value: 24.5, unit: '°C' }]);
  expect(await counter(stored)).toBe(before + 1);
});

test('140 °C відхиляється й не потрапляє до API', async () => {
  const ts = new Date().toISOString();
  await publish({ metric: 'temperature', value: 140, ts });
  await waitFor(() => ingest.stats.rejected === 1, { what: 'відхилення' });
  expect(await latest()).toEqual([]);
  expect(db.prepare('SELECT reason FROM rejected').all())
    .toEqual([{ reason: 'out_of_range' }]);
});

test('повтор повідомлення QoS 1 не створює другого рядка', async () => {
  const ts = new Date().toISOString();
  const body = { metric: 'humidity', value: 61, ts };
  await publish(body);
  await publish(body);
  await waitFor(() => ingest.stats.duplicate === 1, { what: 'дублікат' });
  const rows = db.prepare('SELECT count(*) AS n FROM telemetry').get().n;
  expect(rows).toBe(1);
});

test('успішна й помилкова відповіді одного маршруту мають одну мітку route', async () => {
  await get(DEVICE);
  await request(api).get('/api/v1/devices/nope').expect(404);
  const text = await scrape();
  for (const status of [200, 404]) {
    expect(text).toContain(`greenhouse_http_request_seconds_count{method="GET",status="${status}",route="/api/v1/devices/:id"}`);
  }
});

test('падіння брокера: /readyz дає 503, потім знову 200', async () => {
  const readyz = async () => (await request(api).get('/readyz')).status;
  expect(await readyz()).toBe(200);
  const { port } = broker;
  await broker.stop();      // з пристроєм таку відмову не відтворити
  await waitFor(async () => (await readyz()) === 503,
    { what: '503 після зупинки брокера' });
  // той самий порт: клієнти підключаться самі
  broker = await startBroker(port);
  await waitFor(async () => (await readyz()) === 200,
    { timeoutMs: 8000, what: 'повернення готовності' });
  // проби не рахуються запитами API: їхні 503 спалювали б бюджет помилок
  expect(await scrape()).not.toMatch(/route="\/(readyz|healthz|metrics)"/);
});
