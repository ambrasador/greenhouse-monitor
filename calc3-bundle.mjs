// Розмір клієнтських бібліотек у браузерному пакеті (мінімізація esbuild + gzip -9)
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const esbuild = require('esbuild');
const entries = {
  'socket.io-client': "import { io } from 'socket.io-client'; window.x = io;",
  'mqtt.js': "import mqtt from 'mqtt'; window.x = mqtt;",
  'ws (браузерний міст)': "window.x = WebSocket;",
  'EventSource (вбудований)': "window.x = EventSource;",
  'власний контролер (series+backoff+livefeed+load-window)':
    "import { createLiveFeed } from './client/livefeed.js'; import { createWindowLoader } from './client/load-window.js'; window.x = [createLiveFeed, createWindowLoader];",
  'react + react-dom + recharts (демо-сторінка)':
    "import React from 'react'; import { createRoot } from 'react-dom/client'; import { LineChart } from 'recharts'; window.x = [React, createRoot, LineChart];",
};
const rows = [];
for (const [name, code] of Object.entries(entries)) {
  const r = await esbuild.build({ stdin: { contents: code, resolveDir: here, loader: 'js' },
    bundle: true, minify: true, write: false, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const buf = Buffer.from(r.outputFiles[0].contents);
  rows.push({ name, minKB: +(buf.length / 1024).toFixed(1), gzipKB: +(zlib.gzipSync(buf, { level: 9 }).length / 1024).toFixed(1) });
}
fs.writeFileSync(path.join(here, 'results/bundle.json'), JSON.stringify(rows, null, 1));
console.table(rows);
