// Ширина області графіка в CSS-пікселях для двох вікон: стіл (960) і телефон (390)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startDashboardBed } = require('./dash-bed');
const bed = await startDashboardBed();
const url = `http://127.0.0.1:${bed.httpPort}/dashboard.html`;
const browser = await chromium.launch();
for (const width of [960, 390, 1920]) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, locale: 'uk-UA', timezoneId: 'Europe/Kyiv' });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('[role=img] path.recharts-line-curve');
  await page.waitForTimeout(800);
  const w = await page.evaluate(() => {
    const g = document.querySelector('.recharts-cartesian-grid-horizontal line');
    return { plot: g.getAttribute('x2') - g.getAttribute('x1'),
      container: document.querySelector('[role=img]').getBoundingClientRect().width };
  });
  console.log(`вікно ${width} px: область графіка ${w.plot} px, контейнер ${w.container} px`);
  await ctx.close();
}
await browser.close();
await bed.stop();
