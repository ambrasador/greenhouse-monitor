'use strict';
const express = require('express');
const { ApiError, sendProblem, parseParams } = require('./problem');
const { parseInstant, parseInterval } = require('./timeq');
const { decodeCursor, encodeCursor, createRawReader } = require('./pagination');
const { createAggregator } = require('./aggregate');
const { createAlertReader } = require('./alerts');
const { createWebhook } = require('./webhook');
const { COMMANDS } = require('./commands');
const { createSettings, validateSettings } = require('./settings');
const { AGGREGATES } = require('./metrics');
const { OPEN_AUTH } = require('./auth');

// Бюджет ≈ 100 мс на запит: better-sqlite3 синхронний, і довгий запит зупиняє весь процес.
// Межі випливають із виміряної вартості рядка: агрегат 0,2 мкс, сповіщення 1,6 мкс (розділ 2.4)
const MAX_ROWS = { agg: 500_000, alerts: 60_000 };
// Маршрут розділу 1 залишено до дати Sunset: RFC 9745 (Deprecation) і RFC 8594 (Sunset)
const DEPRECATED = { Deprecation: '@1793664000', Sunset: new Date('2027-05-03T00:00:00Z').toUTCString() };
const num = (s) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : null);
const int = (lo, hi) => (s) => { const n = Number(s); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
const oneOf = (...xs) => (s) => (xs.includes(s) ? s : null);
const validZone = (s) => { try { new Intl.DateTimeFormat('en', { timeZone: s }); return s; } catch { return null; } };

// auth — шар безпеки (auth.js); без нього API відкрите, як у розділах 2–5.
// ingestAuth — перевірка підпису вебхука; allowDevice — межа інтеграції
function createApi({ db, ingest, metrics, commands, clock = Date.now, auth = OPEN_AUTH,
  ingestAuth, allowDevice }) {
  const { guard, access, audit } = auth;
  const router = express.Router();
  const readRaw = createRawReader(db);
  const aggregate = createAggregator(db);
  const readAlerts = createAlertReader(db);
  const settings = createSettings(db, clock);
  const deviceExists = db.prepare('SELECT 1 FROM devices WHERE device_id = ?');
  // Чужий пристрій відповідає так само, як неіснуючий: 404 не розкриває, що він є (API1)
  const needDevice = (req, id) => {
    if (!deviceExists.get(id) || !access.can(req, id)) {
      throw new ApiError(404, 'device-not-found', 'Пристрій не знайдено', { device: id });
    }
  };

  const checkWindow = (p) => {
    if (p.from >= p.to) {
      throw new ApiError(400, 'invalid-query', 'Некоректні параметри запиту',
        { errors: [{ param: 'from', message: 'from має бути раніше за to' }] });
    }
  };

  function guardCost(kind, p, meta) {
    const rows = (p.to - p.from) / (meta.periodSec * 1000);     // очікувана кількість вимірювань у вікні
    if (rows > MAX_ROWS[kind]) {
      throw new ApiError(400, 'window-too-large', 'Вікно містить забагато вимірювань: звузьте його',
        { estimated_rows: Math.round(rows), max_rows: MAX_ROWS[kind] });
    }
  }

  const common = {
    device: { required: true, hint: 'до 32 символів: літери, цифри, «-», «_»',
              parse: (s) => (/^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : null) },
    metric: { required: true, hint: `одна з: ${[...metrics.keys()].join(', ')}`,
              parse: (s) => (metrics.has(s) ? s : null) },
    from: { required: true, parse: parseInstant, hint: 'час UTC, наприклад 2026-11-03T12:00:00Z' },
    to: { required: true, parse: parseInstant, hint: 'час UTC, наприклад 2026-11-03T13:00:00Z' },
  };
  const RAW = { ...common,
    limit: { default: 500, parse: int(1, 1000), hint: 'ціле від 1 до 1000' },
    cursor: { parse: (s) => s || null, hint: 'значення next з попередньої відповіді' },
    order: { default: 'asc', parse: oneOf('asc', 'desc'), hint: 'asc або desc' } };
  const AGG = { ...common,
    agg: { required: true, parse: (s) => s.split(','), hint: 'список: avg, min, max, sum, delta, count' },
    interval: { required: true, parse: parseInterval, hint: '1m–30m, 1h–12h (дільники 60 і 24), 1d, 1mo' },
    tz: { default: 'UTC', parse: validZone, hint: 'назва зони IANA, наприклад Europe/Kyiv' },
    fill: { default: 'none', parse: oneOf('none', 'null'), hint: 'none або null' } };

  const listDevices = db.prepare(
    `SELECT d.device_id AS id, d.name, d.zone, d.created_at,
            (SELECT max(ts) FROM latest l WHERE l.device_id = d.device_id) AS last_seen
       FROM devices d WHERE d.device_id > @after AND (@zone IS NULL OR d.zone = @zone)
        ${auth.scopeSql}
      ORDER BY d.device_id LIMIT @limit`);
  router.get('/devices', guard('device:read'), (req, res) => {
    const p = parseParams(req.query, {
      zone: { parse: (s) => s || null, hint: 'непорожній рядок' },
      limit: RAW.limit, cursor: RAW.cursor });
    const q = { zone: p.zone ?? null };
    const after = p.cursor ? decodeCursor(p.cursor, q) : '';
    const rows = listDevices.all({ after, zone: q.zone, limit: p.limit + 1, ...access.visible(req) });
    const more = rows.length > p.limit;
    if (more) rows.pop();
    res.json({ data: rows, next: more ? encodeCursor(rows.at(-1).id, q) : null });
  });

  const latestOf = db.prepare('SELECT metric, ts, value FROM latest WHERE device_id = ? ORDER BY metric');
  const deviceById = db.prepare('SELECT device_id AS id, name, zone, created_at FROM devices WHERE device_id = ?');
  router.get('/devices/:id', guard('device:read'), (req, res) => {
    needDevice(req, req.params.id);
    const d = deviceById.get(req.params.id);
    res.json({ ...d, latest: latestOf.all(d.id).map((r) => ({ ...r, unit: metrics.get(r.metric)?.unit })) });
  });

  router.get('/devices/:id/latest', guard('device:read'), (req, res) => {   // застарілий: замінено полем latest
    needDevice(req, req.params.id);
    res.set(DEPRECATED).json(latestOf.all(req.params.id));
  });

  router.get('/telemetry', guard('telemetry:read'), (req, res) => {
    const aggMode = req.query.agg !== undefined;
    const p = parseParams(req.query, aggMode ? AGG : RAW);
    checkWindow(p);
    needDevice(req, p.device);
    const meta = metrics.get(p.metric);
    const [lo, hi] = [new Date(p.from).toISOString(), new Date(p.to).toISOString()];
    if (!aggMode) {
      return res.json(readRaw({ ...p, from: lo, to: hi }));
    }
    guardCost('agg', p, meta);
    const bad = p.agg.filter((a) => !AGGREGATES[meta.kind].includes(a));
    if (bad.length) {
      throw new ApiError(400, 'invalid-aggregate', `Для метрики типу ${meta.kind} недопустимі агрегати: ${bad.join(', ')}`,
        { allowed: AGGREGATES[meta.kind] });
    }
    let buckets;
    try { buckets = aggregate({ ...p, kind: meta.kind }); }
    catch (e) {
      if (e instanceof RangeError) throw new ApiError(400, 'too-many-buckets', 'Забагато інтервалів: збільште interval або звузьте вікно');
      throw e;
    }
    const keep = new Set(['start', 'count', ...p.agg]);
    res.json({ data: buckets.map((b) => Object.fromEntries(Object.entries(b).filter(([k]) => keep.has(k))) ),
               interval: req.query.interval, tz: p.tz });
  });

  const ALERT = { ...common,
    op: { required: true, parse: oneOf('lt', 'gt'), hint: 'lt (нижче порога) або gt (вище)' },
    threshold: { required: true, parse: num, hint: 'число' },
    hysteresis: { default: 0, parse: (s) => { const n = num(s); return n !== null && n >= 0 ? n : null; }, hint: 'невід’ємне число' },
    min_duration: { default: 0, parse: int(0, 86_400), hint: 'секунди, 0–86400' },
    max_gap: { parse: int(1, 86_400), hint: 'секунди, 1–86400; за замовчуванням 3 періоди метрики' } };
  router.get('/alerts', guard('telemetry:read'), (req, res) => {
    const p = parseParams(req.query, ALERT);
    checkWindow(p);
    needDevice(req, p.device);
    guardCost('alerts', p, metrics.get(p.metric));
    const maxGap = p.max_gap ?? 3 * metrics.get(p.metric).periodSec;
    res.json({ data: readAlerts(p, { op: p.op, threshold: p.threshold, hysteresis: p.hysteresis,
      minDurationMs: p.min_duration * 1000, maxGapMs: maxGap * 1000 }) });
  });

  router.post('/ingest/webhook', ...(ingestAuth ?? [express.json({ limit: '256kb' })]),
    createWebhook({ db, ingest, allow: allowDevice, audit }));

  router.post('/devices/:id/commands', guard('command:create'), express.json({ limit: '4kb' }), async (req, res) => {
    needDevice(req, req.params.id);
    const { name, params } = req.body ?? {};
    const idemKey = req.get('Idempotency-Key') ?? undefined;
    if (!COMMANDS[name]?.(params) || (idemKey !== undefined && !/^[\w-]{8,64}$/.test(idemKey))) {
      throw new ApiError(400, 'invalid-command', 'Невідома команда, некоректні параметри або Idempotency-Key');
    }
    const { command, created } = await commands.create({ deviceId: req.params.id, name, params, idemKey });
    if (created) {
      audit.record({ actor: req.user?.sub, action: 'command.create', target: req.params.id,
        ip: req.ip, detail: { command: command.id, name, params } });
    }
    res.status(202).location(`/api/v1/commands/${command.id}`).json(command);
  });
  router.get('/commands/:id', guard('command:read'), (req, res) => {
    const c = commands.get(req.params.id);
    if (!c || !access.can(req, c.device_id)) throw new ApiError(404, 'command-not-found', 'Команду не знайдено');
    res.json(c);
  });

  // PUT замінює налаштування цілком; версія в ETag; зміна лише з If-Match
  const etagOf = (version) => `"${version}"`;
  const holds = (header, version) => (header.trim() === '*' ? version > 0
    : header.split(',').map((t) => t.trim()).includes(etagOf(version)));
  const json4kb = express.json({ limit: '4kb' });
  router.get('/devices/:id/settings', guard('settings:read'), (req, res) => {
    needDevice(req, req.params.id);
    const s = settings.get(req.params.id);
    res.set('ETag', etagOf(s.version)).json(s.body);
  });
  const canWrite = guard('settings:write');
  router.put('/devices/:id/settings', canWrite, json4kb, (req, res) => {
    needDevice(req, req.params.id);
    const errors = validateSettings(req.body);
    if (errors.length) {
      throw new ApiError(400, 'invalid-body', 'Некоректні налаштування',
        { errors });
    }
    const ifMatch = req.get('If-Match');
    if (ifMatch === undefined) {
      throw new ApiError(428, 'precondition-required',
        'Потрібен If-Match: передайте ETag, отриманий у GET');
    }
    const stale = (cur) => new ApiError(412, 'precondition-failed',
      'Налаштування змінено після вашого читання',
      { current: cur.body, current_etag: etagOf(cur.version) });
    const cur = settings.get(req.params.id);
    if (!holds(ifMatch, cur.version)) throw stale(cur);
    const saved = settings.put(req.params.id, cur.version, req.body);
    if (!saved) throw stale(settings.get(req.params.id));   // гонка процесів
    audit.record({ actor: req.user?.sub, action: 'settings.update',
      target: req.params.id, ip: req.ip,
      detail: { version: saved.version, before: cur.body,
        after: saved.body } });
    res.set('ETag', etagOf(saved.version)).json(saved.body);
  });

  router.use((req, res, next) => next(new ApiError(404, 'not-found', 'Ресурс не знайдено')));
  return router;
}

// Єдиний обробник помилок: кожна відповідь про помилку — application/problem+json
function problemHandler(log = () => {}) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ApiError) return sendProblem(res, err);
    if (err.type === 'entity.parse.failed') return sendProblem(res, new ApiError(400, 'invalid-json', 'Тіло запиту не є коректним JSON'));
    if (err.type === 'entity.too.large') return sendProblem(res, new ApiError(413, 'too-large', 'Тіло запиту завелике'));
    log('unhandled', { message: err.message, stack: err.stack });
    return sendProblem(res, new ApiError(500, 'internal', 'Внутрішня помилка сервера'));
  };
}

module.exports = { createApi, problemHandler };
