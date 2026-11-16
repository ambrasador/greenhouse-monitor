'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { newCode } = require('./claim-codes');
const { makeSecure, NOW, PASSWORD } = require('./auth-kit');
const { seed } = require('./testkit');

const claim = (client, id, code) => client.post(`/api/v1/devices/${id}/claim`).send({ code });
const online = (s, id) => seed(s.db, { device: id, start: NOW - 120_000, count: 2, values: () => 20 });
async function technician(s, name = 'tech') {                 // оператор без жодних прав на пристрої
  s.ids[name] = await s.users.create({ username: name, password: PASSWORD, role: 'operator' });
  return s.as(name);
}

test('код: 16 символів base32 у чотирьох групах, 80 біт; у базі лише SHA-256', async () => {
  assert.match(newCode(), /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
  assert.equal(new Set(Array.from({ length: 1000 }, newCode)).size, 1000);
  const s = await makeSecure();
  const code = s.claimCodes.issue('gh1-new');
  const row = s.db.prepare('SELECT * FROM claim_codes WHERE device_id = ?').get('gh1-new');
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(row).includes(code.replaceAll('-', '')));
});

test('прив’язка з чинним кодом: 201, код згасає, власник бачить пристрій', async () => {
  const s = await makeSecure();
  online(s, 'gh1-new');
  const code = s.claimCodes.issue('gh1-new');
  const tech = await technician(s);
  assert.deepEqual((await tech.get('/api/v1/devices')).body.data, [], 'до прив’язки нічого не видно');
  const ok = await claim(tech, 'gh1-new', code.toLowerCase().replaceAll('-', ' '));   // допуск до форми запису
  assert.equal(ok.status, 201);
  assert.deepEqual((await tech.get('/api/v1/devices')).body.data.map((d) => d.id), ['gh1-new']);
  assert.equal((await claim(tech, 'gh1-new', 'інше')).status, 200, 'повтор власником безпечний');
  const thief = await technician(s, 'thief');
  const again = await claim(thief, 'gh1-new', code);
  assert.equal(again.status, 403, 'код гасить успішна прив’язка');
  assert.equal(s.db.prepare('SELECT count(*) n FROM claim_codes').get().n, 0);
});

test('чотири різні відмови виглядають однаково', async () => {
  const s = await makeSecure();
  online(s, 'gh1-new');
  s.claimCodes.issue('gh1-new');
  const tech = await technician(s);
  const owner = await technician(s, 'owner');
  await claim(owner, 'gh1-new', s.claimCodes.issue('gh1-new'));            // тепер пристрій зайнятий
  const answers = [
    await claim(tech, 'gh1-nope', 'AAAA-BBBB-CCCC-DDDD'),                  // немає такого пристрою
    await claim(tech, 'gh1-s01', 'AAAA-BBBB-CCCC-DDDD'),                   // вільний, але кода немає в базі
    await claim(tech, 'gh1-new', 'AAAA-BBBB-CCCC-DDDD'),                   // зайнятий
    await claim(tech, 'gh1-new', undefined),                               // коду не надіслано
  ];
  for (const r of answers) {
    assert.equal(r.status, 403);
    assert.deepEqual(r.body.type, answers[0].body.type);
  }
});

test('збій на пізнішому кроці не спалює код', async () => {
  const s = await makeSecure();
  const code = s.claimCodes.issue('gh1-new');                // пристрій ще не виходив на зв’язок
  const tech = await technician(s);
  const early = await claim(tech, 'gh1-new', code);
  assert.equal(early.status, 409);
  assert.match(early.body.type, /device-offline$/);
  assert.equal(s.db.prepare('SELECT count(*) n FROM claim_codes').get().n, 1);
  online(s, 'gh1-new');
  assert.equal((await claim(tech, 'gh1-new', code)).status, 201);
});

test('перебір коду стримується за користувачем, інші користувачі не страждають', async () => {
  const s = await makeSecure();
  online(s, 'gh1-new');
  const code = s.claimCodes.issue('gh1-new');
  const [tech, other] = [await technician(s), await technician(s, 'other')];
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await claim(tech, 'gh1-new', `AAAA-AAAA-AAAA-AA${i}2`)).status);
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429, 429]);
  const blocked = await claim(tech, 'gh1-new', code);
  assert.equal(blocked.status, 429, 'навіть правильний код чекає');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  s.clock.tick(120_000);
  assert.equal((await claim(tech, 'gh1-new', code)).status, 201, 'після паузи — знову можна');
  assert.equal((await claim(other, 'gh1-new', 'AAAA-BBBB-CCCC-DDDD')).status, 403, 'інший користувач не заблокований');
});

test('токени push: власні додаються й видаляються, чужий токен не видалити', async () => {
  const s = await makeSecure();
  const [a, b] = [await s.as('north'), await s.as('viewer')];
  const body = { token: 'a'.repeat(40), platform: 'android' };
  assert.equal((await a.post('/api/v1/push-tokens').send(body)).status, 204);
  assert.equal((await b.delete(`/api/v1/push-tokens/${body.token}`)).status, 204);
  assert.equal(s.db.prepare('SELECT count(*) n FROM push_tokens').get().n, 1, 'чужий токен лишився');
  assert.equal((await a.delete(`/api/v1/push-tokens/${body.token}`)).status, 204);
  assert.equal(s.db.prepare('SELECT count(*) n FROM push_tokens').get().n, 0);
  assert.equal((await a.post('/api/v1/push-tokens').send({ ...body, user: 'someone-else' })).status, 204);
  const owner = s.db.prepare('SELECT user_id FROM push_tokens').pluck().get();
  assert.equal(owner, s.ids.north, 'власник береться з токена доступу, а не з тіла запиту');
});
