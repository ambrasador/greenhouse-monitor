'use strict';
const { randomUUID } = require('node:crypto');

// NIST SP 800-63B-4, 3.1.1.2: пароль як єдиний фактор — від 15 символів, верхня межа не менша за 64;
// складових правил (цифра, велика літера) не вводимо, зате порівнюємо з переліком відомих паролів
const MIN_PASSWORD = 15;
const MAX_PASSWORD = 128;
const normName = (s) => s.normalize('NFKC').toLowerCase();

// Керування обліковими записами. Зміна ролі, зняття права й вимкнення збільшують token_version:
// усі видані токени стають недійсними негайно, а не за 15 хвилин, і відкриті потоки закриваються
// blocked(пароль) — перелік поширених і скомпрометованих паролів; сам перелік (мільйони рядків) у код не входить
function createUsers({ db, passwords, refresh, clock = Date.now, blocked = () => false }) {
  const insert = db.prepare(
    `INSERT INTO users (user_id, username, pw_hash, role, created_at)
     VALUES (@id, @name, @hash, @role, @now)`);
  const grant = db.prepare('INSERT OR IGNORE INTO grants (user_id, scope) VALUES (?, ?)');
  const ungrant = db.prepare('DELETE FROM grants WHERE user_id = ? AND scope = ?');
  const setRole = db.prepare(
    'UPDATE users SET role = ?, token_version = token_version + 1 WHERE user_id = ?');
  const off = db.prepare(
    'UPDATE users SET disabled_at = ?, token_version = token_version + 1 WHERE user_id = ?');
  const bump = db.prepare('UPDATE users SET token_version = token_version + 1 WHERE user_id = ?');

  return {
    async create({ id = randomUUID(), username, password, role, grants = [] }) {
      // довжина — у символах Unicode після NFKC, а не в одиницях UTF-16 чи байтах
      const length = typeof password === 'string' ? [...password.normalize('NFKC')].length : 0;
      if (length < MIN_PASSWORD || length > MAX_PASSWORD) {
        throw new RangeError(`пароль: від ${MIN_PASSWORD} до ${MAX_PASSWORD} символів`);
      }
      if (blocked(password.normalize('NFKC'))) throw new RangeError('пароль є в переліку поширених');
      const hash = await passwords.hash(password);
      db.transaction(() => {
        insert.run({ id, name: normName(username), hash, role, now: new Date(clock()).toISOString() });
        for (const g of grants) grant.run(id, g);
      })();
      return id;
    },
    grant: (id, scope) => grant.run(id, scope),
    // Зняття права теж збільшує ver: область доступу REST читає з бази щоразу, а відкритий потік — лише
    // при підключенні, і закрити його можна тільки через ver
    revoke: (id, scope) => db.transaction(() => { ungrant.run(id, scope); bump.run(id); })(),
    changeRole: (id, role) => setRole.run(role, id),
    disable(id) {
      off.run(new Date(clock()).toISOString(), id);
      refresh.revokeAllOf(id);
    },
    // Вихід звідусіль: токени доступу гаснуть через ver, refresh — через анулювання
    signOutEverywhere(id) {
      bump.run(id);
      refresh.revokeAllOf(id);
    },
  };
}

module.exports = { createUsers, normName, MIN_PASSWORD };
