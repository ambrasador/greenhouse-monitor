'use strict';
// База для тестів і стенда розділу 5: схема розділів 2–4 плюс таблиці мобільного клієнта
const fs = require('node:fs');
const { makeDb } = require('./testkit');
const { ApiError } = require('./problem');

function makeMobileDb() {
  const db = makeDb();
  db.exec(fs.readFileSync(`${__dirname}/schema-mobile.sql`, 'utf8'));
  return db;
}

// Тестовий двійник: особа з заголовка X-User. У виробничому коді його немає,
// воно передає identify явно (розділ 6 — це req.user з JWT)
const USER_RE = /^[\w.@-]{1,64}$/;
function headerIdentity(req) {
  const u = req.get('X-User');
  if (!u || !USER_RE.test(u)) throw new ApiError(401, 'unauthorized', 'Потрібен вхід');
  return u;
}

module.exports = { makeMobileDb, headerIdentity };
