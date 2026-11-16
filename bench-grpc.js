'use strict';
// REST і gRPC для одного й того самого запиту «останні значення пристрою»: пропускна здатність і затримка
const { spawn } = require('node:child_process');
const http = require('node:http');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');

const proto = grpc.loadPackageDefinition(loader.loadSync(`${__dirname}/latest.proto`)).greenhouse;

const serverSrc = (kind) => `
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE latest (device_id TEXT, metric TEXT, ts TEXT, value REAL, PRIMARY KEY (device_id, metric))');
  const ins = db.prepare('INSERT INTO latest VALUES (?, ?, ?, ?)');
  for (const [m, v] of [['temperature', 21.5], ['humidity', 63.2], ['soil_moisture', 41.0], ['light', 18250]]) ins.run('gh1-s01', m, '2026-11-03T12:00:00.000Z', v);
  const q = db.prepare('SELECT metric, ts, value FROM latest WHERE device_id = ? ORDER BY metric');
  if ('${kind}' === 'rest') {
    const app = require('express')();
    app.set('etag', false);
    app.get('/latest/:id', (req, res) => res.json(q.all(req.params.id)));
    app.listen(3331, () => console.log('ready'));
  } else {
    const grpc = require('@grpc/grpc-js');
    const proto = grpc.loadPackageDefinition(require('@grpc/proto-loader').loadSync('${__dirname}/latest.proto')).greenhouse;
    const s = new grpc.Server();
    s.addService(proto.Telemetry.service, { GetLatest: (call, cb) => cb(null, { readings: q.all(call.request.device_id) }) });
    s.bindAsync('127.0.0.1:3332', grpc.ServerCredentials.createInsecure(), () => console.log('ready'));
  }`;

async function load(call, seconds = 6, conc = 64) {
  const lat = [];
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (Date.now() < end) {
      const t = process.hrtime.bigint();
      await call();
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
  }));
  lat.sort((a, b) => a - b);
  return { rps: Math.round(lat.length / seconds), p50_ms: +lat[Math.floor(lat.length * 0.5)].toFixed(2),
    p99_ms: +lat[Math.floor(lat.length * 0.99)].toFixed(2) };
}

(async () => {
  const rest = spawn('node', ['-e', serverSrc('rest')]);
  const rpc = spawn('node', ['-e', serverSrc('grpc')]);
  await Promise.all([rest, rpc].map((c) => new Promise((r) => c.stdout.once('data', r))));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  let restBytes = 0;
  const callRest = () => new Promise((resolve, reject) => http.get('http://127.0.0.1:3331/latest/gh1-s01', { agent }, (res) => {
    let n = 0; res.on('data', (c) => { n += c.length; }); res.on('end', () => { restBytes = n; resolve(); });
  }).on('error', reject));
  const client = new proto.Telemetry('127.0.0.1:3332', grpc.credentials.createInsecure());
  const callGrpc = () => new Promise((resolve, reject) => client.GetLatest({ device_id: 'gh1-s01' }, (e, r) => (e ? reject(e) : resolve(r))));
  const out = [];
  for (let i = 0; i < 3; i++) {
    out.push({ run: i + 1, rest: JSON.stringify(await load(callRest)), grpc: JSON.stringify(await load(callGrpc)) });
  }
  console.table(out);
  console.log('JSON-відповідь, байт:', restBytes);
  rest.kill(); rpc.kill(); client.close(); agent.destroy();
})();
