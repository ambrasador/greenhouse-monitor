// M7: приватність. (а) розмір комірки координатної сітки на широті Херсона і похибка, яку вона дає,
// звіряні з відстанню за формулою гаверсинуса; (б) псевдонім як SHA-256 ідентифікатора проти HMAC:
// скільки часу потрібно, щоб відновити ідентифікатори з простору 10^6 і 10^9; (в) вартість одного
// пакета видалення за строком зберігання залежно від розміру пакета (файл SQLite, WAL, synchronous=FULL, як у main.js).
//   node calc6-privacy.mjs [out.json]
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { coarsen, cellKm, pseudonym } = require('./privacy');
const Database = require('better-sqlite3');
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const out = {};

// (а) сітка
const LAT = 46.6354;                                           // Херсон
const R = 6371.0088;
const hav = (a, b) => {
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
out.grid = [0.001, 0.01, 0.1].map((cell) => {
  const km = cellKm(LAT, cell);
  const a = { lat: LAT, lon: 32.6169 };
  const ns = hav(a, { lat: LAT + cell, lon: a.lon });
  const ew = hav(a, { lat: LAT, lon: a.lon + cell });
  // найгірша похибка: точка в куті комірки, повертається центр
  let worst = 0;
  for (let i = 0; i < 2000; i++) {
    const p = { lat: LAT + Math.random() * 0.5, lon: 32 + Math.random() * 0.5 };
    const c = coarsen(p.lat, p.lon, cell);
    worst = Math.max(worst, hav(p, c));
  }
  const row = { cellDeg: cell, nsKm: km.northSouth, ewKm: km.eastWest, nsHaversine: ns, ewHaversine: ew,
    maxErrorKm: worst, maxErrorTheory: Math.hypot(km.northSouth, km.eastWest) / 2 };
  console.log(`сітка ${cell}°: ${km.northSouth.toFixed(3)} × ${km.eastWest.toFixed(3)} км (гаверсинус ${ns.toFixed(3)} × ${ew.toFixed(3)}), `
    + `найбільша похибка ${worst.toFixed(3)} км, теоретично ${row.maxErrorTheory.toFixed(3)} км`);
  return row;
});

// (б) псевдоніми
const SECRET = randomBytes(32);
const sha = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 24);
const ids = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 1_000_000));
const exposed = new Map(ids.map((id) => [sha(id), id]));
const hmacd = new Set(ids.map((id) => pseudonym(SECRET, id)));
let t = process.hrtime.bigint();
let recovered = 0;
for (let id = 0; id < 1_000_000; id++) if (exposed.has(sha(id))) recovered++;
const enumSec = Number(process.hrtime.bigint() - t) / 1e9;
let rateRuns = [];
for (let r = 0; r < 5; r++) {
  const n = 1_000_000;
  const s = process.hrtime.bigint();
  for (let i = 0; i < n; i++) sha(i);
  rateRuns.push(n / (Number(process.hrtime.bigint() - s) / 1e9));
}
const rate = median(rateRuns);
let viaHmac = 0;
for (let id = 0; id < 1_000_000; id++) if (hmacd.has(sha(id))) viaHmac++;       // той самий перебір проти псевдонімів HMAC
out.pseudonym = { space: 1_000_000, sample: ids.length, recoveredFromSha: recovered, recoveredFromHmac: viaHmac,
  enumerationSec: enumSec, shaPerSec: rate, sec1e9: 1e9 / rate };
console.log(`SHA-256 без ключа: з 1000 псевдонімів відновлено ${recovered} (кількість різних: ${exposed.size}) за ${enumSec.toFixed(2)} с; ${Math.round(rate)} хешів/с; 10^9 → ${(1e9 / rate / 60).toFixed(0)} хв`);
console.log(`HMAC із ключем: відновлено ${viaHmac} з 1000 тим самим перебором`);

// (в) пакетне видалення
const dir = mkdtempSync(path.join(tmpdir(), 'ret-'));
const ROWS = 600_000;
const batches = [100, 1000, 5000, 20_000, 100_000];
const iso = (ms) => new Date(ms).toISOString();
const base = Date.parse('2024-01-01T00:00:00Z');
const result = [];
for (const batch of batches) {
  const db = new Database(path.join(dir, `b${batch}.db`));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(`CREATE TABLE telemetry (device_id TEXT NOT NULL, metric TEXT NOT NULL, ts TEXT NOT NULL,
    received_at TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (device_id, metric, ts)) WITHOUT ROWID;`);
  const ins = db.prepare('INSERT INTO telemetry VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => { for (let i = 0; i < ROWS; i++) { const ts = iso(base + i * 1000); ins.run('gh1-s01', 'temperature', ts, ts, 21 + (i % 7) / 10); } })();
  const del = db.prepare(`DELETE FROM telemetry WHERE (device_id, metric, ts) IN
    (SELECT device_id, metric, ts FROM telemetry WHERE device_id = @d AND metric = @m AND ts < @cut ORDER BY ts LIMIT @batch)`);
  const cut = iso(base + ROWS * 1000 + 1);
  const times = [];
  for (let n = batch; n === batch && times.length < 12;) {
    const s = process.hrtime.bigint();
    n = del.run({ d: 'gh1-s01', m: 'temperature', cut, batch }).changes;
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  const m = median(times);
  result.push({ batch, medianMs: m, maxMs: Math.max(...times), rowsPerSec: batch / (m / 1000), batches: times.length });
  console.log(`пакет ${String(batch).padStart(6)} рядків: ${m.toFixed(1).padStart(8)} мс (макс ${Math.max(...times).toFixed(1)}), ${Math.round(batch / (m / 1000))} рядків/с`);
  db.close();
}
rmSync(dir, { recursive: true, force: true });
out.retention = { rows: ROWS, results: result };

writeFileSync(process.argv[2] ?? 'results/privacy.json', JSON.stringify({ node: process.version, ...out }, null, 2));
