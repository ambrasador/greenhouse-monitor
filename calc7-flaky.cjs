'use strict';
// Нестабільність тестів із фіксованою паузою: скільки справді йде від підтвердження брокера
// до появи показання в базі, у спокої й під навантаженням процесора, і яка частка
// запусків тесту «publish → sleep(X) → перевірка» виявилася б хибно червоною
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const mqtt = require('mqtt');
const { makeDb, addDevice } = require('./testkit');
const { createApp } = require('./app');
const { createMqttSource } = require('./mqtt-source');
const { startBroker } = require('./jest/helpers/broker');

const N = Number(process.argv[2] ?? 1500);
const LOADS = Number(process.argv[3] ?? os.cpus().length * 2);
const SLEEPS = [5, 10, 20, 50, 100];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

async function main() {
  const broker = await startBroker();
  const db = makeDb();
  addDevice(db, 'gh1-s01');
  const source = createMqttSource({ url: broker.url, clientId: 'ingest-flaky', filter: 'greenhouse/+/telemetry' });
  const ingest = createApp({ db, source });
  await ingest.start();
  const device = mqtt.connect(broker.url, { clientId: 'sim-flaky' });
  await new Promise((r) => device.once('connect', r));
  const select = db.prepare("SELECT ts FROM latest WHERE device_id = 'gh1-s01' AND metric = 'temperature'").pluck();
  let last = 0;

  async function sample() {            // повертає мс від PUBACK до появи рядка
    last = Math.max(Date.now(), last + 1);
    const ts = new Date(last).toISOString();
    await new Promise((res, rej) => device.publish('greenhouse/gh1-s01/telemetry',
      JSON.stringify({ metric: 'temperature', value: 21 + (last % 10) / 10, ts }), { qos: 1 }, (e) => (e ? rej(e) : res())));
    const t0 = process.hrtime.bigint();
    while (select.get() !== ts) await sleep(0);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  }
  // Те саме, але «як у поганому тесті»: фіксована пауза й перевірка один раз
  async function fixedSleep(ms) {
    last = Math.max(Date.now(), last + 1);
    const ts = new Date(last).toISOString();
    await new Promise((res, rej) => device.publish('greenhouse/gh1-s01/telemetry',
      JSON.stringify({ metric: 'temperature', value: 22, ts }), { qos: 1 }, (e) => (e ? rej(e) : res())));
    await sleep(ms);
    const ok = select.get() === ts;
    while (select.get() !== ts) await sleep(1);      // дочекатися, щоб наступна ітерація не змішалась
    return ok;
  }

  const result = { host: { cpus: os.cpus().length, model: os.cpus()[0].model, node: process.version }, N, loads: LOADS, conditions: {} };
  for (const cond of ['idle', 'load']) {
    const spinners = [];
    if (cond === 'load') for (let i = 0; i < LOADS; i++) spinners.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
    await sleep(300);
    for (let i = 0; i < 50; i++) await sample();          // розігрів
    const t = [];
    for (let i = 0; i < N; i++) t.push(await sample());
    const s = [...t].sort((a, b) => a - b);
    const fails = {};
    for (const ms of SLEEPS) fails[ms] = t.filter((x) => x > ms).length;
    // пряма перевірка двох значень паузи
    const direct = {};
    for (const ms of [5, 20]) {
      let bad = 0;
      for (let i = 0; i < 300; i++) if (!(await fixedSleep(ms))) bad++;
      direct[ms] = bad;
    }
    result.conditions[cond] = {
      p50: q(s, 0.5), p90: q(s, 0.9), p99: q(s, 0.99), p999: q(s, 0.999), max: s.at(-1),
      mean: t.reduce((a, b) => a + b, 0) / t.length,
      overSleep: fails, directFixedSleep300: direct,
    };
    for (const sp of spinners) sp.kill('SIGKILL');
    await sleep(300);
  }
  fs.writeFileSync(`${__dirname}/results/flaky.json`, JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
  await new Promise((r) => device.end(false, {}, r));
  await ingest.stop();
  await broker.stop();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
