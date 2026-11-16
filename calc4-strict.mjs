// Розділ 4: скільки запитів і з’єднань дає відкриття сторінки в режимі розробки (StrictMode)
// і в робочій збірці. node client/build.mjs && node calc4-strict.mjs dev
//                    node client/build.mjs --prod && node calc4-strict.mjs prod
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startDashboardBed } = require('./dash-bed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const label = process.argv[2] ?? '?';
const bed = await startDashboardBed();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const counts = {};
const add = (k) => { counts[k] = (counts[k] ?? 0) + 1; };
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.pathname === '/api/v1/devices') add('devices');
  else if (/^\/api\/v1\/devices\/[^/]+$/.test(u.pathname)) add('device');
  else if (u.pathname === '/api/v1/telemetry') add(u.searchParams.has('agg') ? 'agg' : 'raw');
  else if (u.pathname.startsWith('/socket.io/') && !u.searchParams.has('sid')) add('socket.io: нове з’єднання');
});
page.on('websocket', () => add('WebSocket'));
await page.goto(`http://127.0.0.1:${bed.httpPort}/dashboard.html`);
await page.waitForSelector('[role=img] path.recharts-line-curve');
await sleep(2500);
const total = Object.entries(counts).filter(([k]) => ['devices', 'device', 'raw', 'agg'].includes(k)).reduce((s, [, v]) => s + v, 0);
console.log(label, JSON.stringify(counts), 'запитів до API:', total);
await browser.close();
await bed.stop();
process.exit(0);
