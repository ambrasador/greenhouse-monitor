import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchHistory, chartRows, splitAtGaps, refreshMs, isStreamed, BUDGET,
} from './history.js';

const NOW = Date.parse('2026-11-04T12:07:00Z');

// Підставний fetch: записує адреси й віддає підготовлені відповіді
function fake(responses) {
  const urls = [];
  const fn = async (url) => {
    urls.push(new URL(url, 'http://x'));
    const body = responses.shift();
    return { ok: true, status: 200, json: async () => body };
  };
  return { fn, urls };
}

test('година при T = 60 с: сирі точки, одна сторінка, без agg', async () => {
  const { fn, urls } = fake([{ data: [{ ts: '2026-11-04T11:10:00.000Z', value: 30 }], next: null }]);
  const r = await fetchHistory({ device: 'gh1', metric: 'soil_moisture', range: '1h',
    periodSec: 60, now: NOW, fetchFn: fn });
  assert.equal(r.kind, 'raw');
  assert.deepEqual(r.points, [{ t: Date.parse('2026-11-04T11:10:00Z'), v: 30 }]);
  assert.equal(urls[0].searchParams.get('agg'), null);
  assert.equal(urls[0].searchParams.get('limit'), '1000');
});

test('сирі точки читаються до кінця курсора', async () => {
  const { fn, urls } = fake([
    { data: [{ ts: '2026-11-04T11:10:00.000Z', value: 1 }], next: 'c1' },
    { data: [{ ts: '2026-11-04T11:11:00.000Z', value: 2 }], next: null }]);
  const r = await fetchHistory({ device: 'gh1', metric: 'temperature', range: '1h',
    periodSec: 60, now: NOW, fetchFn: fn });
  assert.equal(r.points.length, 2);
  assert.equal(urls[1].searchParams.get('cursor'), 'c1');
});

test('тиждень: agg=avg,min,max, interval=30m, початок вікна вирівняно за інтервалом', async () => {
  const { fn, urls } = fake([{ data: [{ start: '2026-10-28T12:00:00.000Z', count: 30, avg: 25, min: 22, max: 29 }] }]);
  const r = await fetchHistory({ device: 'gh1', metric: 'temperature', range: '7d',
    periodSec: 60, now: NOW, fetchFn: fn });
  const q = urls[0].searchParams;
  assert.equal(q.get('agg'), 'avg,min,max');
  assert.equal(q.get('interval'), '30m');
  assert.equal(q.get('fill'), 'null');                           // порожні інтервали — розрив
  assert.equal(q.get('from'), '2026-10-28T12:00:00.000Z');       // 12:07 − 7 діб = 12:07 → 12:00
  assert.equal(r.kind, 'buckets');
  assert.deepEqual(r.rows[0], { t: Date.parse('2026-10-28T12:00:00Z'), n: 30, v: 25, lo: 22, hi: 29 });
});

test('помилка HTTP перетворюється на виняток (TanStack Query повторить запит)', async () => {
  const fn = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(fetchHistory({ device: 'a', metric: 'temperature', range: '1h',
    periodSec: 60, now: NOW, fetchFn: fn }), /HTTP 503/);
});

test('chartRows: сирих точок не більше бюджету, інтервали отримують смугу band', () => {
  const points = Array.from({ length: 3600 }, (_, i) => ({ t: i * 1000, v: Math.sin(i / 50) }));
  assert.equal(chartRows({ kind: 'raw', points }).length, BUDGET);
  const rows = chartRows({ kind: 'buckets', rows: [{ t: 0, v: 5, lo: 4, hi: 7 }] });
  assert.deepEqual(rows[0].band, [4, 7]);
  assert.deepEqual(chartRows(null), []);
});

test('порожній інтервал (count 0, значення null) не має смуги й лишається розривом', () => {
  const rows = chartRows({ kind: 'buckets', rows: [
    { t: 0, n: 30, v: 5, lo: 4, hi: 7 },
    { t: 1800_000, n: 0, v: null, lo: null, hi: null },
    { t: 3600_000, n: 29, v: 6, lo: 5, hi: 8 }] });
  assert.equal(rows.length, 3);
  assert.equal(rows[1].v, null);
  assert.equal(rows[1].band, null);
  assert.deepEqual(rows[2].band, [5, 8]);
});

test('splitAtGaps: розрив — проміжок більший за gapMs; рівно gapMs розривом не є', () => {
  const at = (...mins) => mins.map((m) => ({ t: m * 60_000, v: m }));
  assert.deepEqual(splitAtGaps(at(0, 1, 2, 3), 3 * 60_000).length, 1);
  assert.deepEqual(splitAtGaps(at(0, 1, 5), 3 * 60_000).map((p) => p.length), [2, 1]);
  assert.deepEqual(splitAtGaps(at(0, 3), 3 * 60_000).length, 1);     // 3 хв ≤ 3 хв
  assert.deepEqual(splitAtGaps([], 1000), []);
  assert.deepEqual(splitAtGaps(at(0, 100)).length, 1);               // без gapMs розривів немає
});

test('chartRows: у сирому ряді розрив дає порожній рядок gap між відрізками', () => {
  // 10 хв даних, пауза 12 хв, ще 5 хв даних; T = 60 с → розрив після 3 хв
  const points = [];
  for (let m = 0; m <= 10; m++) points.push({ t: m * 60_000, v: 20 + m });
  for (let m = 22; m <= 27; m++) points.push({ t: m * 60_000, v: 30 });
  const rows = chartRows({ kind: 'raw', points, gapMs: 180_000 });
  const gaps = rows.filter((r) => r.gap);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].t, 16 * 60_000);          // середина між 10-ю й 22-ю хвилинами
  assert.equal(gaps[0].v, null);
  assert.equal(rows.length, points.length + 1);  // бюджет не вичерпано: точки збережено
  const k = rows.indexOf(gaps[0]);
  assert.equal(rows[k - 1].t, 10 * 60_000);      // краї розриву збережено точно
  assert.equal(rows[k + 1].t, 22 * 60_000);
});

test('chartRows: проріджування працює в кожному відрізку окремо й не зливає розрив', () => {
  const points = [];
  for (let i = 0; i < 2000; i++) points.push({ t: i * 5000, v: Math.sin(i / 40) });
  for (let i = 0; i < 2000; i++) points.push({ t: 10_100_000 + i * 5000, v: Math.cos(i / 40) });
  const rows = chartRows({ kind: 'raw', points, gapMs: 15_000 }, 500);
  assert.equal(rows.filter((r) => r.gap).length, 1);
  assert.ok(rows.length >= 500 && rows.length <= 503, `рядків: ${rows.length}`);
  const k = rows.findIndex((r) => r.gap);
  assert.equal(rows[k - 1].t, 1999 * 5000);      // остання точка першого відрізка збережена
  assert.equal(rows[k + 1].t, 10_100_000);        // перша точка другого збережена
});

test('парк, T = 5 с: година дає 720 точок — це інтервали по 1 хв, а не сирий ряд', async () => {
  const { fn, urls } = fake([{ data: [
    { start: '2026-11-04T11:07:00.000Z', count: 12, avg: 40, min: 38, max: 43 }] }]);
  const r = await fetchHistory({ device: 'bus7', metric: 'speed', range: '1h',
    periodSec: 5, now: NOW, fetchFn: fn });
  assert.equal(r.kind, 'buckets');
  assert.equal(r.interval, '1m');
  assert.equal(r.everyMs, 60_000);
  assert.equal(urls[0].searchParams.get('interval'), '1m');
});

test('everyMs: для сирих точок — період звітування, для інтервалів — їхня ширина', async () => {
  const raw = await fetchHistory({ device: 'gh1', metric: 'temperature', range: '1h',
    periodSec: 60, now: NOW, fetchFn: fake([{ data: [], next: null }]).fn });
  assert.equal(raw.everyMs, 60_000);
  const day = await fetchHistory({ device: 'gh1', metric: 'temperature', range: '24h',
    periodSec: 60, now: NOW, fetchFn: fake([{ data: [] }]).fn });
  assert.equal(day.interval, '3m');
  assert.equal(day.everyMs, 180_000);
});

test('refreshMs: потік оновлює лише сирі точки «1 год», решту — таймер', () => {
  const raw = (everyMs) => ({ kind: 'raw', everyMs });
  const buckets = (everyMs) => ({ kind: 'buckets', everyMs });
  assert.equal(refreshMs('1h', raw(60_000), true), false);       // теплиця: потік
  assert.equal(refreshMs('1h', buckets(60_000), true), 60_000);  // парк: хвилина
  assert.equal(refreshMs('24h', buckets(180_000), true), 180_000);  // теплиця, 3m
  assert.equal(refreshMs('7d', buckets(1_800_000), true), 300_000); // стеля 5 хв
  assert.equal(refreshMs('24h', raw(300_000), true), 300_000);   // дім: сирі точки
  assert.equal(refreshMs('24h', raw(15_000), true), 60_000);     // підлога 1 хв
  assert.equal(refreshMs('7d', undefined, true), 300_000);       // даних немає
  assert.equal(refreshMs('1h', undefined, true), 300_000);       // після збою
  // без прапорця домен вважається таким, що опитує: потоку немає
  assert.equal(refreshMs('1h', raw(60_000)), 60_000);
});

test('ряд оновлює або потік, або таймер — ніколи обидва й ніколи жоден', () => {
  for (const range of ['1h', '24h', '7d']) {
    for (const kind of ['raw', 'buckets']) {
      const data = { kind, everyMs: 60_000 };
      assert.equal(isStreamed(range, data, true),
        refreshMs(range, data, true) === false,
        `${range}/${kind}`);
    }
  }
  assert.equal(isStreamed('1h', undefined, true), false);
  assert.equal(isStreamed('24h', { kind: 'raw', everyMs: 300_000 }, true), false);
});

test('домен без push (облік): сирі точки «1 год» оновлює таймер, не потік', () => {
  const raw = { kind: 'raw', everyMs: 900_000 };       // T = 15 хв
  assert.equal(isStreamed('1h', raw, false), false);
  assert.equal(refreshMs('1h', raw, false), 300_000);  // стеля 5 хв
  const gh = { kind: 'raw', everyMs: 60_000 };
  assert.equal(refreshMs('1h', gh, false), 60_000);    // теплиця без потоку
});
