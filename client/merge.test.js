import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSorted, joinSeries, applyLive } from './merge.js';

const p = (t, v = t) => ({ t, v });

test('mergeSorted: відсортований результат без дублів', () => {
  const out = mergeSorted([p(1), p(3), p(5)], [p(2), p(3), p(6)]);
  assert.deepEqual(out.map((x) => x.t), [1, 2, 3, 5, 6]);
});

test('mergeSorted: повтор уже наявних точок повертає той самий масив', () => {
  const a = [p(1), p(2), p(3)];
  assert.equal(mergeSorted(a, [p(2), p(3)]), a);
  assert.equal(mergeSorted(a, []), a);
});

test('mergeSorted: однаковий t з іншим значенням — перемагає новіший ряд', () => {
  const out = mergeSorted([p(1, 10), p(2, 20)], [p(2, 21)]);
  assert.deepEqual(out, [p(1, 10), p(2, 21)]);
});

test('mergeSorted: порядок надходження пакетів не впливає на результат', () => {
  const all = [p(1), p(2), p(3), p(4), p(5)];
  const a = mergeSorted(mergeSorted([], [p(2), p(5)]), [p(1), p(3), p(4)]);
  const b = mergeSorted(mergeSorted([], [p(1), p(3), p(4)]), [p(2), p(5)]);
  assert.deepEqual(a, all);
  assert.deepEqual(b, all);
});

test('mergeSorted: ліміт залишає найновіші точки', () => {
  const out = mergeSorted([p(1), p(2), p(3)], [p(4), p(5)], 3);
  assert.deepEqual(out.map((x) => x.t), [3, 4, 5]);
});

test('joinSeries: рядки за спільним t, прогалини лишаються порожніми', () => {
  const rows = joinSeries({ a: [p(1, 10), p(3, 30)], b: [p(2, 20), p(3, 31)] });
  assert.deepEqual(rows, [{ t: 1, a: 10 }, { t: 2, b: 20 }, { t: 3, a: 30, b: 31 }]);
});

const raw = (...ts) => ({ kind: 'raw', points: ts.map((t) => p(t)), from: 0, to: 100 });

test('applyLive: нова точка додається; доки вікно не заповнене, from не рухається', () => {
  const out = applyLive(raw(10, 20), [p(30)], { windowMs: 100 });
  assert.deepEqual(out.points.map((x) => x.t), [10, 20, 30]);
  assert.equal(out.from, 0);
});

test('applyLive: вікно ковзає — старі точки відкидаються, from посувається', () => {
  const out = applyLive(raw(10, 60, 100), [p(150)], { windowMs: 100 });
  assert.deepEqual(out.points.map((x) => x.t), [60, 100, 150]);
  assert.equal(out.from, 50);
});

test('applyLive: нічого нового — undefined, кеш не оновлюється', () => {
  assert.equal(applyLive(raw(10, 20), [p(20)], { windowMs: 100 }), undefined);
  assert.equal(applyLive(raw(10, 20), [], { windowMs: 100 }), undefined);
});

test('applyLive: історії ще немає або вона в інтервалах — undefined', () => {
  assert.equal(applyLive(undefined, [p(1)], { windowMs: 100 }), undefined);
  assert.equal(applyLive({ kind: 'buckets', rows: [] }, [p(1)], { windowMs: 100 }), undefined);
});
