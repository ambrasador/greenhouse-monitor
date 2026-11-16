'use strict';
// Проба: як Chromium (Playwright) поводиться з уже відкритими WebSocket, EventSource і Socket.IO,
// коли контекст переводять в офлайн. Два сервери: A (HTTP + SSE + чистий WebSocket), B (Socket.IO)
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { Server } = require('socket.io');
const { chromium } = require('playwright');
const WAIT = Number(process.env.WAIT ?? 60);       // скільки секунд чекати розриву в офлайні

(async () => {
  const t0 = Date.now();
  const P = (m) => console.error(((Date.now() - t0) / 1000).toFixed(1).padStart(5), m);
  const a = http.createServer((req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('retry: 1000\n\n');
      const t = setInterval(() => res.write(`data: ${Date.now()}\n\n`), 200);
      res.on('close', () => clearInterval(t));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>probe</title>');
  });
  const wss = new WebSocketServer({ server: a, path: '/ws' });
  wss.on('connection', (c) => { const t = setInterval(() => c.send(String(Date.now())), 200); c.on('close', () => clearInterval(t)); });
  const b = http.createServer();
  const io = new Server(b, { cors: { origin: '*' } });
  setInterval(() => io.emit('tick', Date.now()), 200);
  await new Promise((r) => a.listen(0, '127.0.0.1', r));
  await new Promise((r) => b.listen(0, '127.0.0.1', r));
  const [pa, pb] = [a.address().port, b.address().port];

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${pa}/`);
  await page.addScriptTag({ url: `http://127.0.0.1:${pb}/socket.io/socket.io.js` });
  await page.evaluate(([pa, pb]) => {
    window.log = []; window.n = { ws: 0, es: 0, sio: 0 };
    const T = performance.now();
    const L = (m) => window.log.push([Math.round(performance.now() - T), m]);
    const ws = new WebSocket(`ws://127.0.0.1:${pa}/ws`);
    ws.onopen = () => L('ws open'); ws.onclose = (e) => L(`ws close code=${e.code}`); ws.onerror = () => L('ws error');
    ws.onmessage = () => { window.n.ws++; };
    const es = new EventSource('/sse');
    es.onopen = () => L('sse open'); es.onerror = () => L(`sse error readyState=${es.readyState}`);
    es.onmessage = () => { window.n.es++; };
    const s = window.io(`http://127.0.0.1:${pb}`, { transports: ['websocket'] });
    s.on('connect', () => L('sio connect')); s.on('disconnect', (r) => L(`sio disconnect ${r}`));
    s.on('connect_error', (e) => L(`sio connect_error ${e.message}`));
    s.on('tick', () => { window.n.sio++; });
  }, [pa, pb]);
  await page.waitForTimeout(1500);
  const snap = () => page.evaluate(() => ({ ...window.n }));
  const before = await snap();
  await ctx.setOffline(true);
  P('offline');
  const marks = [];
  for (let s = 1; s <= WAIT; s++) {
    await page.waitForTimeout(1000);
    if (s % 5 === 0 || s === 3) marks.push([s, await snap()]);
  }
  const log1 = await page.evaluate(() => window.log.slice());
  await ctx.setOffline(false);
  P('online');
  await page.waitForTimeout(6000);
  const after = await snap();
  const log2 = await page.evaluate(() => window.log.slice());
  console.log(JSON.stringify({ before, marks, after, logWhileOffline: log1, logAll: log2 }));
  await browser.close();
  process.exit(0);
})();
