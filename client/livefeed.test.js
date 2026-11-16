import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveFeed } from './livefeed.js';

const t = (n) => new Date(Date.UTC(2026, 10, 4, 12, 0, n)).toISOString();
const R = (n, v = n) => ({ device: 'a', metric: 'temperature', ts: t(n), value: v });
const flush = () => new Promise((r) => setImmediate(r));   // дати мікрозадачам відпрацювати

// Підставний транспорт: тест сам викликає обробники, як це робив би сервер
function fakeTransport() {
  const tr = { starts: 0, stops: 0, h: null,
    start(h) { tr.starts++; tr.h = h; }, stop() { tr.stops++; } };
  return tr;
}

function setup(t, { rows = [], flushMs = 1000, delayFor = (n) => n * 1000 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const transport = fakeTransport();
  const views = [];
  const loads = { n: 0, fail: [] };
  const feed = createLiveFeed({
    transport, flushMs, delayFor, now: () => 0,
    onView: (v) => views.push(v),
    loadWindow: async function* () {
      loads.n++;
      const f = loads.fail.shift();
      if (f) throw Object.assign(new Error('HTTP'), f);
      yield rows;
    },
  });
  return { feed, transport, views, loads, last: () => views.at(-1) };
}

test('onOpen: статус online, початкове завантаження й живі події зливаються в один ряд', async (t) => {
  const s = setup(t, { rows: [R(1), R(2), R(3)] });
  s.feed.start();
  assert.equal(s.last().status, 'connecting');
  s.transport.h.onReadings([R(4)]);                    // жива подія раніше за підтвердження
  s.transport.h.onOpen();
  s.transport.h.onReadings([R(3), R(5)]);              // дубль R(3) і новіша R(5)
  await flush();
  t.mock.timers.tick(1000);
  assert.equal(s.last().status, 'online');
  assert.deepEqual(s.last().series['a/temperature'].map((p) => p.value), [1, 2, 3, 4, 5]);
  s.feed.stop();
});

test('обрив: reconnecting із лічильником, повтор через delayFor(n), після onOpen лічильник скинуто', async (t) => {
  const s = setup(t, { rows: [R(1)] });
  s.feed.start();
  s.transport.h.onOpen();
  await flush();
  const first = s.transport.h;
  first.onClose();
  assert.deepEqual([s.last().status, s.last().attempt], ['reconnecting', 1]);
  assert.equal(s.transport.starts, 1);
  t.mock.timers.tick(999);
  assert.equal(s.transport.starts, 1);                 // delayFor(1) = 1000 мс ще не минуло
  t.mock.timers.tick(1);
  assert.equal(s.transport.starts, 2);
  s.transport.h.onClose();                             // друга невдача: затримка 2000 мс
  assert.equal(s.last().attempt, 2);
  t.mock.timers.tick(2000);
  assert.equal(s.transport.starts, 3);
  s.transport.h.onOpen();
  await flush();
  assert.deepEqual([s.last().status, s.last().attempt], ['online', 0]);
  assert.equal(s.loads.n, 2);                          // перше й відновлення — один і той самий sync
  s.feed.stop();
});

test('події старого підключення після перепідключення ігноруються', async (t) => {
  const s = setup(t);
  s.feed.start();
  const old = s.transport.h;
  old.onOpen();
  old.onClose();
  t.mock.timers.tick(1000);
  const fresh = s.transport.h;
  assert.notEqual(old, fresh);
  old.onReadings([R(9)]);                              // запізніла подія зі старого сокета
  old.onOpen();
  old.onClose();
  assert.equal(s.transport.starts, 2);
  fresh.onOpen();
  await flush();
  t.mock.timers.tick(1000);
  assert.deepEqual(s.last().series, {});
  s.feed.stop();
});

test('подвійний onClose від одного обриву не планує два перепідключення', (t) => {
  const s = setup(t);
  s.feed.start();
  s.transport.h.onOpen();
  const h = s.transport.h;
  h.onClose();
  h.onClose();
  assert.equal(s.last().attempt, 1);
  t.mock.timers.tick(5000);
  assert.equal(s.transport.starts, 2);
  s.feed.stop();
});

test('транспорт, що відновлюється сам (SSE): контролер лише показує стан і рахує спроби', (t) => {
  const s = setup(t);
  s.feed.start();
  s.transport.h.onOpen();
  s.transport.h.onClose({ willRetry: true });
  s.transport.h.onClose({ willRetry: true });          // кожна невдала спроба браузера
  assert.deepEqual([s.last().status, s.last().attempt], ['reconnecting', 2]);
  t.mock.timers.tick(60_000);
  assert.equal(s.transport.starts, 1);                 // власного перезапуску немає
  assert.equal(s.transport.stops, 0);
  s.feed.stop();
});

test('тротлінг: 5 подій/с протягом 10 с дають 10 перемальовувань, а не 50', async (t) => {
  const s = setup(t);
  s.feed.start();
  s.transport.h.onOpen();
  await flush();
  const before = s.views.length;
  for (let sec = 0; sec < 10; sec++) {
    for (let k = 0; k < 5; k++) s.transport.h.onReadings([R(sec * 5 + k)]);
    t.mock.timers.tick(1000);
  }
  assert.equal(s.views.length - before, 10);
  assert.equal(s.last().series['a/temperature'].length, 50);
  s.feed.stop();
});

test('помилка REST: повтор через Retry-After, а за його відсутності — за backoff', async (t) => {
  const s = setup(t, { rows: [R(1)] });
  s.loads.fail.push({ retryAfterMs: 3000 }, {});
  s.feed.start();
  s.transport.h.onOpen();
  await flush();
  assert.equal(s.loads.n, 1);
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(s.loads.n, 1);
  t.mock.timers.tick(1);                               // 3000 мс із заголовка Retry-After
  await flush();
  assert.equal(s.loads.n, 2);
  t.mock.timers.tick(2000);                            // delayFor(2) — другий збій
  await flush();
  assert.equal(s.loads.n, 3);
  t.mock.timers.tick(1000);
  assert.deepEqual(s.last().series['a/temperature'].map((p) => p.value), [1]);
  s.feed.stop();
});

test('onFail: стан failed без повторів; stop знімає таймери й транспорт', (t) => {
  const s = setup(t);
  s.feed.start();
  s.transport.h.onFail('unknown');
  assert.deepEqual([s.last().status, s.last().error], ['failed', 'unknown']);
  t.mock.timers.tick(100_000);
  assert.equal(s.transport.starts, 1);
  s.feed.stop();
  assert.ok(s.transport.stops >= 1);
});
