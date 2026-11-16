'use strict';
// Міграції схеми: стара база, нова база, повтор, відкіт, збіг форми
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { setupSchema, loadMigrations } = require('./migrate');

const ALL = ['schema.sql', 'schema-api.sql', 'schema-mobile.sql', 'schema-auth.sql'];
const read = (file) => fs.readFileSync(`${__dirname}/${file}`, 'utf8');
const version = (db) => db.pragma('user_version', { simple: true });
const LATEST = loadMigrations().at(-1).id;

// База, створена кодом до міграцій: push_tokens без session_id
function oldDb() {
  const db = new Database(':memory:');
  db.exec(read('schema.sql') + read('schema-api.sql') + read('fixtures/schema-mobile-before-001.sql'));
  db.prepare(`INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at)
              VALUES ('t1', 'token', 'u1', 'android', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  return db;
}

// Форма схеми: стовпці й індекси, а не текст DDL (ALTER TABLE дописує текст по-своєму)
function shape(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
  return {
    columns: tables.map((t) => [t, db.prepare('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)').all(t)]),
    indexes: db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
  };
}

test('нова база одразу має поточну форму й остання версія', () => {
  const db = new Database(':memory:');
  assert.equal(setupSchema(db, ALL), LATEST);
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('push_tokens') WHERE name = 'session_id'").get());
});

test('стара база: рядок зберігається, стовпець і індекс з’являються', () => {
  const db = oldDb();
  const events = [];
  assert.equal(setupSchema(db, ALL, { log: (msg, f) => events.push([msg, f.id]) }), LATEST);
  assert.deepEqual(events, [['migrated', 1]]);
  const row = db.prepare('SELECT token, session_id FROM push_tokens').get();
  assert.deepEqual({ ...row }, { token: 't1', session_id: null });
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'push_tokens_session'").get());
});

test('мігрована база має ту саму форму, що й нова', () => {
  const migrated = oldDb();
  setupSchema(migrated, ALL);
  const fresh = new Database(':memory:');
  setupSchema(fresh, ALL);
  assert.deepEqual(shape(migrated), shape(fresh));
});

test('база, створена до міграцій, але вже з новою формою, не ламається', () => {
  const db = new Database(':memory:');
  db.exec(ALL.map(read).join('\n'));          // як працював код розділу 6: user_version = 0
  assert.equal(version(db), 0);
  assert.equal(setupSchema(db, ALL), LATEST);
});

test('вхід вимкнено: таблиці push_tokens немає, міграція її не створює', () => {
  const db = new Database(':memory:');
  db.exec(read('schema.sql') + read('schema-api.sql'));
  setupSchema(db, ['schema.sql', 'schema-api.sql']);
  assert.equal(db.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'push_tokens'").pluck().get(), 0);
  setupSchema(db, ALL);                         // вхід увімкнули: таблиця з’являється одразу нової форми
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('push_tokens') WHERE name = 'session_id'").get());
});

test('повторний запуск нічого не змінює', () => {
  const db = oldDb();
  setupSchema(db, ALL);
  const before = shape(db);
  const events = [];
  setupSchema(db, ALL, { log: (msg) => events.push(msg) });
  assert.deepEqual(events, []);
  assert.deepEqual(shape(db), before);
});

test('збій міграції відкочує і зміну, і номер версії', () => {
  const db = oldDb();
  const broken = [{
    id: 1,
    description: 'зламана',
    up(d) {
      d.exec('ALTER TABLE push_tokens ADD COLUMN session_id TEXT');
      assert.equal(version(d), 1, 'номер уже виставлено в межах транзакції');
      throw new Error('збій посеред міграції');
    },
  }];
  assert.throws(() => setupSchema(db, ALL, { migrations: broken }), /збій посеред міграції/);
  assert.equal(version(db), 0);
  assert.equal(db.prepare("SELECT count(*) FROM pragma_table_info('push_tokens') WHERE name = 'session_id'").pluck().get(), 0);
});
