import test from 'node:test';
import assert from 'node:assert/strict';
import { formatValue } from './format.js';

test('десяткова кома й нерозривний пробіл перед одиницею', () => {
  assert.equal(formatValue(27.4, '%'), '27,4 %');
  assert.equal(formatValue(27, '°C', 1), '27,0 °C');
});

test('тисячі розділено нерозривним пробілом, без одиниці — лише число', () => {
  const s = formatValue(9000, 'лк', 0);
  assert.match(s, /^9[\u00a0\u202f ]000\u00a0лк$/);
  assert.equal(formatValue(0.5, '', 2), '0,50');
});
