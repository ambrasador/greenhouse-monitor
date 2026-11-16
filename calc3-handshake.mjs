// Знімає справжнє рукостискання WebSocket із Chromium і відповідь, яку
// будує наш acceptKey. Запуск: node calc3-handshake.mjs → examples/ws-handshake.txt
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = require('playwright');
const { acceptKey, encodeFrame } = require('./ws-frame');

const page = http.createServer((req, res) => res.end('<!doctype html><title>x</title>'));
await new Promise((r) => page.listen(0, '127.0.0.1', r));
let captured = null;
const wsSrv = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0 || captured) return;
    const head = buf.slice(0, end);
    const key = /Sec-WebSocket-Key: (.+)/i.exec(head)[1].trim();
    const resp = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n');
    captured = { request: head, response: resp.trimEnd(), key, accept: acceptKey(key) };
    sock.write(resp);
    sock.write(encodeFrame('{"ok":true}'));
  });
  sock.on('error', () => {});
});
await new Promise((r) => wsSrv.listen(0, '127.0.0.1', r));

const browser = await chromium.launch();
const p = await browser.newPage();
await p.goto(`http://127.0.0.1:${page.address().port}/`);
const got = await p.evaluate((port) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  ws.onmessage = (e) => { res(e.data); ws.close(); };
  ws.onerror = () => res('error');
}), wsSrv.address().port);
const out = `${captured.request}\r\n\r\n${captured.response}\r\n`;
fs.writeFileSync(path.join(here, 'examples/ws-handshake.raw'), out);
console.log(JSON.stringify({ browser: browser.version(), got, key: captured.key, accept: captured.accept }));
console.log(out.replace(/\r/g, ''));
await browser.close();
process.exit(0);
