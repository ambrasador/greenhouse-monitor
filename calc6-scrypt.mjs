// M1: вартість хешування пароля. П’ять наборів scrypt, що їх OWASP вважає рівноцінними,
// параметри стенда з тестів і PBKDF2-HMAC-SHA256 (600 000 ітерацій, рекомендація OWASP).
// Кожен рядок міряє окремий процес: пікова пам’ять належить лише цьому набору.
//   node calc6-scrypt.mjs [out.json]
import { spawnSync } from 'node:child_process';
import { scrypt, pbkdf2, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const ROWS = [
  { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 },
  { name: 'scrypt', N: 2 ** 16, r: 8, p: 2 },
  { name: 'scrypt', N: 2 ** 15, r: 8, p: 3 },
  { name: 'scrypt', N: 2 ** 14, r: 8, p: 5 },
  { name: 'scrypt', N: 2 ** 13, r: 8, p: 10 },
  { name: 'scrypt', N: 2 ** 10, r: 8, p: 1, note: 'стенд тестів' },
  { name: 'pbkdf2-sha256', iterations: 600_000 },
];
const RUNS = 9;
const PARALLEL = 8;

if (process.argv[2] === '--child') {
  const row = JSON.parse(process.argv[3]);
  const salt = randomBytes(16);
  const one = row.name === 'scrypt'
    ? () => promisify(scrypt)('correct horse battery', salt, 32,
      { N: row.N, r: row.r, p: row.p, maxmem: 256 * row.N * row.r })
    : () => promisify(pbkdf2)('correct horse battery', salt, row.iterations, 32, 'sha256');
  await one();                                                   // прогрів
  const before = process.memoryUsage().rss;
  const ms = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    await one();
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const t = process.hrtime.bigint();
  await Promise.all(Array.from({ length: PARALLEL }, one));      // пул libuv: 4 потоки
  const parallelMs = Number(process.hrtime.bigint() - t) / 1e6;
  const peak = process.resourceUsage().maxRSS * 1024;
  ms.sort((a, b) => a - b);
  console.log(JSON.stringify({ ...row, ms: { median: ms[RUNS >> 1], min: ms[0], max: ms[RUNS - 1] },
    parallelPerSec: PARALLEL / (parallelMs / 1000), peakRssDeltaMiB: (peak - before) / 2 ** 20 }));
  process.exit(0);
}

const out = [];
for (const row of ROWS) {
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--child', JSON.stringify(row)],
    { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const res = JSON.parse(r.stdout);
  res.memMiB = row.name === 'scrypt' ? (128 * row.N * row.r) / 2 ** 20 : 0;
  out.push(res);
  const label = row.name === 'scrypt' ? `scrypt N=2^${Math.log2(row.N)} r=${row.r} p=${row.p}` : row.name;
  console.log(`${label.padEnd(26)} ${res.ms.median.toFixed(1).padStart(7)} мс  `
    + `пам’ять ${res.memMiB} МіБ  ΔRSS ${res.peakRssDeltaMiB.toFixed(0)} МіБ  ${res.parallelPerSec.toFixed(1)} хеш/с (8 паралельно)`);
}
writeFileSync(process.argv[2] ?? 'results/scrypt.json', JSON.stringify({ node: process.version, rows: out }, null, 2));
