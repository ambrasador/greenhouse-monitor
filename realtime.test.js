'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: connect } = require('socket.io-client');
const { makeDb, addDevice } = require('./testkit');
const { createFeed } = require('./feed');
const { attachRealtime } = require('./realtime');

const R = (device, value, n = 0, metric = 'temperature') =>
  ({ device, metric, value, ts: new Date(Date.UTC(2026, 10, 4, 12, 0, n)).toISOString() });

async function start({ windowMs = 20, ...options } = {}) {
  const db = makeDb();
  addDevice(db, 'gh1-s01', 'north');
  addDevice(db, 'gh1-s02', 'north');
  addDevice(db, 'gh2-s01', 'south');
  const feed = createFeed({ windowMs });
  const server = http.createServer();
  const rt = attachRealtime(server, { db, feed, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  const client = async (opts = {}) => {
    const s = connect(url, { transports: ['websocket'], reconnection: false, ...opts });
    clients.push(s);
    await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
    return s;
  };
  const stop = async () => { clients.forEach((c) => c.close()); await rt.close(); };
  return { db, feed, rt, url, client, stop, server };
}
const sub = (s, req) => new Promise((r) => s.emit('subscribe', req, r));
const nextEvent = (s, name = 'telemetry:update', ms = 1000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`немає події ${name}`)), ms);
  s.once(name, (...a) => { clearTimeout(t); res(a[0]); });
});
const silent = (s, ms = 120) => new Promise((res, rej) => {
  const f = () => rej(new Error('отримано зайву подію'));
  s.once('telemetry:update', f);
  setTimeout(() => { s.off('telemetry:update', f); res(); }, ms);
});

test('підписка на пристрій: ack після join, подія приходить лише підписаному', async () => {
  const t = await start();
  const a = await t.client();
  const b = await t.client();
  assert.deepEqual(await sub(a, { device: 'gh1-s01' }), { ok: true });
  assert.deepEqual(await sub(b, { device: 'gh2-s01' }), { ok: true });
  const got = nextEvent(a);
  const other = silent(b);
  t.feed.publish(R('gh1-s01', 21.5, 1));
  assert.deepEqual(await got, { device: 'gh1-s01',
    readings: [{ metric: 'temperature', ts: R('x', 0, 1).ts, value: 21.5 }] });
  await other;
  await t.stop();
});

test('помилки підписки: некоректне ім’я та невідомий пристрій чи зона', async () => {
  const t = await start();
  const a = await t.client();
  assert.deepEqual(await sub(a, { device: '../etc' }), { ok: false, error: 'bad_name' });
  assert.deepEqual(await sub(a, { device: 42 }), { ok: false, error: 'bad_name' });
  assert.deepEqual(await sub(a, { device: 'nope' }), { ok: false, error: 'unknown' });
  assert.deepEqual(await sub(a, { zone: 'nowhere' }), { ok: false, error: 'unknown' });
  assert.deepEqual(await sub(a, undefined), { ok: false, error: 'bad_name' });
  await t.stop();
});

test('на одне з’єднання припадає не більше 20 підписок', async () => {
  const t = await start();
  for (let i = 0; i < 25; i++) addDevice(t.db, `n${i}`, 'east');
  const a = await t.client();
  const results = [];
  for (let i = 0; i < 22; i++) results.push((await sub(a, { device: `n${i}` })));
  assert.equal(results.filter((r) => r.ok).length, 20);
  assert.deepEqual(results[20], { ok: false, error: 'too_many_rooms' });
  await t.stop();
});

test('кімната зони доставляє всі пристрої зони; клієнт у двох кімнатах отримує кадр один раз', async () => {
  const t = await start();
  const zone = await t.client();
  const both = await t.client();
  await sub(zone, { zone: 'north' });
  await sub(both, { zone: 'north' });
  await sub(both, { device: 'gh1-s01' });
  const frames = [];
  both.on('telemetry:update', (f) => frames.push(f));
  const z = nextEvent(zone);
  t.feed.publish(R('gh1-s01', 1, 1));
  assert.equal((await z).device, 'gh1-s01');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(frames.length, 1);              // union кімнат, а не два кадри
  const z2 = nextEvent(zone);
  t.feed.publish(R('gh1-s02', 2, 2));
  assert.equal((await z2).device, 'gh1-s02');
  await t.stop();
});

test('пакетування: 50 вимірювань за вікно — один кадр на пристрій', async () => {
  const t = await start({ windowMs: 50 });
  const a = await t.client();
  await sub(a, { device: 'gh1-s01' });
  const frames = [];
  a.on('telemetry:update', (f) => frames.push(f));
  for (let i = 0; i < 50; i++) t.feed.publish(R('gh1-s01', i, i));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].readings.length, 50);
  assert.deepEqual(frames[0].readings.map((r) => r.value), [...Array(50).keys()]);
  await t.stop();
});

test('connectionStateRecovery: після обриву на кілька секунд клієнт отримує пропущене', async () => {
  const t = await start({ recoveryMs: 120_000 });
  const a = await t.client({ reconnection: true, reconnectionDelay: 50, reconnectionDelayMax: 100 });
  await sub(a, { device: 'gh1-s01' });
  const frames = [];
  a.on('telemetry:update', (f) => frames.push(f));
  const first = nextEvent(a);
  t.feed.publish(R('gh1-s01', 1, 1));
  await first;                                   // клієнт отримав зсув (offset)
  a.io.engine.close();                           // обрив транспорту без закриття сокета
  await new Promise((r) => setTimeout(r, 20));
  t.feed.publish(R('gh1-s01', 2, 2));
  t.feed.flush();                                // подія в момент, коли клієнта немає
  const back = new Promise((r) => a.once('connect', r));
  await back;
  assert.equal(a.recovered, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(frames.flatMap((f) => f.readings.map((x) => x.value)), [1, 2]);
  await t.stop();
});

test('після перезапуску сервера recovered = false: стан кімнат втрачено', async () => {
  const t = await start({ recoveryMs: 120_000 });
  const a = await t.client({ reconnection: true, reconnectionDelay: 50, reconnectionDelayMax: 100 });
  await sub(a, { device: 'gh1-s01' });
  const first = nextEvent(a);
  t.feed.publish(R('gh1-s01', 1, 1));
  await first;
  const port = t.server.address().port;
  await t.rt.close();
  await new Promise((r) => setTimeout(r, 100));
  // новий екземпляр на тому самому порту: пам’ять сесій порожня
  const db = makeDb();
  addDevice(db, 'gh1-s01', 'north');
  const feed = createFeed({ windowMs: 20 });
  const server = http.createServer();
  const rt = attachRealtime(server, { db, feed, recoveryMs: 120_000 });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  await new Promise((r) => a.once('connect', r));
  assert.equal(a.recovered, false);
  const quiet = silent(a, 150);                  // кімнати немає: подія не прийде
  feed.publish(R('gh1-s01', 2, 2));
  await quiet;
  assert.deepEqual(await sub(a, { device: 'gh1-s01' }), { ok: true });
  a.close();
  await rt.close();
});

test('за замовчуванням відновлення вимкнено: після обриву recovered = false', async () => {
  const t = await start();
  const a = await t.client({ reconnection: true, reconnectionDelay: 50, reconnectionDelayMax: 100 });
  await sub(a, { device: 'gh1-s01' });
  a.io.engine.close();
  await new Promise((r) => a.once('connect', r));
  assert.ok(!a.recovered);                       // сервер не повідомляє pid: undefined
  const quiet = silent(a, 150);                  // кімнат немає: події не прийдуть
  t.feed.publish(R('gh1-s01', 3, 3));
  await quiet;
  assert.deepEqual(await sub(a, { device: 'gh1-s01' }), { ok: true });
  await t.stop();
});

test('клієнт, що перестав читати, відключається, коли черга перевищує maxQueue', async () => {
  const t = await start({ maxQueue: 5, sweepMs: 20 });
  const reasons = [];
  t.rt.io.on('connection', (sock) => sock.on('disconnect', (why) => reasons.push(why)));
  const slow = await t.client();
  const ok = await t.client();
  await sub(slow, { device: 'gh1-s01' });
  await sub(ok, { device: 'gh1-s01' });
  slow.io.engine.transport.ws._socket.pause();   // клієнт перестав читати з сокета
  const got = [];
  ok.on('telemetry:update', (f) => got.push(f.readings.length));
  const big = 'x'.repeat(200_000);
  for (let i = 0; i < 80 && reasons.length === 0; i++) {
    t.feed.publish({ ...R('gh1-s01', 1, i), value: big });
    t.feed.flush();
    await new Promise((r) => setTimeout(r, 10));
  }
  for (let i = 0; i < 50 && reasons.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(reasons, ['forced close']);   // відключено рівно одного
  assert.equal(t.rt.io.engine.clientsCount, 1);  // черга звільнена, не лише «відключено»
  assert.equal(ok.connected, true);              // справний клієнт не постраждав
  assert.ok(got.length > 5);                     // і далі отримує кадри
  slow.io.engine.transport.ws._socket.destroy(); // ws чекав би на закриття ще 30 с
  await t.stop();
});
