'use strict';
// Межі приховування секретів у журналі (підрозділ 7.8.1): які поля REDACT справді закриває.
// Запускає logger.js із тими самими шляхами, що й сервер, і пише в стандартний вивід один рядок JSON.
// Результат — results/redact-probe.txt. Запуск: node calc7-redact.js
const { createLogger } = require('./logger');

const { log } = createLogger({ destination: process.stdout });
log('probe', {
  password: 'p1',                                   // шлях password: поле верхнього рівня
  user: { password: 'p2' },                         // вкладене поле: шлях password його не охоплює
  token: 't1',
  req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', 'x-api-key': 'k' } },
  note: 'password=p3 у тексті',                     // секрет усередині рядка pino не бачить
});
