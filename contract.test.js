'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const YAML = require('yaml');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const request = require('supertest');
const { makeDb, addDevice, seed, iso } = require('./testkit');
const { createServer } = require('./server');
const { createFeed } = require('./feed');
const { makeSecure, routesOf, PASSWORD } = require('./auth-kit');
const { ACTIONS } = require('./policy');

// Контрактний тест: кожну відповідь API звіряють зі схемою з openapi.yaml
const file = `${__dirname}/openapi.yaml`;
const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
ajv.addSchema(doc, 'api');
const esc = (s) => s.replaceAll('~', '~0').replaceAll('/', '~1');
const unesc = (s) => s.replaceAll('~1', '/').replaceAll('~0', '~');
const at = (ref) =>
  ref.slice(2).split('/').reduce((o, k) => o[unesc(k)], doc);
const covered = new Set();

// Ajv не проходить крізь $ref у середині вказівника,
// тому відповідь розгортаємо самі
function schemaRef(path, method, status, type) {
  let base = `/paths/${esc(path)}/${method}/responses/${status}`;
  let resp = at(`#${base}`);
  if (resp?.$ref) { base = resp.$ref.slice(1); resp = at(resp.$ref); }
  if (!resp?.content?.[type]) return null;
  return `api#${base}/content/${esc(type)}/schema`;
}

function conforms(res, method, path) {
  const type = res.headers['content-type'].split(';')[0];
  const ref = schemaRef(path, method, res.status, type);
  const where = `${method} ${path} → ${res.status} (${type})`;
  assert.ok(ref, `у специфікації немає ${where}`);
  const validate = ajv.compile({ $ref: ref });
  const ok = validate(res.body);
  assert.ok(ok, JSON.stringify(validate.errors?.slice(0, 2)));
  covered.add(`${method} ${path} ${res.status}`);
}

const NOW = Date.parse('2026-11-03T12:00:00Z');
const START = NOW - 6 * 3_600_000;
const db = makeDb();
addDevice(db, 'gh1-s01');
seed(db, { start: START, count: 360, values: (i) => (i >= 100 && i < 130 ? 15 : 21) });
const sink = { async send() {} };
const app = createServer({ db, state: { mqttConnected: true }, sink, clock: () => NOW,
  limits: { rate: 1000, burst: 1000 } });
// Другий екземпляр із шиною подій: лише він має маршрут потоку SSE
const feed = createFeed({ windowMs: 0 });
const live = createServer({ db, state: { mqttConnected: true }, sink, feed, clock: () => NOW,
  limits: { rate: 1000, burst: 1000 } });
const w = { device: 'gh1-s01', metric: 'temperature', from: iso(START), to: iso(NOW) };
const get = (path, params) => request(app).get(`/api/v1${path}?${new URLSearchParams(params)}`);

test('відповіді GET відповідають схемам специфікації', async () => {
  conforms(await get('/devices', {}), 'get', '/devices');
  conforms(await request(app).get('/api/v1/devices/gh1-s01'), 'get', '/devices/{id}');
  conforms(await request(app).get('/api/v1/devices/gh1-s01/latest'), 'get', '/devices/{id}/latest');
  conforms(await get('/telemetry', { ...w, limit: 50 }), 'get', '/telemetry');
  conforms(await get('/telemetry', { ...w, agg: 'avg,min', interval: '1h', fill: 'null' }), 'get', '/telemetry');
  conforms(await get('/alerts', { ...w, op: 'lt', threshold: 18 }), 'get', '/alerts');
  conforms(await request(app).get('/api/v1/devices/gh1-s01/settings'), 'get', '/devices/{id}/settings');
});

test('відповіді про помилки відповідають схемі Problem', async () => {
  conforms(await get('/telemetry', { device: 'gh1-s01' }), 'get', '/telemetry');                       // 400
  conforms(await get('/telemetry', { ...w, device: 'nope' }), 'get', '/telemetry');                    // 404
  conforms(await request(app).get('/api/v1/devices/nope'), 'get', '/devices/{id}');                    // 404
  conforms(await request(app).get('/api/v1/commands/00000000-0000-0000-0000-000000000000'), 'get', '/commands/{id}');
  conforms(await request(app).get('/api/v1/devices/nope/settings'), 'get', '/devices/{id}/settings');   // 404
});

test('POST: webhook і команди відповідають схемам', async () => {
  const hook = await request(app).post('/api/v1/ingest/webhook')
    .send({ events: [{ device_id: 'gh1-s01', metric: 'humidity', value: 55, ts: iso(NOW - 60_000) }] });
  conforms(hook, 'post', '/ingest/webhook');
  const cmd = await request(app).post('/api/v1/devices/gh1-s01/commands').send({ name: 'irrigate', params: { duration_sec: 30 } });
  conforms(cmd, 'post', '/devices/{id}/commands');
  conforms(await request(app).get(`/api/v1/commands/${cmd.body.id}`), 'get', '/commands/{id}');
  conforms(await request(app).post('/api/v1/ingest/webhook').send({ events: [] }), 'post', '/ingest/webhook');   // 400
});

test('PUT налаштувань: 200, 400, 412 і 428 відповідають схемам', async () => {
  const put = (body, ifMatch) => request(app).put('/api/v1/devices/gh1-s01/settings')
    .set(ifMatch ? { 'If-Match': ifMatch } : {}).send(body);
  conforms(await put({ soil_moisture_min: 30 }, '"0"'), 'put', '/devices/{id}/settings');       // 200
  conforms(await put({ soil_moisture_min: 40 }, '"0"'), 'put', '/devices/{id}/settings');       // 412
  conforms(await put({ soil_moisture_min: 40 }), 'put', '/devices/{id}/settings');              // 428
  conforms(await put({ soil_moisture_min: 400 }, '"1"'), 'put', '/devices/{id}/settings');      // 400
});

// Потік SSE не завершується, тож supertest не годиться: перші події читаємо через fetch
const parseEvent = (block) => Object.fromEntries(block.split('\n').map((line) => {
  const k = line.indexOf(': ');
  return [line.slice(0, k), line.slice(k + 2)];
}));

test('потік SSE: події відповідають схемам StreamEvent і StreamReading', async () => {
  const server = await new Promise((r) => { const s = live.listen(0, '127.0.0.1', () => r(s)); });
  const ctl = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/devices/gh1-s01/stream`,
      { signal: ctl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const items = [];
    let buf = '';
    while (!items.some((e) => e.event === 'telemetry')) {
      const { value, done } = await reader.read();
      assert.ok(!done, 'потік закрито до події telemetry');
      buf += dec.decode(value, { stream: true });
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const e = parseEvent(buf.slice(0, i));
        if (e.event === undefined) continue;               // блок лише з retry: це не подія
        items.push(e);
        if (e.event === 'ready') feed.publish({ device: 'gh1-s01', metric: 'temperature', ts: iso(NOW), value: 21.4 });
      }
    }
    const checkItem = ajv.compile({ $ref: 'api#/components/schemas/StreamEvent' });
    const checkReading = ajv.compile({ $ref: 'api#/components/schemas/StreamReading' });
    for (const e of items) {
      assert.ok(checkItem(e), JSON.stringify(checkItem.errors?.slice(0, 2)));
      if (e.event === 'telemetry') assert.ok(checkReading(JSON.parse(e.data)), JSON.stringify(checkReading.errors?.slice(0, 2)));
    }
    assert.deepEqual(items.map((e) => e.event), ['ready', 'telemetry']);
    covered.add('get /devices/{id}/stream 200');
  } finally {
    ctl.abort();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

// Операція без тіла відповіді (204): схеми немає, перевіряємо лише, що статус описано
function bodyless(res, method, path) {
  assert.ok(doc.paths[path][method].responses[String(res.status)], `у специфікації немає ${method} ${path} → ${res.status}`);
  assert.equal(res.text ?? '', '');
  covered.add(`${method} ${path} ${res.status}`);
}

let secure;
test('автентифікація: відповіді входу, оновлення, виходу й профілю відповідають схемам', async () => {
  secure = await makeSecure({ feed: createFeed({ windowMs: 0 }) });
  const login = await secure.login('north');
  conforms(login, 'post', '/auth/login');                                                   // 200, форма RFC 6749
  conforms(await secure.login('north', 'wrong password!!'), 'post', '/auth/login');          // 401
  conforms(await secure.request().post('/api/v1/auth/login').send({}), 'post', '/auth/login');   // 400
  const rf = await secure.request().post('/api/v1/auth/refresh').send({ refresh_token: login.body.refresh_token });
  conforms(rf, 'post', '/auth/refresh');
  conforms(await secure.request().post('/api/v1/auth/refresh').send({ refresh_token: login.body.refresh_token }), 'post', '/auth/refresh');   // 401
  const me = await secure.request().get('/api/v1/auth/me').set('Authorization', `Bearer ${rf.body.access_token}`);
  conforms(me, 'get', '/auth/me');
  conforms(await secure.request().get('/api/v1/auth/me'), 'get', '/auth/me');                // 401 без токена
  bodyless(await secure.request().post('/api/v1/auth/logout').send({ refresh_token: rf.body.refresh_token }), 'post', '/auth/logout');
});

test('автентифікація: ліміт входу дає 429 за схемою Problem', async () => {
  const tight = await makeSecure({ limits: { ip: { rate: 1e-6, burst: 1 }, user: { rate: 1, burst: 99 } } });
  await tight.login('north');
  conforms(await tight.login('north'), 'post', '/auth/login');
});

test('безпека: 401 і 403 відповідають схемам, нові операції — теж', async () => {
  const [north, viewer, root] = await Promise.all(['north', 'viewer', 'root'].map((u) => secure.as(u)));
  conforms(await secure.request().get('/api/v1/devices'), 'get', '/devices');                           // 401
  conforms(await viewer.post('/api/v1/devices/gh1-s01/commands').send({ name: 'irrigate', params: { duration_sec: 5 } }),
    'post', '/devices/{id}/commands');                                                                   // 403
  conforms(await north.get('/api/v1/audit'), 'get', '/audit');                                           // 403
  conforms(await root.get('/api/v1/audit?limit=5'), 'get', '/audit');                                    // 200
  conforms(await root.get('/api/v1/audit?limit=0'), 'get', '/audit');                                    // 400
  conforms(await north.post('/api/v1/devices/gh1-s01/stream-ticket'), 'post', '/devices/{id}/stream-ticket');
  conforms(await north.post('/api/v1/devices/gh1-s02/stream-ticket'), 'post', '/devices/{id}/stream-ticket');   // 404
  const push = { token: 'p'.repeat(40), platform: 'android' };
  bodyless(await north.post('/api/v1/push-tokens').send(push), 'post', '/push-tokens');
  conforms(await north.post('/api/v1/push-tokens').send({ platform: 'android' }), 'post', '/push-tokens');   // 400
  bodyless(await north.delete(`/api/v1/push-tokens/${push.token}`), 'delete', '/push-tokens/{token}');
});

test('прив’язка пристрою: 201, 200, 403 і 409 відповідають схемам', async () => {
  secure.ids.tech = await secure.users.create({ username: 'tech', password: PASSWORD, role: 'operator' });
  const tech = await secure.as('tech');
  const claim = (id, code) => tech.post(`/api/v1/devices/${id}/claim`).send({ code });
  const code = secure.claimCodes.issue('gh1-new');
  conforms(await claim('gh1-new', code), 'post', '/devices/{id}/claim');                    // 409: ще не в мережі
  seed(secure.db, { device: 'gh1-new', start: secure.clock() - 120_000, count: 2, values: () => 20 });
  conforms(await claim('gh1-new', code), 'post', '/devices/{id}/claim');                    // 201
  conforms(await claim('gh1-new', 'ignored'), 'post', '/devices/{id}/claim');               // 200: власник повторює
  conforms(await claim('gh1-s01', 'AAAA-BBBB-CCCC-DDDD'), 'post', '/devices/{id}/claim');   // 403
});

test('вебхук у захищеному режимі: 401 за схемою Problem', async () => {
  conforms(await secure.request().post('/api/v1/ingest/webhook').send({ events: [] }), 'post', '/ingest/webhook');
});

// Маршрути API: у маршрутизаторі та (потік SSE) безпосередньо в застосунку; службові /healthz і /readyz поза API
function implemented(root) {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) for (const m of Object.keys(layer.route.methods)) out.push(`${m} ${layer.route.path.replace(/:(\w+)/g, '{$1}')}`);
      else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  for (const layer of root.router.stack) {
    if (layer.handle?.stack) walk(layer.handle.stack);
    else if (layer.route?.path.startsWith('/api/v1/')) {
      for (const m of Object.keys(layer.route.methods)) out.push(`${m} ${layer.route.path.slice(7).replace(/:(\w+)/g, '{$1}')}`);
    }
  }
  return out;
}

test('безпека в специфікації збігається з guard-ами в коді: схема, ролі, 401 і 403', () => {
  for (const { key, action } of routesOf(secure.app)) {
    const [method, path] = key.split(' ');
    const op = doc.paths[path]?.[method];
    assert.ok(op, `${key}: немає в специфікації`);
    const effective = op.security ?? doc.security;
    if (!action) {                                         // вхід, оновлення, вихід
      assert.deepEqual(effective, [], `${key}: публічна операція має security: []`);
      continue;
    }
    assert.deepEqual(op['x-allowed-roles'], ACTIONS[action], `${key}: ролі в специфікації й у політиці різні`);
    const want = action === 'ingest:write' ? [{ webhookSignature: [] }]
      : key === 'get /devices/{id}/stream' ? [{ bearerAuth: [] }, { streamTicket: [] }] : [{ bearerAuth: [] }];
    assert.deepEqual(effective, want, `${key}: схема безпеки`);
    const codes = Object.keys(op.responses);
    assert.ok(codes.includes('401'), `${key}: не описано 401`);
    if (ACTIONS[action].length > 0 && ACTIONS[action].length < 3) assert.ok(codes.includes('403'), `${key}: не описано 403`);
  }
});

test('специфікація й реалізація збігаються: кожна операція описана й перевірена', () => {
  const described = Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`));
  const tested = new Set([...covered].map((c) => c.split(' ').slice(0, 2).join(' ')));
  assert.deepEqual(described.filter((d) => !tested.has(d)), [], 'описано, але не перевірено');
  const everything = [...new Set([...implemented(live), ...routesOf(secure.app).map((r) => r.key)])];
  assert.deepEqual(everything.filter((r) => !described.includes(r)), [], 'реалізовано, але не описано');
});
