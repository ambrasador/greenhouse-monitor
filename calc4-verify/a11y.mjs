import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startDashboardBed } = require('../dash-bed');
const bed = await startDashboardBed();
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 960, height: 800 } });
await p.goto(`http://127.0.0.1:${bed.httpPort}/dashboard.html`);
await p.waitForSelector('[role=img] path.recharts-line-curve');
console.log(JSON.stringify(await p.evaluate(() => {
  const wrap = document.querySelector('[role=img]');
  const svg = wrap.querySelector('svg.recharts-surface');
  return { svgRole: svg.getAttribute('role'), svgTabindex: svg.getAttribute('tabindex'),
    tabindexed: [...wrap.querySelectorAll('[tabindex]')].map((e) => `${e.tagName.toLowerCase()}.${e.className?.baseVal ?? e.className}[tabindex=${e.getAttribute('tabindex')}]`) };
})));
await b.close(); await bed.stop();
