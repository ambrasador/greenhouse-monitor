import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startDashboardBed } = require('../dash-bed');
const here = new URL('.', import.meta.url).pathname;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: fs.readFileSync(`${here}out.js`, 'utf8') });

// 1. Відтворення графіки: апаратне чи програмне
const gl = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const g = c.getContext('webgl');
  if (!g) return 'webgl недоступний';
  const ext = g.getExtension('WEBGL_debug_renderer_info');
  return ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'без debug-розширення';
});
console.log('WebGL renderer:', gl);

// 2. Chart.js: lineTo для n точок
for (const n of [5000, 50000]) {
  for (const tuned of [false, true]) {
    const calls = await page.evaluate(([k, t]) => window.countLineTo(k, t), [n, tuned]);
    console.log(`Chart.js n=${n} ${tuned ? 'parsing:false+normalized' : 'типові'}: lineTo = ${calls}`);
  }
}

// 3. Recharts: syncId між двома графіками
await page.evaluate(() => window.mountSync());
await page.waitForSelector('#b .recharts-wrapper');
await page.waitForTimeout(300);
const box = await page.locator('#a .recharts-wrapper').boundingBox();
await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
await page.waitForTimeout(300);
const tips = await page.$$eval('.recharts-tooltip-wrapper', (els) => els.map((e) => ({
  visibility: getComputedStyle(e).visibility, text: e.innerText.replace(/\n/g, ' | ') })));
console.log('підказки після наведення на перший графік:', JSON.stringify(tips));
await page.screenshot({ path: `${here}sync.png` });
await browser.close();

// 4. Доступність SVG в еталоні
const bed = await startDashboardBed();
const b2 = await chromium.launch();
const p2 = await b2.newPage({ viewport: { width: 960, height: 800 } });
await p2.goto(`http://127.0.0.1:${bed.httpPort}/dashboard.html`);
await p2.waitForSelector('[role=img] path.recharts-line-curve');
const a11y = await p2.evaluate(() => {
  const wrap = document.querySelector('[role=img]');
  const svg = wrap.querySelector('svg.recharts-surface');
  const focusable = [...wrap.querySelectorAll('[tabindex]')].map((e) => `${e.tagName.toLowerCase()}[tabindex=${e.getAttribute('tabindex')}]`);
  return { wrapRole: wrap.getAttribute('role'), svgRole: svg.getAttribute('role'), svgTabindex: svg.getAttribute('tabindex'),
    svgAria: svg.getAttribute('aria-label'), focusable };
});
console.log('доступність:', JSON.stringify(a11y));
await b2.close();
await bed.stop();
