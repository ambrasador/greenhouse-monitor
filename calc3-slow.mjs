// Повільний клієнт: що росте на сервері, коли клієнт перестав читати.
// node calc3-slow.mjs [sse|sse-policy|socketio|socketio-policy] → results/slow-<режим>.json
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const express = require('express');
const { makeDb, addDevice } = require('./testkit');
const { createFeed } = require('./feed');
const { attachRealtime } = require('./realtime');
const { createStreamHandler } = require('./sse');
const { GREENHOUSE } = require('./metrics');

const mode = process.argv[2] ?? 'sse';
const SECONDS = Number(process.argv[3] ?? (mode.startsWith('socketio') ? 60 : 25));
const FRAME_KB = 8;                     // як пакет зі ста вимірювань
const RATE = mode.startsWith('socketio') ? 100 : 200;          // подій за секунду
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = 'x'.repeat(FRAME_KB * 1024);

const db = makeDb();
addDevice(db, 'gh1-s01', 'north');
const feed = createFeed({ windowMs: 0 });
const app = express();
let sseRes = null;
const policy = mode.endsWith('policy');
app.get('/devices/:id/stream', (req, res, next) => {
  sseRes = res;
  return createStreamHandler({ db, feed, metrics: GREENHOUSE, perClient: 1e9,
    maxBuffered: policy ? 1 << 20 : Infinity })(req, res, next);
});
const server = http.createServer(app);
const rt = attachRealtime(server, { db, feed, ...(policy ? { maxQueue: 500 } : { maxQueue: Infinity }) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const samples = [];
let closedAt = null;
let reason = null;
let stuck = null;

if (mode.startsWith('sse')) {
  // клієнт — «сирий» TCP-сокет, який надіслав запит і більше не читає
  stuck = net.connect(port, '127.0.0.1');
  await new Promise((r) => stuck.once('connect', r));
  stuck.write('GET /devices/gh1-s01/stream HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n');
  await sleep(300);
  stuck.pause();
  sseRes.on('close', () => { closedAt ??= Date.now(); reason = 'сервер закрив потік'; });
} else {
  // клієнт — окремий процес, який ми заморожуємо сигналом SIGSTOP (вкладка «заснула»)
  const kid = fork(path.join(here, 'calc3-slow-client.js'), [String(port)]);
  await new Promise((r) => kid.once('message', r));
  const sid = [...rt.io.sockets.sockets.values()][0];
  sid.on('disconnect', (why) => { closedAt ??= Date.now(); reason = why; });
  stuck = { sock: sid, kid };
  process.kill(kid.pid, 'SIGSTOP');
  await sleep(300);
}

const MB = 1048576;
const live = () => { global.gc(); const m = process.memoryUsage(); return (m.heapUsed + m.external) / MB; };
const base = process.memoryUsage().rss;
const liveBase = live();
const t0 = Date.now();
let sent = 0;
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  const queued = mode.startsWith('sse')
    ? (sseRes?.destroyed ? 0 : sseRes.writableLength)
    : stuck.sock.conn?.writeBuffer?.length ?? 0;
  samples.push({ t: Math.round((Date.now() - t0) / 1000), queued, rssMB: +((m.rss - base) / MB).toFixed(1),
    liveMB: +(live() - liveBase).toFixed(1), sent, open: closedAt === null });
}, 1000);
const step = 1000 / RATE;
for (let n = 0; n < RATE * SECONDS; n++) {
  const wait = t0 + n * step - Date.now();
  if (wait > 1) await sleep(wait);
  feed.publish({ device: 'gh1-s01', metric: 'temperature', ts: new Date().toISOString(), value: pad });
  sent += 1;
}
await sleep(1200);
clearInterval(sampler);
const out = { mode, seconds: SECONDS, frameKB: FRAME_KB, rate: RATE, closedAfterS: closedAt ? +((closedAt - t0) / 1000).toFixed(1) : null,
  reason, peakQueued: Math.max(...samples.map((s) => s.queued)), peakRssMB: Math.max(...samples.map((s) => s.rssMB)),
  peakLiveMB: Math.max(...samples.map((s) => s.liveMB)), rssAfterMB: samples.at(-1).rssMB, samples };
fs.writeFileSync(path.join(here, `results/slow-${mode}.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, samples: undefined }));
console.log(samples.filter((_, i) => i % 5 === 0).map((s) => `${s.t}s q=${s.queued} live+${s.liveMB}MB rss+${s.rssMB}MB`).join('\n'));
if (stuck.kid) { process.kill(stuck.kid.pid, 'SIGCONT'); stuck.kid.kill('SIGKILL'); }
process.exit(0);
