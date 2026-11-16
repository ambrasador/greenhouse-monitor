// M6: підпис webhook. (а) вартість перевірки HMAC-SHA256 залежно від розміру тіла, без кешу
// повторів і з ним; (б) пам’ять кешу повторів на один запис; (в) скільки спроб підбору слабкого
// секрету за секунду робить одне ядро (атакувальник має зразок «t, тіло, підпис» і перебирає офлайн,
// жоден ліміт запитів на нього не діє).
//   node --expose-gc calc6-webhook.mjs [out.json]
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { sign, createVerifier } = require('./webhook-sign');
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

const secret = 'whsec-' + randomBytes(24).toString('base64url');
const T = 1_800_000_000;                                  // секунди, фіксований момент
const clock = () => T * 1000;

if (process.argv[2] === '--mem') {
  const n = Number(process.argv[3]);
  const v = createVerifier({ secrets: [secret], clock, toleranceSec: 300 });
  const make = (i) => { const b = `{"events":[{"n":${i}}]}`; return [sign(secret, b, T), b]; };
  for (let i = 0; i < 1000; i++) make(i);                  // прогрів
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) { const [h, b] = make(i); if (v(h, b) !== null) throw new Error('відхилено'); }
  global.gc();
  const after = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({ entries: v.size(), bytesPerEntry: (after - before) / n }));
  process.exit(0);
}

// (а) вартість перевірки
const sizes = [256, 1024, 16 * 1024, 64 * 1024, 256 * 1024];
const cost = [];
for (const size of sizes) {
  const body = randomBytes(size >> 1).toString('hex');   // size байтів тексту
  const iters = Math.max(300, Math.floor(40_000_000 / size));
  const header = sign(secret, body, T);
  const noCache = createVerifier({ secrets: [secret], clock, replay: false });
  const series = (f) => median(Array.from({ length: 5 }, () => {
    const t = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) f(i);
    return Number(process.hrtime.bigint() - t) / 1e3 / iters;
  }));
  const plain = series(() => noCache(header, body));
  // з кешем повторів кожне тіло має бути новим, інакше друга перевірка дасть 'replay'
  const bodies = Array.from({ length: iters }, (_, i) => `${i}`.padStart(8, '0') + body.slice(8));
  const headers = bodies.map((b) => sign(secret, b, T));
  const cached = median(Array.from({ length: 5 }, () => {
    const v = createVerifier({ secrets: [secret], clock });
    const t = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) { if (v(headers[i], bodies[i]) !== null) throw new Error('відхилено'); }
    return Number(process.hrtime.bigint() - t) / 1e3 / iters;
  }));
  cost.push({ bytes: size, hmacUs: plain, withReplayUs: cached });
  console.log(`тіло ${String(size).padStart(7)} Б  HMAC ${plain.toFixed(1).padStart(7)} мкс  з кешем повторів ${cached.toFixed(1).padStart(7)} мкс`);
}

// (б) пам’ять кешу повторів: окремий процес, щоб сміття з частини (а) не спотворювало різницю
const N = 200_000;
const mem = spawnSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname, '--mem', String(N)], { encoding: 'utf8' });
if (mem.status !== 0) throw new Error(mem.stderr);
const entry = JSON.parse(mem.stdout).bytesPerEntry;
console.log(`кеш повторів: ${N} записів, ${entry.toFixed(0)} Б на запис (купа)`);

// (в) підбір слабкого секрету
const msg = `${T}.{"events":[]}`;
const rate = median(Array.from({ length: 5 }, () => {
  const n = 300_000;
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) createHmac('sha256', `guess${i}`).update(msg).digest();
  return n / (Number(process.hrtime.bigint() - t) / 1e9);
}));
console.log(`підбір секрету: ${Math.round(rate)} спроб/с на ядро`);

writeFileSync(process.argv[2] ?? 'results/webhook.json', JSON.stringify({ node: process.version, cost,
  replay: { entries: N, bytesPerEntry: entry }, guessPerSec: rate }, null, 2));
