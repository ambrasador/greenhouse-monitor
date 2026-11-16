'use strict';
const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const STEP = { m: 60_000, h: 3_600_000 };

// Строгий розбір часу UTC: лише формат із «Z», 30 лютого не «виправляється»
function parseInstant(s) {
  if (typeof s !== 'string' || !TS_RE.test(s)) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const same = new Date(t).toISOString().slice(0, 19) === s.slice(0, 19);
  return same ? t : null;
}

// Допустимі інтервали: межі мають збігатися з межами години, доби чи місяця
function parseInterval(s) {
  const m = /^(\d{1,2})(m|h|d|mo)$/.exec(s ?? '');
  if (!m) return null;
  const n = Number(m[1]), unit = m[2];
  const cycle = { m: 60, h: 24 }[unit];          // одиниць у старшій одиниці
  const fits = cycle ? n >= 1 && n < cycle && cycle % n === 0 : n === 1;
  return fits ? { n, unit } : null;
}

const formats = new Map();
function localParts(tz, ms) {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(ms)) p[type] = Number(value);
  return p;
}
const offsetAt = (tz, ms) => {
  const p = localParts(tz, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    - Math.floor(ms / 1000) * 1000;
};
// Момент UTC, коли в зоні tz починається локальна доба (y, m, d)
function startOfDay(tz, y, m, d) {
  const g = Date.UTC(y, m - 1, d);
  const before = g - offsetAt(tz, g - 86_400_000);  // зсув попередньої доби
  const after = g - offsetAt(tz, g + 86_400_000);   // зсув наступної
  const valid = [before, after].filter((c) => g - offsetAt(tz, c) === c);
  // якщо перехід припав на північ і її не існує,
  // доба починається в момент переходу
  return valid.length ? Math.min(...valid) : Math.max(before, after);
}

// Межі інтервалів [початок, кінець) у мс UTC, що покривають [from, to)
function bucketBounds(from, to, { n, unit }, tz = 'UTC', max = 10_000) {
  const out = [];
  const add = (a, b) => {
    if (out.push([a, b]) > max) throw new RangeError('too_many_buckets');
  };
  if (unit === 'm' || unit === 'h') {            // фіксована довжина
    const step = n * STEP[unit];
    for (let s = Math.floor(from / step) * step; s < to; s += step) {
      add(s, s + step);
    }
    return out;
  }
  const p = localParts(tz, from);                // календарні: доба, місяць
  let y = p.year, m = p.month, d = unit === 'd' ? p.day : 1;
  let start = startOfDay(tz, y, m, d);
  while (start < to) {
    if (unit === 'd') d += 1; else m += 1;
    // Date.UTC переносить d і m: 32 січня стає 1 лютого
    const u = new Date(Date.UTC(y, m - 1, d));
    [y, m, d] = [u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate()];
    const end = startOfDay(tz, y, m, d);
    add(start, end);
    start = end;
  }
  return out;
}

module.exports = { parseInstant, parseInterval, bucketBounds };
