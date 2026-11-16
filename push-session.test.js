'use strict';
// Адреси push живуть разом із сеансом: вихід, крадіжка refresh-токена й вимкнення
// облікового запису прибирають їх на сервері, навіть коли застосунок не встиг
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { makeSecure } = require('./auth-kit');

const tokensOf = (s) => s.db.prepare('SELECT token, user_id, session_id FROM push_tokens ORDER BY token').all();
const sid = (access) => jwt.decode(access).sid;

// Новий вхід користувача: окрема родина refresh-токенів, одна зареєстрована адреса
async function device(s, user, letter) {
  const me = await s.as(user);
  const token = letter.repeat(40);
  const r = await me.post('/api/v1/push-tokens').send({ token, platform: 'android' });
  assert.equal(r.status, 204);
  return { me, token, refresh: me.tokens.refresh_token, sid: sid(me.tokens.access_token) };
}

test('токен доступу несе sid, і адреса прив’язується до сеансу, у якому її зареєстровано', async () => {
  const s = await makeSecure();
  const a = await device(s, 'north', 'a');
  const family = s.db.prepare('SELECT family_id FROM refresh_tokens WHERE user_id = ?').pluck().get(s.ids.north);
  assert.equal(a.sid, family);
  assert.deepEqual(tokensOf(s), [{ token: a.token, user_id: s.ids.north, session_id: family }]);
});

test('обмін refresh-токена лишає той самий sid: сеанс один, хоча токени змінюються', async () => {
  const s = await makeSecure();
  const a = await device(s, 'north', 'a');
  const r = await s.request().post('/api/v1/auth/refresh').send({ refresh_token: a.refresh });
  assert.equal(r.status, 200);
  assert.equal(sid(r.body.access_token), a.sid);
});

test('вихід прибирає адреси лише цього сеансу, адреса другого телефона лишається', async () => {
  const s = await makeSecure();
  const phone = await device(s, 'north', 'a');
  const tablet = await device(s, 'north', 'b');
  assert.notEqual(phone.sid, tablet.sid);
  const out = await s.request().post('/api/v1/auth/logout').send({ refresh_token: phone.refresh });
  assert.equal(out.status, 204);
  assert.deepEqual(tokensOf(s).map((t) => t.token), [tablet.token]);
});

test('вихід без попереднього DELETE /push-tokens: застосунок міг не мати мережі', async () => {
  const s = await makeSecure();
  const a = await device(s, 'north', 'a');
  // клієнт вийшов локально, а запит виходу дійшов лише тепер; токена доступу в нього вже немає
  await s.request().post('/api/v1/auth/logout').send({ refresh_token: a.refresh });
  assert.equal(tokensOf(s).length, 0);
});

test('повторне пред’явлення використаного refresh-токена прибирає адреси цієї родини', async () => {
  const s = await makeSecure({ leewaySec: 10 });
  const stolen = await device(s, 'north', 'a');
  const other = await device(s, 'north', 'b');
  const exchange = (t) => s.request().post('/api/v1/auth/refresh').send({ refresh_token: t });
  assert.equal((await exchange(stolen.refresh)).status, 200);
  s.clock.tick(11_000);
  assert.equal((await exchange(stolen.refresh)).status, 401);
  assert.deepEqual(tokensOf(s).map((t) => t.token), [other.token], 'чужа родина не постраждала');
});

test('вимкнення облікового запису й вихід звідусіль прибирають усі адреси користувача', async () => {
  const s = await makeSecure();
  await device(s, 'north', 'a');
  await device(s, 'north', 'b');
  const keep = await device(s, 'agro', 'c');
  s.users.signOutEverywhere(s.ids.north);
  assert.deepEqual(tokensOf(s).map((t) => t.token), [keep.token]);
  await device(s, 'viewer', 'd');
  s.users.disable(s.ids.viewer);
  assert.deepEqual(tokensOf(s).map((t) => t.token), [keep.token]);
});

test('нова адреса того самого телефона від іншого користувача забирає запис і сеанс', async () => {
  const s = await makeSecure();
  const first = await device(s, 'north', 'a');
  const me = await s.as('agro');
  await me.post('/api/v1/push-tokens').send({ token: first.token, platform: 'android' });
  const [row] = tokensOf(s);
  assert.equal(row.user_id, s.ids.agro);
  assert.equal(row.session_id, sid(me.tokens.access_token));
  // вихід попереднього користувача вже не зачіпає адресу, що перейшла до нового
  await s.request().post('/api/v1/auth/logout').send({ refresh_token: first.refresh });
  assert.equal(tokensOf(s).length, 1);
});
