// M1: дублікати команд при втрачених відповідях. Для кожного q і режиму —
// свіжий стенд, проксі, що губить відповіді ПІСЛЯ виконання, і Dart-клієнт.
//   node calc5-m1.mjs [N] [out.json] [q1,q2,...]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { startMobileBed } = require('./mobile-bed');

const N = Number(process.argv[2] ?? 1000);
const OUT = process.argv[3] ?? 'results/m1.json';
const QS = (process.argv[4] ?? '0.05,0.1,0.2,0.3,0.5').split(',').map(Number);
const MODES = ['none', 'per-attempt', 'per-action'];
const MAX_ATTEMPTS = 10;

function dart(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('dart', ['run', 'tool/m1_duplicates.dart', ...args],
      { cwd: new URL('./mobile/', import.meta.url).pathname, env: process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`dart ${code}: ${err}`));
      resolve(JSON.parse(out.trim().split('\n').pop()));
    });
  });
}

const results = [];
let run = 0;
for (const q of QS) {
  for (const mode of MODES) {
    const bed = await startMobileBed();
    bed.proxy.configure({ lossAfter: q, seed: 20261104 + run++ });
    const client = await dart(['--base', bed.lossy, '--n', String(N), '--mode', mode]);
    const rows = bed.db.prepare("SELECT count(*) AS n FROM commands WHERE device_id = 'gh1-s01'").get().n;
    // теорія: спроб на дію до першої доставленої відповіді, не більше MAX_ATTEMPTS
    const expectedPerTap = (1 - q ** MAX_ATTEMPTS) / (1 - q);
    results.push({ q, mode, N, rows, duplicates: rows - N, extraPct: +(100 * (rows - N) / N).toFixed(1),
      theoryRows: mode === 'per-action' ? N : +(N * expectedPerTap).toFixed(1),
      proxy: { ...bed.proxy.stats }, client });
    console.log(JSON.stringify(results.at(-1)));
    await bed.close();
  }
}
writeFileSync(OUT, JSON.stringify(results, null, 1));
