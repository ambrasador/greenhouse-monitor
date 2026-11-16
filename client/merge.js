// Злиття двох рядів { t, v }, відсортованих за t. Однаковий t — одна точка,
// новіший ряд b перемагає. Якщо b нічого не змінило, повертається той самий
// масив a: кеш і React.memo бачать «без змін» і не перемальовують
export function mergeSorted(a, b, max = Infinity) {
  const out = [];
  let [i, j, changed] = [0, 0, false];
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].t < b[j].t)) {
      out.push(a[i++]);
    } else if (i >= a.length || b[j].t < a[i].t) {
      out.push(b[j++]);
      changed = true;                          // нова точка
    } else {
      const same = a[i].v === b[j].v;
      out.push(same ? a[i] : b[j]);
      changed = changed || !same;
      i += 1;
      j += 1;
    }
  }
  if (!changed && out.length <= max) return a;
  return out.length > max ? out.slice(out.length - max) : out;
}

// Живі точки в історії «1 год»: { kind: 'raw', points, from, to }. Вікно
// ковзає: точки старші за windowMs від найновішої відкидаються, а межа
// from посувається разом із ними, тож графік не росте з часом. Якщо
// нічого не змінилося, повертається undefined, і кеш не оновлюється
export function applyLive(old, fresh, { windowMs, max = Infinity }) {
  if (old?.kind !== 'raw' || !fresh.length) return undefined;
  const merged = mergeSorted(old.points, fresh, max);
  if (merged === old.points) return undefined;
  const cut = merged[merged.length - 1].t - windowMs;
  const start = merged.findIndex((pt) => pt.t >= cut);
  const points = start > 0 ? merged.slice(start) : merged;
  return { ...old, points, from: Math.max(old.from, cut) };
}

// Ряди кількох метрик в один масив рядків для Recharts:
// { t, soil_moisture, temperature }
export function joinSeries(byKey) {
  const rows = new Map();
  for (const [key, pts] of Object.entries(byKey)) {
    for (const { t, v } of pts) {
      if (!rows.has(t)) rows.set(t, { t });
      rows.get(t)[key] = v;
    }
  }
  return [...rows.values()].sort((x, y) => x.t - y.t);
}
