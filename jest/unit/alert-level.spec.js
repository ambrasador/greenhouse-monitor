'use strict';
const { nextLevel, RULES } = require('../../push');
const { findViolations } = require('../../alerts');

// Вологість ґрунту: попередження нижче 35 %, критично нижче 30 %,
// гістерезис 2 п. п.
const moisture = RULES.get('soil_moisture');

describe('nextLevel: рівень тривоги з гістерезисом', () => {
  test.each([
    // поточний рівень, нове значення, очікуваний рівень
    ['normal',   35.0, 'normal'],     // межа: лише строго нижче порога
    ['normal',   34.9, 'warning'],
    ['normal',   30.0, 'warning'],
    ['normal',   29.9, 'critical'],
    ['critical', 31.9, 'critical'],   // гістерезис: 30 + 2 не досягнуто
    ['critical', 32.0, 'warning'],    // з critical вийшли, з warning — ні
    ['critical', 36.0, 'warning'],    // у гістерезисі warning: 35 + 2
    ['warning',  36.9, 'warning'],
    ['warning',  37.0, 'normal'],     // 35 + 2
  ])('з рівня %s значення %f дає %s', (current, value, expected) => {
    expect(nextLevel(current, value, moisture)).toBe(expected);
  });
});

describe('findViolations: епізод порушення в ряді', () => {
  const rule = { op: 'lt', threshold: 35, hysteresis: 2, minDurationMs: 120_000, maxGapMs: 180_000 };
  const row = (minute, value) => ({ ms: minute * 60_000, value });

  test('епізод коротший за 2 хв не повідомляється', () => {
    expect(findViolations([row(0, 40), row(1, 34), row(2, 40)], rule)).toEqual([]);
  });

  test('значення 36 не закриває епізод, 37 закриває', () => {
    const rows = [row(0, 34), row(1, 36), row(2, 33), row(3, 37)];
    expect(findViolations(rows, rule)).toMatchObject([
      { startMs: 0, endMs: 180_000, extreme: 33, samples: 3, endedBy: 'recovered' }]);
  });

  test('розрив даних понад 3 хв закриває епізод', () => {
    const rows = [row(0, 34), row(1, 34), row(2, 34), row(10, 34)];
    expect(findViolations(rows, rule)).toMatchObject([{ endMs: 120_000, endedBy: 'gap' }]);
  });

  test('розрив рівно в 3 хв ще не закриває епізод', () => {
    const rows = [row(0, 34), row(1, 34), row(2, 34), row(5, 34)];
    expect(findViolations(rows, rule)).toMatchObject([{ endMs: 300_000, samples: 4, endedBy: 'window_end' }]);
  });
});
