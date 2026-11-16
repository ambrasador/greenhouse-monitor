import test from 'node:test';
import assert from 'node:assert/strict';
import { contrast, luminance, deuteranopia, deltaE } from './color.js';

test('контраст чорного з білим дорівнює 21, однакових кольорів — 1', () => {
  assert.equal(contrast('#000000', '#FFFFFF').toFixed(2), '21.00');
  assert.equal(contrast('#2E7D32', '#2E7D32'), 1);
});

test('яскравість білого — 1, чорного — 0', () => {
  assert.equal(luminance('#FFFFFF'), 1);
  assert.equal(luminance('#000000'), 0);
});

test('контраст симетричний', () => {
  assert.equal(contrast('#C62828', '#FFFFFF'), contrast('#FFFFFF', '#C62828'));
});

test('сірі кольори дейтеранопія не змінює (зберігається нейтральність)', () => {
  for (const g of ['#808080', '#757575', '#FFFFFF', '#000000']) {
    const [r, gr, b] = [1, 3, 5].map((i) => parseInt(deuteranopia(g).slice(i, i + 2), 16));
    assert.ok(Math.abs(r - gr) <= 1 && Math.abs(gr - b) <= 1, `${g} → ${deuteranopia(g)}`);
  }
});

test('ΔE для однакових кольорів — 0, для чорного й білого — 100', () => {
  assert.equal(deltaE('#336699', '#336699'), 0);
  assert.ok(Math.abs(deltaE('#000000', '#FFFFFF') - 100) < 0.1);
});
