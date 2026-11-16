// Збирає демонстраційну сторінку: node client/build.mjs [--prod]
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const prod = process.argv.includes('--prod');
mkdirSync(`${dir}dist`, { recursive: true });
for (const f of ['index.html', 'dashboard.html', 'dashboard.css']) {
  copyFileSync(`${dir}${f}`, `${dir}dist/${f}`);
}
await build({
  entryPoints: [`${dir}app.jsx`, `${dir}dashboard.jsx`],   // демонстрація розділу 3 і дашборд розділу 4
  bundle: true,
  outdir: `${dir}dist`,
  minify: prod,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': prod ? '"production"' : '"development"' },
  logLevel: 'warning',
});
