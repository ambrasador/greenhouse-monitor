'use strict';
// Кінцеві точки мобільного клієнта: токени push і прив’язка пристрою (claim).
// Особу користувача повертає identify(req): у розділі 6 це req.user із JWT,
// а стенди розділу 5 підставляють заголовок X-User (mobile-kit.js)
const express = require('express');
const { ApiError, sendProblem } = require('./problem');
const { OPEN_AUTH } = require('./auth');

const TOKEN_RE = /^[\w:.-]{16,4096}$/;
const PLATFORMS = ['android', 'ios'];

// identify — обов’язкова: типового способу назвати користувача немає навмисно.
// claimCodes вмикає код прив’язки; onClaim(user, device) видає права на пристрій
// Адреси push живуть не довше сеансу, що їх зареєстрував: вихід, повторне пред’явлення
// refresh-токена чи вимкнення облікового запису прибирають їх на сервері, навіть якщо
// застосунок до цього не встиг (вихід без мережі). Використання: createRefresh({ onEnd })
function endPushSessions(db) {
  const byFamily = db.prepare('DELETE FROM push_tokens WHERE session_id = ?');
  const byUser = db.prepare('DELETE FROM push_tokens WHERE user_id = ?');
  return ({ family, user }) => (family ? byFamily.run(family) : byUser.run(user)).changes;
}

function createMobileApi({ db, identify, session = () => null, auth = OPEN_AUTH, claimCodes, onClaim,
  clock = Date.now, periodSec = 60 }) {
  if (typeof identify !== 'function') throw new TypeError('createMobileApi: потрібна функція identify');
  const { guard } = auth;
  const router = express.Router();
  const iso = () => new Date(clock()).toISOString();
  const userOf = identify;

  // ON CONFLICT: та сама адреса від іншого користувача переходить до нього
  const upsert = db.prepare(
    `INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at, session_id)
     VALUES (@token, @kind, @user, @platform, @now, @now, @session)
     ON CONFLICT (token) DO UPDATE SET user_id = @user, platform = @platform,
                                       kind = @kind, refreshed_at = @now, session_id = @session`);
  const remove = db.prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?');

  router.post('/push-tokens', guard('push:write'), express.json({ limit: '8kb' }), (req, res) => {
    const user = userOf(req);
    // Рівно одне з двох: token (SDK ≤ 16) або fid (SDK ≥ 17)
    const { token, fid, platform } = req.body ?? {};
    const kind = fid === undefined ? 'token' : 'fid';
    const address = kind === 'fid' ? fid : token;
    if ((token === undefined) === (fid === undefined) || typeof address !== 'string'
        || !TOKEN_RE.test(address) || !PLATFORMS.includes(platform)) {
      throw new ApiError(400, 'invalid-body',
        'Очікується { token | fid, platform: android | ios }');
    }
    upsert.run({ token: address, kind, user, platform, now: iso(), session: session(req) });
    res.status(204).end();
  });

  // Видалити можна лише власний токен; чужий — тихо ігнорується
  router.delete('/push-tokens/:token', guard('push:write'), (req, res) => {
    remove.run(req.params.token, userOf(req));
    res.status(204).end();
  });

  const known = db.prepare('SELECT 1 FROM devices WHERE device_id = ?');
  const ownerOf = db.prepare('SELECT user_id FROM device_owner WHERE device_id = ?');
  const lastSeen = db.prepare('SELECT max(ts) AS ts FROM latest WHERE device_id = ?');
  const insertOwner = db.prepare(
    'INSERT INTO device_owner (device_id, user_id, claimed_at) VALUES (?, ?, ?)');

  // claim: пристрій має бути в мережі (недавнє вимірювання) і вільним.
  // Повторний claim тим самим користувачем безпечний: 200 замість 409.
  // З кодом прив’язки (claimCodes) чужий пристрій не прив’язати, не знаючи коду
  const claimed = (id) => ownerOf.get(id);
  const take = db.transaction((id, user) => {
    insertOwner.run(id, user, iso());
    claimCodes?.burn(id);
  });
  router.post('/devices/:id/claim', guard('device:claim'), express.json({ limit: '1kb' }), (req, res) => {
    const user = userOf(req);
    const id = req.params.id;
    if (claimed(id)?.user_id === user) return res.status(200).json({ device: id, owner: user });
    claimCodes?.verify(user, id, req.body?.code);       // до будь-яких відповідей про стан пристрою
    if (!known.get(id)) throw new ApiError(404, 'device-not-found', 'Пристрій не знайдено');
    const taken = new ApiError(409, 'already-claimed', 'Пристрій уже прив’язано до іншого облікового запису');
    if (claimed(id)) throw taken;
    const ts = lastSeen.get(id)?.ts;
    if (!ts || clock() - Date.parse(ts) > 3 * periodSec * 1000) {
      throw new ApiError(409, 'device-offline', 'Пристрій ще не вийшов на зв’язок');
    }
    try {
      take(id, user);
    } catch (e) {            // гонка: інший процес встиг першим
      if (e.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') throw e;
      throw taken;
    }
    onClaim?.(user, id);
    res.status(201).json({ device: id, owner: user });
  });

  router.use((err, req, res, next) => (err instanceof ApiError ? sendProblem(res, err) : next(err)));
  return router;
}

module.exports = { createMobileApi, endPushSessions };
