// Розділ 7: скільки тестів у кожному рівні піраміди еталона і скільки вони тривають.
// Кожен файл запускається окремо (node --test --test-reporter=tap), без паралельного навантаження.
// Рівень визначається за вмістом файла: мережа → інтеграційний із мережею,
// база (testkit, better-sqlite3) → інтеграційний із базою, решта → модульний.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const files = [...fs.readdirSync(here).filter((f) => f.endsWith('.test.js')),
  ...fs.readdirSync(path.join(here, 'client')).filter((f) => f.endsWith('.test.js')).map((f) => `client/${f}`)]
  .sort();

// Рівень визначає поведінка процесу, а не текст файла: зонд calc7-probe.cjs фіксує,
// чи відкривав він сокети (мережа) і чи завантажував SQLite (база)
const PROBE = path.join(here, 'results', 'probe.jsonl');
const level = (p) => (p.net ? 'integration-net' : p.db ? 'integration-db' : 'unit');

const rows = [];
for (const f of files) {
  fs.rmSync(PROBE, { force: true });
  const t0 = process.hrtime.bigint();
  const r = spawnSync('node', ['--test', '--test-reporter=tap', f], { cwd: here, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--require=' + path.join(here, 'calc7-probe.cjs'), PROBE_OUT: PROBE } });
  const probes = fs.existsSync(PROBE) ? fs.readFileSync(PROBE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const p = { net: probes.some((x) => x.net), db: probes.some((x) => x.db) };
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const pick = (k) => Number((r.stdout.match(new RegExp(`^# ${k} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
  rows.push({ file: f, level: level(p), net: p.net, db: p.db, tests: pick('tests'), pass: pick('pass'), fail: pick('fail'),
    wallMs: Math.round(wallMs), status: r.status });
  console.log(`${level(p).padEnd(16)} ${String(pick('tests')).padStart(3)} ${String(Math.round(wallMs)).padStart(6)} мс  ${f}`);
}
const sum = {};
for (const r of rows) {
  const s = (sum[r.level] ??= { files: 0, tests: 0, wallMs: 0 });
  s.files++; s.tests += r.tests; s.wallMs += r.wallMs;
}
const startup = (() => { // накладні витрати запуску порожнього процесу node --test
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) execFileSync('node', ['-e', '0']);
  return Number(process.hrtime.bigint() - t0) / 5e6;
})();
console.log(JSON.stringify(sum), 'node -e 0 ≈', startup.toFixed(0), 'мс');
fs.mkdirSync('results', { recursive: true });
fs.writeFileSync('results/pyramid.json', JSON.stringify({ host: 'Xeon 2.1 GHz, sha_ni, 2 vCPU, Node ' + process.version,
  startupMs: Math.round(startup), sum, rows }, null, 1));
