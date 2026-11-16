// Знімки екрана дашборда для підручника: node shots-dashboard.mjs [каталог]
// Стенд dash-bed.js, збірка client/dist (production), часовий пояс Києва
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startDashboardBed } = require('./dash-bed');

const outDir = process.argv[2] ?? '.';
const bed = await startDashboardBed();
const url = `http://127.0.0.1:${bed.httpPort}/dashboard.html`;
const browser = await chromium.launch();
const open = async (viewport) => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'uk-UA', timezoneId: 'Europe/Kyiv' });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('.device-card');
  await page.waitForSelector('[role=img] path.recharts-line-curve');
  return page;
};
const settle = (page) => page.waitForTimeout(1500);

// 1. Робочий стіл: початковий стан (вологість ґрунту, «1 год»)
let page = await open({ width: 960, height: 760 });
await settle(page);
await page.screenshot({ path: `${outDir}/dash4-desktop.png`, fullPage: true });

// 2. Температура Грядки А за 7 днів: смуга мін–макс і два пороги.
// Спершу без підказки, потім із підказкою на піку (мін … макс за 30 хв)
await page.getByRole('button', { name: /Грядка А.*Температура/ }).click();
await Promise.all([page.waitForResponse((r) => r.url().includes('interval=30m')), page.getByLabel('7 днів').check()]);
await page.waitForSelector('[role=img] path.recharts-area-area');
await page.mouse.move(0, 0);
await settle(page);
const panel = page.locator('section[aria-labelledby="panel-title"]');
await panel.screenshot({ path: `${outDir}/dash4-temp7d.png` });
const box = await page.locator('[role=img]').boundingBox();
const tip = page.locator('.recharts-tooltip-wrapper');
let found = false;
for (let x = box.x + 60; x < box.x + box.width - 20 && !found; x += 2) {
  await page.mouse.move(x, box.y + box.height * 0.55);
  found = /38,6/.test(await tip.innerText().catch(() => ''));
}
console.log('підказка на піку:', found);
if (found) await panel.screenshot({ path: `${outDir}/dash4-peak-tooltip.png` });
await page.context().close();

// 3. Перерви в даних Грядки Б: графік за 24 год (перерви 12 хв і 2 год) і за годину (12 хв)
page = await open({ width: 960, height: 760 });
await page.getByRole('button', { name: /Грядка Б.*Температура/ }).click();
await Promise.all([page.waitForResponse((r) => r.url().includes('interval=3m')), page.getByLabel('24 год').check()]);
await page.waitForSelector('[role=img] path.recharts-area-area');
await page.mouse.move(0, 0);
await settle(page);
await page.locator('section[aria-labelledby="panel-title"]').screenshot({ path: `${outDir}/dash4-gap24.png` });
await page.getByLabel('1 год').check();
await settle(page);
await page.mouse.move(0, 0);
await page.locator('section[aria-labelledby="panel-title"]').screenshot({ path: `${outDir}/dash4-gap1h.png` });
await page.context().close();

// 4. Телефон: дві колонки карток
page = await open({ width: 390, height: 844 });
await settle(page);
await page.screenshot({ path: `${outDir}/dash4-mobile.png`, fullPage: true });

await browser.close();
await bed.stop();
console.log('готово');
