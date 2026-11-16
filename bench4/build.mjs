// Збирає сторінки вимірювань: node bench4/build.mjs
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(`${dir}dist`, { recursive: true });
const pages = process.argv.slice(2).length ? process.argv.slice(2) : ['rerender', 'render'];
for (const p of pages) {
  copyFileSync(`${dir}${p}.html`, `${dir}dist/${p}.html`);
  await build({
    entryPoints: [`${dir}${p}.jsx`], bundle: true, minify: true, outfile: `${dir}dist/${p}.js`,
    jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
  });
}
