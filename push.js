'use strict';
// Push-сповіщення про порушення порогів: правила з гістерезисом і cooldown,
// повідомлення FCM HTTP v1 і розбір відповідей FCM. Токени й власники беруться
// з бази; сам канал доставки (fcm) підставляється ззовні
const { setTimeout: sleepMs } = require('node:timers/promises');

// Пороги ті самі, що в client/domain.js і lib/core/domain.dart; hysteresis — запас
// повернення, у одиницях метрики
const RULES = new Map([
  ['soil_moisture', { op: 'lt', warn: 35, crit: 30, hysteresis: 2, label: 'Вологість ґрунту', unit: '%' }],
  ['temperature', { op: 'gt', warn: 32, crit: 35, hysteresis: 1, label: 'Температура повітря', unit: '°C' }],
]);
const LEVELS = { normal: 0, warning: 1, critical: 2 };
const LEVEL_TEXT = { warning: 'попередження', critical: 'критично' };

// Погіршення рівня відбувається одразу, покращення — лише коли значення
// повернулося за межу рівня на величину гістерезису
function nextLevel(cur, v, r) {
  const lt = r.op === 'lt';
  const beyond = (limit) => (lt ? v < limit : v > limit);
  const clear = (limit) =>
    lt ? v >= limit + r.hysteresis : v <= limit - r.hysteresis;
  if (beyond(r.crit)) return 'critical';
  if (cur === 'critical' && !clear(r.crit)) return 'critical';
  if (beyond(r.warn)) return 'warning';
  if (cur !== 'normal' && !clear(r.warn)) return 'warning';
  return 'normal';
}

// Стан правил на пару (пристрій, метрика). evaluate повертає сповіщення,
// яке треба надіслати, або null. Cooldown діє на повторення того самого
// рівня; перехід на вищий рівень проходить завжди
function createAlertTracker({
  rules = RULES, hysteresis, cooldownMs = 600_000, maxAgeMs = 300_000,
  clock = Date.now,
} = {}) {
  const state = new Map();
  return {
    evaluate({ device, metric, ts, value }) {
      const base = rules.get(metric);
      if (!base || !Number.isFinite(value)) return null;
      const rule = hysteresis === undefined
        ? base : { ...base, hysteresis };
      const key = `${device}\u0000${metric}`;
      const st = state.get(key) ?? { level: 'normal', pushed: null };
      state.set(key, st);
      const prev = st.level;
      st.level = nextLevel(prev, value, rule);
      if (LEVELS[st.level] <= LEVELS[prev]) return null;
      const at = Date.parse(ts);
      if (clock() - at > maxAgeMs) return null;      // подія з минулого
      const last = st.pushed;
      if (last && LEVELS[last.level] >= LEVELS[st.level]
          && at - last.at < cooldownMs) return null;  // «дзвін» біля порога
      st.pushed = { level: st.level, at };
      return { device, metric, level: st.level, value, ts };
    },
    size: () => state.size,
  };
}

// Повідомлення HTTP v1: notification показує система, навіть коли
// застосунок закрито; data — лише рядки (для переходу на екран).
// collapse_key не використовуємо: FCM тримає не більше чотирьох різних
// ключів на пристрій, а пар (пристрій, метрика) більше. Чергу накопичених
// сповіщень обмежує ttl; заміну вже показаного сповіщення робить tag
// (Android) і apns-collapse-id (iOS)
function buildMessage(target, alert, opts) {
  const { name, ttlSec = 600, nowMs = Date.now() } = opts;
  const r = RULES.get(alert.metric);
  const key = `${alert.device}:${alert.metric}`;
  const value = alert.value.toFixed(1).replace('.', ',');
  return {
    message: {
      // адреса йде у поле за видом: fid або token
      [target.kind]: target.id,
      notification: {
        title: `${r.label}: ${LEVEL_TEXT[alert.level]}`,
        body: `${name}: ${value} ${r.unit}`,
      },
      data: {
        device: alert.device, metric: alert.metric, level: alert.level,
        value: String(alert.value), ts: alert.ts,
      },
      android: {
        priority: 'HIGH', ttl: `${ttlSec}s`,
        notification: { tag: key, channel_id: 'alerts' },
      },
      apns: {
        headers: {
          'apns-push-type': 'alert', 'apns-priority': '10',
          'apns-collapse-id': key,
          'apns-expiration': String(Math.floor(nowMs / 1000) + ttlSec),
        },
        payload: { aps: { sound: 'default' } },
      },
    },
  };
}

class FcmError extends Error {
  constructor(http, code, retryAfterSec = null, message = '') {
    super(message || code);
    Object.assign(this, { http, code, retryAfterSec });
  }
}

// Коди з документації FCM для відповідей, у яких тіло не розібрати
const BY_HTTP = { 400: 'INVALID_ARGUMENT', 401: 'THIRD_PARTY_AUTH_ERROR', 403: 'SENDER_ID_MISMATCH',
  404: 'UNREGISTERED', 429: 'QUOTA_EXCEEDED', 500: 'INTERNAL', 503: 'UNAVAILABLE' };

function createFcmClient({ baseUrl, project, getAccessToken, fetchImpl = fetch, timeoutMs = 10_000 }) {
  return {
    async send(body) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/v1/projects/${project}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new FcmError(0, 'NETWORK', null, e.message);
      }
      if (res.ok) return res.json();
      let detail = null;
      try { detail = (await res.json()).error; } catch { /* тіло не JSON */ }
      const fcm = detail?.details?.find((d) => d.errorCode)?.errorCode;
      const wait = Number(res.headers.get('retry-after'));
      throw new FcmError(res.status, fcm ?? BY_HTTP[res.status] ?? 'UNKNOWN',
        Number.isFinite(wait) && wait > 0 ? wait : null, detail?.message);
    },
  };
}

const RETRYABLE = new Set(['UNAVAILABLE', 'INTERNAL', 'QUOTA_EXCEEDED', 'NETWORK']);
const CONFIG = new Set(['THIRD_PARTY_AUTH_ERROR', 'SENDER_ID_MISMATCH']);

function createDispatcher({ db, fcm, clock = Date.now, sleep = sleepMs, rnd = Math.random,
  ttlSec = 600, maxAttempts = 5, log = () => {} }) {
  const ownerOf = db.prepare('SELECT user_id FROM device_owner WHERE device_id = ?');
  const targetsOf = db.prepare('SELECT token AS id, kind FROM push_tokens WHERE user_id = ?');
  const dropToken = db.prepare('DELETE FROM push_tokens WHERE token = ?');
  const nameOf = db.prepare('SELECT name FROM devices WHERE device_id = ?');
  const stats = { alerts: 0, sent: 0, unregistered: 0, invalid: 0, config: 0,
    retries: 0, expired: 0, gaveUp: 0, noRecipients: 0 };

  // Пауза перед повтором: 1, 2, 4 … 32 с із джитером. Для 429
  // (QUOTA_EXCEEDED) документація FCM вимагає експоненційної паузи з
  // початком не менше хвилини: 60, 120, 240 … с. Retry-After сервера,
  // якщо він більший, має перевагу
  function pause(err, attempt) {
    const quota = err.code === 'QUOTA_EXCEEDED';
    const base = quota ? 60_000 : 1000;
    const ceiling = Math.min(32 * base, base * 2 ** (attempt - 1));
    const own = ceiling * (0.5 + rnd() / 2);
    const server = (err.retryAfterSec ?? 0) * 1000;
    return Math.max(own, quota ? 60_000 : 0, server);
  }

  async function toTarget(target, alert, name) {
    const deadline = Date.parse(alert.ts) + ttlSec * 1000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // FCM відлічує TTL від відправлення, тож кожна спроба несе
        // залишок строку дії: усі вони спливають в один момент
        const nowMs = clock();
        const left = Math.ceil((deadline - nowMs) / 1000);
        if (left <= 0) { stats.expired++; return 'expired'; }
        const opts = { name, ttlSec: left, nowMs };
        await fcm.send(buildMessage(target, alert, opts));
        stats.sent++;
        return 'sent';
      } catch (e) {
        if (!(e instanceof FcmError)) throw e;
        if (e.code === 'UNREGISTERED') {   // токен мертвий: прибрати
          dropToken.run(target.id);
          stats.unregistered++;
          return 'unregistered';
        }
        if (e.code === 'INVALID_ARGUMENT') {  // повтор не допоможе
          stats.invalid++;
          log('fcm-invalid', { device: alert.device, message: e.message });
          return 'invalid';
        }
        if (CONFIG.has(e.code) || !RETRYABLE.has(e.code)) {
          stats.config++;
          log('fcm-config', { code: e.code });
          return 'config';
        }
        if (attempt === maxAttempts) break;   // пауза вже нічого не дасть
        const wait = pause(e, attempt);
        if (clock() + wait > deadline) {   // повтор після строку дії
          stats.expired++;
          return 'expired';
        }
        stats.retries++;
        await sleep(wait);
      }
    }
    stats.gaveUp++;
    return 'gave-up';
  }

  async function deliver(alert) {
    stats.alerts++;
    const owner = ownerOf.get(alert.device);
    const targets = owner ? targetsOf.all(owner.user_id) : [];
    if (targets.length === 0) { stats.noRecipients++; return []; }
    const name = nameOf.get(alert.device)?.name ?? alert.device;
    return Promise.all(targets.map((t) => toTarget(t, alert, name)));
  }

  return {
    stats, deliver,
    // підписка на шину вимірювань: feed.subscribe('*', dispatcher.onReadings(tracker))
    onReadings: (tracker) => (device, readings) => {
      for (const r of readings) {
        const alert = tracker.evaluate({ device, ...r });
        if (alert) deliver(alert).catch((e) => log('push-failed', { message: e.message }));
      }
    },
  };
}

module.exports = { RULES, nextLevel, createAlertTracker, buildMessage, createFcmClient,
  createDispatcher, FcmError };
