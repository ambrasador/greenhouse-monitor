'use strict';
// Сервер для досліду «шторм перепідключень»: реальний API + Socket.IO,
// які можна «перезапустити» (закрити всі з’єднання, помовчати downMs, слухати знову)
const { makeDb, addDevice, seed } = require('./testkit');
const { createFeed } = require('./feed');
const { createServer } = require('./server');
const { attachRealtime } = require('./realtime');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let S = null;

async function listen() {
  S.http = S.app.listen(S.port, '127.0.0.1');
  await new Promise((r) => S.http.once('listening', r));
  S.port = S.http.address().port;
  S.rt = attachRealtime(S.http, { db: S.db, feed: S.feed });
  S.rt.io.on('connection', () => S.arrivals.push(Date.now()));
}

async function start() {
  const db = makeDb();
  addDevice(db, 'gh1-s01', 'north');
  seed(db, { device: 'gh1-s01', metric: 'temperature', start: Date.now() - 2 * 3600_000,
    count: 120, step: 60, values: (i) => 20 + Math.sin(i / 10) });
  const feed = createFeed({ windowMs: 100 });
  const app = createServer({ db, state: { mqttConnected: true, lastReadingAt: null },
    sink: { async send() {} }, feed,
    limits: { rate: 1e6, burst: 1e6, ingest: { rate: 1e6, burst: 1e6 } } });
  S = { db, feed, app, port: 0, arrivals: [], t0: null };
  await listen();
  return { port: S.port };
}

async function restart({ downMs }) {
  S.arrivals = [];
  S.cpu0 = process.cpuUsage();
  S.t0 = Date.now();
  await S.rt.close();
  S.http.closeAllConnections();
  await sleep(downMs);
  await listen();
  S.upAt = Date.now();
  return { t0: S.t0, upAt: S.upAt };
}

async function mark() {
  S.arrivals = [];
  S.cpu0 = process.cpuUsage();
  S.t0 = Date.now();
  return {};
}

async function report() {
  const cpu = process.cpuUsage(S.cpu0);
  return { t0: S.t0, upAt: S.upAt, arrivals: S.arrivals.map((t) => t - S.t0),
    cpuMs: (cpu.user + cpu.system) / 1000 };
}

const handlers = { start, restart, mark, report };
process.on('message', async (m) => {
  try { process.send({ id: m.id, result: await handlers[m.op](m.args ?? {}) }); }
  catch (e) { process.send({ id: m.id, error: e.stack }); }
});
process.send({ ready: true });
