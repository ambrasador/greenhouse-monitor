'use strict';
// Клієнти стенду розсилання: U з’єднань Socket.IO, SSE або WebSocket в одному процесі.
// Затримка = час отримання мінус ts події (годинник спільний: одна машина)
const http = require('node:http');
const { io } = require('socket.io-client');
const WebSocket = require('ws');

let conns = [];
let lat = [];
let frames = 0;
let readings = 0;
const rec = (ts, n) => {
  lat.push(Date.now() - Date.parse(ts));
  frames += 1;
  readings += n;
};

function open(kind, { httpPort, wsPort }) {
  return new Promise((resolve, reject) => {
    const fail = (e) => reject(e);
    if (kind === 'socketio') {
      const s = io(`http://127.0.0.1:${httpPort}`, { transports: ['websocket'],
        forceNew: true, reconnection: false });
      s.on('telemetry:update', ({ readings: r }) => rec(r[0].ts, r.length));
      s.on('connect', () => s.emit('subscribe', { device: 'gh1-s01' },
        (a) => (a.ok ? resolve(s) : fail(new Error(a.error)))));
      s.on('connect_error', fail);
      conns.push(() => s.close());
    } else if (kind === 'ws') {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      ws.on('message', (d) => { const f = JSON.parse(d.toString()); rec(f.readings[0].ts, f.readings.length); });
      ws.on('open', () => resolve(ws));
      ws.on('error', fail);
      conns.push(() => ws.terminate());
    } else {
      const req = http.get({ host: '127.0.0.1', port: httpPort, agent: false,
        path: '/devices/gh1-s01/stream' }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith('event: ready')) resolve(res);
            else if (block.includes('event: telemetry')) {
              const d = JSON.parse(block.slice(block.indexOf('data: ') + 6));
              rec(d.ts, 1);
            }
          }
        });
        res.on('error', () => {});
      });
      req.on('error', fail);
      conns.push(() => req.destroy());
    }
  });
}

async function connect({ kind, U, ports, chunk = 100 }) {
  for (let i = 0; i < U; i += chunk) {
    await Promise.all(Array.from({ length: Math.min(chunk, U - i) }, () => open(kind, ports)));
    await new Promise((r) => setTimeout(r, 20));
  }
  return { connected: conns.length };
}
const reset = () => { lat = []; frames = 0; readings = 0; return {}; };
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const report = () => {
  const s = Float64Array.from(lat).sort();
  return { frames, readings, samples: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95),
    p99: pct(s, 0.99), max: s[s.length - 1] ?? null };
};
const close = async () => { conns.forEach((c) => c()); conns = []; await new Promise((r) => setTimeout(r, 300)); return {}; };

const handlers = { connect, reset, report, close };
process.on('message', async (m) => {
  try {
    process.send({ id: m.id, result: await handlers[m.op](m.args ?? {}) });
  } catch (e) {
    process.send({ id: m.id, error: e.stack });
  }
});
process.send({ ready: true });
