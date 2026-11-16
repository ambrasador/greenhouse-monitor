'use strict';
// Предметні правила теплиці: допустимі діапазони значень
const RANGE = new Map([
  ['temperature',   [-40, 85]],     // °C
  ['humidity',      [0, 100]],      // %
  ['soil_moisture', [0, 100]],      // %
  ['light',         [0, 200000]],   // лк
]);
const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function check(r, now) {
  if (typeof r.deviceId !== 'string' || !r.deviceId) return 'bad_device';
  const range = RANGE.get(r.metric);
  if (!range) return 'unknown_metric';
  if (typeof r.value !== 'number' || !Number.isFinite(r.value))
    return 'bad_value';
  if (r.value < range[0] || r.value > range[1]) return 'out_of_range';
  if (typeof r.ts !== 'string' || !TS_RE.test(r.ts)) return 'bad_ts';
  const t = Date.parse(r.ts);
  // Date.parse «виправляє» 30 лютого, 13-й місяць дає NaN: звіряємо рядок
  const iso = Number.isNaN(t) ? '' : new Date(t).toISOString();
  if (iso.slice(0, 19) !== r.ts.slice(0, 19)) return 'bad_ts';
  if (t > now + MAX_FUTURE_MS) return 'ts_in_future';
  if (t < now - MAX_AGE_MS) return 'ts_too_old';
  return null;
}

// onStored викликається для кожного нового вимірювання лише після COMMIT
function createIngest(db, clock = Date.now, onStored = () => {}) {
  const insTel = db.prepare(
    `INSERT INTO telemetry (device_id, metric, ts, received_at, value)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (device_id, metric, ts) DO NOTHING`);
  const upLatest = db.prepare(
    `INSERT INTO latest (device_id, metric, ts, value) VALUES (?, ?, ?, ?)
     ON CONFLICT (device_id, metric) DO UPDATE
       SET ts = excluded.ts, value = excluded.value
       WHERE excluded.ts > latest.ts`);
  const insRej = db.prepare(
    `INSERT INTO rejected (received_at, reason, raw) VALUES (?, ?, ?)`);

  const store = db.transaction((r, receivedAt) => {
    const { changes } = insTel.run(
      r.deviceId, r.metric, r.ts, receivedAt, r.value);
    if (changes === 0) return 'duplicate';
    upLatest.run(r.deviceId, r.metric, r.ts, r.value);
    return 'stored';
  });

  function reject(reason, raw) {
    const at = new Date(clock()).toISOString();
    insRej.run(at, reason, String(raw).slice(0, 512));
    return reason;
  }

  const pending = [];                  // записано, ще не опубліковано
  const flush = () => {
    for (const event of pending.splice(0)) onStored(event);
  };

  function accept(r) {
    const now = clock();
    const bad = check(r, now);
    if (bad) return reject(bad, JSON.stringify(r));
    const ts = new Date(r.ts).toISOString();   // завжди 3 знаки мс
    const res = store({ ...r, ts }, new Date(now).toISOString());
    if (res === 'stored') {
      pending.push({ device: r.deviceId, metric: r.metric, ts,
        value: r.value });
    }
    if (!db.inTransaction) flush();    // зовнішньої транзакції немає
    return res;
  }

  // Пакет в одній транзакції: події виходять лише після її COMMIT
  const run = db.transaction((items) => items.map(accept));
  function batch(items) {
    let results;
    try {
      results = run(items);
    } catch (e) {
      pending.length = 0;              // ROLLBACK: у базі цих подій немає
      throw e;
    }
    flush();
    return results;
  }
  return { accept, reject, batch };
}

module.exports = { createIngest };
