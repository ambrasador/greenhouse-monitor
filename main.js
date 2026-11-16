'use strict';
const Database = require('better-sqlite3');
const { createApp } = require('./app');
const { createMqttSource } = require('./mqtt-source');
const { createServer } = require('./server');
const { createMqttCommandChannel } = require('./mqtt-commands');
const { createFeed } = require('./feed');
const { attachRealtime } = require('./realtime');
const { loadSecurityConfig, describe } = require('./config');
const { OPEN_AUTH, createAuth } = require('./auth');
const { createAudit } = require('./audit');
const { createTokens } = require('./tokens');
const { createRefresh } = require('./refresh');
const { createPasswordService } = require('./passwords');
const { createUsers } = require('./users');
const { createClaimCodes } = require('./claim-codes');
const { createVerifier, webhookAuth } = require('./webhook-sign');
const { endPushSessions } = require('./mobile-api');
const { createLogger } = require('./logger');
const { setupSchema } = require('./migrate');
const { createHealthState, trackBroker } = require('./health');
const { createOpsMetrics } = require('./ops-metrics');

// Конфігурація лише зі змінних середовища (12-factor, фактор III)
const cfg = {
  mqttUrl: process.env.MQTT_URL ?? 'mqtt://localhost:1883',
  dbFile: process.env.DB_FILE ?? './greenhouse.db',
  port: Number(process.env.PORT ?? 3000),
  sync: process.env.DB_SYNC ?? 'FULL',
};
const { log } = createLogger();            // рядки JSON у stdout; рівень — LOG_LEVEL
const sec = loadSecurityConfig();          // хибна конфігурація зупиняє запуск до відкриття бази

const db = new Database(cfg.dbFile);
db.pragma('journal_mode = WAL');
db.pragma(`synchronous = ${cfg.sync}`);
const schemas = ['schema.sql', 'schema-api.sql', ...(sec.enabled ? ['schema-mobile.sql', 'schema-auth.sql'] : [])];
setupSchema(db, schemas, { log });         // міграції старої бази, потім CREATE ... IF NOT EXISTS

const state = createHealthState();
const source = createMqttSource({
  url: cfg.mqttUrl,
  clientId: 'ingest-1',
  filter: 'greenhouse/+/telemetry',
});
const feed = createFeed({ onError: (e) => log('feed_error', { message: e.message }) });
const ops = createOpsMetrics({ feed, state });
const app = createApp({ db, source, onStored: feed.publish, observe: ops.recordIngest });
const channel = createMqttCommandChannel({ url: cfg.mqttUrl, clientId: 'api-1' });

async function main() {
  await app.start();                // повертається після першого connect
  trackBroker(source.client, state, { log });
  // Шар безпеки (розділ 6): вхід, ролі, область доступу, підпис вебхука, аудит
  let security = {};
  if (sec.enabled) {
    const audit = createAudit({ db, log, onRecord: ops.recordAudit });
    const tokens = createTokens({ keys: sec.keys, current: sec.current });
    const refresh = createRefresh({ db, audit, onEnd: endPushSessions(db) });
    const passwords = createPasswordService();
    const auth = createAuth({ db, tokens, refresh, passwords, audit });
    const users = createUsers({ db, passwords, refresh });
    security = {
      auth, tokens,
      ingestAuth: webhookAuth({ verifier: createVerifier({ secrets: sec.webhookSecrets }), audit }),
      allowDevice: (id) => sec.devicePattern.test(id),
      mobile: { claimCodes: createClaimCodes({ db }), onClaim: (user, id) => users.grant(user, `device:${id}`) },
    };
    setInterval(() => refresh.purgeExpired(), 3600_000).unref();
  }
  log('security', describe(sec));
  const api = createServer({ db, state, sink: channel, log, feed, ops, auth: security.auth ?? OPEN_AUTH,
    ingestAuth: security.ingestAuth, allowDevice: security.allowDevice, mobile: security.mobile,
    sse: security.tokens && { maxLifetimeMs: security.tokens.accessTtlSec * 1000 } });
  channel.onAck(({ deviceId, id, ok }) => api.commands.ack(id, ok, deviceId));
  const server = api.listen(cfg.port, () => log('listening', { port: cfg.port }));
  const realtime = attachRealtime(server, { db, feed, auth: security.auth, origins: sec.origins });
  ops.trackSockets(() => realtime.io.sockets.sockets.size);
  // повтор відправлення команд і спливання TTL: раз на 5 с
  const sweep = setInterval(() => {
    api.commands.expireOverdue();
    api.commands.dispatchPending().catch((e) => log('dispatch_failed', { message: e.message }));
  }, 5000);

  // Коректне завершення: перестати брати нове, закрити ресурси
  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log('shutdown', { signal, stats: app.stats });
    clearInterval(sweep);
    const closed = realtime.close();   // сокети Socket.IO і слухач HTTP
    server.closeAllConnections();      // SSE-потоки: інакше close() чекає їх
    await closed;                      // нові з’єднання не приймаємо
    await app.stop();             // MQTT: закрити з’єднання
    await channel.close();
    db.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
main();
