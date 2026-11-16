'use strict';
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { ApiError } = require('./problem');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const invalid = (why) => new ApiError(401, 'invalid-grant', 'Сеанс недійсний, потрібен новий вхід', { reason: why });

// Refresh-токен — 256 випадкових біт, тож швидкого SHA-256 досить: перебір
// неможливий, а витік бази не розкриває самих токенів
// onEnd({ family } | { user }) викликають після анулювання: хто тримав дані сеансу (адреси
// push), може їх прибрати
function createRefresh({ db, clock = Date.now, ttlSec = 30 * 86400, leewaySec = 10, audit,
  onEnd = () => {} }) {
  const iso = (ms = clock()) => new Date(ms).toISOString();
  const insert = db.prepare(
    `INSERT INTO refresh_tokens (token_hash, family_id, user_id, issued_at, expires_at)
     VALUES (@hash, @family, @user, @now, @expires)`);
  const byHash = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?');
  const markUsed = db.prepare(
    `UPDATE refresh_tokens SET used_at = @now
      WHERE token_hash = @hash AND used_at IS NULL AND revoked_at IS NULL`);
  const revokeFamily = db.prepare(
    'UPDATE refresh_tokens SET revoked_at = @now WHERE family_id = @family AND revoked_at IS NULL');
  const revokeUser = db.prepare(
    'UPDATE refresh_tokens SET revoked_at = @now WHERE user_id = @user AND revoked_at IS NULL');
  const purge = db.prepare('DELETE FROM refresh_tokens WHERE expires_at < @before');

  function issue(user, family = randomUUID()) {
    const token = randomBytes(32).toString('base64url');
    insert.run({ hash: sha256(token), family, user, now: iso(), expires: iso(clock() + ttlSec * 1000) });
    return { token, family };
  }

  // Обмін токена на новий. Усе в одній транзакції; помилку повертаємо як
  // значення й кидаємо ПІСЛЯ коміту: виняток усередині відкотив би анулювання
  const exchange = db.transaction((token) => {
    const row = byHash.get(sha256(token));
    const now = clock();
    if (!row || row.revoked_at) return { fail: 'unknown' };
    if (Date.parse(row.expires_at) <= now) return { fail: 'expired' };
    if (row.used_at) {
      if (now - Date.parse(row.used_at) <= leewaySec * 1000) {
        return { ...issue(row.user_id, row.family_id), user: row.user_id,
          leeway: true };
      }
      revokeFamily.run({ family: row.family_id, now: iso() });
      return { fail: 'reuse', user: row.user_id, family: row.family_id };
    }
    markUsed.run({ hash: row.token_hash, now: iso() });
    return { ...issue(row.user_id, row.family_id), user: row.user_id };
  });

  function rotate(token, ctx = {}) {
    const r = exchange(token);
    if (r.fail === 'reuse') {
      audit?.record({ actor: r.user, action: 'refresh.reuse', target: r.family, outcome: 'revoked', ip: ctx.ip });
      onEnd({ family: r.family });
    }
    if (r.fail) throw invalid(r.fail);
    return r;
  }

  return {
    issue,
    rotate,
    revokeByToken: (token) => {
      const row = byHash.get(sha256(token));
      if (row) {
        revokeFamily.run({ family: row.family_id, now: iso() });
        onEnd({ family: row.family_id });
      }
    },
    revokeAllOf: (user) => {
      const n = revokeUser.run({ user, now: iso() }).changes;
      onEnd({ user });
      return n;
    },
    purgeExpired: (graceMs = 7 * 86400_000) => purge.run({ before: iso(clock() - graceMs) }).changes,
    sha256,
  };
}

module.exports = { createRefresh };
