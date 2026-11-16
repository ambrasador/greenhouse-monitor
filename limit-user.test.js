'use strict';
// Ліміт запитів API рахується за користувачем; без чинного токена — за адресою клієнта
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSecure } = require('./auth-kit');

// Три запити й жодного поповнення: кошик порожніє остаточно, тож тест не залежить від годинника
const API_LIMITS = { rate: 1e-6, burst: 3, ingest: { rate: 1e6, burst: 1e6 } };
const burst = async (call, n = 4) => {
  const codes = [];
  for (let i = 0; i < n; i++) codes.push((await call(i)).status);
  return codes;
};

test('двоє користувачів за однією адресою мають окремі кошики', async () => {
  const s = await makeSecure({ apiLimits: API_LIMITS });
  // два входи беруть із кошика адреси два з трьох токенів; далі запити йдуть за користувачами
  const [north, agro] = [await s.as('north'), await s.as('agro')];
  assert.deepEqual(await burst(() => north.get('/api/v1/auth/me')), [200, 200, 200, 429]);
  assert.deepEqual(await burst(() => agro.get('/api/v1/auth/me')), [200, 200, 200, 429],
    'вичерпаний кошик north не зачіпає agro, хоча адреса в них одна');
});

test('відповідь 429 називає паузу в Retry-After', async () => {
  const s = await makeSecure({ apiLimits: API_LIMITS });
  const me = await s.as('north');
  await burst(() => me.get('/api/v1/auth/me'), 3);
  const r = await me.get('/api/v1/auth/me');
  assert.equal(r.status, 429);
  assert.match(r.body.type, /rate-limited$/);
  assert.ok(Number(r.headers['retry-after']) > 0);
});

test('недійсні токени рахуються за адресою: підроблений користувач не дає нового кошика', async () => {
  const s = await makeSecure({ apiLimits: API_LIMITS });
  const junk = (i) => s.request().get('/api/v1/auth/me').set('Authorization', `Bearer junk.token.${i}`);
  assert.deepEqual(await burst(junk, 5), [401, 401, 401, 429, 429]);
  assert.deepEqual(await burst(() => s.request().get('/api/v1/auth/me'), 2), [429, 429], 'анонім ділить кошик адреси');
});

test('токен перевіряється один раз на запит: ключ ліміту передає користувача в guard', async () => {
  const s = await makeSecure();
  const me = await s.as('north');
  const verify = s.tokens.verifyAccess;
  let calls = 0;
  s.tokens.verifyAccess = (token) => { calls++; return verify(token); };
  assert.equal((await me.get('/api/v1/auth/me')).status, 200);
  assert.equal(calls, 1);
});
