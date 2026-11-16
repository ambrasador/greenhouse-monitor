// M8: вартість ротації refresh-токена. (а) час одного обміну refresh-токена (транзакція: позначити
// використаний, видати наступний) на файлі SQLite у режимі WAL і synchronous=FULL, як у main.js;
// (б) розмір таблиці refresh_tokens на один рядок; (в) скільки рядків накопичує сеанс, що обмінюється
// щоразу, коли спливає токен доступу (900 с), за строку 30 діб + 7 діб відстрочки очищення.
//   node calc6-refresh.mjs [out.json]
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createRefresh } = require('./refresh');

const EXCHANGES = 20_000;
const ACCESS_TTL = 900;
const TTL_DAYS = 30;
const GRACE_DAYS = 7;
const dir = mkdtempSync(path.join(tmpdir(), 'm8-'));
const file = path.join(dir, 'm8.db');
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.exec(readFileSync(new URL('./schema-auth.sql', import.meta.url), 'utf8'));
db.prepare(`INSERT INTO users (user_id, username, pw_hash, role, created_at)
            VALUES ('u1', 'u1', 'x', 'viewer', '2026-01-01T00:00:00Z')`).run();

let now = Date.parse('2026-11-05T09:00:00Z');
const refresh = createRefresh({ db, clock: () => now });
let { token } = refresh.issue('u1');
const us = [];
for (let i = 0; i < EXCHANGES; i++) {
  now += ACCESS_TTL * 1000;
  const t = process.hrtime.bigint();
  token = refresh.rotate(token).token;
  us.push(Number(process.hrtime.bigint() - t) / 1e3);
}
us.sort((a, b) => a - b);
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
const rows = db.prepare('SELECT count(*) FROM refresh_tokens').pluck().get();
const pages = db.pragma('page_count', { simple: true });
const pageSize = db.pragma('page_size', { simple: true });
const bytes = pages * pageSize;
db.close();

const perDay = 86_400 / ACCESS_TTL;
const out = {
  node: process.version, exchanges: EXCHANGES,
  exchangeUs: { median: us[us.length >> 1], p99: us[Math.floor(us.length * 0.99)], max: us.at(-1) },
  exchangesPerSec: 1e6 / us[us.length >> 1],
  rows, tableBytes: bytes, bytesPerRow: bytes / rows,
  rowsPerDay: perDay, retentionDays: TTL_DAYS + GRACE_DAYS,
  steadyRowsPerSession: perDay * (TTL_DAYS + GRACE_DAYS),
  steadyKiBPerSession: (perDay * (TTL_DAYS + GRACE_DAYS) * (bytes / rows)) / 1024,
};
rmSync(dir, { recursive: true, force: true });
console.log(`обмін: медіана ${out.exchangeUs.median.toFixed(0)} мкс, p99 ${out.exchangeUs.p99.toFixed(0)} мкс (${out.exchangesPerSec.toFixed(0)} за с)`);
console.log(`таблиця: ${rows} рядків, ${(bytes / 1024).toFixed(0)} КіБ, ${out.bytesPerRow.toFixed(0)} Б на рядок`);
console.log(`сеанс, що обмінюється кожні ${ACCESS_TTL} с: ${perDay} рядків за добу, у сталому режимі ${out.steadyRowsPerSession} рядків, ${out.steadyKiBPerSession.toFixed(0)} КіБ`);
writeFileSync(process.argv[2] ?? new URL('results/refresh.json', import.meta.url), JSON.stringify(out, null, 2));
process.exit(0);
