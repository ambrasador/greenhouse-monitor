import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createSession, SessionExpired } from './session.js';
import { socketIoTransport, sseTransport } from './transports.js';

const require = createRequire(import.meta.url);

// ---- службові засоби ----
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } });
const tokenPair = (n, expires_in = 900) => ({ token_type: 'Bearer', access_token: `access-${n}`,
  refresh_token: `refresh-token-number-${n}`, expires_in });
const problem = (kind, status = 401) => json(status, { type: `https://greenhouse.example/problems/${kind}`, title: kind, status });
function clock(start = 1_000_000) {
  const now = () => now.t;
  now.t = start;
  return now;
}
// Умовний сервер: lastRefresh рахує обміни, valid — які токени доступу він ще приймає
function fakeServer() {
  const srv = { calls: [], refreshes: 0, valid: new Set(), n: 0, refreshStatus: 200, refreshDelay: 0 };
  const issue = () => { srv.n += 1; srv.valid.add(`access-${srv.n}`); return tokenPair(srv.n); };
  srv.fetch = async (url, init = {}) => {
    const path = new URL(url, 'http://x').pathname.replace('/api/v1', '');
    srv.calls.push({ path, auth: init.headers?.Authorization });
    if (path === '/auth/login') return json(200, issue());
    if (path === '/auth/logout') return new Response(null, { status: 204 });
    if (path === '/auth/refresh') {
      srv.refreshes += 1;
      if (srv.refreshDelay) await new Promise((r) => setTimeout(r, srv.refreshDelay));
      if (srv.refreshStatus === 200) return json(200, issue());
      if (srv.refreshStatus === 'network') throw new TypeError('Failed to fetch');
      return problem('invalid-grant', srv.refreshStatus);
    }
    const token = init.headers?.Authorization?.slice(7);
    if (!srv.valid.has(token)) return problem('token-expired');
    if (path.endsWith('/stream-ticket')) return json(200, { ticket: 't1', expires_in: 30 });
    return json(200, { ok: true });
  };
  return srv;
}
const make = (srv, extra = {}) => createSession({ fetchFn: srv.fetch, now: extra.now ?? clock(), ...extra });

// ---- сеанс ----
test('вхід зберігає пару; 401 і 429 стають HttpError з Retry-After', async () => {
  const srv = fakeServer();
  const s = make(srv);
  assert.equal(s.signedIn(), false);
  await s.login('agro', 'secret');
  assert.equal(s.signedIn(), true);
  const bad = createSession({ fetchFn: async () => json(429, {}, { 'Retry-After': '7' }) });
  await assert.rejects(bad.login('a', 'b'), (e) => e.status === 429 && e.retryAfterMs === 7000);
});

test('токен, що спливає за мить, оновлюється до запиту, а не після 401', async () => {
  const now = clock();
  const srv = fakeServer();
  const s = make(srv, { now });
  await s.login('agro', 'secret');
  now.t += 880_000;                                           // до кінця лишилося 20 с < 30 с
  const r = await s.authFetch('/api/v1/devices');
  assert.equal(r.status, 200);
  assert.equal(srv.refreshes, 1);
  assert.equal(srv.calls.filter((c) => c.path === '/devices').length, 1, 'жодного зайвого запиту з простроченим токеном');
});

test('п’ять паралельних запитів — один обмін refresh-токена', async () => {
  const now = clock();
  const srv = fakeServer();
  srv.refreshDelay = 20;
  const s = make(srv, { now });
  await s.login('agro', 'secret');
  now.t += 899_000;
  const all = await Promise.all(Array.from({ length: 5 }, () => s.authFetch('/api/v1/devices')));
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(srv.refreshes, 1);
});

test('401 «токен прострочено» (годинники розійшлися): один обмін і один повтор', async () => {
  const srv = fakeServer();
  const s = make(srv);
  await s.login('agro', 'secret');
  srv.valid.clear();                                          // сервер уже не визнає токена
  const r = await s.authFetch('/api/v1/devices');
  assert.equal(r.status, 200);
  assert.equal(srv.refreshes, 1);
  const sent = srv.calls.filter((c) => c.path === '/devices').map((c) => c.auth);
  assert.deepEqual(sent, ['Bearer access-1', 'Bearer access-2']);
});

test('повторна 401 після оновлення віддається як є, без циклу', async () => {
  const srv = fakeServer();
  const s = createSession({ now: clock(), fetchFn: (url, init) => (url.endsWith('/devices')
    ? Promise.resolve(problem('token-revoked')) : srv.fetch(url, init)) });
  await s.login('agro', 'secret');
  const r = await s.authFetch('/api/v1/devices');
  assert.equal(r.status, 401);
  assert.equal(srv.refreshes, 1, 'один обмін, а не нескінченний цикл');
});

test('401 з іншої причини (не токен) не запускає обмін', async () => {
  const srv = fakeServer();
  const s = createSession({ fetchFn: async (url, init) => (url.endsWith('/x')
    ? problem('invalid-signature') : srv.fetch(url, init)), now: clock() });
  await s.login('agro', 'secret');
  assert.equal((await s.authFetch('/x')).status, 401);
  assert.equal(srv.refreshes, 0);
});

test('запит, що дістав 401 зі старим токеном уже після обміну, нового обміну не робить', async () => {
  const srv = fakeServer();
  srv.refreshDelay = 10;
  const orig = srv.fetch;
  // токен 1 відхиляється: перший запит одразу, другий — через 40 мс, коли пару вже оновлено
  srv.fetch = async (url, init = {}) => {
    if (init.headers?.Authorization === 'Bearer access-1' && url.endsWith('/slow')) {
      await new Promise((r) => setTimeout(r, 40));
      return problem('token-expired');
    }
    if (init.headers?.Authorization === 'Bearer access-1' && url.endsWith('/fast')) return problem('token-expired');
    return orig(url, init);
  };
  const s = createSession({ now: clock(), fetchFn: (...a) => srv.fetch(...a) });
  await s.login('agro', 'secret');
  const [fast, slow] = await Promise.all([s.authFetch('/api/v1/fast'), s.authFetch('/api/v1/slow')]);
  assert.deepEqual([fast.status, slow.status], [200, 200]);
  assert.equal(srv.refreshes, 1, 'обмін зробив лише перший із двох');
});

test('refresh відхилено (invalid-grant): сеанс завершено один раз, запити більше не йдуть', async () => {
  const srv = fakeServer();
  let out = 0;
  const s = make(srv, { onSignedOut: () => { out += 1; } });
  await s.login('agro', 'secret');
  srv.valid.clear();
  srv.refreshStatus = 401;
  await assert.rejects(s.authFetch('/api/v1/devices'), SessionExpired);
  assert.deepEqual([s.signedIn(), out], [false, 1]);
  const before = srv.calls.length;
  await assert.rejects(s.authFetch('/api/v1/devices'), SessionExpired);
  assert.equal(srv.calls.length, before, 'без токена мережу не чіпаємо');
  assert.equal(out, 1);
});

test('збій мережі чи 503 під час обміну не розлогінює: токени лишаються', async () => {
  const srv = fakeServer();
  const s = make(srv);
  await s.login('agro', 'secret');
  srv.valid.clear();
  srv.refreshStatus = 'network';
  await assert.rejects(s.authFetch('/api/v1/devices'), TypeError);
  srv.refreshStatus = 503;
  await assert.rejects(s.authFetch('/api/v1/devices'), (e) => e.status === 503);
  assert.equal(s.signedIn(), true);
  srv.refreshStatus = 200;
  assert.equal((await s.authFetch('/api/v1/devices')).status, 200, 'мережа повернулась: усе працює');
});

test('вихід очищує локально навіть без мережі й надсилає refresh-токен', async () => {
  const srv = fakeServer();
  const s = make(srv);
  await s.login('agro', 'secret');
  await s.logout();
  assert.equal(s.signedIn(), false);
  assert.ok(srv.calls.some((c) => c.path === '/auth/logout'));
  const offline = createSession({ fetchFn: async (url) => {
    if (url.endsWith('/auth/login')) return json(200, tokenPair(1));
    throw new TypeError('offline');
  }, now: clock() });
  await offline.login('a', 'b');
  await offline.logout();
  assert.equal(offline.signedIn(), false);
});

test('квиток потоку запитується з токеном', async () => {
  const srv = fakeServer();
  const s = make(srv);
  await s.login('agro', 'secret');
  assert.equal(await s.streamTicket('gh1-s01'), 't1');
  assert.equal(srv.calls.at(-1).auth, 'Bearer access-1');
});

// ---- транспорти ----
function fakeSocket() {
  const handlers = {};
  return Object.assign({}, { on: (e, f) => { handlers[e] = f; }, handlers, removeAllListeners() {}, close() {}, timeout: () => ({ emit() {} }) });
}
const feedHandlers = () => { const log = []; return { log, onOpen: () => log.push('open'), onClose: () => log.push('close'),
  onFail: (r) => log.push(`fail:${r}`), onReadings() {}, onGap() {} }; };

test('Socket.IO: токен подається функцією при кожному підключенні', async () => {
  let opts;
  const socket = fakeSocket();
  const t = socketIoTransport({ url: 'http://x', device: 'd', connect: (u, o) => { opts = o; return socket; },
    token: async () => 'fresh-token', renew: async () => {} });
  t.start(feedHandlers());
  assert.equal(typeof opts.auth, 'function');
  assert.deepEqual(await new Promise((r) => opts.auth(r)), { token: 'fresh-token' });
});

test('Socket.IO: відмова через токен → обмін і нова спроба; інша відмова → нова спроба без обміну', async () => {
  const h = feedHandlers();
  const socket = fakeSocket();
  let renewed = 0;
  const t = socketIoTransport({ url: 'http://x', device: 'd', connect: () => socket,
    token: async () => 'x', renew: async () => { renewed += 1; } });
  t.start(h);
  socket.handlers.connect_error(Object.assign(new Error('unauthorized'), { data: { code: 'token-expired' } }));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([renewed, h.log], [1, ['close']]);
  socket.handlers.connect_error(new Error('xhr poll error'));
  assert.deepEqual([renewed, h.log], [1, ['close', 'close']]);
});

test('Socket.IO: обмін не вдався (сеанс завершено) → fail unauthorized, а не нескінченні спроби', async () => {
  const h = feedHandlers();
  const socket = fakeSocket();
  const t = socketIoTransport({ url: 'http://x', device: 'd', connect: () => socket,
    token: async () => 'x', renew: async () => { throw new SessionExpired(); } });
  t.start(h);
  socket.handlers.connect_error(Object.assign(new Error('unauthorized'), { data: { code: 'token-revoked' } }));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(h.log, ['fail:unauthorized']);
});

test('SSE: квиток іде в ?ticket=; stop до його надходження потік не створює', async () => {
  const urls = [];
  const es = () => ({ addEventListener() {}, close() {}, readyState: 1 });
  const t = sseTransport({ url: 'http://x', device: 'gh1-s01', metrics: ['temperature'],
    make: (u) => { urls.push(u); return es(); }, ticket: async () => 'a b+c' });
  t.start(feedHandlers());
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(urls, ['http://x/api/v1/devices/gh1-s01/stream?metrics=temperature&ticket=a%20b%2Bc']);
  t.stop();
  const late = sseTransport({ url: 'http://x', device: 'd', metrics: ['t'], make: (u) => { urls.push(u); return es(); },
    ticket: () => new Promise((r) => setTimeout(() => r('late'), 10)) });
  late.start(feedHandlers());
  late.stop();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(urls.length, 1);
});

test('SSE: без сеансу — fail unauthorized, інша помилка — звичайне перепідключення', async () => {
  const h1 = feedHandlers();
  sseTransport({ url: 'u', device: 'd', metrics: ['t'], make: () => assert.fail('потік не мав відкриватися'),
    ticket: async () => { throw new SessionExpired(); } }).start(h1);
  const h2 = feedHandlers();
  sseTransport({ url: 'u', device: 'd', metrics: ['t'], make: () => assert.fail('потік не мав відкриватися'),
    ticket: async () => { throw new TypeError('offline'); } }).start(h2);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([h1.log, h2.log], [['fail:unauthorized'], ['close']]);
});

// ---- проти справжнього захищеного сервера ----
test('із сервером: вхід, перегляд, розбіжність годинників, квиток потоку, вимкнення', async () => {
  const { makeSecure, serve, openStream } = require('../auth-kit');
  const s = await makeSecure({ accessTtlSec: 900 });
  const web = await serve(s.app);
  try {
    let skew = 0;
    let out = 0;
    const session = createSession({ base: web.base, now: () => s.clock() + skew, onSignedOut: () => { out += 1; } });
    await assert.rejects(session.login('north', 'wrong password!!'), (e) => e.status === 401);
    await session.login('north', 'correct horse battery');
    const list = await (await session.authFetch(`${web.base}/api/v1/devices`)).json();
    assert.deepEqual(list.data.map((d) => d.id), ['gh1-new', 'gh1-s01']);

    skew = -600_000;                                          // клієнт вважає, що токен чинний ще 10 хв
    s.clock.tick(901_000);                                    // а сервер: прострочений
    const again = await session.authFetch(`${web.base}/api/v1/devices`);
    assert.equal(again.status, 200, 'клієнт вирівняв пару сам');

    const ticket = await session.streamTicket('gh1-s01');
    const st = await openStream(`${web.base}/api/v1/devices/gh1-s01/stream?ticket=${ticket}`);
    assert.equal(st.status, 200);
    st.close();

    s.users.disable(s.ids.north);
    await assert.rejects(session.authFetch(`${web.base}/api/v1/devices`), SessionExpired);
    assert.deepEqual([session.signedIn(), out], [false, 1]);
  } finally {
    await web.stop();
  }
});
