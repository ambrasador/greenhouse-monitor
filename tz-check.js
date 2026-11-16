const { chromium } = require('playwright');
const { bucketBounds, parseInterval, parseInstant } = require('./timeq');
const zones = ['UTC', 'Europe/Kyiv', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'America/Santiago', 'Asia/Beirut', 'Pacific/Chatham', 'Africa/Cairo', 'America/Havana', 'America/Asuncion', 'Asia/Tehran', 'Europe/London', 'Asia/Kathmandu'];
const from = parseInstant('2024-01-01T00:00:00Z'), to = parseInstant('2027-01-01T00:00:00Z');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  for (const tz of zones) for (const unit of ['1d', '1mo']) {
    const mine = bucketBounds(from, to, parseInterval(unit), tz);
    const ref = await p.evaluate(({ tz, unit, from, to }) => {
      const out = [];
      let z = Temporal.Instant.fromEpochMilliseconds(from).toZonedDateTimeISO(tz).startOfDay();
      if (unit === '1mo') z = z.with({ day: 1 }).startOfDay();
      while (z.epochMilliseconds < to) {
        const next = (unit === '1d' ? z.toPlainDate().add({ days: 1 }) : z.toPlainDate().add({ months: 1 }))
          .toZonedDateTime(tz);
        out.push([z.epochMilliseconds, next.epochMilliseconds]);
        z = next;
      }
      return out;
    }, { tz, unit, from, to });
    let diff = 0, first = null;
    const n = Math.min(mine.length, ref.length);
    for (let i = 0; i < n; i++) if (mine[i][0] !== ref[i][0] || mine[i][1] !== ref[i][1]) { diff++; first ??= [i, mine[i], ref[i]]; }
    console.log(tz.padEnd(22), unit.padEnd(4), 'buckets', mine.length, ref.length, 'diff', diff,
      first ? JSON.stringify([first[0], first[1].map((x) => new Date(x).toISOString()), first[2].map((x) => new Date(x).toISOString())]) : '');
  }
  await b.close();
})();
