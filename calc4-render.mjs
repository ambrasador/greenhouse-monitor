// Розділ 4: швидкість малювання лінійного графіка різними засобами.
// node bench4/build.mjs render && node calc4-render.mjs   (≈ 10–15 хв на двох vCPU)
// Для кожної пари «бібліотека — кількість точок» береться медіана за RUNS свіжих завантажень сторінки
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const url = `file://${here}/bench4/dist/render.html`;
const out = path.join(here, 'results/render.jsonl');
fs.writeFileSync(out, '');
const SIZES = [100, 500, 1000, 5000, 10_000, 50_000];
const RUNS = Number(process.env.RUNS ?? 3);
const SLOW_MS = 20_000;                                  // після такого першого кадру більші розміри пропускаємо
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

const browser = await chromium.launch();
const libs = await (async () => { const p = await browser.newPage(); await p.goto(url); const l = await p.evaluate(() => window.libs); await p.close(); return l; })();
const rows = [];
for (const lib of libs) {
  let skipFrom = Infinity;
  for (const n of SIZES) {
    if (n >= skipFrom) { rows.push({ lib, n, skipped: true }); continue; }
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const page = await browser.newPage({ viewport: { width: 900, height: 400 } });
      try {
        await page.goto(url);
        runs.push(await Promise.race([page.evaluate(([l, k]) => window.runCase(l, k), [lib, n]), timeout(90_000)]));
      } catch (e) {
        console.log(`   ${lib} n=${n}: ${e.message}`);
        runs.push({ failed: true, first: Infinity });
      }
      await page.close();
      if (runs.at(-1).first > SLOW_MS) break;            // не повторюємо вимір, який і так задовгий
    }
    const ok = runs.filter((r) => !r.failed);
    const m = (k) => (ok.length ? median(ok.map((r) => r[k]).filter((v) => v != null)) : null);
    const row = { lib, n, runs: ok.length, sync: m('sync'), first: m('first'), nodes: ok[0]?.nodes ?? null,
      appendFps: m('appendFps'), appendWork: m('appendWork'), hoverFps: ok.some((r) => r.hoverFps != null) ? m('hoverFps') : null,
      firstAll: ok.map((r) => r.first) };
    if (!ok.length || row.first > SLOW_MS) skipFrom = n * 2;
    rows.push(row);
    fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
    console.log(`${lib.padEnd(17)} n=${String(n).padStart(6)}  перший кадр ${row.first?.toFixed(0).padStart(6)} мс  вузлів ${String(row.nodes).padStart(6)}  додавання ${row.appendFps?.toFixed(1)} к/с (${row.appendWork?.toFixed(1)} мс)  наведення ${row.hoverFps?.toFixed(1) ?? '—'} к/с`);
  }
}
fs.writeFileSync(path.join(here, 'results/render.json'), JSON.stringify(rows));
await browser.close();
