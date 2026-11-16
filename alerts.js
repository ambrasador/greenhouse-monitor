'use strict';

// Періоди порушення порога у впорядкованому потоці рядків { ms, value }.
// Період закривається поверненням значення за поріг із гістерезисом
// або розривом даних
function findViolations(rows, rule) {
  const { op, threshold, hysteresis = 0 } = rule;
  const { minDurationMs = 0, maxGapMs = Infinity } = rule;
  const lt = op === 'lt';
  const bad = (v) => (lt ? v < threshold : v > threshold);
  const clear = (v) =>
    (lt ? v >= threshold + hysteresis : v <= threshold - hysteresis);
  const worst = lt ? Math.min : Math.max;
  const out = [];
  let cur = null, prev = null;

  const close = (endMs, endedBy, open = false) => {
    cur.endMs = endMs;
    cur.durationMs = endMs - cur.startMs;
    Object.assign(cur, { endedBy, open });
    if (cur.durationMs >= minDurationMs) out.push(cur);
    cur = null;
  };

  for (const { ms, value } of rows) {
    if (cur && ms - prev > maxGapMs) close(prev, 'gap');  // дані зникли
    if (!cur) {
      if (bad(value)) cur = { startMs: ms, extreme: value, samples: 1 };
    } else if (clear(value)) {
      close(ms, 'recovered');
    } else {
      cur.samples += 1;
      cur.extreme = worst(cur.extreme, value);
    }
    prev = ms;
  }
  // період ще триває в кінці вікна
  if (cur) close(prev, 'window_end', true);
  return out;
}

function createAlertReader(db) {
  const stmt = db.prepare(
    `SELECT ts, value FROM telemetry
      WHERE device_id = ? AND metric = ? AND ts >= ? AND ts < ? ORDER BY ts`);
  const iso = (ms) => new Date(ms).toISOString();
  return function readAlerts({ device, metric, from, to }, rule) {
    const rows = (function* () {
      for (const r of stmt.iterate(device, metric, iso(from), iso(to))) {
        yield { ms: Date.parse(r.ts), value: r.value };
      }
    })();
    return findViolations(rows, rule).map((p) => ({
      start: iso(p.startMs),
      end: iso(p.endMs),
      duration_sec: p.durationMs / 1000,
      extreme: p.extreme,
      samples: p.samples,
      ended_by: p.endedBy,
      open: p.open,
    }));
  };
}

module.exports = { findViolations, createAlertReader };
