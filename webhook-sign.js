'use strict';
const express = require('express');
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { ApiError } = require('./problem');

// Підписується рядок `${t}.${тіло}`: час входить у підпис, тож його не підмінити
const mac = (secret, t, raw) => createHmac('sha256', secret).update(`${t}.`).update(raw).digest();

// Ключ кешу повторів — хеш підписаного рядка, а не заголовка. Заголовок атакувальник
// може переписати (поміняти місцями чи прибрати зайвий v1), підписаний рядок — ні
const seenKey = (t, raw) => createHash('sha256').update(`${t}.`).update(raw).digest('base64url');

// Заголовок X-Signature: t=<unix-секунди>,v1=<hex>[,v1=<hex>] — за зразком Stripe.
// Кілька v1 дозволяють перевипустити секрет без простою
function sign(secret, raw, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${mac(secret, t, raw).toString('hex')}`;
}

function createVerifier({
  secrets, toleranceSec = 300, clock = Date.now, replay = true,
}) {
  // хеш підписаного рядка → мілісекунда, коли запис можна забути
  const seen = new Map();
  let swept = clock();

  // null — підпис чинний; інакше причина відмови (для журналу,
  // не для відповіді)
  function verify(header, raw) {
    const pairs = String(header ?? '').split(',')
      .map((kv) => kv.trim().split('='));
    const t = Number(pairs.find(([k]) => k === 't')?.[1]);
    const sigs = pairs
      .filter(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/.test(v))
      .map(([, v]) => Buffer.from(v, 'hex'));
    if (!Number.isInteger(t) || sigs.length === 0) return 'malformed';
    const now = clock();
    if (Math.abs(now / 1000 - t) > toleranceSec) return 'stale';
    const good = secrets.some((s) => {
      const want = mac(s, t, raw);
      return sigs.some((got) => timingSafeEqual(got, want));
    });
    if (!good) return 'bad-signature';
    if (replay) {
      if (now - swept > toleranceSec * 1000) {
        // старіший за вікно підпис далі і так 'stale'
        for (const [k, until] of seen) if (until < now) seen.delete(k);
        swept = now;
      }
      const key = seenKey(t, raw);
      if (seen.has(key)) return 'replay';
      seen.set(key, (t + toleranceSec) * 1000);
    }
    return null;
  }
  return Object.assign(verify, { size: () => seen.size });
}

// Спершу підпис на сирих байтах і лише потім розбір JSON: тіло, чий підпис не
// збігся, парсер не побачить
function webhookAuth({ verifier, audit, header = 'X-Signature', limit = '256kb' }) {
  const rawBody = express.raw({ type: () => true, limit });
  const check = Object.assign((req, res, next) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const why = verifier(req.get(header), raw);
    if (why) {
      audit.record({ action: 'webhook', outcome: 'rejected', ip: req.ip, detail: { why } });
      return next(new ApiError(401, 'invalid-signature', 'Підпис вебхука недійсний'));
    }
    try {
      req.body = JSON.parse(raw.toString('utf8'));
    } catch {
      return next(new ApiError(400, 'invalid-json', 'Тіло запиту не є коректним JSON'));
    }
    next();
  }, { action: 'ingest:write' });
  return [rawBody, check];
}

module.exports = { sign, createVerifier, webhookAuth };
