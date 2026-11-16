// Розділ 4: розміри цілей натискання й горизонтальна прокрутка на малих екранах.
// node calc4-mobile.mjs  (потрібен client/dist: node client/build.mjs --prod)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startDashboardBed } = require('./dash-bed');

const bed = await startDashboardBed();
const browser = await chromium.launch();
const rows = [];
for (const [width, height] of [[1280, 900], [390, 844], [320, 640]]) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${bed.httpPort}/dashboard.html`);
  await page.waitForSelector('[role=img] path.recharts-line-curve');
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
    const min = (sel) => {
      const sizes = [...document.querySelectorAll(sel)].map(box);
      return { n: sizes.length, w: Math.min(...sizes.map((s) => s[0])), h: Math.min(...sizes.map((s) => s[1])) };
    };
    const cols = new Set([...document.querySelectorAll('.device-card')].map((e) => Math.round(e.getBoundingClientRect().left))).size;
    return {
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, cols,
      card: min('.device-card'), label: min('.range label'), button: min('.toolbar button'),
      chart: box(document.querySelector('[role=img]')),
    };
  });
  rows.push({ width, ...m });
  await ctx.close();
}
console.log(JSON.stringify(rows, null, 1));
await browser.close();
await bed.stop();
process.exit(0);
