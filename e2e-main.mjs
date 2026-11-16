// Перевірка main.js на брокері Aedes: SIGKILL посеред потоку, перезапуск, повтор, SIGTERM.
// Кожен крок підтверджено перевіркою: за першого ж порушення сценарій завершується кодом 1
import assert from 'node:assert/strict';
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

const aedes = await Aedes.createBroker();
const server = net.createServer(aedes.handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `mqtt://127.0.0.1:${server.address().port}`;
const DB = path.join(os.tmpdir(), 'e2e.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
const BASE = 'http://127.0.0.1:3222';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Чекаємо умову, а не фіксовану паузу (розділ 7.3): падаємо з назвою умови
async function until(check, what, ms = 15_000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if (await check()) return;
    await wait(25);
  }
  throw new Error(`не дочекались: ${what} (${ms} мс)`);
}
const rows = () => { const d = new Database(DB, { readonly: true });
  const n = d.prepare('select count(*) n from telemetry').get().n; d.close(); return n; };
const duplicates = async () => {
  try {
    const text = await (await fetch(`${BASE}/metrics`)).text();
    return Number(text.match(/greenhouse_readings_total\{result="duplicate"\} (\d+)/)?.[1] ?? 0);
  } catch { return 0; }
};
function run() {
  const p = spawn('node', ['main.js'], { env: { ...process.env, MQTT_URL: url, DB_FILE: DB, PORT: '3222', AUTH_DISABLED: '1' } });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  return { p, lines: () => out.trim().split('\n'),
    exit: () => new Promise((r) => p.once('exit', (c, s) => r(`код ${c}, сигнал ${s}`))) };
}
const ready = async () => {
  await until(async () => { try { return (await fetch(`${BASE}/readyz`)).status === 200; } catch { return false; } }, '/readyz = 200');
  return 200;
};
const pub = mqtt.connect(url, { clientId: 'gh1-s01' });
await new Promise((r) => pub.once('connect', r));
const t0 = Date.now() - 600000;
const send = (i) => new Promise((r) => pub.publish('greenhouse/gh1-s01/telemetry',
  JSON.stringify({ metric: 'temperature', value: 20 + (i % 10) / 10,
    ts: new Date(t0 + i * 1000).toISOString() }), { qos: 1 }, r));
const TOTAL = 600;

let a = run();
try {
  assert.equal(await ready(), 200);
  console.log('1. /readyz: 200');
  const sending = (async () => { for (let i = 0; i < TOTAL; i++) { await send(i); if (i % 50 === 0) await wait(5); } })();
  await until(() => rows() >= 20, 'перші 20 рядків у базі');
  console.log('   SIGKILL посеред потоку: рядків у базі', rows());
  a.p.kill('SIGKILL');
  assert.equal(await a.exit(), 'код null, сигнал SIGKILL');
  await sending;
  const survived = rows();
  console.log('2. публікацію завершено, застосунок вимкнений; рядків', survived, 'із', TOTAL);
  assert.ok(survived < TOTAL, 'убивство мало статися до кінця потоку');

  a = run();
  await ready();
  await until(() => rows() === TOTAL, `${TOTAL} рядків після перезапуску`);
  // дублікати до повтору — це повідомлення, які перший процес записав, але не підтвердив
  console.log('3. після перезапуску: рядків', rows(), 'із', TOTAL,
    '| повторів від брокера:', await duplicates());

  // повтор усього потоку: дублікати не створюють рядків
  for (let i = 0; i < TOTAL; i++) await send(i);
  await until(async () => (await duplicates()) >= TOTAL, 'лічильник дублікатів у /metrics');
  assert.equal(rows(), TOTAL);
  console.log('4. після повторної публікації тих самих значень: рядків', rows());

  a.p.kill('SIGTERM');
  assert.equal(await a.exit(), 'код 0, сигнал null');
  // після запису shutdown у журнал може потрапити ще й broker_down: беремо запис за назвою
  const log = a.lines().map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .find((l) => l.msg === 'shutdown');
  assert.ok(log, 'у журналі немає запису shutdown');
  // що не встиг записати перший процес, записав другий: кожне повідомлення — рівно один раз
  assert.equal(log.stats.stored + survived, TOTAL);
  console.log('5. SIGTERM: код 0, сигнал null |', JSON.stringify(log));
  console.log('Усі перевірки пройдено');
} finally {
  a.p.kill('SIGKILL');
  pub.end(true);
  await new Promise((r) => aedes.close(r));
  server.close();
}
