'use strict';
// U клієнтів з трьома політиками перепідключення:
//   default  — Socket.IO за замовчуванням (1 с, подвоєння до 5 с, ±50 %)
//   nojitter — те саме без випадковості
//   full     — перепідключення веде застосунок: повний джитер, base 1 с, стеля 30 с
//   full5    — те саме з base 5 с і стелею 60 с
const { io } = require('socket.io-client');

let cl = [];
let url = '';
let backoff;
const isFull = (c) => c.mode.startsWith('full');

function resync(c) {
  const from = new Date(Date.now() - 360_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const q = new URLSearchParams({ device: 'gh1-s01', metric: 'temperature', from, to, limit: '1000' });
  return fetch(`${url}/api/v1/telemetry?${q}`).then((r) => r.json());
}

function attach(c, socket) {
  c.socket = socket;
  socket.on('connect', () => {
    c.tConnect = Date.now();
    socket.emit('subscribe', { device: 'gh1-s01' }, async (a) => {
      if (!a.ok) return;
      await resync(c).catch(() => {});
      c.attempt = 0;
      if (c.tDisc !== null && c.tBack === null) { c.tBack = Date.now(); c.resyncMs = c.tBack - c.tConnect; }
      c.ready = true;
    });
  });
  socket.on('disconnect', () => {
    if (c.tDisc === null) c.tDisc = Date.now();
    c.ready = false;
    if (isFull(c) && c.socket === socket) retry(c);
  });
  socket.on('connect_error', () => {
    if (c.tDisc === null) return;
    c.failed += 1;
    if (isFull(c) && c.socket === socket) retry(c);
  });
  socket.io.on('reconnect_error', () => { c.failed += 1; });
}

function retry(c) {
  c.socket.removeAllListeners(); c.socket.close();
  c.attempt += 1;
  setTimeout(() => attach(c, open(c)), backoff(c.attempt, c.mode));
}

function open(c) {
  const base = { transports: ['websocket'], forceNew: true };
  if (isFull(c)) return io(url, { ...base, reconnection: false });
  return io(url, { ...base, reconnection: true,
    ...(c.mode === 'nojitter' ? { randomizationFactor: 0 } : {}) });
}

async function run({ mode, U, port }) {
  url = `http://127.0.0.1:${port}`;
  const { delay } = await import('./client/backoff.js');
  backoff = (n, mode) => delay(n, mode === 'full5' ? { base: 5000, cap: 60_000 } : { base: 1000, cap: 30_000 });
  cl = Array.from({ length: U }, () => ({ mode, tDisc: null, tBack: null, failed: 0,
    attempt: 0, ready: false, resyncMs: null }));
  for (let i = 0; i < U; i += 100) {
    cl.slice(i, i + 100).forEach((c) => attach(c, open(c)));
    await new Promise((r) => setTimeout(r, 100));
  }
  for (let i = 0; i < 200 && cl.some((c) => !c.ready); i++) await new Promise((r) => setTimeout(r, 100));
  return { ready: cl.filter((c) => c.ready).length };
}
const status = () => ({ back: cl.filter((c) => c.tBack !== null).length,
  down: cl.filter((c) => c.tDisc !== null).length });
const report = () => cl.map((c) => ({ tDisc: c.tDisc, tBack: c.tBack, failed: c.failed, resyncMs: c.resyncMs }));
const close = () => { cl.forEach((c) => { c.socket.removeAllListeners(); c.socket.close(); }); cl = []; return {}; };

const handlers = { run, status, report, close };
process.on('message', async (m) => {
  try { process.send({ id: m.id, result: await handlers[m.op](m.args ?? {}) }); }
  catch (e) { process.send({ id: m.id, error: e.stack }); }
});
process.send({ ready: true });
