import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'Europe/Kyiv';                // позначки часу залежать від часової зони
const { timeTicks, formatTick, valueScale } = await import('./axes.js');

const at = (iso) => Date.parse(iso);

test('година: позначки кожні 10 хв, кратні 10 за локальним часом', () => {
  const { ticks, stepMin } = timeTicks(at('2026-11-04T10:07:00Z'), at('2026-11-04T11:07:00Z'));
  assert.equal(stepMin, 10);
  assert.ok(ticks.length >= 5 && ticks.length <= 7);
  for (const t of ticks) assert.equal(new Date(t).getMinutes() % 10, 0);
});

test('доба: крок 4 год; тиждень: крок 1 доба, позначки — локальна північ', () => {
  assert.equal(timeTicks(at('2026-11-03T10:00:00Z'), at('2026-11-04T10:00:00Z')).stepMin, 240);
  const { ticks, stepMin } = timeTicks(at('2026-10-28T10:00:00Z'), at('2026-11-04T10:00:00Z'));
  assert.equal(stepMin, 1440);
  assert.equal(ticks.length, 7);
  for (const t of ticks) assert.equal(new Date(t).getHours(), 0);
});

test('перехід на зимовий час 25.10.2026: позначки лишаються опівночі за Києвом', () => {
  const { ticks } = timeTicks(at('2026-10-21T12:00:00Z'), at('2026-10-28T12:00:00Z'));
  for (const t of ticks) assert.equal(new Date(t).getHours(), 0);
  const gaps = ticks.slice(1).map((t, i) => (t - ticks[i]) / 3_600_000);
  assert.ok(gaps.includes(25), `проміжки, год: ${gaps}`);   // доба переходу триває 25 годин
});

test('формат позначок: час для кроку < доби, день тижня й дата для доби', () => {
  assert.match(formatTick(at('2026-11-04T10:00:00Z'), 60), /^\d{2}:\d{2}$/);
  assert.match(formatTick(at('2026-11-04T10:00:00Z'), 1440), /04\.11/);
});

test('valueScale: «круглі» межі, що охоплюють дані й обидва пороги', () => {
  const rows = [{ t: 0, v: 33.7, lo: 33.1, hi: 34.2 }, { t: 1, v: 41.5, lo: 41, hi: 42 }];
  const { domain, ticks } = valueScale(rows, { warn: 35, crit: 30 });
  assert.ok(domain[0] <= 30 && domain[1] >= 42);
  assert.ok(ticks.every((v) => Math.abs(v / 2.5 - Math.round(v / 2.5)) < 1e-9 || Number.isInteger(v)));
  assert.equal(ticks[0], domain[0]);
  assert.equal(ticks.at(-1), domain[1]);
});

test('valueScale: стала серія без порогів не дає нульового діапазону', () => {
  const { domain } = valueScale([{ t: 0, v: 5 }, { t: 1, v: 5 }], null);
  assert.ok(domain[1] > domain[0]);
  assert.deepEqual(valueScale([], null).domain, ['auto', 'auto']);
});

test('valueScale: розриви (v: null) не вважаються нулем', () => {
  const rows = [{ t: 0, v: 21, lo: 20, hi: 22 }, { t: 1, v: null, lo: null, hi: null, band: null },
    { t: 2, v: 23, lo: 22, hi: 24 }];
  const { domain } = valueScale(rows, null);
  assert.ok(domain[0] >= 15, `нижня межа ${domain[0]} не має тягнутися до нуля`);
});
