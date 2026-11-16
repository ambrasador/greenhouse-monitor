'use strict';
// Ціна спостережуваності: метрики на кожне повідомлення, відповідь /metrics, рядок журналу
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const pino = require('pino');
const { makeDb, addDevice } = require('./testkit');
const { createApp } = require('./app');
const { createFakeSource } = require('./fake-source');
const { createOpsMetrics } = require('./ops-metrics');
const { REDACT } = require('./logger');

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const fs_ = fs;
const NOW = Date.parse('2026-11-03T12:00:00Z');
const result = { host: `${os.cpus()[0].model}, ${os.cpus().length} vCPU, Node ${process.version}` };

function ingestRun(db, n, observe) {
  const source = createFakeSource();
  createApp({ db, source, observe, clock: () => NOW });
  const base = NOW - 60_000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    source.push({ deviceId: 'gh1-s01', metric: 'temperature', value: 20 + (i % 50) / 10, ts: new Date(base + i).toISOString() });
  }
  return Number(process.hrtime.bigint() - t0) / 1e3 / n;       // мкс на повідомлення
}

// Форма повідомлення, яке приймає ядро, береться з тесту ingest; перевіряємо, що приймання справді працює
{
  const db = makeDb(); addDevice(db, 'gh1-s01');
  const source = createFakeSource(); const app = createApp({ db, source, clock: () => NOW });
  source.push({ deviceId: 'gh1-s01', metric: 'temperature', value: 21.5, ts: '2026-11-03T11:59:00.000Z' });
  if (app.stats.stored !== 1) { console.error('форма повідомлення хибна', app.stats); process.exit(1); }
}

function series(label, n, mk) {
  const runs = { without: [], with: [] };
  for (let r = 0; r < 7; r++) {
    for (const variant of ['without', 'with']) {
      const db = mk(); addDevice(db, 'gh1-s01');
      const observe = variant === 'with' ? createOpsMetrics({ state: { mqttConnected: true, lastReadingAt: null }, defaults: false }).recordIngest : undefined;
      runs[variant].push(ingestRun(db, n, observe));
      db.close();
    }
  }
  result[label] = { n, usWithout: median(runs.without), usWith: median(runs.with), all: runs };
  result[label].overheadUs = result[label].usWith - result[label].usWithout;
  result[label].overheadPercent = (result[label].overheadUs / result[label].usWithout) * 100;
}
series('inMemory', 30000, () => makeDb());
{
  const dir = fs_.mkdtempSync(path.join(os.tmpdir(), 'ovh-'));
  let k = 0;
  series('fileWalFull', 1500, () => {
    const db = new Database(path.join(dir, `d${k++}.db`));
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    for (const f of ['schema.sql', 'schema-api.sql']) db.exec(fs_.readFileSync(path.join(__dirname, f), 'utf8'));
    return db;
  });
  fs_.rmSync(dir, { recursive: true, force: true });
}

// /metrics: розмір і час відповіді з типовими метриками процесу
{
  const feed = { size: () => 3 };
  const ops = createOpsMetrics({ feed, state: { mqttConnected: true, lastReadingAt: Date.now() } });
  for (let i = 0; i < 1000; i++) ops.recordIngest('stored', 0.001 + (i % 7) * 0.0005);
  ops.recordIngest('out_of_range', 0.0004);
  for (const [a, o] of [['login', 'ok'], ['login', 'fail']]) ops.recordAudit(a, o);
  (async () => {
    const times = [];
    let text = '';
    for (let i = 0; i < 300; i++) {
      const t0 = process.hrtime.bigint();
      text = await ops.registry.metrics();
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const lines = text.split('\n');
    result.scrape = { bytes: Buffer.byteLength(text), lines: lines.length,
      series: lines.filter((l) => l && !l.startsWith('#')).length, medianMs: median(times), p99Ms: [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.99)] };

    // рядок журналу: pino (з редагуванням і без) і console.log із JSON.stringify
    const devnull = fs_.openSync('/dev/null', 'w');
    const N = 200000;
    const t = (fn) => { const a = []; for (let r = 0; r < 5; r++) { const t0 = process.hrtime.bigint(); for (let i = 0; i < N; i++) fn(i); a.push(Number(process.hrtime.bigint() - t0) / 1e3 / N); } return median(a); };
    const plain = pino({ base: { service: 'greenhouse' } }, pino.destination({ fd: devnull, sync: true }));
    const redacting = pino({ base: { service: 'greenhouse' }, redact: { paths: REDACT, censor: '[скрито]' } }, pino.destination({ fd: devnull, sync: true }));
    const off = pino({ level: 'error', base: { service: 'greenhouse' } }, pino.destination({ fd: devnull, sync: true }));
    result.log = {
      N,
      pinoUs: t((i) => plain.info({ port: 3000, i }, 'listening')),
      pinoRedactUs: t((i) => redacting.info({ port: 3000, i, req: { headers: { authorization: 'Bearer x' } } }, 'listening')),
      pinoDisabledLevelUs: t((i) => off.info({ port: 3000, i }, 'listening')),
      stringifyWriteUs: t((i) => fs_.writeSync(devnull, JSON.stringify({ level: 'info', time: new Date().toISOString(), service: 'greenhouse', port: 3000, i, msg: 'listening' }) + '\n')),
    };

    // окремі операції метрик
    const m = createOpsMetrics({ state: { mqttConnected: true, lastReadingAt: null }, defaults: false });
    result.ops = { N, recordIngestUs: t((i) => m.recordIngest('stored', 0.001)), recordAuditUs: t(() => m.recordAudit('login', 'ok')) };
    fs_.writeFileSync(path.join(process.env.CALC7_OUT ?? path.join(__dirname, 'results'), 'overhead.json'), JSON.stringify(result, null, 1));
    console.log(JSON.stringify(result, (k, v) => (k === 'all' ? undefined : v), 1));
  })();
}
