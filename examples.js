'use strict';
// Генерує приклади обміну з API (запит → відповідь) для тексту підручника: examples/*.txt
const fs = require('node:fs');
const request = require('supertest');
const { makeDb, addDevice, seed, iso } = require('./testkit');
const { createServer } = require('./server');

const NOW = Date.parse('2026-11-03T12:00:00Z');
const db = makeDb();
addDevice(db, 'gh1-s01', 'north');
seed(db, { start: NOW - 3 * 3_600_000, count: 180, values: (i) => 21 + (i % 10) / 10 });
let now = NOW;
const app = createServer({ db, state: { mqttConnected: true, lastReadingAt: null }, sink: { async send() {} },
  clock: () => now, limits: { rate: 1, burst: 2, ingest: { rate: 100, burst: 200 } } });

// Стислий вигляд JSON: короткі об’єкти й елементи масивів — в один рядок
function fmt(v, ind = 0, width = 76) {
  const pad = ' '.repeat(ind);
  const scalar = (x) => x === null || typeof x !== 'object';
  const isFlat = v && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v).every(scalar);
  const parts = isFlat
    ? Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`) : [];
  const flat = isFlat ? `{${parts.join(', ')}}` : null;
  if (flat && flat.length + ind < width) return flat;
  if (isFlat && parts.length > 2) {          // довгий об’єкт: два рядки
    return `{${parts.slice(0, 2).join(', ')},\n${pad} ${parts.slice(2).join(', ')}}`;
  }
  if (Array.isArray(v)) return `[\n${v.map((x) => `${pad}  ${fmt(x, ind + 2, width)}`).join(',\n')}\n${pad}]`;
  if (v && typeof v === 'object') {
    return `{\n${Object.entries(v).map(([k, x]) => `${pad}  ${JSON.stringify(k)}: ${fmt(x, ind + 2, width)}`).join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(v);
}

async function show(file, req, { sent = [], body, head: customHead, width = 76 } = {}, keep = ['content-type', 'location', 'retry-after', 'deprecation', 'sunset']) {
  const res = await req;
  const head = customHead ?? `${req.method} ${req.url.replace(/^http:\/\/[^/]+/, '')}`;
  const hdr = keep.filter((h) => res.headers[h]).map((h) => `${h.replace(/(^|-)(\w)/g, (m, a, b) => a + b.toUpperCase())}: ${res.headers[h]}`);
  const reqPart = [head, ...sent, ...(body ? ['', fmt(body)] : [])].join('\n');
  fs.writeFileSync(`${__dirname}/examples/${file}.txt`, `${reqPart}\n\nHTTP ${res.status}\n${hdr.join('\n')}\n\n${fmt(res.body, 0, width)}\n`);
  return res;
}
(async () => {
  now = NOW;
  await show('invalid-query', request(app).get('/api/v1/telemetry')
    .query('device=gh1-s01&metric=pressure&form=2026-11-03&to=today'),
  { head: 'GET /api/v1/telemetry\n  ?device=gh1-s01&metric=pressure\n  &form=2026-11-03&to=today' });
  now += 10_000;
  await show('agg', request(app).get('/api/v1/telemetry').query(
    'device=gh1-s01&metric=temperature&from=2026-11-03T08:00:00Z&to=2026-11-03T11:00:00Z&agg=avg,min&interval=1h&fill=null'),
  { head: ['GET /api/v1/telemetry', '  ?device=gh1-s01&metric=temperature', '  &from=2026-11-03T08:00:00Z&to=2026-11-03T11:00:00Z',
    '  &agg=avg,min&interval=1h&fill=null'].join('\n') });
  now += 10_000;
  await show('deprecated', request(app).get('/api/v1/devices/gh1-s01/latest'));
  now += 10_000;
  const cmd = { name: 'irrigate', params: { duration_sec: 120 } };
  await show('command', request(app).post('/api/v1/devices/gh1-s01/commands')
    .set('Idempotency-Key', 'irr-2026-11-03-0001').send(cmd),
  { sent: ['Idempotency-Key: irr-2026-11-03-0001'], body: cmd });
  now += 10_000;
  for (let i = 0; i < 3; i++) await request(app).get('/api/v1/devices');   // вичерпати кошик
  await show('rate-limited', request(app).get('/api/v1/devices'));
  now += 60_000;
  await show('window-too-large', request(app).get('/api/v1/telemetry')
    .query('device=gh1-s01&metric=temperature&from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z&agg=avg&interval=1d'));
  const q = await request(app).get('/api/v1/telemetry')
    .query(`device=gh1-s01&metric=temperature&from=${iso(NOW - 3 * 3_600_000)}&to=${iso(NOW)}&limit=2`);
  fs.writeFileSync(`${__dirname}/examples/page.txt`, `${fmt(q.body)}\n`);
  console.log('ok');
})();
