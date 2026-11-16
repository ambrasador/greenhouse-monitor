// Розділ 4: скільки запитів до API робить дашборд за сценарієм користувача.
// node calc4-requests.mjs  (потрібен client/dist: node client/build.mjs --prod)
// Порівнюються типові налаштування TanStack Query (?cache=default) і налаштування книги
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startDashboardBed } = require('./dash-bed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kind = (u) => {
  if (u.pathname === '/api/v1/devices') return 'devices';
  if (/^\/api\/v1\/devices\/[^/]+$/.test(u.pathname)) return 'device';
  if (u.pathname === '/api/v1/telemetry') return u.searchParams.has('agg') ? `agg ${u.searchParams.get('interval')}` : 'raw';
  return 'other';
};

async function scenario(cacheMode) {
  const bed = await startDashboardBed();
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const log = [];
  await page.clock.install({ time: Date.now() });   // щоб зсунути час сторінки без таймерів
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/v1/')) log.push(kind(u)); });
  const phase = async (name, action, wait = 900) => {
    const from = log.length;
    await action();
    await sleep(wait);
    return { name, requests: log.slice(from) };
  };
  const base = `http://127.0.0.1:${bed.httpPort}/dashboard.html${cacheMode === 'default' ? '?cache=default' : ''}`;
  const phases = [];
  phases.push(await phase('відкриття сторінки', async () => { await page.goto(base); await page.waitForSelector('[role=img] path.recharts-line-curve'); }, 1500));
  for (const [label, name] of [['24 год', '→ 24 год'], ['7 днів', '→ 7 днів'], ['1 год', '→ 1 год'], ['24 год', '→ 24 год (повторно)']]) {
    phases.push(await phase(name, () => page.getByLabel(label).check()));
  }
  // Користувач тридцять разів повертається на вкладку; подія visibilitychange — та сама, що й у браузері
  const focusFrom = log.length;
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await sleep(250);
  }
  await sleep(500);
  phases.push({ name: '30 повернень на вкладку', requests: log.slice(focusFrom) });
  // Пауза: час сторінки зсунуто на 20 с (таймери не спрацьовують), далі одне повернення
  phases.push(await phase('повернення після паузи 20 с', async () => {
    await page.clock.setSystemTime(Date.now() + 20_000);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
  }, 1000));
  await browser.close();
  await bed.stop();
  return phases;
}

const summarize = (reqs) => {
  const c = {};
  for (const r of reqs) c[r] = (c[r] ?? 0) + 1;
  return c;
};
const result = {};
for (const mode of ['default', 'tuned']) {
  result[mode] = (await scenario(mode)).map((p) => ({ name: p.name, total: p.requests.length, by: summarize(p.requests) }));
  console.log(`\n== ${mode} ==`);
  for (const p of result[mode]) console.log(`${p.name.padEnd(28)} ${String(p.total).padStart(3)}  ${JSON.stringify(p.by)}`);
  const total = result[mode].reduce((s, p) => s + p.total, 0);
  console.log(`разом: ${total}`);
}
fs.writeFileSync('results/requests.json', JSON.stringify(result));
process.exit(0);
