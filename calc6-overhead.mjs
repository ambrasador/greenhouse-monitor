// M5: що автентифікація й область доступу додають до кожного запиту читання. Той самий сервер і ті самі дані:
// без входу (OPEN_AUTH) і з входом (JWT HS256, перевірка облікового запису в базі, SQL-фільтр області).
// Сервер — окремий процес, навантаження autocannon (16 з’єднань, 8 с, 3 прогони, чергування).
// Окрім запитів за секунду міряємо процесорний час сервера на один запит (process.cpuUsage()): клієнт
// і сервер ділять два ядра, тож лише за пропускною здатністю вартість автентифікації не відновити.
//   node calc6-overhead.mjs [out.json]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import autocannon from 'autocannon';

const require = createRequire(import.meta.url);

if (process.argv[2] === '--serve') {
  const mode = process.argv[3];
  const kit = require('./auth-kit');
  let app, token = null;
  if (mode === 'secure') {
    const bed = await kit.makeSecure();
    app = bed.app;
    token = (await bed.login('agro')).body.access_token;
  } else {
    const { makeMobileDb } = require('./mobile-kit');
    const { addDevice, seed } = require('./testkit');
    const { createServer } = require('./server');
    const { createFeed } = require('./feed');
    const db = makeMobileDb();
    for (const [id, zone] of [['gh1-s01', 'north'], ['gh1-s02', 'south'], ['gh1-new', 'north']]) addDevice(db, id, zone);
    for (const device of ['gh1-s01', 'gh1-s02']) seed(db, { device, start: kit.NOW - 3_600_000, count: 60, values: () => 21 });
    app = createServer({ db, state: { mqttConnected: true, lastReadingAt: null }, feed: createFeed(), clock: kit.fakeClock(),
      sink: { async send() {} }, limits: { rate: 1e6, burst: 1e6, ingest: { rate: 1e6, burst: 1e6 } } });
  }
  const express = require('express');
  const outer = express();
  outer.get('/__cpu', (req, res) => res.json(process.cpuUsage()));
  outer.use(app);
  const server = outer.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, token })));
  process.on('SIGTERM', () => process.exit(0));
} else {
  const ENDPOINTS = [
    ['GET /devices', '/api/v1/devices'],
    ['GET /devices/{id}', '/api/v1/devices/gh1-s01'],
    ['GET /telemetry (60 точок)', '/api/v1/telemetry?device=gh1-s01&metric=temperature&from=2026-11-05T08:00:00Z&to=2026-11-05T09:00:00Z'],
  ];
  const REPS = 3;
  const start = async (mode) => {
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--serve', mode], { stdio: ['ignore', 'pipe', 'inherit'] });
    const info = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(JSON.parse(d))));
    return { child, ...info };
  };
  const cpuOf = async (port) => { const u = await (await fetch(`http://127.0.0.1:${port}/__cpu`)).json(); return u.user + u.system; };
  const run = async (port, path, token) => {
    const before = await cpuOf(port);
    const r = await autocannon({ url: `http://127.0.0.1:${port}${path}`, connections: 16, duration: 8,
      headers: token ? { authorization: `Bearer ${token}` } : {} });
    r.cpuUsPerReq = ((await cpuOf(port)) - before) / r.requests.total;
    return r;
  };
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

  const servers = { open: await start('open'), secure: await start('secure') };
  const samples = Object.fromEntries(ENDPOINTS.map(([n]) => [n, { open: [], secure: [] }]));
  for (const [, path] of ENDPOINTS) await run(servers.open.port, path, null);      // прогрів
  for (let rep = 0; rep < REPS; rep++) {
    for (const [name, path] of ENDPOINTS) {
      for (const mode of ['open', 'secure']) {
        const { port, token } = servers[mode];
        const r = await run(port, path, token);
        if (r.non2xx) throw new Error(`${mode} ${name}: ${r.non2xx} відповідей не 2xx`);
        samples[name][mode].push({ rps: r.requests.average, p50: r.latency.p50, p99: r.latency.p99, cpuUs: r.cpuUsPerReq });
      }
    }
  }
  for (const s of Object.values(servers)) s.child.kill('SIGTERM');

  const rows = ENDPOINTS.map(([name]) => {
    const o = median(samples[name].open.map((x) => x.rps));
    const s = median(samples[name].secure.map((x) => x.rps));
    return { name, openRps: o, secureRps: s, openP99: median(samples[name].open.map((x) => x.p99)),
      secureP99: median(samples[name].secure.map((x) => x.p99)),
      openCpuUs: median(samples[name].open.map((x) => x.cpuUs)),
      secureCpuUs: median(samples[name].secure.map((x) => x.cpuUs)),
      extraCpuUs: median(samples[name].secure.map((x) => x.cpuUs)) - median(samples[name].open.map((x) => x.cpuUs)),
      runs: samples[name] };
  });
  for (const r of rows) {
    console.log(`${r.name.padEnd(28)} без входу ${Math.round(r.openRps)} з/с  з входом ${Math.round(r.secureRps)} з/с  `
      + `(${((r.secureRps / r.openRps - 1) * 100).toFixed(1)} %)  процесор на запит ${r.openCpuUs.toFixed(0)} → ${r.secureCpuUs.toFixed(0)} мкс (+${r.extraCpuUs.toFixed(0)})`);
  }
  writeFileSync(process.argv[2] ?? 'results/overhead.json', JSON.stringify({ node: process.version, connections: 16, durationSec: 8, reps: REPS, rows }, null, 2));
}
