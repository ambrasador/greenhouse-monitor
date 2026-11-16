'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');

// Наскрізні тести: справжній Chromium, окремий процес сервера (брокер Aedes, API, потік
// подій) і зібраний клієнт. Їх небагато: кожен повільний, а дублювати перевірки
// нижчих рівнів немає сенсу
let server, browser, page, url;

beforeAll(async () => {
  server = spawn('node', ['demo-dashboard.js'], { cwd: path.join(__dirname, '../..') });
  url = await new Promise((resolve, reject) => {
    server.once('exit', (code) => reject(new Error(`сервер завершився з кодом ${code}`)));
    server.stdout.on('data', (chunk) => {
      const m = /(http:\/\/\S+\/dashboard\.html)/.exec(chunk);
      if (m) resolve(m[1]);
    });
  });
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  server.kill('SIGTERM');
});
beforeEach(async () => { page = await browser.newPage(); });
afterEach(async () => { await page.close(); });

test('сторінка відкривається й показує картки пристроїв', async () => {
  await page.goto(url);
  const cards = page.locator('.device-card');
  await cards.first().waitFor();
  expect(await cards.count()).toBe(8);                          // 4 пристрої × 2 показники
  expect(await cards.first().locator('.device-card__name').textContent()).toBe('Грядка А');
  expect(await cards.first().locator('.device-card__value').textContent()).toMatch(/^\d\d,\d\s%$/);   // між числом і % — нерозривний пробіл
});

test('недоступний сервер: кнопка «Повторити» замість графіка', async () => {
  await page.goto(url);
  await page.locator('.device-card').first().waitFor();
  await page.route('**/api/v1/**', (r) => r.abort('connectionrefused'));
  await page.getByLabel('24 год').check();      // діапазону немає в кеші
  const alert = page.getByRole('alert');
  await alert.waitFor({ timeout: 20_000 });     // спершу кілька повторів
  expect(await alert.textContent())
    .toContain('Не вдалося завантажити дані');
  const retry = page.getByRole('button', { name: 'Повторити' });
  expect(await retry.isVisible()).toBe(true);
  expect(await page.locator('[role=img]').count()).toBe(0);
});
