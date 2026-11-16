// M3: чи видно за часом відповіді, що ім’я існує. Справжня кінцева точка POST /auth/login зі
// scrypt за параметрами OWASP: «ім’я існує, пароль хибний» проти «імені немає». Для порівняння —
// наївний варіант без фіктивного хешу (5 рядків у цьому ж файлі). Показник розрізнюваності —
// ймовірність, що навмання взята відповідь на існуюче ім’я повільніша за відповідь на неіснуюче
// (0,5 — відрізнити неможливо, 1 — завжди відрізняється).
//   node calc6-timing.mjs [out.json] [n]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { makeSecure, OPEN_LIMITS } = require('./auth-kit');
const { DEFAULT_PARAMS } = require('./passwords');

const N = Number(process.argv[3] ?? 60);
const bed = await makeSecure({ params: DEFAULT_PARAMS, limits: OPEN_LIMITS });
const WRONG = 'wrong horse battery';
const ms = async (f) => { const t = process.hrtime.bigint(); await f(); return Number(process.hrtime.bigint() - t) / 1e6; };

// Наївна перевірка: невідоме ім’я — одразу відмова
const row = bed.db.prepare('SELECT pw_hash FROM users WHERE username = ?');
const naive = async (name) => { const r = row.get(name); return r ? bed.passwords.verify(WRONG, r.pw_hash) : false; };

const real = { exists: [], unknown: [] };
const naiveT = { exists: [], unknown: [] };
await bed.login('north', WRONG);                                   // прогрів: перший фіктивний хеш
for (let i = 0; i < N; i++) {
  real.exists.push(await ms(() => bed.login('north', WRONG)));
  real.unknown.push(await ms(() => bed.login(`nobody-${i}`, WRONG)));
  naiveT.exists.push(await ms(() => naive('north')));
  naiveT.unknown.push(await ms(() => naive(`nobody-${i}`)));
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
function auc(slow, fast) {                                          // Манна — Вітні
  let wins = 0;
  for (const a of slow) for (const b of fast) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (slow.length * fast.length);
}
const summary = (name, t) => ({
  name, exists: { median: median(t.exists) }, unknown: { median: median(t.unknown) },
  gapMs: median(t.exists) - median(t.unknown), auc: auc(t.exists, t.unknown),
});
const res = [summary('кінцева точка /auth/login', real), summary('наївна перевірка без фіктивного хешу', naiveT)];
for (const r of res) {
  console.log(`${r.name.padEnd(40)} існує ${r.exists.median.toFixed(1).padStart(7)} мс  немає ${r.unknown.median.toFixed(2).padStart(7)} мс  `
    + `різниця ${r.gapMs.toFixed(1)} мс  ймовірність ${r.auc.toFixed(3)}`);
}
writeFileSync(process.argv[2] ?? 'results/timing.json', JSON.stringify({ n: N, params: DEFAULT_PARAMS, rows: res }, null, 2));
process.exit(0);
