'use strict';
// Вартість мітки «пристрій» у метриках: розмір сторінки /metrics і час її побудови залежно від числа пристроїв.
// Запуск: node calc7-cardinality.cjs [результат.json]   (потрібен prom-client; нічого паралельно не запускайте)
const fs = require('node:fs');
const client = require('prom-client');
const BUCKETS = [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5];     // як у ops-metrics.js

async function measure(build, n) {
  const registry = new client.Registry();
  build(registry, n);
  let text = await registry.metrics();                                 // прогрів
  const times = [];
  for (let i = 0; i < 7; i++) {
    const t0 = process.hrtime.bigint();
    text = await registry.metrics();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { devices: n, bytes: Buffer.byteLength(text), lines: text.split('\n').length - 1,
    buildMs: times[3], bytesPerDevice: Buffer.byteLength(text) / n };
}

const gauge = (registry, n) => {
  const g = new client.Gauge({ name: 'greenhouse_last_reading_timestamp_seconds', help: 'x',
    labelNames: ['device'], registers: [registry] });
  for (let i = 0; i < n; i++) g.set({ device: `dev-${String(i).padStart(6, '0')}` }, 1793940443.685 + i);
};
const histogram = (registry, n) => {
  const h = new client.Histogram({ name: 'greenhouse_ingest_seconds', help: 'x', labelNames: ['device'],
    buckets: BUCKETS, registers: [registry] });
  for (let i = 0; i < n; i++) h.observe({ device: `dev-${String(i).padStart(6, '0')}` }, 0.0007);
};

(async () => {
  const out = { host: `Node ${process.version}`, gauge: [], histogram: [] };
  for (const n of [200, 300, 1500, 3000, 100000]) out.gauge.push(await measure(gauge, n));
  for (const n of [200, 3000]) out.histogram.push(await measure(histogram, n));
  const file = process.argv[2];
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
})();
