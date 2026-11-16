'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { addDevice, seed } = require('./testkit');
const { makeMobileDb, headerIdentity } = require('./mobile-kit');
const { createMobileApi } = require('./mobile-api');
const { problemHandler } = require('./api');

const NOW = Date.parse('2026-11-04T12:00:00Z');
const TOKEN_A = 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'fcm-token-bbbbbbbbbbbbbbbbbbbbbbbb';

function setup() {
  const db = makeMobileDb();
  addDevice(db, 'gh1');
  const app = express();
  app.use('/api/v1', createMobileApi({ db, clock: () => NOW, identify: headerIdentity }));
  app.use(problemHandler());
  return { app, db };
}
const as = (r, user) => r.set('X-User', user);

test('push-tokens: без входу 401, некоректне тіло 400', async () => {
  const { app } = setup();
  const r = await request(app).post('/api/v1/push-tokens').send({ token: TOKEN_A, platform: 'android' });
  assert.equal(r.status, 401);
  assert.match(r.type, /problem\+json/);
  for (const body of [{}, { token: 'short', platform: 'android' }, { token: TOKEN_A, platform: 'windows' }]) {
    const bad = await as(request(app).post('/api/v1/push-tokens'), 'u1').send(body);
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
});

test('push-tokens: fid зберігається з видом fid; token і fid разом — 400', async () => {
  const { app, db } = setup();
  const FID = 'fid-cccccccccccccccccccccccc';
  await as(request(app).post('/api/v1/push-tokens'), 'u1').send({ fid: FID, platform: 'android' }).expect(204);
  assert.equal(db.prepare('SELECT kind FROM push_tokens WHERE token = ?').get(FID).kind, 'fid');
  await as(request(app).post('/api/v1/push-tokens'), 'u1').send({ token: TOKEN_A, platform: 'android' }).expect(204);
  assert.equal(db.prepare('SELECT kind FROM push_tokens WHERE token = ?').get(TOKEN_A).kind, 'token');
  const both = await as(request(app).post('/api/v1/push-tokens'), 'u1')
    .send({ token: TOKEN_A, fid: FID, platform: 'android' });
  assert.equal(both.status, 400);
});

test('push-tokens: повторна реєстрація оновлює мітку, але не створює дубль', async () => {
  const { app, db } = setup();
  await as(request(app).post('/api/v1/push-tokens'), 'u1').send({ token: TOKEN_A, platform: 'android' }).expect(204);
  await as(request(app).post('/api/v1/push-tokens'), 'u1').send({ token: TOKEN_A, platform: 'android' }).expect(204);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_tokens').get().n, 1);
});

test('push-tokens: токен переходить до того, хто увійшов на телефоні останнім', async () => {
  const { app, db } = setup();
  await as(request(app).post('/api/v1/push-tokens'), 'u1').send({ token: TOKEN_A, platform: 'ios' });
  await as(request(app).post('/api/v1/push-tokens'), 'u2').send({ token: TOKEN_A, platform: 'ios' });
  const row = db.prepare('SELECT user_id FROM push_tokens WHERE token = ?').get(TOKEN_A);
  assert.equal(row.user_id, 'u2');
});

test('push-tokens: видалити можна лише власний токен', async () => {
  const { app, db } = setup();
  await as(request(app).post('/api/v1/push-tokens'), 'u1').send({ token: TOKEN_A, platform: 'android' });
  await as(request(app).post('/api/v1/push-tokens'), 'u2').send({ token: TOKEN_B, platform: 'android' });
  await as(request(app).delete(`/api/v1/push-tokens/${TOKEN_B}`), 'u1').expect(204);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_tokens').get().n, 2, 'чужий токен лишився');
  await as(request(app).delete(`/api/v1/push-tokens/${TOKEN_A}`), 'u1').expect(204);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_tokens').get().n, 1);
});

test('claim: 404, 401, офлайн-пристрій, вільний пристрій, повтор, чужий', async () => {
  const { app, db } = setup();
  await as(request(app).post('/api/v1/devices/nope/claim'), 'u1').expect(404);
  await request(app).post('/api/v1/devices/gh1/claim').expect(401);

  // даних немає зовсім
  let r = await as(request(app).post('/api/v1/devices/gh1/claim'), 'u1');
  assert.equal(r.status, 409);
  assert.match(r.body.type, /device-offline$/);

  // останнє вимірювання 4 хв тому: більше за 3 періоди по 60 с
  seed(db, { device: 'gh1', metric: 'temperature', start: NOW - 4 * 60_000, count: 1, values: [20] });
  r = await as(request(app).post('/api/v1/devices/gh1/claim'), 'u1');
  assert.equal(r.status, 409);
  assert.match(r.body.type, /device-offline$/);

  // свіже вимірювання → прив’язка
  seed(db, { device: 'gh1', metric: 'temperature', start: NOW - 30_000, count: 1, values: [21] });
  await as(request(app).post('/api/v1/devices/gh1/claim'), 'u1').expect(201);
  // повтор тим самим користувачем безпечний (втрачена відповідь)
  await as(request(app).post('/api/v1/devices/gh1/claim'), 'u1').expect(200);
  r = await as(request(app).post('/api/v1/devices/gh1/claim'), 'u2');
  assert.equal(r.status, 409);
  assert.match(r.body.type, /already-claimed$/);
  assert.equal(db.prepare('SELECT user_id FROM device_owner').get().user_id, 'u1');
});
