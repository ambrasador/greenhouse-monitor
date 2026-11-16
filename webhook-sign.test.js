'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { sign, createVerifier } = require('./webhook-sign');
const { makeSecure, fakeClock, WEBHOOK_SECRET } = require('./auth-kit');

const SECRET = 'whsec-test-secret-0123456789abcdefgh';
const OLD = 'whsec-previous-secret-abcdefghijklmnop';
const sec = (clock) => Math.floor(clock() / 1000);
const BODY = Buffer.from('{"events":[]}');
const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

test('еталонний вектор HMAC-SHA256 (документація GitHub): примітив налаштовано правильно', () => {
  const mac = createHmac('sha256', "It's a Secret to Everybody").update('Hello, World!').digest('hex');
  assert.equal(mac, '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17');
});

test('заголовок має вигляд t=<секунди>,v1=<64 hex>, а підпис охоплює час і тіло', () => {
  const header = sign(SECRET, BODY, 1_762_333_200);
  assert.match(header, /^t=1762333200,v1=[0-9a-f]{64}$/);
  const mac = createHmac('sha256', SECRET).update('1762333200.').update(BODY).digest('hex');
  assert.equal(header, `t=1762333200,v1=${mac}`);
});

test('чинний підпис проходить; змінене тіло, час чи секрет — ні', () => {
  const clock = fakeClock();
  const verify = createVerifier({ secrets: [SECRET], clock, replay: false });
  const t = sec(clock);
  const good = sign(SECRET, BODY, t);
  assert.equal(verify(good, BODY), null);
  assert.equal(verify(good, Buffer.from('{"events":[1]}')), 'bad-signature');
  assert.equal(verify(good.replace(`t=${t}`, `t=${t + 1}`), BODY), 'bad-signature', 'час входить у підпис');
  assert.equal(verify(sign('another-secret-of-similar-length-0000', BODY, t), BODY), 'bad-signature');
  const [, v1] = good.split(',v1=');
  assert.equal(verify(`t=${t},v1=${flip(v1)}`, BODY), 'bad-signature');
});

test('вікно часу: ±300 с включно, далі stale', () => {
  const clock = fakeClock();
  const verify = createVerifier({ secrets: [SECRET], clock, replay: false });
  const t = sec(clock);
  for (const dt of [-300, -299, 0, 299, 300]) {
    assert.equal(verify(sign(SECRET, BODY, t + dt), BODY), null, `dt=${dt}`);
  }
  for (const dt of [-301, 301, -86_400]) {
    assert.equal(verify(sign(SECRET, BODY, t + dt), BODY), 'stale', `dt=${dt}`);
  }
});

test('некоректні заголовки: malformed, без винятків', () => {
  const clock = fakeClock();
  const verify = createVerifier({ secrets: [SECRET], clock });
  const t = sec(clock);
  const v1 = sign(SECRET, BODY, t).split('v1=')[1];
  for (const h of [undefined, '', 'garbage', `v1=${v1}`, `t=${t}`, `t=abc,v1=${v1}`, `t=${t},v1=zz`,
    `t=${t},v1=${v1.slice(1)}`, `t=${t},v0=${v1}`, `t=${t},v1=${v1.toUpperCase()}`, `t=${t}.5,v1=${v1}`, 't=,v1=', ',,,']) {
    assert.equal(verify(h, BODY), 'malformed', String(h));
  }
});

test('повтор: перша доставка проходить, друга з тим самим підписом — replay', () => {
  const clock = fakeClock();
  const verify = createVerifier({ secrets: [SECRET], clock });
  const header = sign(SECRET, BODY, sec(clock));
  assert.equal(verify(header, BODY), null);
  assert.equal(verify(header, BODY), 'replay');
  clock.tick(301_000);
  assert.equal(verify(header, BODY), 'stale', 'після вікна відмова вже за часом, кеш не потрібен');
});

test('повтор не обходиться зміною заголовка: порядок v1 і зайві підписи не мають значення', () => {
  const clock = fakeClock();
  const verify = createVerifier({ secrets: [SECRET, OLD], clock });
  const t = sec(clock);
  const a = sign(SECRET, BODY, t).split('v1=')[1];
  const b = sign(OLD, BODY, t).split('v1=')[1];
  assert.equal(verify(`t=${t},v1=${a},v1=${b}`, BODY), null);
  assert.equal(verify(`t=${t},v1=${b},v1=${a}`, BODY), 'replay', 'поміняли місцями');
  assert.equal(verify(`t=${t},v1=${b}`, BODY), 'replay', 'лишили лише старий підпис');
  assert.equal(verify(`t=${t},v1=${a}`, BODY), 'replay', 'лишили лише новий');
});

test('кеш повторів очищується: після вікна лишається лише свіже', () => {
  const clock = fakeClock();
  const verify = createVerifier({ secrets: [SECRET], clock });
  for (let i = 0; i < 1000; i++) {
    assert.equal(verify(sign(SECRET, Buffer.from(`n${i}`), sec(clock)), Buffer.from(`n${i}`)), null);
  }
  assert.equal(verify.size(), 1000);
  clock.tick(601_000);                      // більше за 2 × 300 с: усе вже stale
  assert.equal(verify(sign(SECRET, BODY, sec(clock)), BODY), null);
  assert.equal(verify.size(), 1);
});

test('перевипуск секрету без простою: підписи старим і новим приймаються, чужим — ні', () => {
  const clock = fakeClock();
  const t = sec(clock);
  const during = createVerifier({ secrets: [SECRET, OLD], clock, replay: false });
  assert.equal(during(sign(OLD, BODY, t), BODY), null, 'відправник ще на старому секреті');
  assert.equal(during(sign(SECRET, BODY, t), BODY), null, 'вже на новому');
  const both = `${sign(SECRET, BODY, t)},v1=${sign(OLD, BODY, t).split('v1=')[1]}`;
  assert.equal(during(both, BODY), null, 'перехідний період: два підписи');
  const after = createVerifier({ secrets: [SECRET], clock, replay: false });
  assert.equal(after(sign(OLD, BODY, t), BODY), 'bad-signature', 'старий секрет вилучено');
});

// ---- через HTTP ----
const event = (s, extra = {}) => ({ device_id: 'gh1-s01', metric: 'humidity', value: 55,
  ts: new Date(s.clock() - 60_000).toISOString(), ...extra });
async function post(s, raw, header) {
  const rq = s.request().post('/api/v1/ingest/webhook').set('Content-Type', 'application/json');
  if (header !== undefined) rq.set('X-Signature', header);
  return rq.send(raw);
}
const signed = (s, raw, secret = WEBHOOK_SECRET) => sign(secret, Buffer.from(raw), sec(s.clock));

test('вебхук: підписана пачка приймається, підпис рахується від байтів тіла як надіслано', async () => {
  const s = await makeSecure();
  const raw = JSON.stringify({ events: [event(s), event(s, { ts: new Date(s.clock() - 30_000).toISOString() })] });
  const ok = await post(s, raw, signed(s, raw));
  assert.deepEqual([ok.status, ok.body], [200, { stored: 2, duplicate: 0, rejected: 0 }]);
  const pretty = JSON.stringify(JSON.parse(raw), null, 2);               // той самий JSON, інші байти
  const r = await post(s, pretty, signed(s, raw));
  assert.equal(r.status, 401, 'перевірка йде по сирих байтах, а не по розібраному об’єкту');
});

test('вебхук: усі причини відмови виглядають однаково, причина лише в журналі', async () => {
  const s = await makeSecure();
  const raw = JSON.stringify({ events: [event(s)] });
  const header = signed(s, raw);
  const stale = sign(WEBHOOK_SECRET, Buffer.from(raw), sec(s.clock) - 1000);
  const answers = [
    await post(s, raw),                                   // немає заголовка
    await post(s, raw, 'oops'),                           // malformed
    await post(s, raw, stale),                            // stale
    await post(s, raw, signed(s, raw, 'wrong-secret-wrong-secret-wrong-0')),   // bad-signature
    (await post(s, raw, header), await post(s, raw, header)),                   // replay (друга доставка)
  ];
  for (const r of answers) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, answers[0].body, 'тіло відповіді не залежить від причини');
  }
  const why = s.audit.list().filter((e) => e.action === 'webhook').map((e) => e.detail.why).reverse();
  assert.deepEqual(why, ['malformed', 'malformed', 'stale', 'bad-signature', 'replay']);
});

test('вебхук: JSON розбирається лише після перевірки підпису', async () => {
  const s = await makeSecure();
  const garbage = '{{{ не json';
  assert.equal((await post(s, garbage)).status, 401, 'без підпису парсер не бачить тіла');
  const r = await post(s, garbage, signed(s, garbage));
  assert.deepEqual([r.status, r.body.type.split('/').pop()], [400, 'invalid-json']);
});

test('вебхук: завелике тіло відсікається за лімітом до перевірки', async () => {
  const s = await makeSecure();
  const huge = JSON.stringify({ events: [event(s)], pad: 'x'.repeat(300_000) });
  assert.equal((await post(s, huge, signed(s, huge))).status, 413);
});

test('вебхук: подія чужого пристрою відхиляється, решта пачки приймається, кількість у журналі', async () => {
  const s = await makeSecure();
  const raw = JSON.stringify({ events: [event(s), event(s, { device_id: 'other-77' }), event(s, { device_id: 'gh1-s02',
    ts: new Date(s.clock() - 90_000).toISOString() })] });
  const r = await post(s, raw, signed(s, raw));
  assert.deepEqual([r.status, r.body], [200, { stored: 2, duplicate: 0, rejected: 1 }]);
  assert.equal(s.db.prepare("SELECT count(*) n FROM telemetry WHERE device_id = 'other-77'").get().n, 0);
  assert.ok(s.audit.list().some((e) => e.action === 'webhook.scope' && e.detail.events === 1));
  const allForeign = JSON.stringify({ events: [event(s, { device_id: 'other-1' })] });
  assert.deepEqual((await post(s, allForeign, signed(s, allForeign))).body, { stored: 0, duplicate: 0, rejected: 1 });
});

test('вебхук: підписана доставка потрапляє у стрічку подій для потоків', async () => {
  const s = await makeSecure();
  const seen = [];
  s.feed.subscribe('gh1-s01', (_d, readings) => seen.push(...readings));
  const raw = JSON.stringify({ events: [event(s)] });
  await post(s, raw, signed(s, raw));
  s.feed.flush();
  assert.deepEqual(seen.map((r) => [r.metric, r.value]), [['humidity', 55]]);
});
