// Статус картки: чотири рівні. «Немає даних» — окремий рівень, а не
// відсутність значення
export const STATUS = {
  ok: { label: 'Норма', icon: '✓' },
  warning: { label: 'Попередження', icon: '!' },
  critical: { label: 'Критично', icon: '✕' },
  offline: { label: 'Немає даних', icon: '?' },
};

export const STALE_PERIODS = 3;     // старші за 3 періоди — застарілі
export const staleAfterMs = (periodSec) => STALE_PERIODS * periodSec * 1000;

// reading = { ts: ISO-рядок, value };
// rule = { direction: 'below' | 'above', warn, crit } або null
export function evaluateStatus(reading, rule,
  { now = Date.now(), periodSec }) {
  if (!reading || !Number.isFinite(reading.value)) return 'offline';
  const age = now - Date.parse(reading.ts);
  if (Number.isNaN(age) || age > staleAfterMs(periodSec)) return 'offline';
  if (!rule) return 'ok';
  const beyond = (limit) => (rule.direction === 'below'
    ? reading.value < limit : reading.value > limit);
  if (beyond(rule.crit)) return 'critical';
  if (beyond(rule.warn)) return 'warning';
  return 'ok';
}

// Лічильники для зведеного рядка: { ok, warning, critical, offline }
export function summarize(levels) {
  const out = { ok: 0, warning: 0, critical: 0, offline: 0 };
  for (const l of levels) out[l] += 1;
  return out;
}
