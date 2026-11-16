'use strict';
// Стенд розділу 6: сервер розділів 2–5 з увімкненою безпекою на базі в пам’яті.
// Параметри scrypt занижено лише тут, щоб тести йшли секунди
const fs = require('node:fs');
const request = require('supertest');
const { makeMobileDb } = require('./mobile-kit');
const { addDevice, seed } = require('./testkit');
const { createServer } = require('./server');
const { createFeed } = require('./feed');
const { createAudit } = require('./audit');
const { createTokens } = require('./tokens');
const { createRefresh } = require('./refresh');
const { createPasswordService } = require('./passwords');
const { createUsers } = require('./users');
const { createAuth } = require('./auth');
const { createClaimCodes } = require('./claim-codes');
const { createVerifier, webhookAuth } = require('./webhook-sign');
const { endPushSessions } = require('./mobile-api');

const NOW = Date.parse('2026-11-05T09:00:00Z');
const PASSWORD = 'correct horse battery';
const KEYS = { k1: Buffer.alloc(32, 'k1-test-key'), k2: Buffer.alloc(32, 'k2-test-key') };
const WEBHOOK_SECRET = 'whsec-test-secret-0123456789abcdefgh';
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const OPEN_LIMITS = { ip: { rate: 1e6, burst: 1e6 }, user: { rate: 1e6, burst: 1e6 } };
// ім’я, роль, область доступу
const USERS = [
  ['root', 'admin', []],
  ['agro', 'operator', ['*']],
  ['north', 'operator', ['zone:north']],
  ['viewer', 'viewer', ['zone:north']],
  ['guest', 'viewer', []],
];

function fakeClock(start = NOW) {
  const clock = () => clock.now;
  clock.now = start;
  clock.tick = (ms) => { clock.now += ms; };
  return clock;
}

// Складові безпеки над готовою базою: спільні для тестового стенда й стенда мобільного клієнта
async function makeSecurity({ db, clock, accessTtlSec = 900, refreshTtlSec, leewaySec,
  limits = OPEN_LIMITS, slots, params = FAST, users = USERS, password = PASSWORD }) {
  db.exec(fs.readFileSync(`${__dirname}/schema-auth.sql`, 'utf8'));
  const audit = createAudit({ db, clock });
  const tokens = createTokens({ keys: KEYS, current: 'k1', accessTtlSec, clock });
  const refresh = createRefresh({ db, clock, onEnd: endPushSessions(db), ttlSec: refreshTtlSec, leewaySec, audit });
  const passwords = createPasswordService({ params });
  const auth = createAuth({ db, tokens, refresh, passwords, audit, clock, limits, slots });
  const usersApi = createUsers({ db, passwords, refresh, clock });
  const verifier = createVerifier({ secrets: [WEBHOOK_SECRET], clock });
  const claimCodes = createClaimCodes({ db, clock });
  const ids = {};
  for (const [username, role, grants] of users) {
    ids[username] = await usersApi.create({ username, password, role, grants });
  }
  return { audit, tokens, refresh, passwords, auth, users: usersApi, verifier, claimCodes, ids,
    server: { auth, ingestAuth: webhookAuth({ verifier, audit }), allowDevice: (id) => /^gh1-/.test(id),
      mobile: { claimCodes, onClaim: (user, id) => usersApi.grant(user, `device:${id}`) } } };
}

async function makeSecure({ clock = fakeClock(), feed = createFeed(), sse, apiLimits, ...security } = {}) {
  const db = makeMobileDb();
  for (const [id, zone] of [['gh1-s01', 'north'], ['gh1-s02', 'south'], ['gh1-new', 'north']]) addDevice(db, id, zone);
  for (const device of ['gh1-s01', 'gh1-s02']) {
    seed(db, { device, start: NOW - 3_600_000, count: 60, values: () => 21 });
  }
  const parts = await makeSecurity({ db, clock, ...security });
  const { audit, tokens, refresh, passwords, auth, users: usersApi, verifier, claimCodes, ids } = parts;
  const app = createServer({ db, state: { mqttConnected: true, lastReadingAt: null }, feed, sse,
    sink: { async send() {} }, clock, ...parts.server,
    limits: apiLimits ?? { rate: 1e6, burst: 1e6, ingest: { rate: 1e6, burst: 1e6 } } });

  const login = (username, password = PASSWORD) => request(app)
    .post('/api/v1/auth/login').send({ username, password });
  // Обгортка запитів від імені користувача
  async function as(username) {
    const r = await login(username);
    if (r.status !== 200) throw new Error(`вхід ${username}: ${r.status} ${JSON.stringify(r.body)}`);
    const headers = { Authorization: `Bearer ${r.body.access_token}` };
    const call = (method) => (url) => request(app)[method](url).set(headers);
    return { headers, tokens: r.body, get: call('get'), post: call('post'), put: call('put'),
      delete: call('delete') };
  }
  return { app, db, clock, auth, tokens, refresh, audit, passwords, users: usersApi, claimCodes,
    verifier, feed, ids, login, as, request: () => request(app) };
}

// Справжній HTTP-сервер для потоків: supertest не вміє читати нескінченну відповідь
async function serve(app) {
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const stop = () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); };
  return { base: `http://127.0.0.1:${server.address().port}`, stop };
}

// Відкриває SSE і збирає назви подій; для не-200 повертає розібране тіло Problem
async function openStream(url, headers = {}) {
  const ctl = new AbortController();
  const res = await fetch(url, { headers, signal: ctl.signal });
  const out = { status: res.status, headers: res.headers, events: [], ended: false, ctl,
    close: () => ctl.abort() };
  if (res.status !== 200) {
    out.body = await res.json().catch(() => null);
    return out;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
          const m = /^event: (\w+)/m.exec(buf.slice(0, i));
          if (m) out.events.push(m[1]);
        }
      }
    } catch { /* обрив з нашого боку */ }
    out.ended = true;
  })();
  out.waitFor = async (pred, ms = 2000) => {
    for (let t = 0; t < ms && !pred(out); t += 10) await new Promise((r) => setTimeout(r, 10));
    return pred(out);
  };
  return out;
}

// Маршрути застосунку з позначками дій (guard.action); ключ — «метод шлях» у стилі OpenAPI
function routesOf(app) {
  const out = [];
  const add = (route, prefix) => {
    const action = route.stack.map((l) => l.handle.action).find(Boolean);
    for (const m of Object.keys(route.methods)) {
      out.push({ key: `${m} ${(prefix + route.path).replace(/:(\w+)/g, '{$1}')}`, action });
    }
  };
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) add(layer.route, '');
      else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  for (const layer of app.router.stack) {
    if (layer.handle?.stack) walk(layer.handle.stack);
    else if (layer.route?.path.startsWith('/api/v1/')) add(layer.route, '');
  }
  return out.map((r) => ({ ...r, key: r.key.replace('/api/v1', '') }));
}

module.exports = { makeSecure, makeSecurity, serve, openStream, routesOf, fakeClock, NOW, PASSWORD, KEYS, WEBHOOK_SECRET, FAST, USERS, OPEN_LIMITS };
