import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceQuery, combineDevices } from './queries.js';

test('deviceQuery: ключ, свіжість, опитування й повернення до вкладки', () => {
  const q = deviceQuery('http://x', 'gh1-s01');
  assert.deepEqual(q.queryKey, ['device', 'gh1-s01']);
  assert.equal(q.staleTime, 15_000);
  assert.equal(q.refetchInterval, 30_000);
  assert.equal(q.refetchOnWindowFocus, true);
});

test('deviceQuery: опитування T/2, свіжість T/4 — для парку 2,5 с і 1,25 с', () => {
  const q = deviceQuery('http://x', 'bus-07', 5);
  assert.equal(q.refetchInterval, 2_500);
  assert.equal(q.staleTime, 1_250);
});

test('deviceQuery: запит іде за адресою пристрою, помилка HTTP — виняток', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return { ok: false, status: 503, json: async () => ({}) }; };
  await assert.rejects(deviceQuery('http://x', 'a').queryFn({}), /HTTP 503/);
  assert.deepEqual(urls, ['http://x/api/v1/devices/a']);
  delete globalThis.fetch;
});

test('combineDevices: відповіді без даних (ще вантажаться) пропускаються', () => {
  const a = { id: 'a' };
  const out = combineDevices([{ data: a }, { data: undefined }, { data: { id: 'c' } }]);
  assert.deepEqual(out.map((d) => d.id), ['a', 'c']);
  assert.equal(out[0], a);
});
