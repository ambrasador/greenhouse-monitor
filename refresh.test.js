'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSecure } = require('./auth-kit');

const reject = (fn) => { try { fn(); } catch (e) { return `${e.status} ${e.code} ${e.extra?.reason}`; } return 'прийнято'; };
const count = (db, where) => db.prepare(`SELECT count(*) AS n FROM refresh_tokens WHERE ${where}`).get().n;

test('ротація: старий токен позначено використаним, новий — у тій самій родині; у базі лише хеші', async () => {
  const s = await makeSecure();
  const first = s.refresh.issue(s.ids.agro);
  const next = s.refresh.rotate(first.token);
  assert.notEqual(next.token, first.token);
  assert.equal(next.family, first.family);
  assert.equal(count(s.db, 'used_at IS NOT NULL'), 1);
  const stored = s.db.prepare('SELECT * FROM refresh_tokens').all().flatMap((r) => Object.values(r));
  assert.ok(!stored.includes(first.token) && !stored.includes(next.token), 'токени у відкритому вигляді не зберігаються');
  assert.match(first.token, /^[\w-]{43}$/, '256 біт у base64url');
});

test('повторне пред’явлення після вікна поблажливості анулює всю родину, включно з новим токеном', async () => {
  const s = await makeSecure({ leewaySec: 10 });
  const first = s.refresh.issue(s.ids.agro);
  const second = s.refresh.rotate(first.token);
  s.clock.tick(11_000);
  assert.equal(reject(() => s.refresh.rotate(first.token)), '401 invalid-grant reuse');
  assert.equal(reject(() => s.refresh.rotate(second.token)), '401 invalid-grant unknown', 'законний власник теж мусить увійти заново');
  assert.equal(count(s.db, 'revoked_at IS NULL'), 0);
  assert.equal(s.audit.list({ limit: 5 })[0].action, 'refresh.reuse');
});

test('анулювання переживає виняток: його кидають після коміту транзакції', async () => {
  const s = await makeSecure({ leewaySec: 0 });
  const first = s.refresh.issue(s.ids.agro);
  s.refresh.rotate(first.token);
  s.clock.tick(1_000);
  assert.throws(() => s.refresh.rotate(first.token), { code: 'invalid-grant' });
  assert.equal(count(s.db, 'revoked_at IS NOT NULL'), 2, 'відкат транзакції стер би анулювання');
});

test('вікно поблажливості: повтор через втрачену відповідь дає ще один токен, не анулювання', async () => {
  const s = await makeSecure({ leewaySec: 10 });
  const first = s.refresh.issue(s.ids.agro);
  const a = s.refresh.rotate(first.token);
  s.clock.tick(3_000);
  const b = s.refresh.rotate(first.token);                       // клієнт не отримав відповіді й повторив
  assert.notEqual(a.token, b.token);
  assert.equal(count(s.db, 'revoked_at IS NOT NULL'), 0);
  s.clock.tick(8_000);                                           // 11 с від першого використання
  assert.equal(reject(() => s.refresh.rotate(first.token)), '401 invalid-grant reuse');
});

test('строк дії, вихід і незалежність родин', async () => {
  const s = await makeSecure({ refreshTtlSec: 100 });
  const a = s.refresh.issue(s.ids.agro);
  const b = s.refresh.issue(s.ids.agro);                         // другий пристрій: окрема родина
  assert.notEqual(a.family, b.family);
  s.refresh.revokeByToken(a.token);
  assert.equal(reject(() => s.refresh.rotate(a.token)), '401 invalid-grant unknown');
  const bNext = s.refresh.rotate(b.token);
  s.clock.tick(101_000);
  assert.equal(reject(() => s.refresh.rotate(bNext.token)), '401 invalid-grant expired');
  assert.equal(s.refresh.purgeExpired(0), 3);
});

test('вимкнення користувача анулює всі його родини', async () => {
  const s = await makeSecure();
  const t1 = s.refresh.issue(s.ids.north);
  s.refresh.issue(s.ids.north);
  const other = s.refresh.issue(s.ids.agro);
  s.users.disable(s.ids.north);
  assert.equal(reject(() => s.refresh.rotate(t1.token)), '401 invalid-grant unknown');
  assert.doesNotThrow(() => s.refresh.rotate(other.token));
});
