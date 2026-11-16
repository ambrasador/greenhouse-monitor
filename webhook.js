'use strict';
const { ApiError } = require('./problem');

// Вхідний webhook платформи: пакет подій приймається однією транзакцією
// allow(deviceId) — межа інтеграції: пише лише у свої пристрої
function createWebhook({
  ingest, maxEvents = 500, allow = () => true, audit,
}) {
  return (req, res) => {
    const events = req.body?.events;
    const size = Array.isArray(events) ? events.length : 0;
    if (size < 1 || size > maxEvents) {
      throw new ApiError(400, 'invalid-body',
        `events: масив від 1 до ${maxEvents} елементів`);
    }
    const mine = events.filter((e) => allow(e?.device_id));
    const outside = events.length - mine.length;
    if (outside) {
      audit?.record({ action: 'webhook.scope', outcome: 'rejected',
        ip: req.ip, detail: { events: outside } });
    }
    // зовнішній контракт — snake_case, внутрішня модель — camelCase
    const results = mine.length === 0 ? [] : ingest.batch(mine.map((e) => ({
      deviceId: e?.device_id, metric: e?.metric, value: e?.value, ts: e?.ts,
    })));
    const n = (what) => results.filter((r) => r === what).length;
    // відповідь 2xx — підтвердження: платформа не повторить пакет,
    // тож надсилаємо її лише тоді, коли все вже в базі
    const [stored, duplicate] = [n('stored'), n('duplicate')];
    const rejected = results.length - stored - duplicate + outside;
    res.json({ stored, duplicate, rejected });
  };
}

module.exports = { createWebhook };
