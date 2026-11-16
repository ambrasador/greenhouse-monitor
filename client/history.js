// Читання історії з REST API (розділ 2): сирі точки сторінками за курсором
// або інтервали avg/min/max. Результат — масиви { t, v } і, для інтервалів,
// { t, v, lo, hi }
import { INTERVALS, pickInterval } from './intervals.js';
import { lttb } from './downsample.js';
import { staleAfterMs } from './status.js';
import { HttpError } from './http.js';

export const RANGES = {
  '1h': { ms: 3_600_000, label: '1 год' },
  '24h': { ms: 86_400_000, label: '24 год' },
  '7d': { ms: 604_800_000, label: '7 днів' },
};
export const BUDGET = 500;          // точок на серію ≈ ширина графіка
const REFRESH = { min: 60_000, max: 300_000 };   // межі таймера оновлення

const intervalMs = (name) => INTERVALS.find(([n]) => n === name)[1];

export async function fetchHistory({ base = '', device, metric, range,
  periodSec, now = Date.now(), signal, fetchFn = (...a) => fetch(...a) }) {
  const ms = RANGES[range].ms;
  const interval = pickInterval(ms, periodSec * 1000, BUDGET);
  // Початок вікна вирівнюємо за інтервалом: перший інтервал має бути повним
  const step = interval ? intervalMs(interval) : 1;
  const from = Math.floor((now - ms) / step) * step;
  const q = new URLSearchParams({ device, metric,
    from: new Date(from).toISOString(), to: new Date(now).toISOString() });

  const get = async (params) => {
    const url = `${base}/api/v1/telemetry?${params}`;
    const res = await fetchFn(url, { signal });
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  };

  if (interval) {
    q.set('agg', 'avg,min,max');
    q.set('interval', interval);
    q.set('fill', 'null');          // порожній інтервал — розрив лінії
    const { data } = await get(q);
    const rows = data.map((b) => ({ t: Date.parse(b.start), n: b.count,
      v: b.avg, lo: b.min, hi: b.max }));
    return { kind: 'buckets', interval, everyMs: step, rows,
      from, to: now };
  }
  q.set('limit', '1000');
  const points = [];
  for (let cursor = null, first = true; first || cursor; first = false) {
    if (cursor) q.set('cursor', cursor);
    const page = await get(q);
    for (const p of page.data) {
      points.push({ t: Date.parse(p.ts), v: p.value });
    }
    cursor = page.next;
  }
  return { kind: 'raw', points, everyMs: periodSec * 1000, from, to: now,
    gapMs: staleAfterMs(periodSec) };
}

// Потік доповнює лише сирі точки «1 год» у доменах із push. Інтервали (у
// парку 720 точок за годину не вміщуються в бюджет) потік не оновлює:
// їх перечитує таймер
export const isStreamed = (range, data, push = false) =>
  push && range === '1h' && data?.kind === 'raw';

// Інтервал таймера (refetchInterval): не частіше за хвилину, не рідше за
// 5 хв і не чутливіше за крок даних — ширину інтервалу чи період звітування
export function refreshMs(range, data, push = false) {
  if (isStreamed(range, data, push)) return false;
  if (!data) return REFRESH.max;           // даних ще немає або запит упав
  return Math.min(REFRESH.max, Math.max(REFRESH.min, data.everyMs));
}

// Ряд, розрізаний там, де між сусідніми точками більше gapMs
export function splitAtGaps(points, gapMs = Infinity) {
  const parts = [];
  let from = 0;
  for (let i = 1; i <= points.length; i++) {
    if (i === points.length || points[i].t - points[i - 1].t > gapMs) {
      parts.push(points.slice(from, i));
      from = i;
    }
  }
  return parts;
}

// Те, що потрапляє в графік. Інтервали — як є, порожні дають розрив.
// Сирі точки: кожен відрізок без розривів проріджується окремо, між
// відрізками стоїть порожній рядок gap, і лінія в цьому місці перервана
export function chartRows(result, budget = BUDGET) {
  if (!result) return [];
  if (result.kind === 'buckets') {
    return result.rows.map((r) => (
      { ...r, band: r.v === null ? null : [r.lo, r.hi] }));
  }
  const parts = splitAtGaps(result.points, result.gapMs);
  const rows = [];
  parts.forEach((part, k) => {
    if (k) rows.push({ t: (parts[k - 1].at(-1).t + part[0].t) / 2,
      v: null, gap: true });
    const share = Math.round((budget * part.length) / result.points.length);
    rows.push(...lttb(part, Math.max(3, share)));
  });
  return rows;
}
