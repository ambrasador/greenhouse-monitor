// Ціна connectionStateRecovery без клієнтів і з одним клієнтом:
// node --expose-gc calc3-recovery.mjs off|on → results/recovery-<режим>.json
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { makeDb, addDevice } = require('./testkit');
const { createFeed } = require('./feed');
const { attachRealtime } = require('./realtime');
const { io: connect } = require('socket.io-client');

const mode = process.argv[2] ?? 'off';
const N = 20_000;
const MB = 1048576;
const live = () => { global.gc(); const m = process.memoryUsage(); return (m.heapUsed + m.external) / MB; };

const db = makeDb();
addDevice(db, 'gh1-s01', 'north');
const feed = createFeed({ windowMs: 0 });
const server = http.createServer();
const rt = attachRealtime(server, { db, feed, recoveryMs: mode === 'on' ? 120_000 : 0 });
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const metrics = ['temperature', 'humidity', 'soil', 'light'];
const frame = (i) => {
  for (const [k, metric] of metrics.entries()) {
    feed.publish({ device: 'gh1-s01', metric, ts: new Date(1_800_000_000_000 + i * 1000).toISOString(),
      value: 20 + k + (i % 100) / 10 });
  }
  feed.flush();
};
for (let i = 0; i < 2000; i++) frame(i);               // прогрів
const out = { mode, frames: N };
for (const withClient of [false, true]) {
  let client = null;
  if (withClient) {
    client = connect(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], reconnection: false });
    await new Promise((r) => client.once('connect', r));
    await new Promise((r) => client.emit('subscribe', { device: 'gh1-s01' }, r));
    client.on('telemetry:update', () => {});
  }
  const before = live();
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    frame(10_000 + i + (withClient ? N : 0));
    if (withClient && i % 500 === 0) await new Promise((r) => setImmediate(r));
  }
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const cpu = process.cpuUsage(cpu0);
  const after = live();
  out[withClient ? 'oneClient' : 'noClients'] = {
    bytesPerFrame: Math.round(((after - before) * MB) / N),
    usPerFrame: +(((cpu.user + cpu.system)) / N).toFixed(2),
    wallMs: Math.round(wallMs),
    packetsKept: rt.io.of('/').adapter.packets?.length ?? null };
  if (client) { client.removeAllListeners(); client.close(); }
}
fs.writeFileSync(path.join(here, `results/recovery-${mode}.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
process.exit(0);
