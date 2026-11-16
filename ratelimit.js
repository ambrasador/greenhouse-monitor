'use strict';
const { ApiError } = require('./problem');

// Кошик токенів: поповнення rate токенів за секунду, місткість burst
function createLimiter(opts) {
  const { rate, burst, clock = Date.now, idleMs = 600_000 } = opts;
  const buckets = new Map();
  let lastSweep = clock();

  function take(key) {
    const now = clock();
    if (now - lastSweep > idleMs) {      // прибрати давно неактивні ключі
      for (const [k, b] of buckets) {
        if (now - b.at > idleMs) buckets.delete(k);
      }
      lastSweep = now;
    }
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    const refill = ((now - b.at) / 1000) * rate;
    b.tokens = Math.min(burst, b.tokens + refill);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / rate) };
  }

  const middleware = (keyOf = (req) => req.ip) => (req, res, next) => {
    const r = take(keyOf(req));
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfterSec));
    next(new ApiError(429, 'rate-limited', 'Перевищено ліміт запитів',
      { retry_after_sec: r.retryAfterSec }));
  };
  return { take, middleware, size: () => buckets.size };
}

module.exports = { createLimiter };
