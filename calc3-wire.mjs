// Байти на дроті для семи способів доставки (Chromium + лічильник на TCP).
// Рахуються байти прикладного рівня (без TLS і без заголовків TCP/IP).
// Запуск: node calc3-wire.mjs [idleSec]  → results/wire.json
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const { startTestbed } = require('./testbed');
const { addDevice } = require('./testkit');

const IDLE = Number(process.argv[2] ?? 61);
const PUSHES = 10;
const DEV = 'gh1-s01';
const DEV2 = 'gh9-s99';            // пристрій, чиї вимірювання йдуть через MQTT і базу
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VALUES = { temperature: 21.37, humidity: 55.12, soil_moisture: 33.45, light: 812 };

function countingProxy(targetPort) {
  const c = { up: 0, down: 0, conns: 0 };
  const server = net.createServer((client) => {
    c.conns += 1;
    const up = net.connect(targetPort, '127.0.0.1');
    client.on('data', (b) => { c.up += b.length; });
    up.on('data', (b) => { c.down += b.length; });
    client.pipe(up); up.pipe(client);
    for (const s of [client, up]) {
      s.on('error', () => {});
      s.on('close', () => (s === client ? up : client).destroy());
    }
  });
  return {
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    snap: () => ({ ...c }),
    close: () => server.close(),
  };
}
const diff = (a, b) => ({ up: b.up - a.up, down: b.down - a.down, conns: b.conns - a.conns });

fs.copyFileSync(path.join(here, 'node_modules/mqtt/dist/mqtt.min.js'),
  path.join(here, 'wire-dist/mqtt.min.js'));
const bed = await startTestbed({ windowMs: 100, dist: path.join(here, 'wire-dist'),
  sse: { heartbeatMs: 15_000 } });
addDevice(bed.db, DEV2);
const raw = new WebSocketServer({ host: '127.0.0.1', port: 0 });      // без permessage-deflate
await new Promise((r) => raw.once('listening', r));

const kinds = ['poll', 'sse', 'socketio-ws', 'socketio-poll', 'socketio-upgrade', 'ws-raw', 'mqtt'];
const targets = { poll: bed.httpPort, sse: bed.httpPort, 'socketio-ws': bed.httpPort,
  'socketio-poll': bed.httpPort, 'socketio-upgrade': bed.httpPort,
  'ws-raw': raw.address().port, mqtt: bed.wsPort };
const proxies = {};
const ports = {};
for (const k of kinds) { proxies[k] = countingProxy(targets[k]); ports[k] = await proxies[k].listen(); }
// сторінку HTTP-сценаріїв вантажимо через їхній лічильник (до першої позначки), решту — напряму
const viaProxy = new Set(['poll', 'sse', 'socketio-ws', 'socketio-poll', 'socketio-upgrade']);

const browser = await chromium.launch();
const version = browser.version();
const pages = {};
const reqLog = {};
for (const k of kinds) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  reqLog[k] = [];
  page.on('request', (r) => reqLog[k].push({ t: Date.now(), url: r.url().replace(/^https?:\/\/[^/]+/, ''), m: r.method() }));
  const origin = viaProxy.has(k) ? `http://127.0.0.1:${ports[k]}` : `http://127.0.0.1:${bed.httpPort}`;
  const extra = k === 'ws-raw' ? `?raw=ws://127.0.0.1:${ports[k]}` : k === 'mqtt' ? `?mqtt=ws://127.0.0.1:${ports[k]}&topicDev=${DEV2}` : k === 'poll' ? `?pollDev=${DEV2}` : '';
  await page.goto(`${origin}/wire.html${extra}`);
  pages[k] = page;
}
await sleep(500);

const out = { chromium: version, idleSec: IDLE, pushes: PUSHES, kinds: {} };
const marks = {};
for (const k of kinds) { marks[k] = { s0: proxies[k].snap() }; reqLog[k].length = 0; }

// 1. Установлення зв’язку
await Promise.all(kinds.map(async (k) => {
  const t = Date.now();
  await pages[k].evaluate((kind) => window.connectors[kind](), k);
  marks[k].s1 = proxies[k].snap();
  out.kinds[k] = { setupMs: Date.now() - t, setupRequests: reqLog[k].length };
}));
await sleep(300);
for (const k of kinds) { marks[k].s1 = proxies[k].snap(); reqLog[k].length = 0; }

// 2. Дев’ять… ні, PUSHES розсилок по 4 вимірювання (по одному на метрику)
let expected = 0;
const pollCosts = [];
const emptyPollCosts = [];
for (let i = 0; i < PUSHES; i++) {
  const ts = new Date().toISOString();
  const readings = Object.entries(VALUES).map(([metric, value]) => ({ metric, ts, value }));
  expected += 4;
  for (const r of readings) bed.feed.publish({ device: DEV, ...r });    // SSE і Socket.IO: через шину
  for (const r of readings) await bed.publish(DEV2, r);                // MQTT, база, опитування
  const frame = JSON.stringify({ device: DEV, readings });
  raw.clients.forEach((c) => c.send(frame));
  await sleep(400);
  const s = proxies.poll.snap();
  await pages.poll.evaluate(() => window.pollOnce());
  const s2 = proxies.poll.snap();
  pollCosts.push(diff(s, s2));
  await pages.poll.evaluate(() => window.pollOnce());
  emptyPollCosts.push(diff(s2, proxies.poll.snap()));
}
await sleep(500);
const rx = {};
for (const k of kinds) if (k !== 'poll') rx[k] = await pages[k].evaluate(() => window.rx);
out.expectedReadings = expected;
out.receivedReadings = rx;
for (const k of kinds) marks[k].s2 = proxies[k].snap();

// 3. Простій: лише службові повідомлення (heartbeat, ping/pong, PINGREQ)
await sleep(IDLE * 1000);
for (const k of kinds) marks[k].s3 = proxies[k].snap();

for (const k of kinds) {
  const m = marks[k];
  out.kinds[k].pageLoad = null;
  out.kinds[k].setup = diff(m.s0, m.s1);
  out.kinds[k].push = diff(m.s1, m.s2);
  out.kinds[k].idle = diff(m.s2, m.s3);
  out.kinds[k].conns = m.s3.conns;
  out.kinds[k].perPush = { up: (m.s2.up - m.s1.up) / PUSHES, down: (m.s2.down - m.s1.down) / PUSHES };
}
// Опитування: вартість одного запиту — з відповіддю й без нових даних
out.poll = { withData: pollCosts, noChange: emptyPollCosts };
out.requestsAfterSetup = Object.fromEntries(kinds.map((k) => [k, reqLog[k].map((r) => `${r.m} ${r.url}`)]));
fs.writeFileSync(path.join(here, 'results/wire.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ chromium: version, idleSec: IDLE, received: rx, expected,
  poll: { withData: pollCosts[3], noChange: emptyPollCosts[3] },
  kinds: Object.fromEntries(kinds.map((k) => [k, { setup: out.kinds[k].setup, perPush: out.kinds[k].perPush, idle: out.kinds[k].idle, setupMs: out.kinds[k].setupMs }])) }, null, 1));
await browser.close();
process.exit(0);
