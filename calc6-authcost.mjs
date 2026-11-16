// M5б: з чого складається додатковий процесорний час на запит (вимір M5): перевірка підпису,
// перевірка підпису з читанням рядка користувача (identify), весь guard(дія) з розбором заголовка
// та ролі, область доступу для одного пристрою. Кожна цифра — медіана п’яти серій по 50 000 викликів.
//   node calc6-authcost.mjs [out.json]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { makeSecure, FAST } = require('./auth-kit');

const bed = await makeSecure({ params: FAST });
const { access_token: token } = (await bed.login('agro')).body;
const user = bed.auth.identify(token);
// Запит створюється заново для кожного виклику: authenticate бере готовий req.user, якого
// ставить limitKey або попередній виклик, і на повторному об'єкті guard нічого б не рахував
const header = (h) => (h === 'Authorization' ? `Bearer ${token}` : undefined);
const newReq = () => ({ get: header, ip: '127.0.0.1' });
const guard = bed.auth.guard('device:read');
const ITERS = 50_000;
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

function us(name, fn) {
  for (let i = 0; i < 2000; i++) fn();                      // прогрів
  const t = [];
  for (let s = 0; s < 5; s++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ITERS; i++) fn();
    t.push(Number(process.hrtime.bigint() - t0) / 1e3 / ITERS);
  }
  return { name, us: median(t) };
}
const rows = [
  us('перевірка підпису (tokens.verifyAccess)', () => bed.tokens.verifyAccess(token)),
  us('identify: підпис + рядок користувача', () => bed.auth.identify(token)),
  us('guard(дія): заголовок + identify + роль', () => guard(newReq(), {}, () => {})),
  us('область доступу: canSee для одного пристрою', () => bed.auth.scope.canSee(user, 'gh1-s01')),
];
for (const r of rows) console.log(`${r.name.padEnd(46)} ${r.us.toFixed(1).padStart(6)} мкс`);
writeFileSync(process.argv[2] ?? new URL('results/authcost.json', import.meta.url),
  JSON.stringify({ node: process.version, iters: ITERS, rows }, null, 2));
process.exit(0);
