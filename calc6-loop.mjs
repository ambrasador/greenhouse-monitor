// M2: що вхід робить із подійним циклом. Сто одночасних входів із параметрами OWASP
// (scrypt N=2^15, r=8, p=3) трьома способами: синхронний scryptSync, асинхронний scrypt
// без обмеження і createPasswordService із шлюзом (2 одночасно, черга 32). Паралельно кожні
// 5 мс спрацьовує таймер; затримку його виклику міряє monitorEventLoopDelay.
// Кожен сценарій — окремий процес: пікова пам’ять належить лише йому.
// Ще одна проба: кожні 20 мс асинхронний fs.stat('/') — він іде в той самий пул libuv, що й scrypt,
// тож його затримка показує, чи хешування паролів не заважає решті введення-виведення.
//   node calc6-loop.mjs [out.json]
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { scryptSync, scrypt, randomBytes } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFileSync, stat } from 'node:fs';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const P = { N: 2 ** 15, r: 8, p: 3 };
const LOGINS = 100;
const SCENARIOS = ['idle', 'sync', 'async', 'gate'];

if (process.argv[2] === '--child') {
  const { createPasswordService } = require('./passwords');
  const mode = process.argv[3];
  const salt = randomBytes(16);
  const opts = { ...P, maxmem: 256 * P.N * P.r };
  const h = monitorEventLoopDelay({ resolution: 5 });
  const svc = createPasswordService({ params: P, concurrency: 2, maxQueue: 32 });
  const stored = process.argv[4];                       // хеш готує батьківський процес
  const before = process.memoryUsage().rss;
  h.enable();
  const pool = [];
  const probe = setInterval(() => {
    const t = process.hrtime.bigint();
    stat('/', () => pool.push(Number(process.hrtime.bigint() - t) / 1e6));
  }, 20);
  const t0 = process.hrtime.bigint();
  const lat = [];
  let served = 0;
  let shed = 0;
  const timed = async (work) => {
    const t = process.hrtime.bigint();
    try { await work(); served++; lat.push(Number(process.hrtime.bigint() - t) / 1e6); } catch { shed++; }
  };
  if (mode === 'idle') {
    await new Promise((r) => setTimeout(r, 2000));
  } else if (mode === 'sync') {
    // кожен запит виконується у власному тику, але scryptSync тримає потік, доки не скінчить
    await Promise.all(Array.from({ length: LOGINS }, () => timed(async () => {
      await new Promise((r) => setImmediate(r));
      scryptSync('wrong horse battery', salt, 32, opts);
    })));
  } else if (mode === 'async') {
    await Promise.all(Array.from({ length: LOGINS }, () => timed(() =>
      promisify(scrypt)('wrong horse battery', salt, 32, opts))));
  } else {
    await Promise.all(Array.from({ length: LOGINS }, () => timed(() =>
      svc.verify('wrong horse battery', stored))));
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  await new Promise((r) => setTimeout(r, 100));        // дати таймеру записати останній простій
  clearInterval(probe);
  h.disable();
  lat.sort((a, b) => a - b);
  pool.sort((a, b) => a - b);
  const quant = (a, x) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * x))] : null);
  const q = (x) => quant(lat, x);
  console.log(JSON.stringify({ mode, logins: mode === 'idle' ? 0 : LOGINS, served, shed,
    totalMs,
    poolProbeMs: { n: pool.length, p50: quant(pool, 0.5), p99: quant(pool, 0.99), max: pool.at(-1) },
    loopMs: { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 },
    latencyMs: { p50: q(0.5), p99: q(0.99) },
    peakRssDeltaMiB: (process.resourceUsage().maxRSS * 1024 - before) / 2 ** 20 }));
  process.exit(0);
}

const out = [];
const { hashPassword } = require('./passwords');
const stored = await hashPassword('correct horse battery', P);
for (const mode of SCENARIOS) {
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--child', mode, stored], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const res = JSON.parse(r.stdout);
  out.push(res);
  console.log(`${mode.padEnd(6)} виконано ${String(res.served).padStart(3)}, відмов ${String(res.shed).padStart(2)}  `
    + `цикл p50 ${res.loopMs.p50.toFixed(1)} мс, p99 ${res.loopMs.p99.toFixed(1)} мс, max ${res.loopMs.max.toFixed(0)} мс  `
    + `усе за ${(res.totalMs / 1000).toFixed(1)} с  ΔRSS ${res.peakRssDeltaMiB.toFixed(0)} МіБ  `
    + `fs.stat у пулі: n=${res.poolProbeMs.n} p50 ${res.poolProbeMs.p50.toFixed(2)} мс, max ${res.poolProbeMs.max.toFixed(0)} мс`);
}
writeFileSync(process.argv[2] ?? 'results/loop.json', JSON.stringify({ node: process.version, params: P, rows: out }, null, 2));
