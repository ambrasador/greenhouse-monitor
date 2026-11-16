'use strict';
// Імітація контракту FCM HTTP v1 для тестів: перевіряє те, що документація
// FCM називає помилкою запиту, і дає змогу вставити збої. Це НЕ сервер Google:
// вона відхиляє лише описані правила, і успіх тут не доводить доставку на телефон
const http = require('node:http');

const MAX_BYTES = 4096;

function createFakeFcm({ project = 'greenhouse-demo' } = {}) {
  const validTokens = new Set();
  const delivered = [];                 // прийняті повідомлення
  const received = [];                  // усі повідомлення, що дійшли до сервера
  const rejected = [];                  // { reason, body }
  const script = [];                    // збої для наступних запитів: { status, code, retryAfter }
  let n = 0;

  const fail = (res, http_, code, message, headers = {}) => {
    const canonical = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED',
      404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE' }[http_];
    res.writeHead(http_, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: { code: http_, message, status: canonical,
      details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }] } }));
  };

  // Правила, за якими реальний FCM повертає INVALID_ARGUMENT
  function problems(m) {
    const out = [];
    if ([m.token, m.fid, m.topic, m.condition].filter(Boolean).length !== 1) out.push('потрібен рівно один із token, fid, topic, condition');
    for (const [k, v] of Object.entries(m.data ?? {})) {
      if (typeof v !== 'string') out.push(`data.${k}: значення має бути рядком`);
    }
    const size = Buffer.byteLength(JSON.stringify({ n: m.notification, d: m.data }));
    if (size > MAX_BYTES) out.push(`корисне навантаження ${size} Б > ${MAX_BYTES} Б`);
    const a = m.android;
    if (a?.ttl !== undefined) {
      const sec = /^(\d+)(\.\d+)?s$/.exec(a.ttl) ? parseFloat(a.ttl) : NaN;
      if (!(sec >= 0 && sec <= 2_419_200)) out.push('android.ttl: очікується "<секунди>s", не більше 2 419 200 с');
    }
    if (a?.priority !== undefined && !['NORMAL', 'HIGH'].includes(a.priority)) out.push('android.priority: NORMAL або HIGH');
    const exp = m.apns?.headers?.['apns-expiration'];
    if (exp !== undefined && !/^\d+$/.test(exp)) out.push('apns-expiration: секунди UNIX-часу');
    const cid = m.apns?.headers?.['apns-collapse-id'];
    if (cid !== undefined && Buffer.byteLength(cid) > 64) out.push('apns-collapse-id: не більше 64 байтів');
    return out;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== `/v1/projects/${project}/messages:send`) {
        return fail(res, 404, 'UNSPECIFIED_ERROR', 'невідомий шлях');
      }
      if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) {
        return fail(res, 401, 'THIRD_PARTY_AUTH_ERROR', 'немає токена доступу');
      }
      try { received.push(JSON.parse(raw).message); } catch { /* не JSON */ }
      const next = script.shift();
      if (next) {
        return fail(res, next.status, next.code, 'збій за сценарієм',
          next.retryAfter ? { 'Retry-After': String(next.retryAfter) } : {});
      }
      let body;
      try { body = JSON.parse(raw); } catch { return fail(res, 400, 'INVALID_ARGUMENT', 'не JSON'); }
      const list = problems(body.message ?? {});
      if (list.length) {
        rejected.push({ reason: list, body });
        return fail(res, 400, 'INVALID_ARGUMENT', list.join('; '));
      }
      if (!validTokens.has(body.message.fid ?? body.message.token)) {
        return fail(res, 404, 'UNREGISTERED', 'токен не зареєстровано');
      }
      delivered.push(body.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: `projects/${project}/messages/${++n}` }));
    });
  });

  return {
    project, validTokens, delivered, received, rejected, script,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

module.exports = { createFakeFcm };
