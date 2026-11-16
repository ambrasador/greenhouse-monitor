'use strict';
const jwt = require('jsonwebtoken');
const { randomUUID, createSecretKey } = require('node:crypto');
const { ApiError } = require('./problem');

// Дозволений алгоритм задано списком, а не береться із заголовка токена (RFC 8725, 3.1)
const ALGORITHMS = ['HS256'];
// Тип і аудиторія розрізняють токени: квиток потоку не підійде як токен доступу
const KINDS = {
  access: { typ: 'at+jwt', aud: 'greenhouse-api' },
  ticket: { typ: 'stream+jwt', aud: 'greenhouse-stream' },
};
const REALM = 'Bearer realm="greenhouse-api"';

// 401 без облікових даних не називає причини (RFC 6750, 3); з токеном — invalid_token
const unauthorized = (code = 'unauthorized', withToken = false) => new ApiError(
  401, code, 'Потрібен вхід', {},
  { 'WWW-Authenticate': withToken ? `${REALM}, error="invalid_token"` : REALM });

function createTokens({ keys, current, issuer = 'greenhouse-api', accessTtlSec = 900,
  ticketTtlSec = 30, clock = Date.now }) {
  // kid → ключ. Секрет у вигляді KeyObject створюємо один раз: з буфером jsonwebtoken на кожну
  // перевірку спершу пробує розібрати його як відкритий ключ PEM, ловить виняток і лише тоді
  // створює секретний ключ (профіль: 15 % процесорного часу сервера під навантаженням)
  const ring = new Map(Object.entries(keys).map(([kid, k]) => [kid, createSecretKey(Buffer.from(k))]));
  if (!ring.has(current)) throw new Error(`немає ключа ${current}`);
  const now = () => Math.floor(clock() / 1000);

  function sign(kind, claims, ttl) {
    const iat = now();
    return jwt.sign({ ...claims, iat, exp: iat + ttl, jti: randomUUID() }, ring.get(current), {
      algorithm: 'HS256', issuer, audience: KINDS[kind].aud, keyid: current,
      header: { typ: KINDS[kind].typ },
    });
  }

  function open(kind, token) {
    const header = jwt.decode(token, { complete: true })?.header;
    const key = typeof header?.kid === 'string'
      ? ring.get(header.kid) : undefined;
    if (!key || header.typ !== KINDS[kind].typ) {
      throw unauthorized('invalid-token', true);
    }
    let claims;
    try {
      claims = jwt.verify(token, key, { algorithms: ALGORITHMS, issuer,
        audience: KINDS[kind].aud, clockTimestamp: now() });
    } catch (e) {
      throw unauthorized(e.name === 'TokenExpiredError'
        ? 'token-expired' : 'invalid-token', true);
    }
    // jsonwebtoken не вимагає exp: токен без терміну дії він вважає чинним
    if (!Number.isInteger(claims.exp) || typeof claims.sub !== 'string'
        || !Number.isInteger(claims.ver)) {
      throw unauthorized('invalid-token', true);
    }
    return claims;
  }

  return {
    accessTtlSec,
    ticketTtlSec,
    // sid — родина refresh-токенів, тобто сеанс, у якому видано токен; адреси push
    // прив’язують до нього, щоб вони гинули разом із сеансом
    signAccess: (user, sid) => sign('access',
      { sub: user.user_id, role: user.role, ver: user.token_version, ...(sid && { sid }) }, accessTtlSec),
    signTicket: (user, device) => sign('ticket',
      { sub: user.user_id, ver: user.token_version, dev: device }, ticketTtlSec),
    verifyAccess: (token) => open('access', token),
    verifyTicket: (token) => open('ticket', token),
  };
}

module.exports = { createTokens, unauthorized, ALGORITHMS };
