// Проба: поведінка «голого» EventSource у Chromium при обриві TCP і при відповіді 503
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startTestbed } = require('./testbed');
const { createProxy } = require('./proxy');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const how of ['reset', '503']) {
  const bed = await startTestbed({ sse: { retryMs: 500, heartbeatMs: 1000 } });
  const proxy = createProxy(bed.httpPort);
  const port = await proxy.listen();
  const ids = [];
  bed.http.prependListener('request', (req) => {
    if (req.url.includes('/stream')) ids.push([Date.now(), req.headers['last-event-id'] ?? null]);
  });
  let i = 0;
  const gen = setInterval(() => bed.publish('gh1-s01', { metric: 'temperature', value: 20 + (i % 10) / 10,
    ts: new Date(Date.now() + (i++) * 0).toISOString() }).catch(() => {}), 300);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/healthz`);
  await page.evaluate(() => {
    window.log = []; const T = performance.now();
    const L = (m) => window.log.push([Math.round(performance.now() - T), m]);
    const es = window.es = new EventSource('/api/v1/devices/gh1-s01/stream?metrics=temperature');
    es.onopen = () => L('open'); es.addEventListener('ready', () => L('ready'));
    es.onerror = () => L(`error readyState=${es.readyState}`);
    window.n = 0; es.addEventListener('telemetry', () => { window.n++; });
  });
  await sleep(3000);
  const nBefore = await page.evaluate(() => window.n);
  proxy.cut(6000, how);
  await sleep(14000);
  const out = await page.evaluate(() => ({ log: window.log, n: window.n, rs: window.es.readyState }));
  console.log(JSON.stringify({ how, nBefore, nAfter: out.n, readyStateAtEnd: out.rs, log: out.log,
    streamRequestsLastEventId: ids.map(([t, id]) => id) }));
  clearInterval(gen);
  await browser.close(); await proxy.close(); await bed.stop();
}
process.exit(0);
