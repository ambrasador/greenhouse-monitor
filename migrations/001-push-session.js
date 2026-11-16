'use strict';
// push_tokens.session_id: токен належить родині refresh-токенів (розділ 6).
// База, створена до міграцій, може мати стару форму таблиці або вже нову
module.exports = {
  description: 'push_tokens.session_id та індекс за ним',
  up(db) {
    const cols = db.prepare('SELECT name FROM pragma_table_info(?)')
      .pluck().all('push_tokens');
    // таблиці ще немає: її створить schema-mobile.sql
    if (cols.length === 0) return;
    if (!cols.includes('session_id')) {
      db.exec('ALTER TABLE push_tokens ADD COLUMN session_id TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS push_tokens_session '
      + 'ON push_tokens (session_id)');
  },
};
