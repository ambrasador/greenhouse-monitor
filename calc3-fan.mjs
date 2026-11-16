// Вартість розсилання: node calc3-fan.mjs [A|B|all] → results/fan.json
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] ?? 'all';
const only = process.argv[3];                 // 'sse' — лише SSE
const tag = process.argv[4] ?? '';
const outFile = path.join(here, `results/fan${tag}.json`);

function child(file, execArgv = []) {
  const p = fork(path.join(here, file), [], { execArgv });
  let n = 0;
  const waiting = new Map();
  const ready = new Promise((r) => p.once('message', r));
  p.on('message', (m) => { if (m.id) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const call = (op, args) => new Promise((res, rej) => {
    const id = ++n;
    waiting.set(id, (m) => (m.error ? rej(new Error(m.error)) : res(m.result)));
    p.send({ id, op, args });
  });
  return { call, ready, kill: () => p.kill() };
}

const server = child('calc3-fan-server.js', ['--expose-gc']);
const client = child('calc3-fan-client.js');
await Promise.all([server.ready, client.ready]);
const results = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : [];
const save = () => fs.writeFileSync(outFile, JSON.stringify(results, null, 1));

async function scenario(name, { kind, U, eventsPerSec, readings, seconds = 20, windowMs = 0 }) {
  const ports = await server.call('start', { windowMs });
  await new Promise((r) => setTimeout(r, 500));
  const m0 = await server.call('mem');
  await client.call('connect', { kind, U, ports });
  await new Promise((r) => setTimeout(r, 1500));
  const m1 = await server.call('mem');
  await client.call('reset');
  const load = await server.call('load', { eventsPerSec, readings, seconds });
  await new Promise((r) => setTimeout(r, 500));
  const rx = await client.call('report');
  const m2 = await server.call('mem');
  await client.call('close');
  await server.call('stop');
  const expectReadings = Math.round(eventsPerSec * seconds) * readings * U;
  const cpuMs = load.netCpuMs;                 // без фонового навантаження
  const row = { name, kind, U, eventsPerSec, readings, seconds, windowMs,
    rssBeforeMB: +m0.rssMB.toFixed(1), rssConnectedMB: +m1.rssMB.toFixed(1), rssLoadMB: +m2.rssMB.toFixed(1),
    kbPerConn: +(((m1.rssMB - m0.rssMB) * 1024) / U).toFixed(1),
    idleCpuPct: +load.idleCpuPct.toFixed(2), cpuPct: +((100 * cpuMs) / load.wallMs).toFixed(1), cpuUserMs: +load.cpuUserMs.toFixed(0), cpuSysMs: +load.cpuSysMs.toFixed(0),
    emits: load.frames, readingsPublished: load.readings,
    usPerDelivery: +((cpuMs * 1000) / (load.readings * U)).toFixed(2),
    usPerFrameDelivery: +((cpuMs * 1000) / (load.frames * U)).toFixed(2),
    loopP99ms: +load.loopP99.toFixed(1), loopMaxMs: +load.loopMax.toFixed(1),
    received: rx.readings, expected: expectReadings, p50: rx.p50, p95: rx.p95, p99: rx.p99, max: rx.max };
  results.push(row); save();
  console.log(JSON.stringify(row));
  await new Promise((r) => setTimeout(r, 1000));
}

if (which === 'A' || which === 'all') {
  for (const U of [100, 500, 1000, 2000]) {
    for (const kind of ['socketio', 'sse', 'ws'].filter((k) => !only || k === only)) {
      await scenario(`A-${kind}-${U}`, { kind, U, eventsPerSec: 5, readings: 4 });
    }
  }
}
if (which === 'B' || which === 'all') {
  for (const kind of ['socketio', 'sse'].filter((k) => !only || k === only)) {
    for (const [eventsPerSec, readings] of [[100, 1], [25, 4], [5, 20], [1, 100]]) {
      await scenario(`B-${kind}-${readings}`, { kind, U: 200, eventsPerSec, readings });
    }
  }
}
server.kill(); client.kill();
process.exit(0);
