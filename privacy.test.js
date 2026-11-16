'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { coarsen, cellKm, pseudonym, createRetention, KM_PER_DEG } = require('./privacy');
const { makeSecure, NOW } = require('./auth-kit');
const { seed } = require('./testkit');

test('координата зводиться до центру комірки 0,01°', () => {
  assert.deepEqual(coarsen(46.6354, 32.6169), { lat: 46.635, lon: 32.615 });
  assert.deepEqual(coarsen(-33.8688, 151.2093), { lat: -33.865, lon: 151.205 }, 'від’ємні значення — floor, не trunc');
  assert.deepEqual(coarsen(46.635, 32.615), coarsen(46.6399, 32.6199), 'уся комірка дає одну точку');
  assert.deepEqual(coarsen(90, 180), { lat: 90, lon: 180 }, 'на краю карти центр комірки обрізається до межі');
});

test('похибка не перевищує половини комірки, а комірки різних точок збігаються лише всередині неї', () => {
  for (let i = 0; i < 2000; i++) {
    const lat = -90 + Math.random() * 180;
    const lon = -180 + Math.random() * 360;
    const c = coarsen(lat, lon, 0.01);
    assert.ok(Math.abs(c.lat - lat) <= 0.005 + 1e-9 && Math.abs(c.lon - lon) <= 0.005 + 1e-9);
  }
});

test('межі координат і розмір комірки на широті Херсона', () => {
  assert.throws(() => coarsen(91, 0), RangeError);
  assert.throws(() => coarsen(0, Number.NaN), RangeError);
  assert.ok(Math.abs(KM_PER_DEG - 111.195) < 0.001);
  const k = cellKm(46.6354, 0.01);
  assert.ok(Math.abs(k.northSouth - 1.112) < 0.001, String(k.northSouth));
  assert.ok(Math.abs(k.eastWest - 0.764) < 0.002, String(k.eastWest));
  assert.ok(cellKm(0, 0.01).eastWest > cellKm(60, 0.01).eastWest, 'до полюса паралель коротшає');
});

test('псевдонім: стабільний для ключа, різний для різних ключів і значень', () => {
  const a = pseudonym('key-A', 'meter-004217');
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.equal(a, pseudonym('key-A', 'meter-004217'));
  assert.notEqual(a, pseudonym('key-B', 'meter-004217'));
  assert.notEqual(a, pseudonym('key-A', 'meter-004218'));
  const plain = createHash('sha256').update('004217').digest('hex').slice(0, 24);
  assert.notEqual(pseudonym('key-A', '004217'), plain);
});

test('строк зберігання: старе йде пакетами, нове лишається, подійний цикл вільний між пакетами', async () => {
  const s = await makeSecure();
  const old = NOW - 400 * 86_400_000;
  seed(s.db, { device: 'gh1-s01', start: old, count: 25, values: () => 1 });       // 25 старих вимірювань
  seed(s.db, { device: 'gh1-s01', start: NOW - 60_000, count: 3, values: () => 2 });
  s.db.prepare("INSERT INTO rejected (received_at, reason, raw) VALUES (?, 'x', '{}')").run(new Date(old).toISOString());
  s.db.prepare("INSERT INTO rejected (received_at, reason, raw) VALUES (?, 'x', '{}')").run(new Date(NOW).toISOString());
  s.audit.record({ action: 'fresh' });
  s.db.prepare("INSERT INTO audit_log (ts, action, outcome) VALUES (?, 'ancient', 'ok')").run(new Date(old).toISOString());
  s.db.prepare("INSERT INTO push_tokens (token, kind, user_id, platform, created_at, refreshed_at) VALUES ('t-old','token','u','android',?,?)")
    .run(new Date(old).toISOString(), new Date(old).toISOString());
  let spins = 0;
  let stop = false;
  (function spin() { if (!stop) { spins++; setImmediate(spin); } })();      // «інші» обробники подійного циклу
  const out = await createRetention({ db: s.db, clock: s.clock, batch: 10 }).run();
  stop = true;
  assert.equal(out.telemetry, 25);
  assert.deepEqual([out.rejected, out.push_tokens], [1, 1]);
  assert.ok(out.audit_log >= 1);
  assert.equal(s.db.prepare("SELECT count(*) n FROM telemetry WHERE device_id = 'gh1-s01' AND ts < ?").get(new Date(NOW - 86_400_000).toISOString()).n, 0);
  assert.ok(s.db.prepare("SELECT count(*) n FROM telemetry WHERE device_id = 'gh1-s01'").get().n >= 3);
  assert.equal(s.db.prepare('SELECT count(*) n FROM rejected').get().n, 1);
  assert.ok(s.audit.list().some((e) => e.action === 'fresh'));
  assert.ok(spins >= 5, `між пакетами цикл мав працювати: ${spins}`);
});
