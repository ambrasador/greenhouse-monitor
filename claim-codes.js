'use strict';
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { ApiError } = require('./problem');
const { createLimiter } = require('./ratelimit');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';       // RFC 4648, base32
const sha256 = (s) => createHash('sha256').update(s).digest();

// 10 випадкових байтів = 80 біт у 16 символах: XXXX-XXXX-XXXX-XXXX
function newCode() {
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 15; i >= 0; i--) out += ALPHABET[Number((bits >> BigInt(5 * i)) & 31n)];
  return out.match(/.{4}/g).join('-');
}
const canonical = (code) => String(code).toUpperCase().replace(/[^A-Z2-7]/g, '');

// Код друкують на корпусі пристрою; у базі лише його SHA-256 (80 біт випадковості
// не потребують повільного хешу). Спроби обмежено за користувачем
function createClaimCodes({ db, clock = Date.now, limits = { rate: 1 / 60, burst: 5 } }) {
  const limiter = createLimiter({ ...limits, clock });
  const put = db.prepare(
    `INSERT OR REPLACE INTO claim_codes (device_id, code_hash, created_at) VALUES (?, ?, ?)`);
  const get = db.prepare('SELECT code_hash FROM claim_codes WHERE device_id = ?').pluck();
  const del = db.prepare('DELETE FROM claim_codes WHERE device_id = ?');
  const denied = () => new ApiError(403, 'invalid-claim-code', 'Код прив’язки недійсний');

  return {
    issue(device) {
      const code = newCode();
      put.run(device, sha256(canonical(code)).toString('hex'), new Date(clock()).toISOString());
      return code;
    },
    // Єдина відповідь і на «пристрою немає», і на «вже прив’язано», і на «хибний код»
    verify(user, device, code) {
      const r = limiter.take(user);
      if (!r.ok) {
        throw new ApiError(429, 'rate-limited', 'Забагато спроб', { retry_after_sec: r.retryAfterSec },
          { 'Retry-After': String(r.retryAfterSec) });
      }
      const stored = get.get(device);
      const given = sha256(canonical(code ?? ''));
      const want = Buffer.from(stored ?? '0'.repeat(64), 'hex');
      if (!timingSafeEqual(given, want) || !stored) throw denied();
    },
    // Код гасить успішна прив’язка, а не перевірка: збій на пізнішому кроці його не спалює
    burn: (device) => del.run(device),
  };
}

module.exports = { createClaimCodes, newCode };
