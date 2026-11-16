// Пропускна здатність повного конвеєра: Aedes → mqtt.js (handleMessage) → ядро → SQLite
import { createRequire } from 'node:module';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Aedes } from 'aedes';
const require = createRequire(import.meta.url);
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const N = Number(process.argv[3] ?? 20000);
const SYNC = process.argv[2] ?? 'FULL';

const aedes = await Aedes.createBroker();
const server = net.createServer(aedes.handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `mqtt://127.0.0.1:${server.address().port}`;
const DB = path.join(os.tmpdir(), 'e2e-thr.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const p = spawn('node', ['main.js'], { env: { ...process.env, MQTT_URL: url, DB_FILE: DB, PORT: '3223', DB_SYNC: SYNC } });
for (let i = 0; i < 50; i++) { try { if ((await fetch('http://127.0.0.1:3223/readyz')).status === 200) break; } catch {} await wait(100); }

const pub = mqtt.connect(url, { clientId: 'gh1-s01' });
await new Promise((r) => pub.once('connect', r));
const base = Date.now() - 3600e3;
for (let i = 0; i < N; i++) {
  pub.publish(`greenhouse/gh${i % 50}/telemetry`, JSON.stringify(
    { metric: 'temperature', value: 20 + (i % 10) / 10, ts: new Date(base + i).toISOString() }), { qos: 1 });
}
const db = new Database(DB, { readonly: true });
const count = () => db.prepare('select count(*) n from telemetry').get().n;
let first = null, firstN = 0, last = 0, lastT = 0;
const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  const n = count();
  if (n > 0 && first === null) { first = Date.now(); firstN = n; }
  if (n !== last) { last = n; lastT = Date.now(); }
  if (n >= N) break;
  await wait(20);
}
const sec = (lastT - first) / 1000;
console.log(`режим synchronous=${SYNC}: ${last} з ${N} повідомлень, ${(last - firstN) / sec | 0} пов./с`);
p.kill('SIGTERM'); pub.end(true); process.exit(0);
