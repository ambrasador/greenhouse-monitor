// Осі графіка. Позначки ставимо на «круглі» значення: час — кратний кроку
// в локальному часі користувача, значення — кратні 1, 2, 2,5 чи 5 за
// порядком величини
const MIN = 60_000;
const STEPS_MIN = [10, 30, 60, 120, 240, 360, 720, 1440];  // хвилин

export function timeTicks(from, to, maxTicks = 8) {
  const stepMin = STEPS_MIN.find(
    (s) => (to - from) / (s * MIN) <= maxTicks) ?? 1440;
  const ticks = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (let d = day; d.getTime() <= to; d.setDate(d.getDate() + 1)) {
    for (let m = 0; m < 1440; m += stepMin) {
      // Date рахує за локальним календарем: перехід на літній час
      // не зсуває позначки
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, m)
        .getTime();
      if (t >= from && t <= to) ticks.push(t);
    }
  }
  return { ticks, stepMin };
}

export function formatTick(t, stepMin) {
  const d = new Date(t);
  return stepMin >= 1440
    ? d.toLocaleDateString('uk-UA',
      { weekday: 'short', day: '2-digit', month: '2-digit' })
    : d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

// Межі й позначки осі значень: охоплюють дані й пороги із запасом 5 %
export function valueScale(rows, rule, count = 5) {
  let [lo, hi] = [Infinity, -Infinity];
  for (const r of rows) {
    if (r.v === null) continue;                // розрив: значення немає
    lo = Math.min(lo, r.lo ?? r.v);
    hi = Math.max(hi, r.hi ?? r.v);
  }
  if (!Number.isFinite(lo)) {
    return { domain: ['auto', 'auto'], ticks: undefined };
  }
  if (rule) {
    lo = Math.min(lo, rule.warn, rule.crit);
    hi = Math.max(hi, rule.warn, rule.crit);
  }
  const span = hi - lo || Math.max(1, Math.abs(hi) * 0.1);
  [lo, hi] = [lo - span * 0.05, hi + span * 0.05];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let k = 0; min + k * step <= max + step / 1e6; k++) {
    ticks.push(Number((min + k * step).toFixed(10)));
  }
  return { domain: [min, max], ticks };
}
