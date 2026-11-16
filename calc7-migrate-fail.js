'use strict';
// Що відбувається, коли код розділу 6 відкриває базу, створену кодом розділу 5: без міграції й з нею
// Запуск: node calc7-migrate-fail.js > results/migrate-fail.log
const Database = require('better-sqlite3');
const fs = require('node:fs');
const dir = __dirname;
const db = new Database(':memory:');
db.exec(fs.readFileSync(`${dir}/fixtures/schema-mobile-before-001.sql`, 'utf8'));
db.exec(fs.readFileSync(`${dir}/schema-api.sql`, 'utf8'));
db.prepare("INSERT INTO devices VALUES ('gh1-s01','Грядка А','north','2026-01-01T00:00:00.000Z')").run();
db.prepare("INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at) VALUES ('t1','token','u1','android','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
try {
  db.exec(fs.readFileSync(`${dir}/schema-mobile.sql`, 'utf8').replace(/CREATE (TABLE|INDEX)/g, 'CREATE $1 IF NOT EXISTS'));
  console.log('схема застосована без помилки');
} catch (e) { console.log('schema-mobile.sql:', e.code, '-', e.message); }
try {
  db.prepare('INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at, session_id) VALUES (?,?,?,?,?,?,?)')
    .run('t2', 'token', 'u1', 'android', 'x', 'x', 'fam1');
} catch (e) { console.log('INSERT:', e.code, '-', e.message); }

// З міграцією: стара база приймає і INSERT старої форми (без session_id), і нової
const { setupSchema } = require('./migrate');
const ALL = ['schema.sql', 'schema-api.sql', 'schema-mobile.sql', 'schema-auth.sql'];
const old = new Database(':memory:');
old.exec(fs.readFileSync(`${dir}/schema.sql`, 'utf8') + fs.readFileSync(`${dir}/schema-api.sql`, 'utf8')
  + fs.readFileSync(`${dir}/fixtures/schema-mobile-before-001.sql`, 'utf8'));
old.prepare("INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at) VALUES ('t1','token','u1','android','x','x')").run();
const events = [];
const version = setupSchema(old, ALL, { log: (msg, f) => events.push(`${msg} ${f.id}`) });
console.log('з міграцією: user_version =', version, '; події:', events.join(', '));
for (const [label, sql, args] of [
  ['INSERT старої форми', 'INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at) VALUES (?,?,?,?,?,?)', ['t3', 'token', 'u1', 'android', 'x', 'x']],
  ['INSERT нової форми', 'INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at, session_id) VALUES (?,?,?,?,?,?,?)', ['t4', 'token', 'u1', 'android', 'x', 'x', 'fam1']],
]) {
  try { old.prepare(sql).run(...args); console.log(`з міграцією: ${label}: ok`); } catch (e) { console.log(`з міграцією: ${label}: ${e.code} - ${e.message}`); }
}
console.log('з міграцією: рядків у push_tokens =', old.prepare('SELECT count(*) FROM push_tokens').pluck().get(),
  '; session_id старого рядка =', old.prepare("SELECT session_id FROM push_tokens WHERE token = 't1'").pluck().get());
