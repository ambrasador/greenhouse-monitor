'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSecure, PASSWORD } = require('./auth-kit');
const { ApiError } = require('./problem');
const { SLOTS } = require('./auth');
const { createUsers } = require('./users');

const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timed = async (fn) => { const t0 = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };

test('вхід: відповідь у формі RFC 6749 §5.1, без кешування, без хешу пароля', async () => {
  const s = await makeSecure();
  const r = await s.login('agro');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['token_type', 'access_token', 'expires_in', 'refresh_token']);
  assert.equal(r.body.token_type, 'Bearer');
  assert.equal(r.body.expires_in, 900);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers.pragma, 'no-cache');
  assert.ok(!JSON.stringify(r.body).includes('scrypt'));
});

test('хибний пароль і невідоме ім’я дають однакову відповідь', async () => {
  const s = await makeSecure();
  const wrong = await s.login('agro', 'wrong password!!');
  const unknown = await s.login('nobody', 'wrong password!!');
  for (const r of [wrong, unknown]) {
    assert.equal(r.status, 401);
    assert.equal(r.body.type, 'https://greenhouse.example/problems/invalid-credentials');
    assert.match(r.headers['www-authenticate'], /^Bearer realm=/);
  }
  assert.deepEqual(wrong.body, unknown.body);
});

test('час відповіді не видає, чи існує обліковий запис (холостий хеш)', async () => {
  const s = await makeSecure({ params: { N: 2 ** 13, r: 8, p: 1 } });          // ≈ 8 МіБ, кілька мілісекунд
  await s.login('nobody', 'x'.repeat(14));                                      // розігрів: холостий хеш рахується раз
  const known = [], unknown = [];
  for (let i = 0; i < 9; i++) {
    known.push(await timed(() => s.login('agro', `wrong-${i}-password`)));
    unknown.push(await timed(() => s.login(`nobody${i}`, `wrong-${i}-password`)));
  }
  const ratio = median(unknown) / median(known);
  assert.ok(ratio > 0.6 && ratio < 1.7, `відношення медіан ${ratio.toFixed(2)} має бути близьким до 1`);
});

test('GET /auth/me повертає дозволений список полів, а не рядок таблиці', async () => {
  const s = await makeSecure();
  const north = await s.as('north');
  const r = await north.get('/api/v1/auth/me');
  assert.deepEqual(r.body, { id: s.ids.north, username: 'north', role: 'operator', scopes: ['zone:north'] });
});

test('без токена — 401 без error; з хибним — error="invalid_token"; прострочений — token-expired', async () => {
  const s = await makeSecure();
  const none = await s.request().get('/api/v1/devices');
  assert.equal(none.status, 401);
  assert.equal(none.headers['www-authenticate'], 'Bearer realm="greenhouse-api"');
  const bad = await s.request().get('/api/v1/devices').set('Authorization', 'Bearer abc.def.ghi');
  assert.equal(bad.headers['www-authenticate'], 'Bearer realm="greenhouse-api", error="invalid_token"');
  const basic = await s.request().get('/api/v1/devices').set('Authorization', 'Basic YTpi');
  assert.equal(basic.status, 401);
  const a = await s.as('agro');
  s.clock.tick(901_000);
  const old = await a.get('/api/v1/devices');
  assert.equal(old.status, 401);
  assert.match(old.body.type, /token-expired$/);
});

test('оновлення: нова пара працює, стара refresh-пара — ні; крадіжка виявляється', async () => {
  const s = await makeSecure({ leewaySec: 5 });
  const login = (await s.login('agro')).body;
  const rf = (token) => s.request().post('/api/v1/auth/refresh').send({ refresh_token: token });
  const second = await rf(login.refresh_token);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.refresh_token, login.refresh_token);
  s.clock.tick(6_000);
  const thief = await rf(login.refresh_token);                                   // злодій з украденим старим токеном
  assert.equal(thief.status, 401);
  assert.match(thief.body.type, /invalid-grant$/);
  assert.equal((await rf(second.body.refresh_token)).status, 401, 'родину анульовано: потрібен новий вхід');
});

test('вихід анулює родину; повторний вихід і сміття — також 204', async () => {
  const s = await makeSecure();
  const { refresh_token: rt } = (await s.login('agro')).body;
  const out = (body) => s.request().post('/api/v1/auth/logout').send(body);
  assert.equal((await out({ refresh_token: rt })).status, 204);
  assert.equal((await out({ refresh_token: rt })).status, 204);
  assert.equal((await out({ refresh_token: 12 })).status, 204);
  assert.equal((await s.request().post('/api/v1/auth/refresh').send({ refresh_token: rt })).status, 401);
});

test('вимкнення, зміна ролі й «вийти звідусіль» діють негайно, не чекаючи кінця токена', async () => {
  const s = await makeSecure();
  const agro = await s.as('agro');
  const cmd = () => agro.post('/api/v1/devices/gh1-s01/commands').send({ name: 'irrigate', params: { duration_sec: 5 } });
  assert.equal((await cmd()).status, 202);
  s.users.changeRole(s.ids.agro, 'viewer');
  assert.equal((await agro.get('/api/v1/devices')).status, 401, 'токен із старою версією відхилено');
  const again = await s.as('agro');                                              // новий вхід: роль viewer
  assert.equal((await again.post('/api/v1/devices/gh1-s01/commands').send({ name: 'irrigate', params: { duration_sec: 5 } })).status, 403);
  s.users.disable(s.ids.agro);
  assert.equal((await again.get('/api/v1/devices')).status, 401);
  assert.equal((await s.login('agro')).status, 401);
  const north = await s.as('north');
  s.users.signOutEverywhere(s.ids.north);
  const r = await north.get('/api/v1/devices');
  assert.equal(r.status, 401);
  assert.match(r.body.type, /token-revoked$/);
});

test('ліміт спроб входу: за IP і за іменем, з Retry-After', async () => {
  const s = await makeSecure({ limits: { ip: { rate: 1e-6, burst: 3 }, user: { rate: 1e-6, burst: 100 } } });
  for (let i = 0; i < 3; i++) assert.equal((await s.login('agro', 'wrong password!!')).status, 401);
  const blocked = await s.login('agro');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  const t = await makeSecure({ limits: { ip: { rate: 1e6, burst: 1e6 }, user: { rate: 1e-6, burst: 2 } } });
  for (let i = 0; i < 2; i++) await t.login('agro', 'wrong password!!');
  assert.equal((await t.login('agro')).status, 429, 'навіть правильний пароль чекає: ліміт на ім’я');
  assert.equal((await t.login('north')).status, 200, 'інше ім’я не постраждало');
});

test('ліміт за іменем не росте від вигаданих імен: пам’ять обмежена комірками', async () => {
  assert.equal(SLOTS, 4096);
  const s = await makeSecure({ slots: 32, limits: { ip: { rate: 1e6, burst: 1e6 }, user: { rate: 1 / 60, burst: 5 } } });
  for (let i = 0; i < 400; i++) await s.login(`nobody-${i}`, 'x'.repeat(12));
  const size = s.auth.limiters.byName.size();
  assert.ok(size > 16 && size <= 32, `комірок ${size}`);
});

test('відмова холостого хешу (503) не кешується: наступний вхід із невідомим іменем працює', async () => {
  const s = await makeSecure();
  const real = s.passwords.hash;
  let calls = 0;
  s.passwords.hash = (pw) => (++calls === 1 ? Promise.reject(new ApiError(503, 'busy', 'Сервер зайнятий')) : real(pw));
  assert.equal((await s.login('nobody', 'x'.repeat(12))).status, 503);
  assert.equal((await s.login('nobody', 'x'.repeat(12))).status, 401);
});

test('некоректні тіла: 400; завеликі — 413; пароль не потрапляє в журнал аудиту', async () => {
  const s = await makeSecure();
  const post = (body) => s.request().post('/api/v1/auth/login').send(body);
  for (const bad of [{}, { username: 'a' }, { username: 1, password: 'x' }, { username: 'a', password: 'x'.repeat(257) }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await post({ username: 'agro', password: 'p'.repeat(3000) })).status, 413);
  await s.login('agro', 'secret-guess-123456');
  const log = JSON.stringify(s.audit.list());
  assert.ok(!log.includes('secret-guess'));
  assert.ok(s.audit.list().some((e) => e.action === 'login' && e.outcome === 'fail'));
});

test('вхід зі старим хешем оновлює його до поточних параметрів', async () => {
  const s = await makeSecure({ params: { N: 2 ** 11, r: 8, p: 1 } });
  const old = await require('./passwords').hashPassword(PASSWORD, { N: 2 ** 10, r: 8, p: 1 });
  s.db.prepare('UPDATE users SET pw_hash = ? WHERE username = ?').run(old, 'agro');
  assert.equal((await s.login('agro')).status, 200);
  const now = () => s.db.prepare('SELECT pw_hash FROM users WHERE username = ?').get('agro').pw_hash;
  assert.ok(now().startsWith('scrypt$2048$8$1$'), now().slice(0, 20));
  assert.equal((await s.login('agro')).status, 200, 'новий хеш приймається');
});

test('політика пароля: від 15 до 128 символів Unicode, перелік поширених, NFKC', async () => {
  const s = await makeSecure();
  const users = createUsers({ db: s.db, passwords: s.passwords, refresh: s.refresh, clock: s.clock,
    blocked: (p) => p === 'correct horse battery' });
  let n = 0;
  const create = (password) => users.create({ username: `policy${++n}`, password, role: 'viewer' });
  await assert.rejects(create('a'.repeat(14)), /від 15 до 128/);
  await create('a'.repeat(15));
  await create('я'.repeat(15));                                  // 15 символів, хоч 30 байтів
  await create('😀'.repeat(15));                                 // 15 символів, хоч 30 одиниць UTF-16
  await assert.rejects(create('😀'.repeat(14)), /від 15 до 128/);
  await create('a'.repeat(128));
  await assert.rejects(create('a'.repeat(129)), /від 15 до 128/);
  await assert.rejects(create(12345678901234568), /від 15 до 128/);
  await assert.rejects(create('correct horse battery'), /є в переліку/);
  // повноширинні літери після NFKC дають той самий пароль, тож перелік їх теж бачить
  await assert.rejects(create('ｃｏｒｒｅｃｔ ｈｏｒｓｅ ｂａｔｔｅｒｙ'), /є в переліку/);
});
