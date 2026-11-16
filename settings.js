'use strict';

// Допустимі налаштування пристрою й межі їхніх значень (навчальний набір для теплиці)
const RULES = {
  soil_moisture_min: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  temperature_min: (v) => Number.isFinite(v) && v >= 0 && v <= 40,
};

function validateSettings(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return [{ param: 'body', message: 'очікується JSON-об’єкт' }];
  }
  return Object.entries(body).flatMap(([k, v]) => {
    if (!(k in RULES)) return [{ param: k, message: 'невідоме налаштування' }];
    return RULES[k](v) ? [] : [{ param: k, message: 'значення поза допустимими межами' }];
  });
}

function createSettings(db, clock = Date.now) {
  const read = db.prepare('SELECT body, version FROM device_settings WHERE device_id = ?');
  const insert = db.prepare(
    `INSERT INTO device_settings (device_id, body, version, updated_at) VALUES (@id, @body, 1, @now)
     ON CONFLICT (device_id) DO NOTHING`);
  const update = db.prepare(
    `UPDATE device_settings SET body = @body, version = version + 1, updated_at = @now
      WHERE device_id = @id AND version = @version`);

  // Пристрій без збережених налаштувань має версію 0
  function get(id) {
    const r = read.get(id);
    return r ? { body: JSON.parse(r.body), version: r.version } : { body: {}, version: 0 };
  }
  // Порівняння версії й запис — один оператор: другий із двох одночасних записів дістає null
  function put(id, version, body) {
    const args = { id, body: JSON.stringify(body), now: new Date(clock()).toISOString() };
    const changes = version === 0 ? insert.run(args).changes : update.run({ ...args, version }).changes;
    return changes === 1 ? get(id) : null;
  }
  return { get, put };
}

module.exports = { createSettings, validateSettings };
