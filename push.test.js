'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { addDevice } = require('./testkit');
const { makeMobileDb } = require('./mobile-kit');
const { createFeed } = require('./feed');
const { createFakeFcm } = require('./fake-fcm');
const { RULES, nextLevel, createAlertTracker, buildMessage, createFcmClient,
  createDispatcher } = require('./push');

const T0 = Date.parse('2026-11-04T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const soil = RULES.get('soil_moisture');
const temp = RULES.get('temperature');

test('правила push збігаються з client/domain.js', async () => {
  const { GREENHOUSE } = await import('./client/domain.js');
  for (const [metric, r] of RULES) {
    const m = GREENHOUSE.metrics[metric];
    assert.equal(r.op, m.rule.direction === 'below' ? 'lt' : 'gt', `${metric}.op`);
    assert.equal(r.warn, m.rule.warn, `${metric}.warn`);
    assert.equal(r.crit, m.rule.crit, `${metric}.crit`);
    assert.equal(r.label, m.label, `${metric}.label`);
    assert.equal(r.unit, m.unit, `${metric}.unit`);
  }
  for (const [metric, m] of Object.entries(GREENHOUSE.metrics)) {
    if (m.rule) assert.ok(RULES.has(metric), `${metric}: правила push немає`);
  }
});

test('nextLevel: погіршення одразу, покращення — із запасом гістерезису', () => {
  const cases = [
    // [правило, поточний, значення, очікуваний]
    [soil, 'normal', 36, 'normal'], [soil, 'normal', 35, 'normal'],
    [soil, 'normal', 34.9, 'warning'], [soil, 'normal', 29.9, 'critical'],
    [soil, 'warning', 36.9, 'warning'], [soil, 'warning', 37, 'normal'],
    [soil, 'critical', 31.9, 'critical'], [soil, 'critical', 32, 'warning'],
    [soil, 'critical', 36.9, 'warning'], [soil, 'critical', 37, 'normal'],
    [temp, 'normal', 32, 'normal'], [temp, 'normal', 32.1, 'warning'],
    [temp, 'normal', 35.1, 'critical'], [temp, 'warning', 31.1, 'warning'],
    [temp, 'warning', 31, 'normal'], [temp, 'critical', 34.1, 'critical'],
    [temp, 'critical', 34, 'warning'],
  ];
  for (const [rule, cur, v, want] of cases) {
    assert.equal(nextLevel(cur, v, rule), want, `${rule.op} ${cur} ${v}`);
  }
});

function tracker(opts) {
  let now = T0;
  const t = createAlertTracker({ clock: () => now, ...opts });
  const feed = (minutes, value, metric = 'soil_moisture') =>
    t.evaluate({ device: 'gh1', metric, ts: iso(T0 + minutes * MIN), value });
  return { t, feed, setNow: (m) => { now = T0 + m * MIN; } };
}

test('tracker: сповіщення лише при погіршенні; той самий рівень мовчить', () => {
  const { feed, setNow } = tracker();
  setNow(0);
  assert.equal(feed(0, 40), null);
  assert.equal(feed(1, 34).level, 'warning');
  setNow(2);
  assert.equal(feed(2, 33), null, 'ще warning');
  assert.equal(feed(3, 29).level, 'critical', 'ескалація проходить');
  assert.equal(feed(4, 28), null);
});

test('tracker: значення на межі коливається — гістерезис дає одне сповіщення', () => {
  const edge = tracker({ hysteresis: 0, cooldownMs: 0 });
  const hyst = tracker({ cooldownMs: 0 });
  let a = 0; let b = 0;
  for (let i = 0; i < 20; i++) {
    const v = i % 2 === 0 ? 34.9 : 35.1;   // поріг 35, коливання ±0,1
    edge.setNow(i); hyst.setNow(i);
    a += edge.feed(i, v) ? 1 : 0;
    b += hyst.feed(i, v) ? 1 : 0;
  }
  assert.equal(a, 10, 'без гістерезису — кожне друге вимірювання');
  assert.equal(b, 1);
});

test('tracker: cooldown гасить повторення рівня, але не ескалацію', () => {
  const { feed, setNow } = tracker({ cooldownMs: 10 * MIN });
  setNow(0);
  assert.equal(feed(0, 34).level, 'warning');
  setNow(1);
  assert.equal(feed(1, 38), null, 'повернулось до норми');
  setNow(5);
  assert.equal(feed(5, 34), null, 'знову warning за 5 хв: cooldown');
  setNow(6);
  assert.equal(feed(6, 29).level, 'critical', 'critical вищий за той, що вже був у push');
  setNow(7);
  assert.equal(feed(7, 38), null);
  setNow(18);
  assert.equal(feed(18, 34).level, 'warning', 'cooldown минув (18 − 6 > 10)');
});

test('tracker: подія з минулого оновлює стан, але не штовхає', () => {
  const { feed, setNow } = tracker({ maxAgeMs: 5 * MIN });
  setNow(60);                       // зараз 13:00, а вимірювання з 12:01
  assert.equal(feed(1, 34), null);
  assert.equal(feed(61, 33), null, 'стан уже warning: повтору немає');
  assert.equal(feed(62, 28).level, 'critical');
});

test('tracker: невідома метрика й нечислове значення ігноруються', () => {
  const { feed } = tracker();
  assert.equal(feed(0, 1, 'light'), null);
  assert.equal(feed(0, NaN), null);
});

test('buildMessage: data — лише рядки, tag замість collapse_key, строк дії', () => {
  const alert = { device: 'gh1', metric: 'soil_moisture', level: 'critical', value: 28, ts: iso(T0) };
  const { message: m } = buildMessage({ id: 'tok', kind: 'token' }, alert,
    { name: 'Грядка А', ttlSec: 600, nowMs: T0 });
  assert.equal(m.token, 'tok');
  assert.equal(m.fid, undefined);
  assert.ok(Object.values(m.data).every((v) => typeof v === 'string'));
  assert.equal(m.data.value, '28');
  assert.equal(m.notification.body, 'Грядка А: 28,0 %');
  assert.equal(m.android.ttl, '600s');
  assert.equal(m.android.collapse_key, undefined, 'FCM тримає ≤ 4 ключів на пристрій');
  assert.equal(m.android.notification.tag, 'gh1:soil_moisture');
  assert.equal(m.apns.headers['apns-expiration'], String(T0 / 1000 + 600));
  assert.equal(m.apns.headers['apns-collapse-id'], 'gh1:soil_moisture');
  assert.equal(m.apns.headers['apns-push-type'], 'alert');
  assert.ok(Buffer.byteLength(JSON.stringify({ n: m.notification, d: m.data })) < 4096);
});

test('buildMessage: адреса виду fid іде в поле fid, а не token', () => {
  const alert = { device: 'gh1', metric: 'temperature', level: 'warning', value: 33.2, ts: iso(T0) };
  const { message: m } = buildMessage({ id: 'fid-0123456789abcdef', kind: 'fid' }, alert, { name: 'Грядка А' });
  assert.equal(m.fid, 'fid-0123456789abcdef');
  assert.equal(m.token, undefined);
});

// ---- диспетчер проти імітації FCM ----

async function bed({ attempts = 5, clock = () => T0, onSleep = () => {} } = {}) {
  const db = makeMobileDb();
  addDevice(db, 'gh1');
  db.prepare("INSERT INTO device_owner VALUES ('gh1', 'u1', ?)").run(iso(T0));
  const fake = createFakeFcm();
  const port = await fake.listen();
  const addToken = (token, user = 'u1', valid = true, kind = 'token') => {
    db.prepare(`INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at)
                VALUES (?, ?, ?, 'android', ?, ?)`).run(token, kind, user, iso(T0), iso(T0));
    if (valid) fake.validTokens.add(token);
  };
  const sleeps = [];
  const fcm = createFcmClient({ baseUrl: `http://127.0.0.1:${port}`, project: fake.project,
    getAccessToken: async () => 'access', timeoutMs: 2000 });
  const logs = [];
  const d = createDispatcher({ db, fcm, clock, rnd: () => 1, maxAttempts: attempts,
    sleep: async (ms) => { sleeps.push(ms); onSleep(ms); }, log: (...a) => logs.push(a) });
  const alert = { device: 'gh1', metric: 'soil_moisture', level: 'critical', value: 28, ts: iso(T0) };
  return { db, fake, d, sleeps, logs, alert, addToken, close: () => fake.close() };
}

test('диспетчер: доставка власнику; мертвий токен видаляється; чужий не чіпається', async () => {
  const b = await bed();
  b.addToken('tok-live-0000000000000001');
  b.addToken('tok-dead-0000000000000002', 'u1', false);
  b.addToken('tok-other-000000000000003', 'u2');
  const res = await b.d.deliver(b.alert);
  assert.deepEqual(res.sort(), ['sent', 'unregistered']);
  assert.equal(b.fake.delivered.length, 1);
  assert.equal(b.fake.delivered[0].token, 'tok-live-0000000000000001');
  const left = b.db.prepare('SELECT token FROM push_tokens ORDER BY token').all().map((r) => r.token);
  assert.deepEqual(left, ['tok-live-0000000000000001', 'tok-other-000000000000003']);
  assert.deepEqual(b.fake.rejected, [], 'імітація не знайшла порушень контракту');
  await b.close();
});

test('диспетчер: адреса-FID доставляється через поле fid; токен — через token', async () => {
  const b = await bed();
  b.addToken('fid-live-0000000000000001', 'u1', true, 'fid');
  b.addToken('tok-live-0000000000000002', 'u1', true, 'token');
  assert.deepEqual((await b.d.deliver(b.alert)).sort(), ['sent', 'sent']);
  const byField = b.fake.delivered.map((m) => (m.fid ? ['fid', m.fid] : ['token', m.token])).sort();
  assert.deepEqual(byField, [['fid', 'fid-live-0000000000000001'], ['token', 'tok-live-0000000000000002']]);
  assert.deepEqual(b.fake.rejected, []);
  await b.close();
});

test('диспетчер: 503 → повтори з експоненційною паузою, потім успіх', async () => {
  const b = await bed();
  b.addToken('tok-live-0000000000000001');
  b.fake.script.push({ status: 503, code: 'UNAVAILABLE' }, { status: 500, code: 'INTERNAL' });
  assert.deepEqual(await b.d.deliver(b.alert), ['sent']);
  assert.deepEqual(b.sleeps, [1000, 2000], 'rnd = 1 → верхня межа джитера');
  assert.equal(b.d.stats.retries, 2);
  await b.close();
});

test('диспетчер: 429 — пауза від хвилини й далі подвоюється; більший Retry-After має перевагу', async () => {
  const b = await bed();
  b.addToken('tok-live-0000000000000001');
  b.fake.script.push({ status: 429, code: 'QUOTA_EXCEEDED' }, { status: 429, code: 'QUOTA_EXCEEDED' },
    { status: 429, code: 'QUOTA_EXCEEDED', retryAfter: 300 });
  assert.deepEqual(await b.d.deliver(b.alert), ['sent']);
  assert.deepEqual(b.sleeps, [60_000, 120_000, 300_000], 'rnd = 1; на третій спробі 240 с < Retry-After 300 с');
  await b.close();
});

test('диспетчер: повтор, що вийшов би за строк дії сповіщення, не робиться', async () => {
  let now = T0 + 9.5 * MIN;           // сповіщенню вже 9,5 хв, строк дії 10
  const b = await bed({ clock: () => now });
  b.addToken('tok-live-0000000000000001');
  b.fake.script.push({ status: 429, code: 'QUOTA_EXCEEDED' });
  assert.deepEqual(await b.d.deliver(b.alert), ['expired']);
  assert.equal(b.sleeps.length, 0);
  assert.equal(b.fake.delivered.length, 0);
  await b.close();
});

test('диспетчер: TTL кожної спроби — залишок строку дії, а не 600 с', async () => {
  let now = T0 + 20_000;                 // сповіщенню 20 с
  const b = await bed({ clock: () => now, onSleep: (ms) => { now += ms; } });
  b.addToken('tok-live-0000000000000001');
  b.fake.script.push({ status: 503, code: 'UNAVAILABLE' }, { status: 503, code: 'UNAVAILABLE' });
  assert.deepEqual(await b.d.deliver(b.alert), ['sent']);
  // спроби на 20-й, 21-й і 23-й секундах після події
  assert.deepEqual(b.fake.received.map((m) => m.android.ttl), ['580s', '579s', '577s']);
  const end = String(T0 / 1000 + 600);   // 600-та секунда після події
  assert.deepEqual(b.fake.received.map((m) => m.apns.headers['apns-expiration']), [end, end, end]);
  await b.close();
});

test('диспетчер: сповіщення, чий строк дії минув, не відправляється', async () => {
  const b = await bed({ clock: () => T0 + 11 * MIN });
  b.addToken('tok-live-0000000000000001');
  assert.deepEqual(await b.d.deliver(b.alert), ['expired']);
  assert.equal(b.fake.received.length, 0);
  assert.equal(b.d.stats.expired, 1);
  await b.close();
});

test('диспетчер: INVALID_ARGUMENT і помилки конфігурації не повторюються, токен лишається', async () => {
  const b = await bed();
  b.addToken('tok-live-0000000000000001');
  b.fake.script.push({ status: 400, code: 'INVALID_ARGUMENT' });
  assert.deepEqual(await b.d.deliver(b.alert), ['invalid']);
  b.fake.script.push({ status: 401, code: 'THIRD_PARTY_AUTH_ERROR' });
  assert.deepEqual(await b.d.deliver(b.alert), ['config']);
  b.fake.script.push({ status: 403, code: 'SENDER_ID_MISMATCH' });
  assert.deepEqual(await b.d.deliver(b.alert), ['config']);
  assert.equal(b.sleeps.length, 0);
  assert.equal(b.db.prepare('SELECT count(*) AS n FROM push_tokens').get().n, 1);
  await b.close();
});

test('диспетчер: мережа недоступна → повтори, далі здаємось', async () => {
  const b = await bed({ attempts: 3 });
  b.addToken('tok-live-0000000000000001');
  await b.fake.close();            // FCM «зник»
  assert.deepEqual(await b.d.deliver(b.alert), ['gave-up']);
  assert.equal(b.sleeps.length, 2, 'після останньої спроби не чекаємо');
});

test('диспетчер: без власника чи токенів нікому слати', async () => {
  const b = await bed();
  assert.deepEqual(await b.d.deliver(b.alert), []);
  assert.deepEqual(await b.d.deliver({ ...b.alert, device: 'ghX' }), []);
  assert.equal(b.d.stats.noRecipients, 2);
  await b.close();
});

test('шина → правило → диспетчер → FCM: наскрізно', async () => {
  const b = await bed();
  b.addToken('tok-live-0000000000000001');
  const feed = createFeed({ windowMs: 1 });
  const tr = createAlertTracker({ clock: () => T0 });
  feed.subscribe('*', b.d.onReadings(tr));
  feed.publish({ device: 'gh1', metric: 'soil_moisture', ts: iso(T0 - 1000), value: 41 });
  feed.publish({ device: 'gh1', metric: 'soil_moisture', ts: iso(T0), value: 28 });
  feed.flush();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.fake.delivered.length, 1);
  const m = b.fake.delivered[0];
  assert.equal(m.data.level, 'critical');
  assert.equal(m.notification.title, 'Вологість ґрунту: критично');
  await b.close();
});
