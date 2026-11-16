'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const mqtt = require('mqtt');
const request = require('supertest');
const { Aedes } = require('aedes');
const { makeDb, addDevice } = require('./testkit');
const { createApp } = require('./app');
const { createMqttSource } = require('./mqtt-source');
const { createMqttCommandChannel } = require('./mqtt-commands');
const { createServer } = require('./server');

// Наскрізний тест: брокер Aedes у пам’яті, справжні клієнти mqtt.js, HTTP API
async function startStack() {
  const aedes = await Aedes.createBroker();
  const broker = net.createServer(aedes.handle);
  await new Promise((r) => broker.listen(0, '127.0.0.1', r));
  const url = `mqtt://127.0.0.1:${broker.address().port}`;
  const db = makeDb();
  addDevice(db, 'gh1-s01');
  const source = createMqttSource({ url, clientId: 'ingest-test', filter: 'greenhouse/+/telemetry' });
  const ingestApp = createApp({ db, source });
  const channel = createMqttCommandChannel({ url, clientId: 'api-test' });
  const state = { mqttConnected: true, lastReadingAt: null };
  const app = createServer({ db, state, sink: channel, limits: { rate: 1000, burst: 1000 } });
  channel.onAck(({ deviceId, id, ok }) => app.commands.ack(id, ok, deviceId));
  await Promise.all([ingestApp.start(), channel.ready()]);
  const device = mqtt.connect(url, { clientId: 'gh1-s01' });
  await new Promise((r) => device.once('connect', r));
  return { db, app, device, url,
    async stop() {
      await new Promise((r) => device.end(false, {}, r));
      await ingestApp.stop(); await channel.close();
      await new Promise((r) => aedes.close(r)); broker.close();
    } };
}
const until = async (fn, ms = 3000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    const v = await fn(); if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('умова не виконалась за відведений час');
};
const publish = (client, topic, body) => new Promise((resolve, reject) =>
  client.publish(topic, JSON.stringify(body), { qos: 1 }, (e) => (e ? reject(e) : resolve())));

test('телеметрія з брокера з’являється у відповідях REST; той самий замір через webhook — дублікат', async () => {
  const s = await startStack();
  try {
    const ts = new Date(Date.now() - 60_000).toISOString();
    const reading = { metric: 'temperature', value: 21.5, ts };
    await publish(s.device, 'greenhouse/gh1-s01/telemetry', reading);
    const dev = await until(async () => {
      const r = await request(s.app).get('/api/v1/devices/gh1-s01');
      return r.body.latest.length ? r.body : null;
    });
    assert.deepEqual(dev.latest, [{ metric: 'temperature', ts, value: 21.5, unit: '°C' }]);
    const hook = await request(s.app).post('/api/v1/ingest/webhook')
      .send({ events: [{ device_id: 'gh1-s01', ...reading }] });
    assert.deepEqual(hook.body, { stored: 0, duplicate: 1, rejected: 0 });
  } finally { await s.stop(); }
});

test('команда: POST → брокер → пристрій → підтвердження → стан acked', async () => {
  const s = await startStack();
  try {
    await new Promise((r) => s.device.subscribe('greenhouse/gh1-s01/commands', { qos: 1 }, r));
    s.device.on('message', (topic, payload) => {
      const cmd = JSON.parse(payload.toString());
      publish(s.device, 'greenhouse/gh1-s01/acks', { id: cmd.id, ok: true });
    });
    const res = await request(s.app).post('/api/v1/devices/gh1-s01/commands')
      .send({ name: 'irrigate', params: { duration_sec: 90 } });
    assert.equal(res.status, 202);
    const done = await until(async () => {
      const c = (await request(s.app).get(res.headers.location)).body;
      return c.status === 'acked' ? c : null;
    });
    assert.equal(done.params.duration_sec, 90);
  } finally { await s.stop(); }
});

async function startBroker(port = 0) {
  const aedes = await Aedes.createBroker();
  const srv = net.createServer(aedes.handle);
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { port: srv.address().port, stop: () => new Promise((r) => aedes.close(() => srv.close(r))) };
}

test('брокер недоступний: POST не зависає, команда лишається pending і доходить після відновлення', { timeout: 20_000 }, async () => {
  let broker = await startBroker();
  const url = `mqtt://127.0.0.1:${broker.port}`;
  const db = makeDb();
  addDevice(db, 'gh1-s01');
  const channel = createMqttCommandChannel({ url, clientId: 'api-outage' });
  const app = createServer({ db, state: { mqttConnected: true }, sink: channel, limits: { rate: 1000, burst: 1000 } });
  await channel.ready();
  await broker.stop();
  await until(() => !channel.connected());
  const t0 = Date.now();
  const res = await request(app).post('/api/v1/devices/gh1-s01/commands')
    .send({ name: 'irrigate', params: { duration_sec: 30 } });
  assert.deepEqual([res.status, res.body.status], [202, 'pending']);
  assert.ok(Date.now() - t0 < 1000, 'відповідь не чекає на відновлення зв’язку');

  broker = await startBroker(broker.port);
  const device = mqtt.connect(url, { clientId: 'gh1-s01' });
  const got = [];
  device.on('message', (topic, payload) => got.push(JSON.parse(payload.toString())));
  await new Promise((r) => device.once('connect', r));
  await new Promise((r) => device.subscribe('greenhouse/gh1-s01/commands', { qos: 1 }, r));
  await until(() => channel.connected(), 5000);
  await app.commands.dispatchPending();
  assert.equal((await request(app).get(res.headers.location)).body.status, 'sent');
  await until(() => got.length === 1);
  assert.equal(got[0].id, res.body.id);
  await new Promise((r) => device.end(false, {}, r));
  await channel.close();
  await broker.stop();
});
