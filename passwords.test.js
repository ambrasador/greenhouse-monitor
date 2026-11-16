'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scryptSync, randomBytes } = require('node:crypto');
const { hashPassword, verifyPassword, needsRehash, createGate, createPasswordService } = require('./passwords');

const FAST = { N: 2 ** 10, r: 8, p: 1 };

test('хеш має формат scrypt$N$r$p$сіль$ключ; та сама пара пароль/сіль не повторюється', async () => {
  const a = await hashPassword('correct horse battery', FAST);
  const b = await hashPassword('correct horse battery', FAST);
  assert.match(a, /^scrypt\$1024\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
  assert.notEqual(a, b, 'сіль випадкова, тож хеші різні');
  assert.ok(await verifyPassword('correct horse battery', a));
  assert.ok(await verifyPassword('correct horse battery', b));
});

test('хибний пароль, пошкоджений і чужий запис не проходять', async () => {
  const h = await hashPassword('correct horse battery', FAST);
  assert.equal(await verifyPassword('Correct horse battery', h), false);
  // Знак змінюють усередині ключа. Останній знак base64url для 32 байтів несе лише 4 значущі біти
  // із 6: заміна 'A' на 'B' давала б ті самі байти, і тест падав у кожному шістнадцятому запуску
  const at = h.length - 6;
  const tampered = h.slice(0, at) + (h[at] === 'A' ? 'B' : 'A') + h.slice(at + 1);
  // Негативний тест спершу доводить, що вхід справді зіпсовано: порівнюються байти ключа, а не рядки
  const bytes = (rec) => Buffer.from(rec.split('$').at(-1), 'base64url');
  assert.notDeepEqual(bytes(tampered), bytes(h));
  assert.equal(await verifyPassword('correct horse battery', tampered), false);
  for (const junk of ['', 'plain', 'bcrypt$10$x$y', 'scrypt$3$8$1$AA$AA', 'scrypt$1024$8$99$AA$AA', 'scrypt$1048576$32$1$AA$AA']) {
    assert.equal(await verifyPassword('x', junk), false, junk);
  }
});

test('пароль нормалізується NFKC: повноширинні символи дають той самий хеш', async () => {
  const h = await hashPassword('password-1234', FAST);
  assert.ok(await verifyPassword('ｐａｓｓｗｏｒｄ-１２３４', h));
});

test('параметри читаються із запису; слабший запис просить оновлення', async () => {
  const old = await hashPassword('x'.repeat(12), FAST);
  assert.equal(needsRehash(old, FAST), false);
  assert.equal(needsRehash(old, { N: 2 ** 11, r: 8, p: 1 }), true);
  assert.equal(needsRehash('мотлох'), true);
});

test('Node без підвищеного maxmem відхиляє N=2^16; наш derive його приймає', async () => {
  const prm = { N: 2 ** 16, r: 8, p: 1 };           // 64 МіБ, поріг за замовчуванням — 32 МіБ
  assert.throws(() => scryptSync('x', randomBytes(16), 32, prm), { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' });
  const h = await hashPassword('x'.repeat(12), prm);
  assert.ok(await verifyPassword('x'.repeat(12), h));
});

test('шлюз: двоє працюють, двоє чекають, п’ятий отримує 503 із Retry-After', async () => {
  const gate = createGate(2, 2);
  const open = [];
  const job = () => gate(() => new Promise((resolve) => open.push(resolve)));
  const running = [job(), job(), job(), job()];
  await new Promise((r) => setImmediate(r));
  assert.equal(open.length, 2, 'у роботі лише двоє');
  await assert.rejects(job(), (e) => e.status === 503 && e.headers['Retry-After'] === '1');
  open.shift()();                                       // звільнилося одне місце
  await new Promise((r) => setImmediate(r));
  assert.equal(open.length, 2, 'місце перейшло до першого з черги');
  while (open.length) open.shift()();
  await new Promise((r) => setImmediate(r));
  while (open.length) open.shift()();
  await Promise.all(running);
  const after = gate(async () => 'ok');                  // лічильник повернувся до нуля
  assert.equal(await after, 'ok');
});

test('сервіс паролів: hash і verify проходять через шлюз', async () => {
  const svc = createPasswordService({ params: FAST, concurrency: 1, maxQueue: 0 });
  const h = await svc.hash('x'.repeat(12));
  assert.ok(await svc.verify('x'.repeat(12), h));
  const slow = svc.hash('y'.repeat(12));
  await assert.rejects(svc.hash('z'.repeat(12)), { status: 503 });
  await slow;
});
