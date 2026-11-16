'use strict';
const express = require('express');
const { createApi, problemHandler } = require('./api');
const { createIngest } = require('./core');
const { createLimiter } = require('./ratelimit');
const { createCommands } = require('./commands');
const { GREENHOUSE } = require('./metrics');
const { createStreamHandler } = require('./sse');
const { OPEN_AUTH } = require('./auth');
const { createMobileApi } = require('./mobile-api');

// limits — для клієнтів застосунку; limits.ingest — окремий, значно вищий ліміт для платформи.
// auth (розділ 6) вмикає вхід, ролі й область доступу; ingestAuth — підпис вебхука;
// mobile — параметри кінцевих точок мобільного клієнта (потребують auth)
function createServer({ db, state, sink, clock = Date.now, feed, sse, auth = OPEN_AUTH, ingestAuth,
                       allowDevice, mobile, ops,
                       limits = { rate: 1, burst: 10, ingest: { rate: 100, burst: 200 } }, log = () => {} }) {
  const app = express();
  app.disable('x-powered-by');                  // версія фреймворку атакувальникові не потрібна
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
  // Операційні метрики (розділ 7): час запитів і сторінка /metrics. Проксі її назовні не віддає
  if (ops) {
    app.use(ops.http);
    app.get('/metrics', async (req, res) => {
      res.set('Content-Type', ops.registry.contentType);
      res.end(await ops.registry.metrics());
    });
  }
  // Liveness: процес відповідає. Зовнішні залежності не перевіряємо
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  // Readiness: чи може екземпляр обслуговувати трафік
  app.get('/readyz', (req, res) => {
    let dbOk = true;
    try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    const ready = dbOk && state.mqttConnected;
    res.status(ready ? 200 : 503).json({
      db: dbOk,
      mqtt: state.mqttConnected,
      lastReadingAgeSec: state.lastReadingAt === null ? null
        : Math.round((Date.now() - state.lastReadingAt) / 1000),
    });
  });

  const commands = createCommands({ db, sink, clock });
  const limiter = createLimiter({ ...limits, clock });
  const ingestLimiter = createLimiter({ ...(limits.ingest ?? limits), clock });
  // Ліміт API рахується за користувачем (розділ 6): користувачі за одним NAT не ділять кошик.
  // Запити без чинного токена, зокрема вхід, рахуються за адресою
  const [userMw, ingestMw] = [limiter.middleware(auth.limitKey), ingestLimiter.middleware()];
  // SSE-потік пристрою (розділ 3): той самий ліміт, що й в усього API
  if (feed) {
    const streamAuth = auth.enabled ? [auth.streamAccess] : [];
    app.get('/api/v1/devices/:id/stream', userMw, ...streamAuth,
      createStreamHandler({ db, feed, metrics: GREENHOUSE,
        keyOf: (req) => req.user?.sub ?? req.ip,
        ...(auth.enabled && { valid: (req) => auth.stillValid(req.user) }), ...sse }));
  }
  const mobileApi = auth.enabled && mobile
    ? [createMobileApi({ db, auth, clock, identify: (req) => req.user.sub,
        session: (req) => req.user.sid, ...mobile })] : [];
  app.use('/api/v1',
    // Помилку віддає обробник верхнього рівня, де baseUrl уже порожній: префікс для мітки route запам’ятовуємо тут
    (req, res, next) => { res.locals.routeBase = req.baseUrl; next(); },
    (req, res, next) => (req.path.startsWith('/ingest/') ? ingestMw : userMw)(req, res, next),
    ...(auth.enabled ? [auth.router] : []), ...mobileApi,
    createApi({ db, ingest: createIngest(db, clock, feed?.publish), metrics: GREENHOUSE, commands, clock,
      auth, ingestAuth, allowDevice }));
  app.use(problemHandler(log));
  return Object.assign(app, { commands, limiter, ingestLimiter });
}

module.exports = { createServer };
