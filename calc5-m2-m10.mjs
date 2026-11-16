// M2 (годинник за Date) і M10 (скасування SSE): стенд + Dart-інструменти.
//   node calc5-m2-m10.mjs out_m2.json out_m10.json
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { startMobileBed } = require('./mobile-bed');

function dart(tool, args) {
  return new Promise((resolve, reject) => {
    const p = spawn('dart', ['run', `tool/${tool}.dart`, ...args],
      { cwd: new URL('./mobile/', import.meta.url).pathname, env: process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => (code === 0
      ? resolve(JSON.parse(out.trim().split('\n').pop()))
      : reject(new Error(`dart ${code}: ${err}`))));
  });
}

const [outM2, outM10] = [process.argv[2] ?? 'results/m2.json', process.argv[3] ?? 'results/m10.json'];

if (!process.env.SKIP_M2) {
// --- M2: телефон поспішає на 37,3 с, відстає на 12,9 с, годинник точний
const m2 = [];
for (const skewMs of [37_300, -12_900, 0]) {
  const bed = await startMobileBed();
  m2.push(await dart('m2_clock', ['--base', bed.api, '--skew-ms', String(skewMs), '--n', '100', '--gap-ms', '137']));
  console.log(JSON.stringify(m2.at(-1)));
  await bed.close();
}
writeFileSync(outM2, JSON.stringify(m2, null, 1));
}

// --- M10: скасування; потім ліміт потоків на клієнта (6)
const m10 = [];
for (const [impl, runs] of [['legacy', 3], ['abortable', 20]]) {
  const bed = await startMobileBed({ sse: { heartbeatMs: 15_000 } });
  m10.push(await dart('m10_cancel', ['--base', bed.api, '--ctl', bed.ctl, '--impl', impl, '--mode', 'cancel', '--runs', String(runs)]));
  console.log(JSON.stringify(m10.at(-1)));
  await bed.close();
}
for (const impl of ['legacy', 'abortable']) {
  const bed = await startMobileBed({ sse: { heartbeatMs: 15_000 } });
  m10.push(await dart('m10_cancel', ['--base', bed.api, '--ctl', bed.ctl, '--impl', impl, '--mode', 'slots', '--runs', '10']));
  console.log(JSON.stringify(m10.at(-1)));
  await bed.close();
}
writeFileSync(outM10, JSON.stringify(m10, null, 1));
