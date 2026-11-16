// Ряд значень одного потоку: відсортований за ts, без дублів, обмежений
// вікном. add() ідемпотентний і не залежить від порядку надходження
export function createSeries(maxPoints = 300) {
  const pts = [];                          // { ts, value }; ts зростає

  // Перший індекс із pts[i].ts >= ts
  const lowerBound = (ts) => {
    let lo = 0;
    let hi = pts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return {
    add({ ts, value }) {                   // true, якщо ряд змінився
      const i = lowerBound(ts);
      if (pts[i]?.ts === ts) return false;                 // дубль
      if (i === 0 && pts.length >= maxPoints) return false; // поза вікном
      pts.splice(i, 0, { ts, value });
      if (pts.length > maxPoints) pts.shift();
      return true;
    },
    points: () => pts.slice(),
    lastTs: () => pts.at(-1)?.ts ?? null,
  };
}

// Сховище рядів за ключем «пристрій/метрика»
export function createStore(maxPoints = 300) {
  const rows = new Map();
  return {
    apply(r) {                             // r = { device, metric, ts, value }
      const key = `${r.device}/${r.metric}`;
      if (!rows.has(key)) rows.set(key, createSeries(maxPoints));
      return rows.get(key).add(r);
    },
    snapshot: () => Object.fromEntries(
      [...rows].map(([key, s]) => [key, s.points()])),
    lastTs: (key) => rows.get(key)?.lastTs() ?? null,
  };
}
