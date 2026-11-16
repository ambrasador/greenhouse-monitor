// M10: скільки коштує запис у журнал аудиту, коли записів багато (потік відмов вебхука чи входу).
// (а) час одного audit.record() у режимі WAL і synchronous=FULL, як у main.js;
// (б) скільки байтів займає рядок разом з індексом audit_ts;
// (в) скільки це складає за добу при ліміті прийому з розділу 2 (100 запитів за секунду з однієї адреси).
// Рядок моделює відхилений вебхук: дія 'webhook', результат 'rejected', адреса і причина в detail.
//   node calc6-audit.mjs [out.json]
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createAudit } = require('./audit');

const N = 20_000;
const PER_IP_RATE = 100;                    // limits.ingest.rate: запитів за секунду з однієї адреси
const dir = mkdtempSync(path.join(tmpdir(), 'm10-'));
const file = path.join(dir, 'm10.db');
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.exec(readFileSync(new URL('./schema-auth.sql', import.meta.url), 'utf8'));
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
const emptyBytes = statSync(file).size;

let now = Date.parse('2026-11-05T09:00:00Z');
const audit = createAudit({ db, clock: () => now });
const us = [];
for (let i = 0; i < N; i++) {
  now += 10;
  const t = process.hrtime.bigint();
  audit.record({ action: 'webhook', outcome: 'rejected', ip: `203.0.113.${i % 250}`, detail: { why: 'bad-signature' } });
  us.push(Number(process.hrtime.bigint() - t) / 1e3);
}
us.sort((a, b) => a - b);
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
const bytesPerRow = (statSync(file).size - emptyBytes) / N;
db.close();
rmSync(dir, { recursive: true, force: true });

const medianUs = us[N >> 1];
const out = {
  node: process.version,
  rows: N,
  recordUs: { median: medianUs, p99: us[Math.floor(N * 0.99)], max: us.at(-1) },
  recordsPerSec: 1e6 / medianUs,
  bytesPerRow,
  flood: {
    perIpRate: PER_IP_RATE,
    rowsPerDay: PER_IP_RATE * 86_400,
    mbPerDay: (PER_IP_RATE * 86_400 * bytesPerRow) / 1e6,
    coreShare: (PER_IP_RATE * medianUs) / 1e6,
    daysToFill10Gb: 10e9 / (PER_IP_RATE * 86_400 * bytesPerRow),
  },
};
console.log(`audit.record: медіана ${medianUs.toFixed(0)} мкс, p99 ${out.recordUs.p99.toFixed(0)} мкс, ${out.recordsPerSec.toFixed(0)} записів/с`);
console.log(`рядок: ${bytesPerRow.toFixed(1)} байта; ${PER_IP_RATE} відмов/с = ${out.flood.rowsPerDay} рядків/добу = ${out.flood.mbPerDay.toFixed(0)} МБ/добу `
  + `(${(out.flood.coreShare * 100).toFixed(1)} % ядра); 10 ГБ за ${out.flood.daysToFill10Gb.toFixed(1)} доби`);
writeFileSync(process.argv[2] ?? new URL('results/audit.json', import.meta.url), JSON.stringify(out, null, 2));
process.exit(0);
