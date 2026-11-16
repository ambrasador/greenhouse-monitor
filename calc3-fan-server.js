'use strict';
// Сервер стенду розсилання: Socket.IO, SSE та «голий» WebSocket (бібліотека ws)
// ділять одну шину. Керується повідомленнями IPC від calc3-fan.mjs
const http = require('node:http');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const express = require('express');
const { WebSocketServer } = require('ws');
const { makeDb, addDevice } = require('./testkit');
const { createFeed } = require('./feed');
const { attachRealtime } = require('./realtime');
// SSE_NAIVE=1 — вихідний варіант без кешу кадрів (для порівняння);
// RECOVERY_MS=120000 — Socket.IO з відновленням стану
const { createStreamHandler } = require(process.env.SSE_NAIVE ? './sse.naive' : './sse');
const { GREENHOUSE } = require('./metrics');

const DEV = 'gh1-s01';
const METRICS = [...GREENHOUSE.keys()];
let S = null;

async function start({ windowMs = 0, maxBuffered = 1 << 20, sendBuffer = null } = {}) {
  const db = makeDb();
  addDevice(db, DEV, 'north');
  const feed = createFeed({ windowMs });
  const app = express();
  app.get('/devices/:id/stream', createStreamHandler({ db, feed, metrics: GREENHOUSE,
    perClient: 1e9, maxBuffered }));
  const server = http.createServer(app);
  const rt = attachRealtime(server, { db, feed,
    recoveryMs: Number(process.env.RECOVERY_MS ?? 0) });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const stat = { frames: 0, readings: 0 };
  feed.subscribe('*', (device, readings) => {
    stat.frames += 1;
    stat.readings += readings.length;
    if (wss.clients.size) {
      const frame = JSON.stringify({ device, readings });
      for (const c of wss.clients) c.send(frame);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  if (!wss.address()) await new Promise((r) => wss.once('listening', r));
  S = { db, feed, server, rt, wss, stat, httpPort: server.address().port,
    wsPort: wss.address().port, sendBuffer };
  return { httpPort: S.httpPort, wsPort: S.wsPort };
}

const mem = () => {
  global.gc?.();
  const m = process.memoryUsage();
  return { rssMB: m.rss / 1048576, heapMB: m.heapUsed / 1048576,
    extMB: (m.external + m.arrayBuffers) / 1048576,
    sio: S.rt.io.engine.clientsCount, sse: S.feed.size() - 2, ws: S.wss.clients.size };
};

// Рівномірне навантаження: eventsPerSec подій на секунду, у кожній readings вимірювань
async function load({ eventsPerSec, readings, seconds, payloadPad = 0 }) {
  const { feed, stat } = S;
  // Фон: процес із відкритими з’єднаннями без навантаження (ping, heartbeat,
  // таймер вимірювання затримки циклу подій); його віднімаємо від результату
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const idle0 = process.cpuUsage();
  const idleT = performance.now();
  await new Promise((r) => setTimeout(r, 4000));
  const idleCpu = process.cpuUsage(idle0);
  const idleMs = performance.now() - idleT;
  h.reset();
  stat.frames = 0; stat.readings = 0;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const step = 1000 / eventsPerSec;
  const total = Math.round(eventsPerSec * seconds);
  const pad = payloadPad ? 'x'.repeat(payloadPad) : null;
  for (let n = 0; n < total; n++) {
    const wait = t0 + n * step - performance.now();
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    const ts = new Date().toISOString();
    for (let j = 0; j < readings; j++) {
      feed.publish({ device: DEV, metric: METRICS[j % 4], ts, value: pad ?? 20 + (j % 10) / 10 });
    }
  }
  feed.flush();
  await new Promise((r) => setTimeout(r, 300));
  const cpu = process.cpuUsage(cpu0);
  h.disable();
  const wallMs = performance.now() - t0;
  const bgRate = (idleCpu.user + idleCpu.system) / 1000 / idleMs;      // мс CPU на мс часу
  return { wallMs, idleCpuPct: 100 * bgRate,
    cpuUserMs: cpu.user / 1000, cpuSysMs: cpu.system / 1000,
    netCpuMs: (cpu.user + cpu.system) / 1000 - bgRate * wallMs,
    frames: stat.frames, readings: stat.readings,
    loopP50: h.percentile(50) / 1e6, loopP99: h.percentile(99) / 1e6, loopMax: h.max / 1e6 };
}

async function stop() {
  S.feed.flush();
  await S.rt.close();
  S.server.closeAllConnections();
  for (const c of S.wss.clients) c.terminate();
  S = null;
}

const handlers = { start, load, mem: async () => mem(), stop };
process.on('message', async (m) => {
  try {
    process.send({ id: m.id, result: await handlers[m.op](m.args ?? {}) });
  } catch (e) {
    process.send({ id: m.id, error: e.stack });
  }
});
process.send({ ready: true });
