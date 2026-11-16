// Проріджування рядів перед малюванням. Точка ряду — { t, v }: t у
// мілісекундах Unix, v — значення; ряд відсортований за t. Усі функції
// повертають нові масиви з тих самих об’єктів точок і зберігають порядок

// LTTB (Largest-Triangle-Three-Buckets) [Steinarsson, 2013]. Перша й
// остання точки лишаються, решту ряду поділено на n − 2 кошики однакової
// довжини. З кошика береться точка, що утворює найбільший трикутник
// із попередньою вибраною точкою та середнім наступного кошика
export function lttb(points, n) {
  const len = points.length;
  if (n >= len || n < 3) return points.slice();
  const out = [points[0]];
  const size = (len - 2) / (n - 2);           // довжина кошика, точок
  let a = 0;                                  // попередня вибрана точка
  for (let i = 0; i < n - 2; i++) {
    const from = Math.floor(i * size) + 1;
    const to = Math.floor((i + 1) * size) + 1;
    const nextTo = Math.min(Math.floor((i + 2) * size) + 1, len);
    let ct = 0;                               // середина наступного кошика
    let cv = 0;
    for (let j = to; j < nextTo; j++) {
      ct += points[j].t;
      cv += points[j].v;
    }
    ct /= nextTo - to;
    cv /= nextTo - to;
    const { t: at, v: av } = points[a];
    let best = from;
    let bestArea = -1;
    for (let j = from; j < to; j++) {         // подвоєна площа трикутника
      const area = Math.abs((at - ct) * (points[j].v - av)
        - (at - points[j].t) * (cv - av));
      if (area > bestArea) { bestArea = area; best = j; }
    }
    out.push(points[best]);
    a = best;
  }
  out.push(points[len - 1]);
  return out;
}

// Мінімум і максимум кожного з кошиків однакової довжини: до 2 · buckets
// точок
export function minMax(points, buckets) {
  const len = points.length;
  if (buckets * 2 >= len) return points.slice();
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * len) / buckets);
    const to = Math.floor(((b + 1) * len) / buckets);
    let lo = from;
    let hi = from;
    for (let j = from + 1; j < to; j++) {
      if (points[j].v < points[lo].v) lo = j;
      if (points[j].v > points[hi].v) hi = j;
    }
    if (lo === hi) out.push(points[lo]);
    else out.push(points[Math.min(lo, hi)], points[Math.max(lo, hi)]);
  }
  return out;
}

// M4 [Jugel et al., 2014]: для кожного стовпчика пікселів у вікні [t0, t1)
// лишає першу, останню, найменшу й найбільшу точки. Лінія, проведена через
// результат, збігається з лінією через весь ряд піксель у піксель
export function m4(points, width,
  t0 = points[0]?.t, t1 = points.at(-1)?.t) {
  if (points.length <= 4 * width) return points.slice();
  const out = [];
  const span = t1 - t0 || 1;
  let col = -1;
  let idx = [];
  const flush = () => {
    const [first, last] = [idx[0], idx[idx.length - 1]];
    let lo = first;
    let hi = first;
    for (const j of idx) {
      if (points[j].v < points[lo].v) lo = j;
      if (points[j].v > points[hi].v) hi = j;
    }
    const keep = new Set([first, lo, hi, last].sort((x, y) => x - y));
    for (const j of keep) out.push(points[j]);
  };
  for (let j = 0; j < points.length; j++) {
    const x = ((points[j].t - t0) / span) * width;
    const c = Math.min(width - 1, Math.floor(x));
    if (c !== col) {
      if (idx.length) flush();
      col = c;
      idx = [];
    }
    idx.push(j);
  }
  if (idx.length) flush();
  return out;
}

// Кожна step-а точка плюс остання: найпростіший спосіб для порівняння
export function everyNth(points, n) {
  if (n >= points.length) return points.slice();
  const step = Math.ceil(points.length / n);
  const out = points.filter((_, i) => i % step === 0);
  if (out.at(-1) !== points.at(-1)) out.push(points.at(-1));
  return out;
}

// Спрощення траси методом Дугласа — Пекера. Точки { x, y } у метрах;
// відхилення будь-якої відкинутої точки від результату не перевищує eps.
// Стек замість рекурсії: у найгіршому разі розбиття відділяє одну точку,
// глибина дорівнює їх кількості, а стек викликів V8 — порядку 10⁴ кадрів
export function simplifyTrack(pts, eps) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let far = -1;
    let dMax = eps;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], pts[s], pts[e]);
      if (d > dMax) { dMax = d; far = i; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([s, far], [far, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let u = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

// Плоскі координати в метрах: рівнопроміжкова проєкція навколо
// (lat0, lon0). Масштаб уздовж паралелей спотворено на
// cos(lat0)/cos(lat) − 1 ≈ tan(lat0)·Δlat: для lat0 = 46,6° це 0,6 %
// на відстані 36 км від центру. На таку саму частку змінюється відстань
// від точки до відрізка, тож допуск eps у метрах зберігається з відносною
// похибкою менш ніж 1 %. Абсолютні координати цієї проєкції для вимірювань
// не годяться: на краю траси вони зсунуті на десятки метрів
const EARTH_R = 6_371_008.8;                  // середній радіус Землі, м
export function toMeters(lat, lon, lat0, lon0) {
  const rad = Math.PI / 180;
  return {
    x: EARTH_R * (lon - lon0) * rad * Math.cos(lat0 * rad),
    y: EARTH_R * (lat - lat0) * rad,
  };
}
