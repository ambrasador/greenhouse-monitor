'use strict';
// Помилка API у форматі «Problem Details» (RFC 9457)
class ApiError extends Error {
  // headers — заголовки відповіді, наприклад WWW-Authenticate для 401
  constructor(status, code, title, extra = {}, headers = {}) {
    super(title);
    Object.assign(this, { status, code, title, extra, headers });
  }
}

function sendProblem(res, err) {
  res.set(err.headers ?? {});
  res.status(err.status).type('application/problem+json').json({
    type: `https://greenhouse.example/problems/${err.code}`,
    title: err.title,
    status: err.status,
    ...err.extra,
  });
}

// Строгий розбір: усі помилки одразу, невідомі параметри — теж помилка
function parseParams(query, spec) {
  const values = {}, errors = [];
  const bad = (param, message) => errors.push({ param, message });
  for (const name of Object.keys(query)) {
    if (!(name in spec)) bad(name, 'невідомий параметр');
  }
  for (const [name, rule] of Object.entries(spec)) {
    const raw = query[name];
    if (raw === undefined) {
      if (rule.required) bad(name, 'обов’язковий параметр');
      else if ('default' in rule) values[name] = rule.default;
      continue;
    }
    if (Array.isArray(raw)) { bad(name, 'параметр повторено'); continue; }
    const v = rule.parse(raw);
    if (v === null || v === undefined) bad(name, rule.hint);
    else values[name] = v;
  }
  if (errors.length) {
    throw new ApiError(400, 'invalid-query',
      'Некоректні параметри запиту', { errors });
  }
  return values;
}

module.exports = { ApiError, sendProblem, parseParams };
