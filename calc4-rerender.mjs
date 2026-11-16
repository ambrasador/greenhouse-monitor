// Розділ 4: перемальовування карток залежно від способу передавання даних.
// node bench4/build.mjs rerender && node calc4-rerender.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const url = `file://${here}/bench4/dist/rerender.html`;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const browser = await chromium.launch();
const names = await (async () => { const p = await browser.newPage(); await p.goto(url); const n = await p.evaluate(() => window.variants); await p.close(); return n; })();
const rows = [];
for (const name of names) {
  const runs = [];
  for (let i = 0; i < 7; i++) {
    const page = await browser.newPage();
    await page.goto(url);
    runs.push(await page.evaluate((n) => window.runVariant(n), name));
    await page.close();
  }
  const first = runs[0];
  rows.push({ name, updates: first.updates, card: first.card, spark: first.spark, parent: first.parent,
    ms: median(runs.map((r) => r.ms)), min: Math.min(...runs.map((r) => r.ms)), max: Math.max(...runs.map((r) => r.ms)),
    stable: runs.every((r) => r.card === first.card && r.spark === first.spark && r.parent === first.parent) });
}
console.table(rows.map((r) => ({ варіант: r.name, оновлень: r.updates, 'рендерів картки': r.card, 'рендерів діаграми': r.spark,
  'рендерів батька': r.parent, 'час, мс': r.ms.toFixed(1), 'мін–макс': `${r.min.toFixed(1)}–${r.max.toFixed(1)}`, стабільно: r.stable })));
fs.writeFileSync(path.join(here, 'results/rerender.json'), JSON.stringify(rows));
await browser.close();
