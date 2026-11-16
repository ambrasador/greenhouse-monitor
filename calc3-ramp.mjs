// Скільки перепідключень за секунду витримує процес: node calc3-ramp.mjs → results/ramp.json
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
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

const rates = (process.argv[2] ?? '100,200,400,600,800,1000,1400,2000').split(',').map(Number);
const seconds = Number(process.argv[3] ?? 3);
const out = [];
for (const rate of rates) {
  const server = child('calc3-storm-server.js');
  const client = child('calc3-ramp-client.js');
  await Promise.all([server.ready, client.ready]);
  const { port } = await server.call('start');
  await sleep(500);
  await server.call('mark');
  const r = await client.call('run', { port, rate, seconds });
  const rep = await server.call('report');
  const row = { rate, seconds, ...r, serverCpuMsPerClient: +(rep.cpuMs / r.total).toFixed(3) };
  out.push(row);
  console.log(JSON.stringify(row));
  server.kill(); client.kill();
  await sleep(1500);
}
fs.writeFileSync(path.join(here, 'results/ramp.json'), JSON.stringify(out, null, 1));
process.exit(0);
