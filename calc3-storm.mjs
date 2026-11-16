// Шторм перепідключень: node calc3-storm.mjs [U] [downMs] → results/storm.json
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const U = Number(process.argv[2] ?? 1000);
const DOWN = Number(process.argv[3] ?? 5000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function child(file) {
  const p = fork(path.join(here, file));
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
const pct = (a, p) => a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)];

const results = [];
for (const mode of (process.env.MODES ?? 'default,nojitter,full').split(',')) {
  const server = child('calc3-storm-server.js');
  const client = child('calc3-storm-client.js');
  await Promise.all([server.ready, client.ready]);
  const { port } = await server.call('start');
  const { ready } = await client.call('run', { mode, U, port });
  await sleep(1000);
  const rs = await server.call('restart', { downMs: DOWN });
  let st;
  for (let i = 0; i < 1200; i++) {                       // до 120 с
    st = await client.call('status');
    if (st.back === U) break;
    await sleep(100);
  }
  await sleep(500);
  const rep = await server.call('report');
  const cl = await client.call('report');
  const back = cl.filter((c) => c.tBack).map((c) => c.tBack - rs.t0).sort((a, b) => a - b);
  const arr = rep.arrivals.sort((a, b) => a - b);
  const bucket = new Map();
  for (const t of arr) bucket.set(Math.floor(t / 100), (bucket.get(Math.floor(t / 100)) ?? 0) + 1);
  let peak100 = 0, peak1000 = 0;
  for (const [b, n] of bucket) {
    peak100 = Math.max(peak100, n);
    let s = 0; for (let k = 0; k < 10; k++) s += bucket.get(b + k) ?? 0;
    peak1000 = Math.max(peak1000, s);
  }
  const resync = cl.map((c) => c.resyncMs).filter((x) => x !== null).sort((a, b) => a - b);
  const row = { mode, U, downMs: DOWN, ready, recovered: st.back,
    firstArrivalAfterUpMs: arr[0] - (rs.upAt - rs.t0), p50: pct(back, 0.5), p95: pct(back, 0.95), p100: back.at(-1),
    peakPer100ms: peak100, peakPerSec: peak1000, failedAttempts: cl.reduce((s, c) => s + c.failed, 0),
    resyncP50: pct(resync, 0.5), resyncP95: pct(resync, 0.95), resyncMax: resync.at(-1),
    serverCpuMs: Math.round(rep.cpuMs), arrivals100ms: [...bucket].sort((a, b) => a[0] - b[0]) };
  results.push(row);
  console.log(JSON.stringify({ ...row, arrivals100ms: undefined }));
  client.call('close').catch(() => {});
  server.kill(); client.kill();
  await sleep(1500);
}
fs.writeFileSync(path.join(here, `results/${process.env.OUT ?? 'storm.json'}`), JSON.stringify(results, null, 1));
process.exit(0);
