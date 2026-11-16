// Що бачить браузер, підписаний на брокер напряму, і що — через сервер застосунку.
// node calc3-mqtt-raw.mjs → results/mqtt-raw.json
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = require('playwright');
const { startTestbed } = require('./testbed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.copyFileSync(path.join(here, 'node_modules/mqtt/dist/mqtt.min.js'),
  path.join(here, 'wire-dist/mqtt.min.js'));
const bed = await startTestbed({ windowMs: 100, dist: path.join(here, 'wire-dist') });
const browser = await chromium.launch();
const open = async (kind, extra = '') => {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${bed.httpPort}/wire.html${extra}`);
  await page.evaluate((k) => window.connectors[k](), kind);
  return page;
};
const viaBroker = await open('mqtt', `?mqtt=ws://127.0.0.1:${bed.wsPort}`);
const viaServer = await open('sse');
await sleep(300);

const now = Date.now();
const good = new Date(now).toISOString();
const noMs = new Date(Math.floor(now / 1000) * 1000 + 1000).toISOString().replace('.000Z', 'Z');
await bed.publish('gh1-s01', { metric: 'temperature', value: 21.4, ts: good });
await bed.publish('gh1-s01', { metric: 'temperature', value: 999, ts: new Date(now + 1).toISOString() });
await bed.publish('gh1-s01', { metric: 'temperature', value: 21.5, ts: noMs });
await sleep(800);
const out = {
  published: 3,
  browserViaBroker: await viaBroker.evaluate(() => window.msgs),
  browserViaServer: await viaServer.evaluate(() => window.msgs),
  rejected: bed.db.prepare('SELECT reason, raw FROM rejected').all(),
  stored: bed.db.prepare("SELECT ts, value FROM telemetry WHERE device_id = 'gh1-s01' ORDER BY ts").all(),
};
fs.writeFileSync(path.join(here, 'results/mqtt-raw.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await browser.close();
await bed.stop();
process.exit(0);
