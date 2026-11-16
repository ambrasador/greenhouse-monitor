'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSecure, serve, openStream, routesOf } = require('./auth-kit');
const { ACTIONS, ROLES } = require('./policy');

const PUBLIC = new Set(['post /auth/login', 'post /auth/refresh', 'post /auth/logout']);
const WEBHOOK = 'post /ingest/webhook';            // підпис замість ролі: webhook-sign.test.js
const STREAM = 'get /devices/{id}/stream';          // нескінченна відповідь: читається окремо
const WHO = { viewer: 'viewer', operator: 'north', admin: 'root' };   // користувач для кожної ролі
const D = 'gh1-s01';                                // зона north: бачать усі троє
const WINDOW = 'from=2026-11-05T07:30:00Z&to=2026-11-05T08:00:00Z';
const COMMAND = { name: 'irrigate', params: { duration_sec: 5 } };
// Один запит на маршрут: [метод, шлях, тіло]. Достатньо, щоб запит дійшов до guard
const REQ = {
  'get /auth/me': ['get', '/auth/me'],
  'post /devices/{id}/stream-ticket': ['post', `/devices/${D}/stream-ticket`],
  'get /audit': ['get', '/audit'],
  'post /push-tokens': ['post', '/push-tokens', { token: 't'.repeat(40), platform: 'android' }],
  'delete /push-tokens/{token}': ['delete', '/push-tokens/unknown-token'],
  'post /devices/{id}/claim': ['post', `/devices/${D}/claim`, { code: 'AAAA-BBBB-CCCC-DDDD' }],
  'get /devices': ['get', '/devices'],
  'get /devices/{id}': ['get', `/devices/${D}`],
  'get /devices/{id}/latest': ['get', `/devices/${D}/latest`],
  'get /telemetry': ['get', `/telemetry?device=${D}&metric=temperature&${WINDOW}`],
  'get /alerts': ['get', `/alerts?device=${D}&metric=temperature&op=gt&threshold=30&${WINDOW}`],
  'post /devices/{id}/commands': ['post', `/devices/${D}/commands`, COMMAND],
  'get /commands/{id}': ['get', '/commands/no-such-command'],
  'get /devices/{id}/settings': ['get', `/devices/${D}/settings`],
  'put /devices/{id}/settings': ['put', `/devices/${D}/settings`, {}],
};

const send = (client, method, url, body) => {
  const rq = client[method](`/api/v1${url}`);
  return body === undefined ? rq : rq.send(body);
};
// Відмова саме guard: 403 з типом forbidden (інші 403, як хибний код прив’язки, не рахуємо)
const denied = (r) => r.status === 403 && /\/forbidden$/.test(r.body.type);

test('кожен маршрут має дію політики, а кожна дія політики — маршрут', async () => {
  const s = await makeSecure();
  const routes = routesOf(s.app);
  assert.deepEqual(routes.filter((r) => !r.action).map((r) => r.key).sort(), [...PUBLIC].sort(),
    'маршрути без guard, крім входу, оновлення й виходу');
  const used = new Set(routes.map((r) => r.action).filter(Boolean));
  for (const a of used) assert.ok(ACTIONS[a], `дії ${a} немає в політиці`);
  assert.deepEqual(Object.keys(ACTIONS).filter((a) => !used.has(a)), [], 'дія політики без маршруту');
  const known = new Set([...Object.keys(REQ), STREAM, WEBHOOK, ...PUBLIC]);
  assert.deepEqual(routes.map((r) => r.key).filter((k) => !known.has(k)), [],
    'новий маршрут без випадку в матриці');
});

test('ключові рядки політики зафіксовано окремо від таблиці ACTIONS', () => {
  assert.deepEqual(ACTIONS['audit:read'], ['admin']);
  assert.deepEqual(ACTIONS['ingest:write'], [], 'вебхук не відкривається жодній ролі користувача');
  for (const a of ['command:create', 'command:read', 'settings:write', 'device:claim']) {
    assert.ok(!ACTIONS[a].includes('viewer'), `спостерігач не має дії ${a}`);
  }
  for (const [a, roles] of Object.entries(ACTIONS)) {
    for (const r of roles) assert.ok(ROLES.includes(r), `${a}: невідома роль ${r}`);
  }
});

test('матриця «роль × маршрут»: без токена 401, з токеном — як у таблиці ролей', async () => {
  const s = await makeSecure();
  const session = {};
  for (const role of ROLES) session[role] = await s.as(WHO[role]);
  const actionOf = new Map(routesOf(s.app).map((r) => [r.key, r.action]));
  const anon = s.request();
  let cells = 0;
  for (const [key, [method, url, body]] of Object.entries(REQ)) {
    const action = actionOf.get(key);
    const r0 = await send(anon, method, url, body);
    assert.equal(r0.status, 401, `${key} без токена: ${r0.status}`);
    assert.match(r0.headers['www-authenticate'], /^Bearer realm=/);
    for (const role of ROLES) {
      const r = await send(session[role], method, url, body);
      const allowed = ACTIONS[action].includes(role);
      assert.equal(denied(r), !allowed, `${key} для ${role}: ${r.status} ${r.body?.type}`);
      assert.notEqual(r.status, 401, `${key} для ${role}: токен відхилено`);
      cells++;
    }
  }
  assert.equal(cells, ROLES.length * Object.keys(REQ).length);
});

test('матриця для потоку SSE: ті самі правила, що й для решти маршрутів', async () => {
  const s = await makeSecure();
  const web = await serve(s.app);
  try {
    const url = `${web.base}/api/v1/devices/${D}/stream`;
    assert.equal((await openStream(url)).status, 401);
    for (const role of ROLES) {
      const { headers } = await s.as(WHO[role]);
      const st = await openStream(url, headers);
      assert.equal(st.status === 200, ACTIONS['stream:read'].includes(role), `${role}: ${st.status}`);
      st.close();
    }
  } finally {
    await web.stop();
  }
});

test('список пристроїв: лише своя область, також при посторінковому читанні', async () => {
  const s = await makeSecure();
  const north = await s.as('north');
  const ids = [];
  for (let cursor = null, page = 0; page < 5; page++) {
    const r = await north.get(`/api/v1/devices?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
    ids.push(...r.body.data.map((d) => d.id));
    if (!(cursor = r.body.next)) break;
  }
  assert.deepEqual(ids, ['gh1-new', 'gh1-s01']);
  assert.deepEqual((await north.get('/api/v1/devices?zone=south')).body.data, [], 'фільтр не розширює область');
  const ofUser = async (name) => (await (await s.as(name)).get('/api/v1/devices')).body.data.map((d) => d.id);
  assert.deepEqual(await ofUser('guest'), []);
  assert.deepEqual(await ofUser('viewer'), ['gh1-new', 'gh1-s01']);
  assert.deepEqual(await ofUser('agro'), ['gh1-new', 'gh1-s01', 'gh1-s02']);
  assert.deepEqual(await ofUser('root'), ['gh1-new', 'gh1-s01', 'gh1-s02'], 'адміністратор без записів grants');
  // курсор не розширює область: гість із курсором північного оператора все одно порожній
  const first = (await north.get('/api/v1/devices?limit=1')).body.next;
  const guest = await s.as('guest');
  assert.deepEqual((await guest.get(`/api/v1/devices?limit=1&cursor=${first}`)).body.data, []);
});

test('чужий пристрій відповідає так само, як неіснуючий: 404 без підказок', async () => {
  const s = await makeSecure();
  const north = await s.as('north');
  const cases = [
    ['get', (d) => `/devices/${d}`],
    ['get', (d) => `/devices/${d}/latest`],
    ['get', (d) => `/devices/${d}/settings`],
    ['get', (d) => `/telemetry?device=${d}&metric=temperature&${WINDOW}`],
    ['get', (d) => `/alerts?device=${d}&metric=temperature&op=gt&threshold=30&${WINDOW}`],
    ['post', (d) => `/devices/${d}/stream-ticket`],
    ['post', (d) => `/devices/${d}/commands`, COMMAND],
    ['put', (d) => `/devices/${d}/settings`, {}],
  ];
  for (const [method, url, body] of cases) {
    const foreign = await send(north, method, url('gh1-s02'), body);
    const missing = await send(north, method, url('gh1-nope'), body);
    assert.equal(foreign.status, 404, url('gh1-s02'));
    assert.equal(missing.status, 404);
    assert.equal(foreign.body.type, missing.body.type);
    assert.deepEqual(Object.keys(foreign.body).sort(), Object.keys(missing.body).sort());
  }
  // Прив’язка: код перевіряється до будь-якої відповіді про стан, тож чужий і неіснуючий збігаються
  const claim = (id) => send(north, 'post', `/devices/${id}/claim`, { code: 'AAAA-BBBB-CCCC-DDDD' });
  const [a, b] = [await claim('gh1-s02'), await claim('gh1-nope')];
  assert.deepEqual([a.status, b.status], [403, 403]);
  assert.equal(a.body.type, b.body.type);
  assert.match(a.body.type, /invalid-claim-code$/);
});

test('команда чужого пристрою недоступна за ідентифікатором', async () => {
  const s = await makeSecure();
  const [agro, north, root, viewer] = await Promise.all(['agro', 'north', 'root', 'viewer'].map((u) => s.as(u)));
  const made = await agro.post('/api/v1/devices/gh1-s02/commands').send(COMMAND);
  assert.equal(made.status, 202);
  const url = `/api/v1/commands/${made.body.id}`;
  assert.equal((await agro.get(url)).status, 200);
  assert.equal((await root.get(url)).status, 200);
  const foreign = await north.get(url);
  const missing = await north.get('/api/v1/commands/00000000-0000-4000-8000-000000000000');
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.type, missing.body.type);
  assert.equal(denied(await viewer.get(url)), true, 'спостерігач не читає команд');
});

test('ключ ідемпотентності не відкриває чужої команди', async () => {
  const s = await makeSecure();
  const [agro, north] = await Promise.all(['agro', 'north'].map((u) => s.as(u)));
  const key = { 'Idempotency-Key': 'key-12345678' };
  const a = await agro.post('/api/v1/devices/gh1-s02/commands').set(key).send(COMMAND);
  assert.equal(a.status, 202);
  const b = await north.post('/api/v1/devices/gh1-s02/commands').set(key).send(COMMAND);
  assert.equal(b.status, 404, 'повтор чужого ключа не повертає чужу відповідь');
  const own = await north.post('/api/v1/devices/gh1-s01/commands').set(key).send(COMMAND);
  assert.equal(own.status, 202);
  assert.notEqual(own.body.id, a.body.id);
});

test('жоден токен користувача не відкриває вебхук', async () => {
  const s = await makeSecure();
  for (const role of ROLES) {
    const { headers } = await s.as(WHO[role]);
    const r = await s.request().post('/api/v1/ingest/webhook').set(headers).send({ events: [] });
    assert.equal(r.status, 401, role);
    assert.match(r.body.type, /invalid-signature$/);
  }
});

test('журнал аудиту: дії, відмови, фільтри; читає лише адміністратор', async () => {
  const s = await makeSecure();
  const [north, viewer, root] = await Promise.all(['north', 'viewer', 'root'].map((u) => s.as(u)));
  await north.post(`/api/v1/devices/${D}/commands`).send(COMMAND);
  await viewer.post(`/api/v1/devices/${D}/commands`).send(COMMAND);               // 403
  const put = await north.put(`/api/v1/devices/${D}/settings`).set('If-Match', '"0"').send({ soil_moisture_min: 35 });
  assert.equal(put.status, 200);
  assert.equal(denied(await north.get('/api/v1/audit')), true);
  const all = (await root.get('/api/v1/audit')).body;
  const acts = all.data.map((e) => `${e.action}:${e.outcome}`);
  for (const want of ['command.create:ok', 'authz.denied:denied', 'settings.update:ok', 'login:ok']) {
    assert.ok(acts.includes(want), `немає запису ${want} у ${acts.join(', ')}`);
  }
  const cmd = all.data.find((e) => e.action === 'command.create');
  assert.equal(cmd.actor, s.ids.north);
  assert.equal(cmd.target, D);
  assert.equal(cmd.detail.name, 'irrigate');
  const upd = all.data.find((e) => e.action === 'settings.update');
  assert.deepEqual(upd.detail, { version: 1, before: {}, after: { soil_moisture_min: 35 } });
  const mine = (await root.get(`/api/v1/audit?actor=${s.ids.viewer}`)).body.data;
  assert.ok(mine.length > 0 && mine.every((e) => e.actor === s.ids.viewer));
  const page1 = (await root.get('/api/v1/audit?limit=2')).body;
  const page2 = (await root.get(`/api/v1/audit?limit=2&before=${page1.next}`)).body;
  assert.equal(page1.data.length, 2);
  assert.ok(page2.data.every((e) => e.id < page1.next));
  assert.equal((await root.get('/api/v1/audit?limit=9999')).status, 400);
  const dump = JSON.stringify(all);
  assert.ok(!/Bearer|eyJ|scrypt\$/.test(dump), 'у журналі немає токенів і хешів');
});

test('повторна команда з тим самим ключем не дублює запис у журналі', async () => {
  const s = await makeSecure();
  const north = await s.as('north');
  const key = { 'Idempotency-Key': 'key-abcdefgh' };
  for (let i = 0; i < 3; i++) await north.post(`/api/v1/devices/${D}/commands`).set(key).send(COMMAND);
  assert.equal(s.audit.list().filter((e) => e.action === 'command.create').length, 1);
});
