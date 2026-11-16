'use strict';
const express = require('express');
const { createHash, randomBytes } = require('node:crypto');
const { ApiError, parseParams } = require('./problem');
const { unauthorized } = require('./tokens');
const { ACTIONS } = require('./policy');
const { createScope, VISIBLE_SQL } = require('./scope');
const { createLimiter } = require('./ratelimit');
const { normName } = require('./users');

const REALM = 'Bearer realm="greenhouse-api"';
const SLOTS = 4096;

// Без автентифікації працюють стенди розділів 2–5 і їхні тести: guard лише
// позначає дію, область доступу не обмежує, журнал нічого не пише
const OPEN_AUTH = {
  enabled: false,
  limitKey: (req) => req.ip,
  guard: (action) => Object.assign((req, res, next) => next(), { action }),
  access: { can: () => true, visible: () => ({}) },
  scopeSql: '',
  audit: { record() {} },
};

function createAuth({ db, tokens, refresh, passwords, audit, clock = Date.now, slots = SLOTS,
  limits = { ip: { rate: 1 / 10, burst: 20 }, user: { rate: 1 / 60, burst: 5 } } }) {
  const scope = createScope(db);
  const userById = db.prepare(
    'SELECT user_id, username, role, token_version, disabled_at FROM users WHERE user_id = ?');
  const userByName = db.prepare(
    `SELECT user_id, username, pw_hash, role, token_version, disabled_at
       FROM users WHERE username = ?`);
  const deviceExists = db.prepare('SELECT 1 FROM devices WHERE device_id = ?');
  const byIp = createLimiter({ ...limits.ip, clock });
  const byName = createLimiter({ ...limits.user, clock });
  // Ліміт за іменем не має створювати запис на кожне вигадане ім’я: беремо хеш у
  // 4096 комірок. Пам’ять обмежена, а за відповіддю не відрізнити існуюче ім’я
  const slot = (name) => createHash('sha256').update(name).digest().readUInt16BE(0) % slots;
  let dummy;               // хеш для невідомого імені: той самий scrypt, що й для справжнього
  const dummyHash = () => (dummy ??= passwords.hash(randomBytes(16).toString('hex'))
    .catch((e) => { dummy = undefined; throw e; }));   // відмову (503) не кешуємо

  // Токен → користувач. Підпис і строк перевіряє tokens, чинність облікового
  // запису — рядок у БД: вимкнення або зміна ролі діють негайно (ver)
  const live = (row, ver) => Boolean(row) && !row.disabled_at && row.token_version === ver;
  function identify(token, kind = 'verifyAccess') {
    const claims = tokens[kind](token);
    const row = userById.get(claims.sub);
    if (!live(row, claims.ver)) throw unauthorized('token-revoked', true);
    return { sub: row.user_id, name: row.username, role: row.role, exp: claims.exp,
      ver: claims.ver, jti: claims.jti, dev: claims.dev, sid: claims.sid };
  }
  // Довге з’єднання перевіряє себе саме: токен ухвалено раз, а обліковий запис міг змінитися
  const stillValid = (user) => live(userById.get(user.sub), user.ver);
  const bearer = (req) => /^Bearer ([\w~+/.-]+=*)$/i.exec(req.get('Authorization') ?? '')?.[1];

  // Ключ ліміту запитів: автентифікований користувач, а без чинного токена — адреса клієнта.
  // Токен перевіряється тут, і authenticate удруге його не перевіряє: бере готовий req.user
  function limitKey(req) {
    const token = bearer(req);
    if (token) {
      try {
        req.user = identify(token);
        return `user:${req.user.sub}`;
      } catch { /* недійсний токен ліміт не збільшує: рахуємо за адресою */ }
    }
    return `ip:${req.ip}`;
  }

  function authenticate(req, res, next) {
    if (req.user) return next();
    const token = bearer(req);
    if (!token) return next(unauthorized());
    try {
      req.user = identify(token);
      next();
    } catch (e) {
      next(e);
    }
  }

  // guard(дія) = автентифікація + рольова перевірка; властивість action
  // читає тест матриці
  function guard(action) {
    const roles = ACTIONS[action];
    // невідома дія — помилка складання, а не запиту
    if (!roles) throw new Error(`невідома дія ${action}`);
    return Object.assign((req, res, next) => authenticate(req, res, (err) => {
      if (err) return next(err);
      if (!roles.includes(req.user.role)) {
        audit.record({ actor: req.user.sub, action: 'authz.denied',
          target: action, outcome: 'denied', ip: req.ip });
        return next(new ApiError(403, 'forbidden',
          'Недостатньо прав для цієї дії'));
      }
      next();
    }), { action });
  }

  const access = {
    can: (req, device) => scope.canSee(req.user, device),
    visible: (req) => scope.visible(req.user),
  };

  // Потік: токен у заголовку (клієнти з fetch) або короткочинний квиток
  // у ?ticket (EventSource не вміє задавати заголовки). Чужий або
  // неіснуючий пристрій — 404
  const streamAccess = Object.assign(function streamAccess(req, res, next) {
    try {
      const ticket = req.query.ticket;
      let user;
      if (typeof ticket === 'string') {
        user = identify(ticket, 'verifyTicket');
        if (user.dev !== req.params.id) {
          throw unauthorized('invalid-token', true);
        }
      } else {
        const token = bearer(req);
        if (!token) throw unauthorized();
        user = identify(token);
      }
      if (!ACTIONS['stream:read'].includes(user.role)) {
        throw new ApiError(403, 'forbidden',
          'Недостатньо прав для цієї дії');
      }
      const id = req.params.id;
      if (!deviceExists.get(id) || !scope.canSee(user, id)) {
        throw new ApiError(404, 'device-not-found', 'Пристрій не знайдено');
      }
      req.user = user;
      next();
    } catch (e) {
      next(e);
    }
  }, { action: 'stream:read' });

  const noStore = (res) => res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });   // RFC 6749, 5.1
  const tokenResponse = (res, row, refreshToken, sid) => noStore(res).json({
    token_type: 'Bearer',
    access_token: tokens.signAccess(row, sid),
    expires_in: tokens.accessTtlSec,
    refresh_token: refreshToken,
  });

  const router = express.Router();
  const json = express.json({ limit: '2kb' });
  const throttle = (limiter, key) => {
    const r = limiter.take(key);
    if (!r.ok) {
      throw new ApiError(429, 'rate-limited', 'Забагато спроб входу',
        { retry_after_sec: r.retryAfterSec }, { 'Retry-After': String(r.retryAfterSec) });
    }
  };

  router.post('/auth/login', json, async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string'
        || !username || !password
        || username.length > 64 || password.length > 256) {
      throw new ApiError(400, 'invalid-body',
        'Очікується { username, password }');
    }
    const name = normName(username);
    throttle(byIp, req.ip);
    throttle(byName, slot(name));
    const row = userByName.get(name);
    const stored = row?.pw_hash ?? await dummyHash();
    const ok = await passwords.verify(password, stored);
    if (!row || !ok || row.disabled_at) {
      audit.record({ actor: row?.user_id, action: 'login',
        target: name.slice(0, 64), outcome: 'fail', ip: req.ip });
      throw new ApiError(401, 'invalid-credentials',
        'Невірне ім’я користувача або пароль',
        {}, { 'WWW-Authenticate': REALM });
    }
    // параметри посилили: оновлюємо хеш при вході
    if (passwords.needsRehash(row.pw_hash)) {
      db.prepare('UPDATE users SET pw_hash = ? WHERE user_id = ?')
        .run(await passwords.hash(password), row.user_id);
    }
    audit.record({ actor: row.user_id, action: 'login', outcome: 'ok',
      ip: req.ip });
    const session = refresh.issue(row.user_id);
    tokenResponse(res, row, session.token, session.family);
  });

  router.post('/auth/refresh', json, (req, res) => {
    const token = req.body?.refresh_token;
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
      throw new ApiError(400, 'invalid-body', 'Очікується { refresh_token }');
    }
    const next = refresh.rotate(token, { ip: req.ip });
    const row = userById.get(next.user);
    if (!row || row.disabled_at) throw new ApiError(401, 'invalid-grant', 'Сеанс недійсний, потрібен новий вхід');
    tokenResponse(res, row, next.token, next.family);
  });

  // Завжди 204: відповідь не підказує, чи був токен справжнім
  router.post('/auth/logout', json, (req, res) => {
    const token = req.body?.refresh_token;
    if (typeof token === 'string' && token.length <= 128) refresh.revokeByToken(token);
    res.status(204).end();
  });

  // Відповідь складається з дозволеного списку полів, а не з рядка таблиці (API3)
  router.get('/auth/me', guard('self:read'), (req, res) => res.json({
    id: req.user.sub, username: req.user.name, role: req.user.role, scopes: scope.grantsOf(req.user) }));

  router.post('/devices/:id/stream-ticket', guard('stream:read'), (req, res) => {
    if (!deviceExists.get(req.params.id) || !scope.canSee(req.user, req.params.id)) {
      throw new ApiError(404, 'device-not-found', 'Пристрій не знайдено');
    }
    const row = userById.get(req.user.sub);
    noStore(res).json({ ticket: tokens.signTicket(row, req.params.id), expires_in: tokens.ticketTtlSec });
  });

  router.get('/audit', guard('audit:read'), (req, res) => {
    const p = parseParams(req.query, {
      limit: { default: 100, parse: (s) => (/^\d{1,3}$/.test(s) && +s >= 1 && +s <= 500 ? +s : null), hint: 'ціле від 1 до 500' },
      before: { default: Number.MAX_SAFE_INTEGER, parse: (s) => (/^\d{1,15}$/.test(s) ? +s : null), hint: 'id запису' },
      actor: { default: null, parse: (s) => (s.length <= 64 ? s : null), hint: 'до 64 символів' } });
    const data = audit.list(p);
    res.json({ data, next: data.length === p.limit ? data.at(-1).id : null });
  });

  return {
    enabled: true, router, authenticate, guard, access, audit, streamAccess, identify, stillValid, scope, limitKey,
    limiters: { byIp, byName },
    scopeSql: `AND ${VISIBLE_SQL}`,
    canSubscribe: (user, kind, name) => (kind === 'device' ? scope.canSee(user, name) : scope.canSeeZone(user, name)),
    // Socket.IO: той самий токен у socket.handshake.auth.token
    identifySocket(token) {
      if (typeof token !== 'string') throw unauthorized();
      const user = identify(token);
      if (!ACTIONS['stream:read'].includes(user.role)) throw new ApiError(403, 'forbidden', 'Недостатньо прав для цієї дії');
      return user;
    },
  };
}

module.exports = { createAuth, OPEN_AUTH, SLOTS };
