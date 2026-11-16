// Розділ 4: скільки місця займає кеш запитів після огляду всіх карток у всіх діапазонах.
// node calc4-cache.mjs  (потрібен client/dist: node client/build.mjs --prod)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startDashboardBed } = require('./dash-bed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bed = await startDashboardBed();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.goto(`http://127.0.0.1:${bed.httpPort}/dashboard.html`);
await page.waitForSelector('[role=img] path.recharts-line-curve');
const cards = await page.$$('.device-card');
for (let i = 0; i < cards.length; i++) {
  await (await page.$$('.device-card'))[i].click();
  for (const label of ['24 год', '7 днів', '1 год']) {
    await page.getByLabel(label).check();
    await page.waitForSelector('section[aria-busy="false"] [role=img]');
    await sleep(250);
  }
}
const rows = await page.evaluate(() => window.__queryClient.getQueryCache().getAll().map((q) => ({
  key: q.queryKey[0], range: q.queryKey[3] ?? '',
  bytes: JSON.stringify(q.state.data ?? null).length,
  n: q.state.data?.rows?.length ?? q.state.data?.points?.length ?? null,
})));
const groups = {};
for (const r of rows) {
  const g = `${r.key}${r.range ? ` ${r.range}` : ''}`;
  groups[g] ??= { записів: 0, байтів: 0, 'точок у записі': new Set() };
  groups[g].записів += 1; groups[g].байтів += r.bytes; groups[g]['точок у записі'].add(r.n);
}
console.table(Object.entries(groups).map(([k, v]) => ({
  запит: k, записів: v.записів, 'КБ разом': (v.байтів / 1024).toFixed(1),
  'КБ на запис': (v.байтів / v.записів / 1024).toFixed(1), 'точок у записі': [...v['точок у записі']].join('/'),
})));
const total = rows.reduce((s, r) => s + r.bytes, 0);
console.log(`усього записів: ${rows.length}, ${(total / 1024).toFixed(1)} КБ у JSON`);
await browser.close();
await bed.stop();
process.exit(0);
