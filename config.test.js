'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { loadSecurityConfig, describe } = require('./config');

const key = () => randomBytes(32).toString('base64');
const good = () => ({ JWT_KEYS: `k2:${key()},k1:${key()}`, JWT_CURRENT: 'k2',
  WEBHOOK_SECRETS: `${randomBytes(24).toString('hex')},${randomBytes(24).toString('hex')}`,
  INGEST_DEVICES: '^gh1-', ALLOWED_ORIGINS: 'https://app.example,http://localhost:5173' });

test('коректне середовище: два ключі, два секрети вебхука, початок ідентифікаторів', () => {
  const cfg = loadSecurityConfig(good());
  assert.equal(cfg.enabled, true);
  assert.deepEqual(Object.keys(cfg.keys), ['k2', 'k1']);
  assert.equal(cfg.current, 'k2');
  assert.equal(cfg.webhookSecrets.length, 2);
  assert.ok(cfg.devicePattern.test('gh1-s01') && !cfg.devicePattern.test('x-gh1-s01'));
  assert.deepEqual(cfg.origins, ['https://app.example', 'http://localhost:5173']);
});

test('порожнє середовище зупиняє запуск і називає всі проблеми одразу', () => {
  assert.throws(() => loadSecurityConfig({}), (e) => {
    for (const part of ['JWT_KEYS: не задано', 'JWT_CURRENT', 'WEBHOOK_SECRETS: не задано']) {
      assert.ok(e.message.includes(part), part);
    }
    return true;
  });
});

test('короткий або схожий на заповнювач ключ відхиляється; повідомлення не містить значень', () => {
  const short = Buffer.alloc(16, 'ab').toString('base64');
  const filler = Buffer.alloc(32, 'A').toString('base64');
  const env = { ...good(), JWT_KEYS: `k1:${short},k2:${filler},k3` , JWT_CURRENT: 'k1',
    WEBHOOK_SECRETS: 'short-secret', ALLOWED_ORIGINS: 'https://app.example/path', INGEST_DEVICES: '(' };
  assert.throws(() => loadSecurityConfig(env), (e) => {
    assert.match(e.message, /ключ k1 коротший за 32 байтів/);
    assert.match(e.message, /ключ k2 схожий на заповнювач/);
    assert.match(e.message, /очікується kid:base64/);
    assert.match(e.message, /WEBHOOK_SECRETS: кожен секрет від 32 символів/);
    assert.match(e.message, /ALLOWED_ORIGINS/);
    assert.match(e.message, /INGEST_DEVICES: не є регулярним виразом/);
    for (const secret of [short, filler, 'short-secret']) assert.ok(!e.message.includes(secret));
    return true;
  });
});

test('секрет вебхука з повторюваних символів відхиляється, значення в повідомлення не потрапляє', () => {
  const filler = 'a'.repeat(40);
  assert.throws(() => loadSecurityConfig({ ...good(), WEBHOOK_SECRETS: `${good().WEBHOOK_SECRETS},${filler}` }), (e) => {
    assert.match(e.message, /WEBHOOK_SECRETS: секрет схожий на заповнювач/);
    assert.ok(!e.message.includes(filler));
    return true;
  });
});

test('JWT_CURRENT має бути серед ключів кільця', () => {
  assert.throws(() => loadSecurityConfig({ ...good(), JWT_CURRENT: 'k9' }), /JWT_CURRENT/);
});

test('AUTH_DISABLED=1 вимикає безпеку явно; опис для журналу не містить секретів', () => {
  assert.deepEqual(loadSecurityConfig({ AUTH_DISABLED: '1' }), { enabled: false });
  assert.deepEqual(describe({ enabled: false }), { auth: false });
  const env = good();
  const text = JSON.stringify(describe(loadSecurityConfig(env)));
  for (const part of env.JWT_KEYS.split(',').map((x) => x.split(':')[1]).concat(env.WEBHOOK_SECRETS.split(','))) {
    assert.ok(!text.includes(part));
  }
  assert.match(text, /"jwt_kids":\["k2","k1"\]/);
});
