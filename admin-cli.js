'use strict';
// Початкове налаштування без HTTP-кінцевої точки: перший адміністратор і коди прив’язки.
//   NEW_PASSWORD=... node admin-cli.js user-add <ім’я> <admin|operator|viewer> [область…]
//   node admin-cli.js device-add <id> <назва> [зона]   — реєстрація пристрою (без неї API відповідає 404)
//   node admin-cli.js claim-code <id пристрою>
//   node admin-cli.js retention [таблиця=діб…]   — прибирання за строками зберігання (cron раз на добу)
//   node admin-cli.js spray [секунд=60] [імен=10] — розпилення паролів: код виходу 1, якщо за вікно
//                                                    відмовлено багатьом різним іменам (cron щохвилини)
// Пароль береться зі змінної середовища, а не з аргументів: аргументи видно в `ps` та історії
const Database = require('better-sqlite3');
const { createPasswordService } = require('./passwords');
const { createRefresh } = require('./refresh');
const { createUsers } = require('./users');
const { createClaimCodes } = require('./claim-codes');
const { createRetention, DEFAULT_DAYS } = require('./privacy');
const { setupSchema } = require('./migrate');

async function main([cmd, ...args]) {
  const db = new Database(process.env.DB_FILE ?? './greenhouse.db');
  setupSchema(db, ['schema.sql', 'schema-api.sql', 'schema-mobile.sql', 'schema-auth.sql']);
  if (cmd === 'user-add') {
    const [username, role, ...grants] = args;
    const users = createUsers({ db, passwords: createPasswordService(), refresh: createRefresh({ db }) });
    console.log('створено', await users.create({ username, password: process.env.NEW_PASSWORD, role, grants }));
  } else if (cmd === 'device-add') {
    const [id, name, zone = null] = args;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id ?? '') || !name) throw new Error('device-add <id> <назва> [зона]');
    db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?)').run(id, name, zone, new Date().toISOString());
    console.log('зареєстровано', id);
  } else if (cmd === 'claim-code') {
    console.log('код (показано один раз):', createClaimCodes({ db }).issue(args[0]));
  } else if (cmd === 'retention') {
    // Строки — рішення власника даних, тому запускає їх оператор, а не сам сервер
    const days = { ...DEFAULT_DAYS };
    for (const a of args) {
      const [table, n] = a.split('=');
      if (!Object.hasOwn(days, table) || !(Number(n) > 0)) throw new Error(`хибний строк: ${a}`);
      days[table] = Number(n);
    }
    console.log(JSON.stringify(await createRetention({ db, days }).run()));
  } else if (cmd === 'spray') {
    // Адресний ліміт не дає одній адресі перебирати імена, тому розпилення видно лише як
    // багато різних імен із відмовою за короткий час, з будь-яких адрес (розділ 6)
    const [windowSec = '60', minNames = '10'] = args;
    const since = new Date(Date.now() - Number(windowSec) * 1000).toISOString();
    const seen = db.prepare(`SELECT count(DISTINCT target) AS names, count(DISTINCT ip) AS addresses,
        count(*) AS attempts FROM audit_log WHERE action = 'login' AND outcome = 'fail' AND ts >= ?`).get(since);
    console.log(JSON.stringify({ windowSec: Number(windowSec), ...seen }));
    if (seen.names >= Number(minNames)) process.exitCode = 1;
  } else {
    console.error('команди: user-add, device-add, claim-code, retention, spray');
    process.exitCode = 2;
  }
  db.close();
}
main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
