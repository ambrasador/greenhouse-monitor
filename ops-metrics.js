'use strict';
const client = require('prom-client');

// Межі кошиків у секундах: від 0,5 мс (транзакція SQLite) до 5 с
// (межа терпіння клієнта)
const BUCKETS = [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5];

// Службові адреси, які не належать до API: проби й опитування метрик
const SERVICE_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

// Поля stats розсилника push (push.js) і значення мітки result, під яким
// вони потрапляють у метрики
const PUSH_RESULTS = {
  sent: 'sent', unregistered: 'unregistered', invalid: 'invalid',
  config: 'config', retries: 'retry', expired: 'expired',
  gaveUp: 'gave_up', noRecipients: 'no_recipients',
};

// Операційні метрики: що відбувається із самим сервісом, а не з теплицею
// (каталог показників пристроїв лежить у metrics.js). Мітки мають скінченну
// множину значень: пристрої й користувачі в мітки не потрапляють, бо кожна
// комбінація значень — окремий ряд
function createOpsMetrics({ feed, state, defaults = true } = {}) {
  const registry = new client.Registry();
  if (defaults) client.collectDefaultMetrics({ register: registry });
  const reg = { registers: [registry] };

  // result: stored, duplicate, rejected
  const readings = new client.Counter({
    name: 'greenhouse_readings_total',
    help: 'Повідомлення телеметрії за результатом приймання',
    labelNames: ['result'], ...reg });
  const rejected = new client.Counter({
    name: 'greenhouse_rejected_total',
    help: 'Відхилені повідомлення за причиною',
    labelNames: ['reason'], ...reg });
  const ingest = new client.Histogram({
    name: 'greenhouse_ingest_seconds',
    help: 'Час опрацювання одного повідомлення: перевірка й транзакція',
    buckets: BUCKETS, ...reg });
  const http = new client.Histogram({
    name: 'greenhouse_http_request_seconds',
    help: 'Тривалість HTTP-запиту до API',
    labelNames: ['method', 'route', 'status'],
    buckets: BUCKETS, ...reg });
  const audit = new client.Counter({
    name: 'greenhouse_audit_events_total',
    help: 'Події журналу аудиту',
    labelNames: ['action', 'outcome'], ...reg });

  // Ряд, якого ще немає, Prometheus не бачить: перший приріст лічильника,
  // що з’явився одразу зі значенням 1, правила rate() та increase() не
  // враховують. Тому ряди, за якими йдуть сповіщення, створюються нулями
  // при старті
  for (const result of ['stored', 'duplicate', 'rejected']) {
    readings.inc({ result }, 0);
  }
  for (const [action, outcome] of [['refresh.reuse', 'revoked'],
    ['webhook', 'rejected'], ['login', 'fail'], ['login', 'ok']]) {
    audit.inc({ action, outcome }, 0);
  }

  // Значення беруться в момент опитування, тож розбіжності зі станом не
  // накопичуються
  new client.Gauge({
    name: 'greenhouse_feed_subscriptions',
    help: 'Підписки шини подій: по одній на потік SSE і одна на весь шлюз '
      + 'Socket.IO',
    collect() { this.set(feed ? feed.size() : 0); }, ...reg });
  new client.Gauge({
    name: 'greenhouse_broker_connected',
    help: '1, якщо з’єднання з брокером встановлено',
    collect() { this.set(state.mqttConnected ? 1 : 0); }, ...reg });
  new client.Gauge({
    name: 'greenhouse_last_reading_timestamp_seconds',
    help: 'Час останнього повідомлення від брокера (Unix, с); 0, поки '
      + 'повідомлень не було',
    collect() {
      const at = state.lastReadingAt;
      this.set(at === null ? 0 : at / 1000);
    }, ...reg });

  return {
    registry,
    // result: stored | duplicate | причина відхилення; seconds — час
    // опрацювання, якщо він був
    recordIngest(result, seconds) {
      const ok = result === 'stored' || result === 'duplicate';
      readings.inc({ result: ok ? result : 'rejected' });
      if (!ok) rejected.inc({ reason: result });
      if (seconds !== undefined) ingest.observe(seconds);
    },
    recordAudit: (action, outcome) => audit.inc({ action, outcome }),
    // Лічильники stats розсилника push (розділ 5) віддаються як метрика:
    // expired, gave_up, invalid і config означають втрачену тривогу, яку
    // правила самі не повторять
    trackPush(stats) {
      new client.Counter({
        name: 'greenhouse_push_total',
        help: 'Доставка push за результатом',
        labelNames: ['result'], ...reg,
        collect() {
          this.reset();   // значення беруться зі stats, а не накопичуються
          for (const [field, result] of Object.entries(PUSH_RESULTS)) {
            this.inc({ result }, stats[field]);
          }
        } });
    },
    // Відкриті з’єднання Socket.IO. Шлюз підписується на шину один раз за
    // всіх клієнтів, тому greenhouse_feed_subscriptions їх кількості не
    // показує. count викликається під час опитування
    trackSockets(count) {
      new client.Gauge({
        name: 'greenhouse_ws_connections',
        help: 'Відкриті з’єднання Socket.IO (WebSocket)',
        collect() { this.set(count()); }, ...reg });
    },
    // Потоки (SSE) закінчуються обривом, а не відповіддю, тому в гістограму
    // не потрапляють: їх рахує greenhouse_feed_subscriptions. Проби й
    // сторінка метрик — не трафік користувачів: їхні 503 під час збою
    // брокера не мають спалювати бюджет помилок API
    http(req, res, next) {
      if (SERVICE_PATHS.has(req.path)) return next();
      const t0 = process.hrtime.bigint();
      res.on('finish', () => {
        const route = req.route
          ? (res.locals.routeBase ?? req.baseUrl) + String(req.route.path)
          : 'unmatched';
        http.observe({ method: req.method, status: res.statusCode, route },
          Number(process.hrtime.bigint() - t0) / 1e9);
      });
      next();
    },
  };
}

module.exports = { createOpsMetrics, BUCKETS };
