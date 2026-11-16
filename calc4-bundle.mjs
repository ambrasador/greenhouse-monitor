// Розмір бібліотек дашборда в браузерному пакеті (esbuild --minify + gzip -9). node calc4-bundle.mjs
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const esbuild = require('esbuild');

async function size(name, opts) {
  const r = await esbuild.build({ bundle: true, minify: true, write: false, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', jsx: 'automatic', ...opts });
  const buf = Buffer.from(r.outputFiles[0].contents);
  return { name, minKB: +(buf.length / 1024).toFixed(1), gzipKB: +(zlib.gzipSync(buf, { level: 9 }).length / 1024).toFixed(1) };
}
const code = (contents) => ({ stdin: { contents, resolveDir: here, loader: 'jsx' } });

const rows = [];
rows.push(await size('react + react-dom', code("import React from 'react'; import { createRoot } from 'react-dom/client'; window.x = [React, createRoot];")));
rows.push(await size('react + react-dom + recharts (ComposedChart, Line, Area, оси, ReferenceLine, Tooltip)', code(
  "import React from 'react'; import { createRoot } from 'react-dom/client';" +
  "import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';" +
  'window.x = [React, createRoot, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine];')));
rows.push(await size('chart.js/auto (усі контролери й шкали)', code("import Chart from 'chart.js/auto'; window.x = Chart;")));
rows.push(await size('chart.js, лише лінійний графік (дерево імпортів)', code(
  "import { Chart, LineController, LineElement, PointElement, LinearScale, Decimation, Tooltip, Filler } from 'chart.js';" +
  'Chart.register(LineController, LineElement, PointElement, LinearScale, Decimation, Tooltip, Filler); window.x = Chart;')));
rows.push(await size('@tanstack/react-query (без react)', {
  ...code("import { QueryClient, QueryClientProvider, useQuery, useQueries, useQueryClient, keepPreviousData } from '@tanstack/react-query'; window.x = [QueryClient, QueryClientProvider, useQuery, useQueries, useQueryClient, keepPreviousData];"),
  external: ['react', 'react/jsx-runtime'] }));
rows.push(await size('d3-scale + d3-shape (scaleTime, scaleLinear, line, area)', code(
  "import { scaleTime, scaleLinear } from 'd3-scale'; import { line, area } from 'd3-shape';" +
  'window.x = [scaleTime, scaleLinear, line, area];')));
rows.push(await size('mqtt (клієнт для браузера)', code("import mqtt from 'mqtt'; window.x = mqtt;")));
rows.push(await size('leaflet (JS)', code("import L from 'leaflet'; window.x = L;")));
const css = await esbuild.build({ entryPoints: [path.join(here, 'node_modules/leaflet/dist/leaflet.css')], bundle: true, minify: true,
  write: false, loader: { '.png': 'dataurl', '.svg': 'dataurl' }, logLevel: 'silent' });
const cssBuf = Buffer.from(css.outputFiles[0].contents.filter ? css.outputFiles[0].contents : css.outputFiles[0].text);
rows.push({ name: 'leaflet.css (зображення вбудовано як data URL)', minKB: +(cssBuf.length / 1024).toFixed(1), gzipKB: +(zlib.gzipSync(cssBuf, { level: 9 }).length / 1024).toFixed(1) });
rows.push(await size('сторінка дашборда: повністю', { entryPoints: [path.join(here, 'client/dashboard.jsx')] }));
rows.push(await size('сторінка демонстраційного потоку (app.jsx): із mqtt', { entryPoints: [path.join(here, 'client/app.jsx')] }));
rows.push(await size('код застосунку без сторонніх пакетів', { entryPoints: [path.join(here, 'client/dashboard.jsx')], packages: 'external', format: 'esm' }));
fs.writeFileSync(path.join(here, 'results/bundle.json'), JSON.stringify(rows, null, 1));
console.table(rows);
