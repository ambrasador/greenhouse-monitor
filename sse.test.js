'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { makeDb, addDevice, seed } = require('./testkit');
const { createFeed } = require('./feed');
const { createStreamHandler } = require('./sse');
const { problemHandler } = require('./api');
const { GREENHOUSE } = require('./metrics');

const T0 = Date.parse('2026-11-04T12:00:00Z');
const ts = (n) => new Date(T0 + n * 1000).toISOString();

async function start(opts = {}) {
  const db = makeDb();
  addDevice(db, 'gh1-s01');
  addDevice(db, 'gh1-s02');
  const feed = createFeed();
  const app = express();
  app.get('/devices/:id/stream', createStreamHandler({ db, feed, metrics: GREENHOUSE, ...opts }));
  app.use(problemHandler());
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); };
  return { db, feed, base, stop };
}

// Читач SSE: розбирає потік на події (поля event, id, data; коментарі окремо)
async function open(url, headers = {}) {
  const ctl = new AbortController();
  const res = await fetch(url, { headers, signal: ctl.signal });
  const out = { res, events: [], comments: [], retry: null, ctl };
  if (res.status !== 200) return out;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = { event: 'message' };
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) { out.comments.push(line.slice(1).trim()); continue; }
            const [k, ...v] = line.split(': ');
            if (k === 'retry') out.retry = Number(v.join(': '));
            else if (k === 'data') ev.data = JSON.parse(v.join(': '));
            else ev[k] = v.join(': ');
          }
          if (block.trim() && !block.startsWith('retry') && !(block.startsWith(':') && !block.includes('\n'))) out.events.push(ev);
        }
      }
    } catch { /* обрив */ }
  })();
  out.until = async (pred, ms = 1500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred(out)) return; await new Promise((r) => setTimeout(r, 5)); }
    throw new Error(`не дочекалися; події: ${JSON.stringify(out.events)}`);
  };
  out.close = () => ctl.abort();
  return out;
}

test('помилки до початку потоку мають вигляд problem+json', async () => {
  const t = await start();
  const r404 = await fetch(`${t.base}/devices/none/stream`);
  assert.equal(r404.status, 404);
  assert.match(r404.headers.get('content-type'), /application\/problem\+json/);
  const r400 = await fetch(`${t.base}/devices/gh1-s01/stream?metrics=temperature,bogus`);
  assert.equal(r400.status, 400);
  await t.stop();
});

test('заголовки потоку, retry із випадковою добавкою та подія ready', async () => {
  const t = await start({ rnd: () => 0.5, retryMs: 3000 });
  const s = await open(`${t.base}/devices/gh1-s01/stream`);
  assert.equal(s.res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(s.res.headers.get('cache-control'), 'no-cache, no-transform');
  await s.until((o) => o.events.some((e) => e.event === 'ready'));
  assert.equal(s.retry, 4500);                  // 3000 + 0.5 · 3000
  s.close(); await t.stop();
});

test('живі події: id = ts, фільтр за пристроєм і метрикою', async () => {
  const t = await start();
  const s = await open(`${t.base}/devices/gh1-s01/stream?metrics=temperature`);
  await s.until((o) => o.events.some((e) => e.event === 'ready'));
  t.feed.publish({ device: 'gh1-s01', metric: 'humidity', ts: ts(1), value: 50 });     // не та метрика
  t.feed.publish({ device: 'gh1-s02', metric: 'temperature', ts: ts(2), value: 19 });  // не той пристрій
  t.feed.publish({ device: 'gh1-s01', metric: 'temperature', ts: ts(3), value: 22.5 });
  await s.until((o) => o.events.some((e) => e.event === 'telemetry'));
  const tel = s.events.filter((e) => e.event === 'telemetry');
  assert.equal(tel.length, 1);
  assert.equal(tel[0].id, ts(3));
  assert.deepEqual(tel[0].data, { device: 'gh1-s01', metric: 'temperature', ts: ts(3), value: 22.5 });
  s.close(); await t.stop();
});

test('Last-Event-ID: повтор від цього ts включно, у порядку ts, потім ready', async () => {
  const t = await start();
  seed(t.db, { device: 'gh1-s01', metric: 'temperature', start: T0, count: 5, step: 1, values: [1, 2, 3, 4, 5] });
  seed(t.db, { device: 'gh1-s01', metric: 'humidity', start: T0 + 2000, count: 1, step: 1, values: [60] });
  const s = await open(`${t.base}/devices/gh1-s01/stream`, { 'Last-Event-ID': ts(2) });
  await s.until((o) => o.events.some((e) => e.event === 'ready'));
  const got = s.events.filter((e) => e.event === 'telemetry').map((e) => [e.id, e.data.metric, e.data.value]);
  assert.deepEqual(got, [
    [ts(2), 'humidity', 60], [ts(2), 'temperature', 3],      // межа включена; ts однакові
    [ts(3), 'temperature', 4], [ts(4), 'temperature', 5]]);
  assert.equal(s.events.at(-1).event, 'ready');
  s.close(); await t.stop();
});

test('занадто довга прогалина: reset замість повтору', async () => {
  const t = await start({ replayLimit: 3 });
  seed(t.db, { device: 'gh1-s01', start: T0, count: 10, step: 1, values: (i) => i });
  const s = await open(`${t.base}/devices/gh1-s01/stream`, { 'Last-Event-ID': ts(0) });
  await s.until((o) => o.events.some((e) => e.event === 'ready'));
  assert.deepEqual(s.events.map((e) => e.event), ['reset', 'ready']);
  s.close(); await t.stop();
});

test('некоректний Last-Event-ID ігнорується', async () => {
  const t = await start();
  seed(t.db, { device: 'gh1-s01', start: T0, count: 3, step: 1, values: [1, 2, 3] });
  const s = await open(`${t.base}/devices/gh1-s01/stream`, { 'Last-Event-ID': "x' OR '1'='1" });
  await s.until((o) => o.events.some((e) => e.event === 'ready'));
  assert.deepEqual(s.events.map((e) => e.event), ['ready']);
  s.close(); await t.stop();
});

test('heartbeat: іменована подія hb надходить, коли даних немає', async () => {
  const t = await start({ heartbeatMs: 20 });
  const s = await open(`${t.base}/devices/gh1-s01/stream`);
  await s.until((o) => o.events.filter((e) => e.event === 'hb').length >= 2);
  s.close(); await t.stop();
});

test('ліміт потоків на клієнта: четвертий дістає 429, після закриття слот вільний', async () => {
  const t = await start({ perClient: 3 });
  const url = `${t.base}/devices/gh1-s01/stream`;
  const streams = [];
  for (let i = 0; i < 3; i++) streams.push(await open(url));
  const r = await fetch(url);
  assert.equal(r.status, 429);
  streams[0].close();
  await new Promise((r2) => setTimeout(r2, 50));
  const again = await open(url);
  assert.equal(again.res.status, 200);
  [...streams, again].forEach((x) => x.close());
  await t.stop();
});

test('закриття клієнтом знімає підписку на шині', async () => {
  const t = await start();
  const s = await open(`${t.base}/devices/gh1-s01/stream`);
  await s.until((o) => o.events.some((e) => e.event === 'ready'));
  assert.equal(t.feed.size(), 1);
  s.close();
  for (let i = 0; i < 50 && t.feed.size() > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.feed.size(), 0);
  await t.stop();
});
