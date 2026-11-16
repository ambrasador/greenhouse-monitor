'use strict';
// Перевірка відповіді до питання 7 розділу 5: розклад повторів FCM у справжньому
// диспетчері push.js, де замість відправки до FCM стоїть підставна функція,
// а час і випадкове число керовані.
//   node calc5-answers-fcm.js
const { createDispatcher, FcmError } = require('./push.js');

const T0 = Date.parse('2026-11-04T12:00:00Z');

async function run({ rnd, ageAtFirst = 0, script, attempts = 5 }) {
  let now = T0 + ageAtFirst * 1000;
  const db = {
    prepare: () => ({
      get: () => ({ user_id: 'u1', name: 'Грядка А' }),
      all: () => [{ id: 'tok', kind: 'token' }],
      run() {},
    }),
  };
  const log = [];
  const fcm = {
    async send(body) {
      const m = body.message;
      log.push({
        t: (now - T0) / 1000,
        ttl: m.android.ttl,
        exp: m.apns.headers['apns-expiration'] - T0 / 1000,
      });
      const step = script.shift();
      if (step) throw new FcmError(step.http, step.code, step.retryAfter ?? null);
      return {};
    },
  };
  const d = createDispatcher({
    db, fcm, clock: () => now, rnd: () => rnd, maxAttempts: attempts,
    sleep: async (ms) => { now += ms; },
  });
  const alert = {
    device: 'gh1', metric: 'soil_moisture', level: 'critical', value: 28,
    ts: new Date(T0).toISOString(),
  };
  const res = await d.deliver(alert);
  return { res, log };
}

const always429 = () =>
  Array.from({ length: 10 }, () => ({ http: 429, code: 'QUOTA_EXCEEDED' }));
const fmt = (log) => log.map((x) => `${x.t} с (TTL ${x.ttl})`).join(', ');

(async () => {
  for (const rnd of [1, 0]) {
    const r = await run({ rnd, script: always429() });
    console.log(
      `429 щоразу, rnd=${rnd}: ${JSON.stringify(r.res)}; відправки: ${fmt(r.log)}`,
      `; apns-expiration = ts+${[...new Set(r.log.map((x) => x.exp))]}`,
    );
  }
  const retryAfter = [{ http: 429, code: 'QUOTA_EXCEEDED', retryAfter: 90 }];
  const r = await run({ rnd: 0, ageAtFirst: 5, script: [...retryAfter] });
  console.log(
    `Retry-After 90, перша відправка на 5-й секунді: ${JSON.stringify(r.res)};`,
    `відправки: ${fmt(r.log)}; apns-expiration = ts+${[...new Set(r.log.map((x) => x.exp))]}`,
  );
})();
