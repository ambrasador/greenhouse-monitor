// Пам’ять сервера на одне з’єднання: свіжий процес на кожен замір.
// node calc3-mem.mjs → results/mem.json
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const rows = [];
for (const kind of ['socketio', 'sse', 'ws']) {
  for (const U of [0, 1000, 2000, 4000]) {
    for (let rep = 0; rep < 3; rep++) {
      const server = child('calc3-fan-server.js', ['--expose-gc']);
      const client = child('calc3-fan-client.js');
      await Promise.all([server.ready, client.ready]);
      const ports = await server.call('start', { windowMs: 0 });
      await sleep(500);
      const m0 = await server.call('mem');
      if (U) await client.call('connect', { kind, U, ports });
      await sleep(2500);
      const m1 = await server.call('mem');
      const row = { kind, U, rep, rssMB: +m1.rssMB.toFixed(2), baseRssMB: +m0.rssMB.toFixed(2),
        heapMB: +m1.heapMB.toFixed(2), baseHeapMB: +m0.heapMB.toFixed(2),
        extMB: +m1.extMB.toFixed(2), baseExtMB: +m0.extMB.toFixed(2),
        kbRss: U ? +(((m1.rssMB - m0.rssMB) * 1024) / U).toFixed(1) : 0,
        kbHeapExt: U ? +(((m1.heapMB + m1.extMB - m0.heapMB - m0.extMB) * 1024) / U).toFixed(1) : 0 };
      rows.push(row);
      console.log(JSON.stringify(row));
      await client.call('close').catch(() => {});
      server.kill(); client.kill();
      await sleep(800);
      if (!U) break;
    }
  }
}
fs.writeFileSync(path.join(here, 'results/mem.json'), JSON.stringify(rows, null, 1));
process.exit(0);
