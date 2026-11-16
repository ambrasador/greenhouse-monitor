// Наскрізна перевірка в Chromium: node e2e-browser.mjs [socketio|sse|mqtt] [reset|503]
// Пристрій публікує вимірювання кожні 200 мс; проксі на 6 с обриває зв’язок браузера
// з сервером; потім звіряємо ряд на сторінці з базою
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startTestbed } = require('./testbed');
const { createProxy } = require('./proxy');

const kind = process.argv[2] ?? 'socketio';
const how = process.argv[3] ?? 'reset';
const OUTAGE = Number(process.env.OUTAGE ?? 6000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bed = await startTestbed({ sse: { retryMs: 500, heartbeatMs: 1000 } });   // retry 0,5–1 с замість 3–6 с
const [apiProxy, mqttProxy] = [createProxy(bed.httpPort), createProxy(bed.wsPort)];
const apiPort = await apiProxy.listen();
const mqttPort = await mqttProxy.listen();

let i = 0;
const t0 = Date.now() - 20_000;                // ts лежать у минулому: перші 100 точок — історія
const gen = setInterval(() => {
  bed.publish('gh1-s01', { metric: 'temperature', value: Math.round((20 + 5 * Math.sin(i / 20)) * 100) / 100,
    ts: new Date(t0 + i * 200).toISOString() }).catch(() => {});
  i += 1;
}, 200);
await sleep(1500);

const browser = await chromium.launch();
const page = await browser.newPage();
const url = `http://127.0.0.1:${apiPort}/index.html?kind=${kind}&device=gh1-s01`
  + `&metric=temperature&mqtt=ws://127.0.0.1:${mqttPort}&mqttv=4&strict=1&silence=4000`;
await page.goto(url);
const status = () => page.evaluate(() => window.__view?.status);
const until = async (want, ms) => {
  for (const s = Date.now(); Date.now() - s < ms;) { if ((await status()) === want) return true; await sleep(50); }
  return false;
};
if (!(await until('online', 10_000))) throw new Error(`не став online: ${await status()}`);
await sleep(4000);

const cutAt = Date.now();
const mark = apiProxy.elapsed();
apiProxy.cut(OUTAGE, how);
mqttProxy.cut(OUTAGE, how);
await sleep(OUTAGE + 300);
const recovered = await until('online', 60_000);
const recoveredAfter = Date.now() - cutAt;
await sleep(4000);
clearInterval(gen);
await sleep(2500);                              // залишок пакета й тротлінг 1 с

const view = await page.evaluate(() => ({
  status: window.__view.status, applied: window.__view.applied, dups: window.__view.dups,
  points: window.__view.series['gh1-s01/temperature'].map((p) => p.ts),
  log: window.__log, commits: window.__commits }));
const dbTs = bed.db.prepare(
  `SELECT ts FROM telemetry WHERE device_id = 'gh1-s01' AND metric = 'temperature' ORDER BY ts`).all().map((r) => r.ts);
const have = new Set(view.points);
const first = view.points[0];
const expected = dbTs.filter((t) => t >= first);
const missing = expected.filter((t) => !have.has(t));
const dbSet = new Set(dbTs);
const extra = view.points.filter((t) => !dbSet.has(t));
const attempts = apiProxy.attempts.filter((a) => a.t >= mark);
console.log(JSON.stringify({
  kind, how, outageMs: OUTAGE, recovered, recoveredAfterCutMs: recoveredAfter,
  seriesLen: view.points.length, extra: extra.length, extraSample: extra.slice(0, 3), dbTotal: dbTs.length, first, dbRowsSinceFirst: expected.length, missing: missing.length,
  duplicatesDiscarded: view.dups, applied: view.applied, commits: view.commits,
  apiAttemptsAfterCut: attempts.map((a) => [a.t - mark, a.ok ? 'ok' : 'x']),
  mqttAttemptsAfterCut: mqttProxy.attempts.filter((a) => a.t >= 0).slice(-12).map((a) => [a.t, a.ok ? 'ok' : 'x']),
  statusLog: view.log,
}));
await browser.close();
await apiProxy.close(); await mqttProxy.close();
await bed.stop();
process.exit(0);
