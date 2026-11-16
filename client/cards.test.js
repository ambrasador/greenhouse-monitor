import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCards } from './cards.js';
import { GREENHOUSE } from './domain.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const dev = (id, name, soil, temp) => ({ id, name, latest: [
  ...(soil ? [{ metric: 'soil_moisture', ts: soil[0], value: soil[1] }] : []),
  ...(temp ? [{ metric: 'temperature', ts: temp[0], value: temp[1] }] : [])] });

test('картка на кожну пару «пристрій × метрика з config.cards», порядок фіксований', () => {
  const cards = buildCards([dev('a', 'Грядка А', [ago(10), 41], [ago(10), 27]),
    dev('b', 'Грядка Б', [ago(10), 33], [ago(10), 36])], GREENHOUSE, NOW);
  assert.deepEqual(cards.map((c) => c.key),
    ['a/soil_moisture', 'a/temperature', 'b/soil_moisture', 'b/temperature']);
  assert.deepEqual(cards.map((c) => c.level), ['ok', 'ok', 'warning', 'critical']);
});

test('текст значення — з десятковою комою; для offline — тире', () => {
  const [soil, temp] = buildCards([dev('a', 'Грядка А', [ago(10), 41.25], [ago(900), 27])], GREENHOUSE, NOW);
  assert.equal(soil.text, '41,3 %');            // 41,25 → округлення до десятих
  assert.equal(temp.level, 'offline');
  assert.equal(temp.text, '—');
  assert.equal(temp.updatedAt, ago(900));            // час останнього вимірювання лишається видимим
});

test('метрики, якої пристрій ще не надсилав, відповідає offline без updatedAt', () => {
  const [soil] = buildCards([dev('a', 'Грядка А', null, null)], GREENHOUSE, NOW);
  assert.equal(soil.level, 'offline');
  assert.equal(soil.updatedAt, null);
});
