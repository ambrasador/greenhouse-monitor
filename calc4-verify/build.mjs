// Збирає calc4-verify/out.js для run.mjs: node calc4-verify/build.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
await build({
  entryPoints: [`${dir}entry.jsx`], bundle: true, outfile: `${dir}out.js`,
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
});
