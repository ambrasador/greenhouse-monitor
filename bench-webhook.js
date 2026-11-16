'use strict';
// Пропускна здатність webhook залежно від розміру пакета (WAL; FULL і NORMAL)
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const autocannon = require('autocannon');

const PORT = 3311;
const DEVICES = Number(process.env.DEVICES ?? 2000);   // як у вимірах розділу 1: 2 000 пристроїв
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(sync, batch, seconds = 6) {
  const db = path.join(os.tmpdir(), `wh-${sync}.db`);
  const srv = spawn('node', ['serve-api.js'], { env: { ...process.env, DB_FILE: db, PORT: String(PORT), DB_SYNC: sync } });
  await new Promise((r) => srv.stdout.once('data', r));
  let counter = 0;
  const base = Date.now() - 3_600_000;
  const res = await autocannon({
    url: `http://127.0.0.1:${PORT}`, connections: 16, duration: seconds,
    requests: [{ method: 'POST', path: '/api/v1/ingest/webhook', headers: { 'content-type': 'application/json' },
      setupRequest(req) {
        const events = [];
        for (let i = 0; i < batch; i++, counter++) {
          events.push({ device_id: `gh1-s${counter % DEVICES}`, metric: 'temperature', value: 21 + (counter % 10) / 10,
            ts: new Date(base + counter).toISOString() });
        }
        req.body = JSON.stringify({ events });
        return req;
      } }],
  });
  srv.kill('SIGTERM');
  await wait(300);
  const ok = res['2xx'], bad = res.non2xx;
  return { sync, batch, requests_s: Math.round(res.requests.average), readings_s: Math.round(res.requests.average * batch),
    p50_ms: res.latency.p50, p99_ms: res.latency.p99, non2xx: bad, total: ok };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
(async () => {
  const RUNS = Number(process.env.RUNS ?? 3);          // медіана трьох прогонів, як у розділі 1
  const out = [];
  for (const sync of ['FULL', 'NORMAL']) {
    for (const batch of [1, 10, 100, 500]) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(await run(sync, batch));
      const m = (k) => median(runs.map((r) => r[k]));
      const rd = runs.map((r) => r.readings_s);
      out.push({ sync, batch, requests_s: m('requests_s'), readings_s: m('readings_s'), p50_ms: m('p50_ms'),
        p99_ms: m('p99_ms'), spread_pct: Math.round(((Math.max(...rd) - Math.min(...rd)) / m('readings_s')) * 100),
        non2xx: runs.reduce((a, r) => a + r.non2xx, 0) });
    }
  }
  console.table(out);
})();
