'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, addDevice } = require('./testkit');
const { createSettings, validateSettings } = require('./settings');

test('запис за версією: другий із двох записів над однією версією програє', () => {
  const db = makeDb();
  addDevice(db, 'gh1-s01');
  const s = createSettings(db);
  assert.deepEqual(s.get('gh1-s01'), { body: {}, version: 0 });
  assert.deepEqual(s.put('gh1-s01', 0, { soil_moisture_min: 30 }), { body: { soil_moisture_min: 30 }, version: 1 });
  assert.equal(s.put('gh1-s01', 0, { soil_moisture_min: 40 }), null, 'версія 0 уже застаріла');
  assert.equal(s.put('gh1-s01', 1, { soil_moisture_min: 40 }).version, 2);
  assert.equal(s.put('gh1-s01', 1, { soil_moisture_min: 50 }), null);
});

test('перевірка налаштувань: невідомі ключі, межі й тип значення', () => {
  assert.deepEqual(validateSettings({ soil_moisture_min: 35, temperature_min: 18.5 }), []);
  assert.deepEqual(validateSettings({ soil_moisture_min: 35.5 }).map((e) => e.param), ['soil_moisture_min']);
  assert.deepEqual(validateSettings({ x: 1 }), [{ param: 'x', message: 'невідоме налаштування' }]);
  assert.equal(validateSettings([1]).length, 1);
});
