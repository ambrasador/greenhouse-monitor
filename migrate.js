'use strict';
// Схема і міграції. Версія схеми лежить у самій базі (PRAGMA user_version),
// тому код і дані не можуть розійтися: база знає, яких змін їй ще бракує
const fs = require('node:fs');
const path = require('node:path');

// Файли migrations/NNN-назва.js; NNN — версія схеми після застосування
function loadMigrations(dir = path.join(__dirname, 'migrations')) {
  return fs.readdirSync(dir)
    .filter((name) => /^\d{3}-.+\.js$/.test(name))
    .sort()
    .map((name) => ({
      id: Number(name.slice(0, 3)),
      ...require(path.join(dir, name)),
    }));
}

const hasTables = (db) => db
  .prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table'")
  .pluck().get() > 0;

function setupSchema(db, schemaFiles,
  { migrations = loadMigrations(), log = () => {} } = {}) {
  const latest = migrations.at(-1)?.id ?? 0;
  const existing = hasTables(db);
  if (existing) {                       // стара база: спершу міграції
    const from = db.pragma('user_version', { simple: true });
    for (const m of migrations.filter((x) => x.id > from)) {
      db.transaction(() => {            // зміна й номер версії — разом
        db.pragma(`user_version = ${m.id}`);
        m.up(db);
      })();
      log('migrated', { id: m.id, description: m.description });
    }
  }
  for (const file of schemaFiles) {     // потім схема: IF NOT EXISTS
    db.exec(fs.readFileSync(path.join(__dirname, file), 'utf8')
      .replace(/CREATE (TABLE|INDEX)/g, 'CREATE $1 IF NOT EXISTS'));
  }
  // нова база вже має поточну форму
  if (!existing) db.pragma(`user_version = ${latest}`);
  return db.pragma('user_version', { simple: true });
}

module.exports = { setupSchema, loadMigrations };
