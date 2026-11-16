'use strict';
const { createHmac } = require('node:crypto');

const R_KM = 6371.0088;                                // середній радіус Землі, км
const KM_PER_DEG = (R_KM * Math.PI) / 180;             // ≈ 111,195 км на градус дуги меридіана

// Мінімізація: координату зберігаємо з точністю до комірки сітки, а не до метра.
// Повертається центр комірки, тож похибка симетрична й не перевищує половини комірки
function coarsen(lat, lon, cellDeg = 0.01) {
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) throw new RangeError('координати поза межами');
  const snap = (x, max) => Math.max(-max, Math.min(max,        // центр комірки на краю карти лишається в межах
    Number(((Math.floor(x / cellDeg) + 0.5) * cellDeg).toFixed(6))));
  return { lat: snap(lat, 90), lon: snap(lon, 180) };
}

// Розмір комірки в кілометрах: меридіан не залежить від широти, паралель коротшає як cos(φ)
function cellKm(lat, cellDeg = 0.01) {
  return { northSouth: cellDeg * KM_PER_DEG,
    eastWest: cellDeg * KM_PER_DEG * Math.cos((lat * Math.PI) / 180) };
}

// Псевдонім для журналів і аналітики: HMAC з ключем, який не лежить поруч із даними.
// Звичайний SHA-256 ідентифікатора з малого простору (6 цифр, номер лічильника) перебирається
function pseudonym(secret, value, bytes = 12) {
  return createHmac('sha256', secret).update(String(value)).digest().subarray(0, bytes).toString('hex');
}

// Строк зберігання як код: видалення пакетами, щоб синхронний SQLite не зупиняв процес
// на секунди. Між пакетами подійний цикл вільний (setImmediate)
const DAY = 86_400_000;
const DEFAULT_DAYS = { audit_log: 365, rejected: 30, push_tokens: 60, telemetry: 365 };

function createRetention({ db, clock = Date.now, days = DEFAULT_DAYS, batch = 5000 }) {
  const rules = {
    audit_log: db.prepare(`DELETE FROM audit_log WHERE id IN
      (SELECT id FROM audit_log WHERE ts < @cut ORDER BY id LIMIT @batch)`),
    rejected: db.prepare(`DELETE FROM rejected WHERE id IN
      (SELECT id FROM rejected WHERE received_at < @cut ORDER BY id LIMIT @batch)`),
    push_tokens: db.prepare(`DELETE FROM push_tokens WHERE token IN
      (SELECT token FROM push_tokens WHERE refreshed_at < @cut LIMIT @batch)`),
  };
  // Вимірювання: ключ (device_id, metric, ts), тож відсікання йде для кожної пари окремо
  const pairs = db.prepare('SELECT device_id, metric FROM latest');
  const telemetry = db.prepare(`DELETE FROM telemetry WHERE (device_id, metric, ts) IN
    (SELECT device_id, metric, ts FROM telemetry
      WHERE device_id = @device AND metric = @metric AND ts < @cut ORDER BY ts LIMIT @batch)`);
  const cutoff = (name) => new Date(clock() - days[name] * DAY).toISOString();
  const later = () => new Promise((r) => setImmediate(r));

  async function drain(stmt, args) {
    let total = 0;
    for (let n = batch; n === batch; await later()) {
      n = stmt.run({ ...args, batch }).changes;
      total += n;
    }
    return total;
  }
  return {
    async run() {
      const out = {};
      for (const name of Object.keys(rules)) out[name] = await drain(rules[name], { cut: cutoff(name) });
      out.telemetry = 0;
      for (const { device_id: device, metric } of pairs.all()) {
        out.telemetry += await drain(telemetry, { device, metric, cut: cutoff('telemetry') });
      }
      return out;
    },
  };
}

module.exports = { coarsen, cellKm, pseudonym, createRetention, KM_PER_DEG, DEFAULT_DAYS };
