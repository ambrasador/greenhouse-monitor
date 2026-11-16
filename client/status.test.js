import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStatus, summarize, staleAfterMs } from './status.js';
import { GREENHOUSE } from './domain.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const at = (sec, value) => ({ ts: new Date(NOW - sec * 1000).toISOString(), value });
const soil = GREENHOUSE.metrics.soil_moisture;
const temp = GREENHOUSE.metrics.temperature;
const level = (r, m) => evaluateStatus(r, m.rule, { now: NOW, periodSec: m.periodSec });

test('вологість ґрунту: межі 35 і 30 належать вищому рівню серйозності з протилежного боку', () => {
  assert.equal(level(at(0, 35), soil), 'ok');          // рівно 35 — ще норма
  assert.equal(level(at(0, 34.9), soil), 'warning');
  assert.equal(level(at(0, 30), soil), 'warning');     // рівно 30 — ще попередження
  assert.equal(level(at(0, 29.9), soil), 'critical');
});

test('температура: межі 32 і 35, напрямок above', () => {
  assert.equal(level(at(0, 32), temp), 'ok');
  assert.equal(level(at(0, 32.1), temp), 'warning');
  assert.equal(level(at(0, 35), temp), 'warning');
  assert.equal(level(at(0, 35.1), temp), 'critical');
});

test('застарілі дані: межа — 3 періоди звітування (180 с)', () => {
  assert.equal(staleAfterMs(60), 180_000);
  assert.equal(level(at(180, 41), soil), 'ok');        // рівно 180 с — ще дійсні
  assert.equal(level(at(181, 41), soil), 'offline');
  assert.equal(level(at(181, 10), soil), 'offline');   // застаріле «критично» не показують як критичне
});

test('немає вимірювання, NaN або некоректний ts → offline', () => {
  assert.equal(level(null, soil), 'offline');
  assert.equal(level(undefined, soil), 'offline');
  assert.equal(level({ ts: at(0, 1).ts, value: NaN }, soil), 'offline');
  assert.equal(level({ ts: 'вчора', value: 40 }, soil), 'offline');
});

test('метрика без правил (rule: null) завжди ok, якщо дані свіжі', () => {
  assert.equal(level(at(10, 55), { rule: null, periodSec: 60 }), 'ok');
  assert.equal(level(at(500, 55), { rule: null, periodSec: 60 }), 'offline');
});

test('значення з майбутнього (годинник пристрою спішить) не дає від’ємного віку-застарілості', () => {
  assert.equal(level(at(-120, 40), soil), 'ok');       // ts на 2 хв попереду годинника клієнта
});

test('summarize рахує картки за рівнями', () => {
  assert.deepEqual(summarize(['ok', 'ok', 'warning', 'offline', 'critical', 'ok']),
    { ok: 3, warning: 1, critical: 1, offline: 1 });
});
