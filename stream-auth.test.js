'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: connect } = require('socket.io-client');
const { makeSecure, openStream } = require('./auth-kit');
const { attachRealtime } = require('./realtime');

// Один HTTP-сервер для REST, SSE і Socket.IO — як у main.js
async function start({ rt = {}, ...opts } = {}) {
  const s = await makeSecure(opts);
  const server = http.createServer(s.app);
  const realtime = attachRealtime(server, { db: s.db, feed: s.feed, auth: s.auth, clock: s.clock, ...rt });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  const client = (token, extra = {}) => new Promise((res, rej) => {
    const c = connect(base, { transports: ['websocket'], reconnection: false,
      auth: token === undefined ? {} : { token }, ...extra });
    sockets.push(c);
    c.once('connect', () => res(c));
    c.once('connect_error', rej);
  });
  const stop = async () => {
    sockets.forEach((c) => c.close());
    server.closeAllConnections();
    await realtime.close();
  };
  return { ...s, base, client, stop };
}
const ticketFor = async (t, user, device) =>
  (await (await t.as(user)).post(`/api/v1/devices/${device}/stream-ticket`)).body.ticket;
const sub = (c, req) => new Promise((r) => c.emit('subscribe', req, r));
const gone = (c, ms = 2000) => new Promise((res) => {
  if (c.disconnected) return res('already');
  const t = setTimeout(() => res(null), ms);
  c.once('disconnect', (why) => { clearTimeout(t); res(why); });
});
const reading = (device, n = 0) => ({ device, metric: 'temperature', value: 20 + n,
  ts: new Date(Date.UTC(2026, 10, 5, 8, 0, n)).toISOString() });

test('SSE: квиток відкриває потік свого пристрою, і лише його', async () => {
  const t = await start();
  const north = await t.as('north');
  const r = await north.post('/api/v1/devices/gh1-s01/stream-ticket');
  assert.equal(r.status, 200);
  assert.equal(r.body.expires_in, 30);
  assert.equal(r.headers['cache-control'], 'no-store');
  const ok = await openStream(`${t.base}/api/v1/devices/gh1-s01/stream?ticket=${r.body.ticket}`);
  assert.equal(ok.status, 200);
  assert.ok(await ok.waitFor((o) => o.events.includes('ready')));
  ok.close();
  const other = await openStream(`${t.base}/api/v1/devices/gh1-new/stream?ticket=${r.body.ticket}`);
  assert.equal(other.status, 401, 'квиток прив’язано до пристрою');
  assert.match(other.body.type, /invalid-token$/);
  await t.stop();
});

test('SSE: квиток і токен доступу не взаємозамінні', async () => {
  const t = await start();
  const north = await t.as('north');
  const ticket = await ticketFor(t, 'north', 'gh1-s01');
  const rest = await t.request().get('/api/v1/devices').set('Authorization', `Bearer ${ticket}`);
  assert.equal(rest.status, 401, 'квиток не відкриває REST');
  const access = north.headers.Authorization.slice(7);
  const stream = await openStream(`${t.base}/api/v1/devices/gh1-s01/stream?ticket=${access}`);
  assert.equal(stream.status, 401, 'токен доступу в URL не приймається');
  await t.stop();
});

test('SSE: квиток живе 30 с; токен доступу в заголовку теж відкриває потік', async () => {
  const t = await start();
  const north = await t.as('north');
  const ticket = await ticketFor(t, 'north', 'gh1-s01');
  t.clock.tick(31_000);
  const late = await openStream(`${t.base}/api/v1/devices/gh1-s01/stream?ticket=${ticket}`);
  assert.equal(late.status, 401);
  assert.match(late.body.type, /token-expired$/);
  const fresh = await t.as('north');                       // новий вхід: токен доступу ще чинний
  const viaHeader = await openStream(`${t.base}/api/v1/devices/gh1-s01/stream`, fresh.headers);
  assert.equal(viaHeader.status, 200);
  viaHeader.close();
  assert.ok(north);
  await t.stop();
});

test('SSE: чужий пристрій — 404, без токена — 401, спостерігач потік бачить', async () => {
  const t = await start();
  const north = await t.as('north');
  const foreign = await openStream(`${t.base}/api/v1/devices/gh1-s02/stream`, north.headers);
  const missing = await openStream(`${t.base}/api/v1/devices/gh1-nope/stream`, north.headers);
  assert.deepEqual([foreign.status, missing.status], [404, 404]);
  assert.equal(foreign.body.type, missing.body.type);
  assert.equal((await openStream(`${t.base}/api/v1/devices/gh1-s01/stream`)).status, 401);
  const viewer = await t.as('viewer');
  const own = await openStream(`${t.base}/api/v1/devices/gh1-s01/stream`, viewer.headers);
  assert.equal(own.status, 200);
  own.close();
  await t.stop();
});

test('SSE: квиток вимкненого користувача не діє', async () => {
  const t = await start();
  const ticket = await ticketFor(t, 'north', 'gh1-s01');
  t.users.disable(t.ids.north);
  const r = await openStream(`${t.base}/api/v1/devices/gh1-s01/stream?ticket=${ticket}`);
  assert.equal(r.status, 401);
  assert.match(r.body.type, /token-revoked$/);
  await t.stop();
});

test('SSE: відкритий потік закривається, коли обліковий запис вимкнено', async () => {
  const t = await start({ sse: { heartbeatMs: 30 } });
  const north = await t.as('north');
  const s = await openStream(`${t.base}/api/v1/devices/gh1-s01/stream`, north.headers);
  assert.ok(await s.waitFor((o) => o.events.includes('ready')));
  assert.ok(await s.waitFor((o) => o.events.includes('hb')), 'поки обліковий запис чинний, hb ідуть');
  assert.equal(s.ended, false);
  t.users.disable(t.ids.north);
  assert.ok(await s.waitFor((o) => o.ended), 'потік закрито за наступним hb');
  await t.stop();
});

test('SSE: зняття права на пристрій закриває відкритий потік, а новий вхід його не відновлює', async () => {
  const t = await start({ sse: { heartbeatMs: 30 } });
  const north = await t.as('north');
  const s = await openStream(`${t.base}/api/v1/devices/gh1-s01/stream`, north.headers);
  assert.ok(await s.waitFor((o) => o.events.includes('hb')), 'поки право є, hb ідуть');
  t.users.revoke(t.ids.north, 'zone:north');
  assert.ok(await s.waitFor((o) => o.ended), 'потік закрито за наступним hb');
  const refreshed = await t.request().post('/api/v1/auth/refresh').send({ refresh_token: north.tokens.refresh_token });
  assert.equal(refreshed.status, 200, 'сеанс живий, змінилося лише право');
  const again = await openStream(`${t.base}/api/v1/devices/gh1-s01/stream`,
    { Authorization: `Bearer ${refreshed.body.access_token}` });
  assert.equal(again.status, 404, 'пристрій поза областю доступу відповідає як неіснуючий');
  await t.stop();
});

test('SSE: ліміт потоків рахується на користувача, а не на IP', async () => {
  const t = await start({ sse: { perClient: 2 } });
  const [north, viewer] = [await t.as('north'), await t.as('viewer')];
  const url = `${t.base}/api/v1/devices/gh1-s01/stream`;
  const open = [await openStream(url, north.headers), await openStream(url, north.headers)];
  assert.deepEqual(open.map((s) => s.status), [200, 200]);
  const third = await openStream(url, north.headers);
  assert.equal(third.status, 429);
  const other = await openStream(url, viewer.headers);
  assert.equal(other.status, 200, 'інший користувач з тієї ж адреси не постраждав');
  [...open, other].forEach((s) => s.close());
  await t.stop();
});

test('SSE: maxLifetimeMs закриває потік, щоб клієнт отримав новий токен', async () => {
  const t = await start({ sse: { maxLifetimeMs: 120 } });
  const north = await t.as('north');
  const s = await openStream(`${t.base}/api/v1/devices/gh1-s01/stream`, north.headers);
  assert.ok(await s.waitFor((o) => o.events.includes('ready')));
  assert.ok(await s.waitFor((o) => o.ended, 1500));
  await t.stop();
});

test('Socket.IO: без токена, з хибним, простроченим і квитком підключення відхилено з кодом', async () => {
  const t = await start();
  const reject = (token) => t.client(token).then(() => assert.fail('підключилися'), (e) => [e.message, e.data?.code]);
  assert.deepEqual(await reject(undefined), ['unauthorized', 'unauthorized']);
  assert.deepEqual(await reject('abc.def.ghi'), ['unauthorized', 'invalid-token']);
  assert.deepEqual(await reject(await ticketFor(t, 'north', 'gh1-s01')), ['unauthorized', 'invalid-token']);
  const { tokens } = await t.as('north');
  t.clock.tick(901_000);
  assert.deepEqual(await reject(tokens.access_token), ['unauthorized', 'token-expired']);
  await t.stop();
});

test('Socket.IO: чужа кімната відповідає як неіснуюча, власна працює', async () => {
  const t = await start({ rt: { revalidateMs: 60_000 } });
  const { tokens } = await t.as('north');
  const c = await t.client(tokens.access_token);
  assert.deepEqual(await sub(c, { device: 'gh1-s01' }), { ok: true });
  assert.deepEqual(await sub(c, { zone: 'north' }), { ok: true });
  const unknown = { ok: false, error: 'unknown' };
  assert.deepEqual(await sub(c, { device: 'gh1-s02' }), unknown, 'чужий пристрій');
  assert.deepEqual(await sub(c, { device: 'gh1-nope' }), unknown, 'неіснуючий пристрій');
  assert.deepEqual(await sub(c, { zone: 'south' }), unknown, 'чужа зона');
  assert.deepEqual(await sub(c, { zone: 'nowhere' }), unknown, 'неіснуюча зона');
  const got = [];
  c.on('telemetry:update', (m) => got.push(m.device));
  t.feed.publish(reading('gh1-s02'));
  t.feed.publish(reading('gh1-s01', 1));
  t.feed.flush();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(got, ['gh1-s01']);
  await t.stop();
});

test('Socket.IO: спостерігач підключається; гість без прав бачить порожній світ', async () => {
  const t = await start();
  const viewer = await t.client((await t.as('viewer')).tokens.access_token);
  assert.deepEqual(await sub(viewer, { device: 'gh1-s01' }), { ok: true });
  const guest = await t.client((await t.as('guest')).tokens.access_token);
  assert.deepEqual(await sub(guest, { device: 'gh1-s01' }), { ok: false, error: 'unknown' });
  await t.stop();
});

test('Socket.IO: вимкнення облікового запису розриває відкрите з’єднання', async () => {
  const t = await start({ rt: { revalidateMs: 40 } });
  const c = await t.client((await t.as('north')).tokens.access_token);
  assert.equal(await gone(c, 150), null, 'поки запис чинний, з’єднання живе');
  t.users.disable(t.ids.north);
  assert.equal(await gone(c), 'io server disconnect');
  await t.stop();
});

test('Socket.IO: зняття права закриває з’єднання з кімнатами, що вже приєднані', async () => {
  const t = await start({ rt: { revalidateMs: 40 } });
  const c = await t.client((await t.as('north')).tokens.access_token);
  assert.deepEqual(await sub(c, { device: 'gh1-s01' }), { ok: true });
  t.users.revoke(t.ids.north, 'zone:north');
  assert.equal(await gone(c), 'io server disconnect');
  await t.stop();
});

test('Socket.IO: з’єднання закривається в мить закінчення токена', async () => {
  const t = await start({ accessTtlSec: 1, rt: { revalidateMs: 60_000 } });
  const c = await t.client((await t.as('north')).tokens.access_token);
  const t0 = Date.now();
  assert.equal(await gone(c, 3000), 'io server disconnect');
  const waited = Date.now() - t0;
  assert.ok(waited > 600 && waited < 1600, `${waited} мс`);
  await t.stop();
});

test('Socket.IO: Origin поза списком відхиляється, рідний клієнт без Origin проходить', async () => {
  const t = await start({ rt: { origins: ['https://app.example'], revalidateMs: 60_000 } });
  const { tokens } = await t.as('north');
  const token = tokens.access_token;
  await assert.rejects(t.client(token, { extraHeaders: { Origin: 'https://evil.example' } }));
  const web = await t.client(token, { extraHeaders: { Origin: 'https://app.example' } });
  const native = await t.client(token);
  assert.ok(web.connected && native.connected);
  await t.stop();
});

test('Socket.IO: порожній список Origin відхиляє будь-який браузер, рідний клієнт без Origin проходить', async () => {
  const t = await start({ rt: { origins: [], revalidateMs: 60_000 } });
  const { tokens } = await t.as('north');
  await assert.rejects(t.client(tokens.access_token, { extraHeaders: { Origin: 'https://app.example' } }));
  assert.ok((await t.client(tokens.access_token)).connected);
  await t.stop();
});
