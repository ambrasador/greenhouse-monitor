'use strict';
const { createHash } = require('node:crypto');
const { ApiError } = require('./problem');

// Курсор непрозорий: ключ останнього рядка та відбиток його запиту
const fingerprint = (q) => createHash('sha256')
  .update(JSON.stringify(q)).digest('base64url').slice(0, 12);

function encodeCursor(key, query) {
  const body = { k: key, q: fingerprint(query) };
  return Buffer.from(JSON.stringify(body)).toString('base64url');
}

function decodeCursor(cursor, query) {
  let c;
  try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { c = null; }
  if (!c || typeof c.k !== 'string' || c.q !== fingerprint(query)) {
    throw new ApiError(400, 'invalid-cursor',
      'Курсор недійсний або належить іншому запиту');
  }
  return c.k;
}

// Сторінка історії за ключем (device_id, metric, ts): рядки після курсора,
// а не після N-го рядка. Після першої сторінки межу вікна замінює курсор:
// дві межі з одного боку SQLite не об’єднує, одна стала б фільтром,
// і пошук починався б з краю вікна
function createRawReader(db) {
  const sql = (cond, dir) => `SELECT ts, value FROM telemetry
     WHERE device_id = @device AND metric = @metric AND ${cond}
     ORDER BY ts ${dir} LIMIT @limit`;
  const WINDOW = 'ts >= @from AND ts < @to';
  const stmts = {
    'asc-first': db.prepare(sql(WINDOW, 'ASC')),
    'asc-next': db.prepare(sql('ts > @after AND ts < @to', 'ASC')),
    'desc-first': db.prepare(sql(WINDOW, 'DESC')),
    'desc-next': db.prepare(sql('ts >= @from AND ts < @after', 'DESC')),
  };
  return function readPage(p) {
    const { device, metric, from, to, order, limit, cursor } = p;
    const q = { device, metric, from, to, order };   // відбиток запиту
    const after = cursor ? decodeCursor(cursor, q) : undefined;
    const rows = stmts[`${order}-${after ? 'next' : 'first'}`]
      .all({ device, metric, from, to, limit: limit + 1, after });
    const more = rows.length > limit;       // зайвий рядок = є наступна
    if (more) rows.pop();
    const next = more ? encodeCursor(rows.at(-1).ts, q) : null;
    return { data: rows, next };
  };
}

module.exports = { createRawReader, encodeCursor, decodeCursor };
