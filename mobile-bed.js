'use strict';
// Стенд розділу 5: еталонний сервер розділів 2–4 + кінцеві точки мобільного
// клієнта + диспетчер push з імітацією FCM + проксі, що губить відповіді.
// Керування стендом (поява вимірювання, збої) — окремий порт.
// З параметром auth (розділ 6) ядро працює з реальним входом: замість заголовка
// X-User — токени, ролі й область доступу; годинником сервера керує /advance
const http = require('node:http');
const express = require('express');
const { makeMobileDb, headerIdentity } = require('./mobile-kit');
const { addDevice, seed } = require('./testkit');
const { createServer } = require('./server');
const { makeSecurity } = require('./auth-kit');
const { createFeed } = require('./feed');
const { createIngest } = require('./core');
const { createMobileApi } = require('./mobile-api');
const { problemHandler } = require('./api');
const { createAlertTracker, createDispatcher, createFcmClient } = require('./push');
const { createFakeFcm } = require('./fake-fcm');
const { createFaultProxy } = require('./fault-proxy');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function startMobileBed({ devices = [['gh1-s01', 'north'], ['gh1-s02', 'south']], sse = {},
  bare = [['gh1-new', 'south']], history = 120, clock: wall = Date.now, auth } = {}) {
  let skew = 0;                                // на скільки мс «перемотано» годинник сервера
  const clock = () => wall() + skew;
  const db = makeMobileDb();
  const feed = createFeed({ windowMs: 20 });
  const now = clock();
  for (const [id, zone] of devices) {
    addDevice(db, id, zone);
    for (const [metric, base] of [['soil_moisture', 41], ['temperature', 26]]) {
      seed(db, { device: id, metric, start: now - history * 60_000, count: history + 1,
        values: (i) => Math.round((base + 2 * Math.sin(i / 9)) * 10) / 10 });
    }
  }
  // «Нові» пристрої: зареєстровані, але ще жодного разу не виходили на зв’язок
  for (const [id, zone] of bare) addDevice(db, id, zone);
  const security = auth && await makeSecurity({ db, clock, ...auth });
  const core = createServer({ db, state: { mqttConnected: true, lastReadingAt: null },
    sink: { async send() {} }, feed, sse, clock, ...security?.server,
    limits: { rate: 1e6, burst: 1e6, ingest: { rate: 1e6, burst: 1e6 } } });
  const ingest = createIngest(db, clock, feed.publish);

  const fake = createFakeFcm();
  const fcmPort = await fake.listen();
  const dispatcher = createDispatcher({ db, clock, ttlSec: 600,
    fcm: createFcmClient({ baseUrl: `http://127.0.0.1:${fcmPort}`, project: fake.project,
      getAccessToken: async () => 'test-access-token' }),
    sleep: async () => {} });
  feed.subscribe('*', dispatcher.onReadings(createAlertTracker({ clock })));

  const app = express();
  if (!security) app.use('/api/v1', createMobileApi({ db, clock, identify: headerIdentity }));
  app.use(core);
  app.use(problemHandler());
  const apiServer = http.createServer(app);
  const apiPort = await listen(apiServer);
  const proxy = createFaultProxy({ targetPort: apiPort });
  const proxyPort = await proxy.listen();

  // Керування: тест сам «є пристроєм» і сам вмикає збої
  const ctl = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url;
      if (path === '/reading') {
        const ts = body.ts ?? new Date(clock()).toISOString();
        return json(res, 200, { result: ingest.accept({ deviceId: body.device, metric: body.metric, ts, value: body.value }) });
      }
      if (path === '/fault') { proxy.configure(body); return json(res, 200, {}); }
      if (path === '/fcm/valid-token') { fake.validTokens.add(body.token); return json(res, 200, {}); }
      if (path === '/stats') {
        return json(res, 200, {
          commands: db.prepare('SELECT count(*) AS n FROM commands').get().n,
          proxy: proxy.stats, push: dispatcher.stats, delivered: fake.delivered,
          rejected: fake.rejected, tokens: db.prepare('SELECT token, user_id FROM push_tokens').all(),
          audit: security?.audit.list({ limit: 200 }).map((r) => `${r.action}:${r.outcome}`),
        });
      }
      if (path === '/advance') { skew += body.sec * 1000; return json(res, 200, {}); }
      if (security && path === '/auth/claim-code') {
        return json(res, 200, { code: security.claimCodes.issue(body.device) });
      }
      if (security && path === '/auth/disable') {
        security.users.disable(security.ids[body.username]);
        return json(res, 200, {});
      }
      if (path === '/owner') {
        db.prepare('INSERT OR REPLACE INTO device_owner VALUES (?, ?, ?)').run(body.device, body.user, new Date(clock()).toISOString());
        return json(res, 200, {});
      }
      return json(res, 404, {});
    });
  });
  const ctlPort = await listen(ctl);

  return {
    db, feed, ingest, dispatcher, fake, proxy,
    api: `http://127.0.0.1:${apiPort}/api/v1/`,
    lossy: `http://127.0.0.1:${proxyPort}/api/v1/`,
    ctl: `http://127.0.0.1:${ctlPort}`,
    async close() {
      await proxy.close();
      for (const s of [apiServer, ctl]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
      await fake.close();
    },
  };
}

module.exports = { startMobileBed };
