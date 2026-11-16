'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { generateKeyPairSync } = require('node:crypto');
const { createTokens } = require('./tokens');
const { fakeClock, KEYS } = require('./auth-kit');

const user = { user_id: 'u1', role: 'operator', token_version: 3 };
const make = (opts = {}) => {
  const clock = fakeClock();
  return { clock, t: createTokens({ keys: KEYS, current: 'k1', clock, ...opts }) };
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const code = (fn) => { try { fn(); } catch (e) { return `${e.status} ${e.code}`; } return 'прийнято'; };

test('токен доступу: заголовок typ/kid і обов’язкові твердження', () => {
  const { t, clock } = make();
  const token = t.signAccess(user);
  const [h, p] = token.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url')));
  assert.deepEqual(h, { alg: 'HS256', typ: 'at+jwt', kid: 'k1' });
  assert.deepEqual(Object.keys(p).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'role', 'sub', 'ver']);
  assert.equal(p.exp - p.iat, 900);
  assert.equal(p.iat, Math.floor(clock() / 1000));
  assert.equal(t.verifyAccess(token).sub, 'u1');
});

test('строк дії: за секунду до exp токен чинний, у момент exp — ні', () => {
  const { t, clock } = make();
  const token = t.signAccess(user);
  clock.tick(899_000);
  assert.equal(code(() => t.verifyAccess(token)), 'прийнято');
  clock.tick(1_000);
  assert.equal(code(() => t.verifyAccess(token)), '401 token-expired');
});

test('alg=none, інший HS-алгоритм і асиметричний підпис відхиляються списком алгоритмів', () => {
  const { t } = make();
  const payload = { sub: 'u1', ver: 3, iss: 'greenhouse-api', aud: 'greenhouse-api', iat: 1, exp: 4_000_000_000 };
  const none = `${b64({ alg: 'none', typ: 'at+jwt', kid: 'k1' })}.${b64(payload)}.`;
  const hs384 = jwt.sign(payload, KEYS.k1, { algorithm: 'HS384', keyid: 'k1', header: { typ: 'at+jwt' } });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rs256 = jwt.sign(payload, privateKey, { algorithm: 'RS256', keyid: 'k1', header: { typ: 'at+jwt' } });
  for (const bad of [none, hs384, rs256]) assert.equal(code(() => t.verifyAccess(bad)), '401 invalid-token');
});

test('jsonwebtoken приймає токен без exp; наша перевірка — ні', () => {
  const { t } = make();
  const noExp = jwt.sign({ sub: 'u1', ver: 3 }, KEYS.k1, { algorithm: 'HS256', keyid: 'k1',
    issuer: 'greenhouse-api', audience: 'greenhouse-api', header: { typ: 'at+jwt' } });
  assert.doesNotThrow(() => jwt.verify(noExp, KEYS.k1, { algorithms: ['HS256'] }), 'бібліотека не вимагає exp');
  assert.equal(code(() => t.verifyAccess(noExp)), '401 invalid-token');
});

test('чужий ключ, невідомий kid і kid-пастки: завжди 401, ніколи виняток іншого типу', () => {
  const { t } = make();
  const claims = { sub: 'u1', ver: 3, iat: 1, exp: 4_000_000_000 };
  const forge = (key, kid) => jwt.sign(claims, key, { algorithm: 'HS256', keyid: kid,
    issuer: 'greenhouse-api', audience: 'greenhouse-api', header: { typ: 'at+jwt' } });
  assert.equal(code(() => t.verifyAccess(forge('чужий секрет чужий секрет чужий', 'k1'))), '401 invalid-token');
  for (const kid of ['k9', '__proto__', 'constructor', '../../etc/passwd', '']) {
    assert.equal(code(() => t.verifyAccess(forge(KEYS.k1, kid))), '401 invalid-token', kid);
  }
  for (const junk of ['', 'a.b.c', 'x'.repeat(5000), 'eyJ.eyJ.sig', '...']) {
    assert.equal(code(() => t.verifyAccess(junk)), '401 invalid-token', junk.slice(0, 12));
  }
});

test('змінене тіло з тим самим підписом не проходить', () => {
  const { t } = make();
  const [h, p, s] = t.signAccess({ ...user, role: 'viewer' }).split('.');
  const body = { ...JSON.parse(Buffer.from(p, 'base64url')), role: 'admin' };
  assert.equal(code(() => t.verifyAccess(`${h}.${b64(body)}.${s}`)), '401 invalid-token');
});

test('iss і aud перевіряються; квиток потоку не підходить як токен доступу і навпаки', () => {
  const { t } = make();
  const other = createTokens({ keys: KEYS, current: 'k1', issuer: 'інший-сервіс' });
  assert.equal(code(() => t.verifyAccess(other.signAccess(user))), '401 invalid-token');
  const access = t.signAccess(user);
  const ticket = t.signTicket(user, 'gh1-s01');
  assert.equal(code(() => t.verifyTicket(access)), '401 invalid-token');
  assert.equal(code(() => t.verifyAccess(ticket)), '401 invalid-token');
  const c = t.verifyTicket(ticket);
  assert.equal(c.dev, 'gh1-s01');
  assert.equal(c.exp - c.iat, 30);
});

test('ротація ключа: токен старого ключа діє, поки ключ у зв’язці; нові підписує поточний', () => {
  const clock = fakeClock();
  const old = createTokens({ keys: { k1: KEYS.k1 }, current: 'k1', clock });
  const rotated = createTokens({ keys: KEYS, current: 'k2', clock });
  const before = old.signAccess(user);
  assert.equal(rotated.verifyAccess(before).sub, 'u1');
  assert.equal(JSON.parse(Buffer.from(rotated.signAccess(user).split('.')[0], 'base64url')).kid, 'k2');
  const retired = createTokens({ keys: { k2: KEYS.k2 }, current: 'k2', clock });
  assert.equal(code(() => retired.verifyAccess(before)), '401 invalid-token');
});

test('відповідь 401 називає схему Bearer; invalid_token лише коли токен був', () => {
  const { t } = make();
  try { t.verifyAccess('a.b.c'); } catch (e) {
    assert.equal(e.headers['WWW-Authenticate'], 'Bearer realm="greenhouse-api", error="invalid_token"');
  }
});
