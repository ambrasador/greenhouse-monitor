// Наскрізна перевірка дашборда розділу 4 у Chromium: node e2e-dashboard.mjs
// Стенд із чотирма пристроями (dash-bed.js), сторінка client/dist/dashboard.html
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startDashboardBed } = require('./dash-bed');

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push([name, 'ok']); console.log(`ok   ${name}`); }
  catch (e) { results.push([name, 'FAIL']); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bed = await startDashboardBed();
const url = `http://127.0.0.1:${bed.httpPort}/dashboard.html`;
const browser = await chromium.launch();
const VIEW = { viewport: { width: 1280, height: 900 } };
const ctx = await browser.newContext({ acceptDownloads: true, ...VIEW });
const page = await ctx.newPage();
const reqs = [];
page.on('request', (r) => { if (r.url().includes('/api/v1/')) reqs.push(new URL(r.url())); });
const telemetry = () => reqs.filter((u) => u.pathname === '/api/v1/telemetry');
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url);
await page.waitForSelector('.device-card');
await page.waitForSelector('[role=img] path.recharts-line-curve');

await check('сітка: 8 карток у фіксованому порядку, рівні статусу очікувані', async () => {
  const rows = await page.$$eval('.device-card', (els) => els.map((e) => ({
    level: [...e.classList].find((c) => c.startsWith('device-card--')).slice(13),
    name: e.querySelector('.device-card__name').textContent,
    metric: e.querySelector('.device-card__metric').textContent,
  })));
  assert.deepEqual(rows.map((r) => `${r.name}/${r.metric}`), [
    'Грядка А/Вологість ґрунту', 'Грядка А/Температура повітря',
    'Грядка Б/Вологість ґрунту', 'Грядка Б/Температура повітря',
    'Грядка В/Вологість ґрунту', 'Грядка В/Температура повітря',
    'Грядка Г/Вологість ґрунту', 'Грядка Г/Температура повітря']);
  assert.deepEqual(rows.map((r) => r.level),
    ['ok', 'ok', 'warning', 'ok', 'critical', 'critical', 'offline', 'offline']);
});

await check('потрійне кодування: кожен бейдж має іконку aria-hidden і словесну мітку', async () => {
  const badges = await page.$$eval('.badge', (els) => els.map((e) => ({
    hidden: e.querySelector('[aria-hidden="true"]')?.textContent,
    text: e.textContent.trim(),
  })));
  assert.equal(badges.length, 8);
  const want = { ok: ['✓', 'Норма'], warning: ['!', 'Попередження'], critical: ['✕', 'Критично'], offline: ['?', 'Немає даних'] };
  const labels = Object.values(want).map(([i, l]) => `${i} ${l}`);
  for (const b of badges) assert.ok(labels.includes(b.text), b.text);
  assert.ok(badges.every((b) => b.hidden));
});

await check('зведений рядок: 3 норма · 1 попередження · 2 критично · 2 немає даних', async () => {
  assert.equal((await page.textContent('.summary')).trim(),
    '3 норма · 1 попередження · 2 критично · 2 немає даних');
});

await check('значення відформатовано за uk-UA: десяткова кома й нерозривний пробіл', async () => {
  const v = await page.$$eval('.device-card__value', (els) => els.map((e) => e.textContent));
  assert.equal(v[2], '33,0 %');
  assert.equal(v[5], '36,2 °C');
  assert.equal(v[6], '—');
});

await check('початкове завантаження: список, 4 пристрої, історія «1 год» сирими точками', async () => {
  assert.equal(reqs.filter((u) => u.pathname === '/api/v1/devices').length, 1);
  assert.equal(reqs.filter((u) => /^\/api\/v1\/devices\/gh1-s0\d$/.test(u.pathname)).length, 4);
  const t = telemetry();
  assert.ok(t.length >= 1 && t.every((u) => !u.searchParams.has('agg')));
});

await check('діаграма має текстову альтернативу', async () => {
  const label = await page.getAttribute('[role=img]', 'aria-label');
  assert.match(label, /^Вологість ґрунту: останнє значення \d+,\d %, \d+ точок на графіку$/);
});

await check('живі точки потрапляють у кеш «1 год» без нових запитів історії', async () => {
  const before = telemetry().length;
  const ts = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  await bed.publish('gh1-s01', { metric: 'soil_moisture', value: 40.55, ts });
  const t = Date.parse(ts);
  const deadline = Date.now() + 8000;
  let has = false;
  while (Date.now() < deadline && !has) {
    has = await page.evaluate((tt) => window.__queryClient
      .getQueryData(['telemetry', 'gh1-s01', 'soil_moisture', '1h'])?.points.some((p) => p.t === tt), t);
    if (!has) await sleep(200);
  }
  assert.ok(has, 'точка не з’явилася в кеші');
  assert.equal(telemetry().length, before);
});

await check('перемикач діапазону: 24 год → interval=3m, 7 днів → interval=30m, agg=avg,min,max', async () => {
  await Promise.all([page.waitForResponse((r) => r.url().includes('interval=3m')),
    page.getByLabel('24 год').check()]);
  await Promise.all([page.waitForResponse((r) => r.url().includes('interval=30m')),
    page.getByLabel('7 днів').check()]);
  const aggs = telemetry().filter((u) => u.searchParams.has('agg'));
  assert.deepEqual(aggs.map((u) => u.searchParams.get('interval')), ['3m', '30m']);
  assert.ok(aggs.every((u) => u.searchParams.get('agg') === 'avg,min,max'));
});

await check('повернення до «24 год» протягом хвилини обслуговує кеш: нового запиту немає', async () => {
  const before = telemetry().length;
  await page.getByLabel('24 год').check();
  await sleep(600);
  assert.equal(telemetry().length, before);
});

await check('тиждень: не більше 500 точок, смуга мін–макс присутня', async () => {
  await page.getByLabel('7 днів').check();
  await page.waitForSelector('[role=img] path.recharts-area-area');
  const label = await page.getAttribute('[role=img]', 'aria-label');
  const n = Number(/(\d+) точок/.exec(label)[1]);
  assert.ok(n <= 500 && n >= 300, `${n} точок`);
});

await check('експорт у CSV: заголовок, кількість рядків дорівнює кількості точок на графіку', async () => {
  const label = await page.getAttribute('[role=img]', 'aria-label');
  const n = Number(/(\d+) точок/.exec(label)[1]);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Експорт у CSV').click()]);
  const text = fs.readFileSync(await download.path(), 'utf8');
  assert.ok(text.startsWith('﻿time,value,min,max\r\n'));
  assert.equal(text.trim().split('\r\n').length - 1, n);
  assert.match(download.suggestedFilename(), /^gh1-s01-soil_moisture-7d\.csv$/);
});

await check('клавіатура: картка досяжна Tab, Enter вибирає її (aria-pressed)', async () => {
  await page.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');     // ... до другої картки
  await page.keyboard.press('Enter');
  const pressed = await page.$$eval('.device-card', (els) => els.map((e) => e.getAttribute('aria-pressed')));
  assert.equal(pressed.filter((p) => p === 'true').length, 1);
});

await check('перерви в даних: лінія розривається і в інтервалах, і в сирому ряді', async () => {
  // Грядка Б мовчала 12 хв (42–30 хв тому) і 2 год (10–8 год тому)
  await page.getByRole('button', { name: /Грядка Б.*Температура/ }).click();
  const segments = async () => (await page.getAttribute(
    '[role=img] path.recharts-line-curve', 'd')).split('M').length - 1;
  await Promise.all([page.waitForResponse((r) => r.url().includes('interval=3m')),
    page.getByLabel('24 год').check()]);
  await page.waitForSelector('[role=img] path.recharts-area-area');
  await sleep(300);
  assert.equal(await segments(), 3);              // дві перерви — три відрізки лінії
  const fill = telemetry().filter((u) => u.searchParams.get('interval') === '3m').at(-1);
  assert.equal(fill.searchParams.get('fill'), 'null');
  await page.getByLabel('1 год').check();
  await sleep(500);
  assert.equal(await segments(), 2);              // у сирому ряді лише перерва 12 хв
});

await check('перемикання діапазону: старий графік лишається з написом «Завантаження діапазону…»', async () => {
  // Грядка В у діапазоні «7 днів» ще не запитувалась: кешу для неї немає
  await page.getByRole('button', { name: /Грядка В.*Температура/ }).click();
  await page.waitForSelector('section[aria-busy="false"] [role=img] path.recharts-line-curve');
  const slow = /\/api\/v1\/telemetry\?.*interval=30m/;
  await page.route(slow, async (route) => { await sleep(1200); await route.continue(); });
  await page.getByLabel('7 днів').check();
  await page.waitForSelector('section[aria-busy="true"]', { timeout: 2000 });
  assert.match(await page.textContent('.toolbar'), /Завантаження діапазону…/);
  assert.equal(await page.locator('[role=img]').count(), 1);          // старий графік на місці
  const exportBtn = page.getByRole('button', { name: 'Експорт у CSV' });
  assert.ok(await exportBtn.isDisabled());   // файл «7d» не повинен містити чужі дані
  await page.waitForSelector('section[aria-busy="false"]');
  assert.ok(await exportBtn.isEnabled());
  assert.doesNotMatch(await page.textContent('.toolbar'), /Завантаження діапазону/);
  await page.unroute(slow);
});

await check('відповідь 400 не повторюється, помилка видна, «Повторити» знову запитує дані', async () => {
  let hits = 0;
  const bad = /\/api\/v1\/telemetry\?.*device=gh1-s03.*interval=3m/;
  await page.route(bad, (route) => {
    hits += 1;
    route.fulfill({ status: 400, contentType: 'application/problem+json',
      body: JSON.stringify({ type: 'about:blank', title: 'Bad Request', status: 400 }) });
  });
  await page.getByLabel('24 год').check();
  await page.waitForSelector('[role=alert]');
  await sleep(2500);                                // довше за першу паузу повтору (1 с)
  assert.equal(hits, 1);
  assert.equal(await page.locator('[role=img]').count(), 0);     // графіка без даних немає
  await page.unroute(bad);
  await page.getByRole('button', { name: 'Повторити' }).click();
  await page.waitForSelector('[role=img] path.recharts-line-curve');
  assert.equal(await page.locator('[role=alert]').count(), 0);
  // браузер сам пише в консоль про відповідь 400: ця помилка очікувана
  errors.splice(0, errors.length, ...errors.filter((e) => !/status of 400/.test(e)));
});

await check('усередині role=img немає елементів у порядку табуляції (вкладений інтерактив)', async () => {
  const n = await page.$$eval('[role=img] [tabindex]:not([tabindex="-1"])', (els) => els.length);
  assert.equal(n, 0);
});

await check('жодних помилок у консолі сторінки', async () => assert.deepEqual(errors, []));
await page.close();

// Старіння без жодної події: годинник сторінки підмінено, а дані на
// сервері не змінюються
const page2 = await (await browser.newContext(VIEW)).newPage();
await page2.clock.install({ time: Date.now() });
await page2.goto(url);
await page2.waitForSelector('.device-card');
const levels = () => page2.$$eval('.device-card', (els) => els.map((e) =>
  [...e.classList].find((c) => c.startsWith('device-card--')).slice(13)));

await check('спершу Грядка Б (33 %) — «Попередження»', async () => {
  assert.equal((await levels())[2], 'warning');
});
await check('через 4 хв без даних усі картки — «Немає даних»', async () => {
  await page2.clock.fastForward('04:00');
  await sleep(500);
  assert.deepEqual(await levels(), Array(8).fill('offline'));
  assert.equal((await page2.textContent('.summary')).trim(),
    '0 норма · 0 попередження · 0 критично · 8 немає даних');
});

// Повернення на вкладку: картки пристроїв оновлюються лише тоді, коли їхні
// дані старші за staleTime (15 с); годинник сторінки зсувається без таймерів
const page3 = await (await browser.newContext(VIEW)).newPage();
const paths3 = [];
page3.on('request', (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith('/api/v1/')) paths3.push(u.pathname);
});
await page3.clock.install({ time: Date.now() });
await page3.goto(url);
await page3.waitForSelector('[role=img] path.recharts-line-curve');
await sleep(600);
const comeBack = () => page3.evaluate(() =>
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));

await check('повернення на вкладку менш ніж за 15 с: нових запитів немає', async () => {
  const before = paths3.length;
  await comeBack();
  await sleep(600);
  assert.equal(paths3.length, before);
});
await check('повернення після паузи 20 с: чотири запити пристроїв, список і історія не чіпаються', async () => {
  await page3.clock.setSystemTime(Date.now() + 20_000);
  const before = paths3.length;
  await comeBack();
  await sleep(800);
  const added = paths3.slice(before);
  assert.equal(added.length, 4, added.join(' '));
  assert.ok(added.every((p) => /^\/api\/v1\/devices\/gh1-s0\d$/.test(p)), added.join(' '));
});

// Вузький екран: 320 CSS px — ширина, на якій вміст не повинен прокручуватися вбік
const page4 = await (await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true })).newPage();
await page4.goto(url);
await page4.waitForSelector('[role=img] path.recharts-line-curve');
await sleep(400);

await check('320 px: горизонтальної прокрутки сторінки немає, картки у дві колонки', async () => {
  const m = await page4.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, inner: window.innerWidth,
    cols: new Set([...document.querySelectorAll('.device-card')]
      .map((e) => Math.round(e.getBoundingClientRect().left))).size,
  }));
  assert.ok(m.scroll <= m.inner, `${m.scroll} > ${m.inner}`);
  assert.equal(m.cols, 2);
});
await check('цілі натискання (картки, радіокнопки, експорт) не менші за 44 × 44 px', async () => {
  const small = await page4.$$eval('.device-card, .range label, .toolbar button', (els) => els
    .map((e) => { const r = e.getBoundingClientRect(); return [e.className || e.tagName, r.width, r.height]; })
    .filter(([, w, h]) => w < 44 || h < 44));
  assert.deepEqual(small, []);
});

await browser.close();
await bed.stop();
const failed = results.filter(([, r]) => r !== 'ok').length;
console.log(`\n${results.length - failed} з ${results.length} перевірок пройдено`);
process.exit(failed ? 1 : 0);
