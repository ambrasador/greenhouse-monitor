'use strict';
// Стенд розділу 4: стенд розділу 3 + чотири пристрої з різними статусами й історією
// за сім діб (крок 60 с). Історію записано напряму в базу, живі точки подаються через брокер
const { startTestbed } = require('./testbed');
const { seed, addDevice } = require('./testkit');
const { greenhouseSeries, DAY } = require('./synth');

// id, назва, зона, вологість ґрунту, температура, відставання останнього вимірювання, с,
// перерви в даних: [скільки хвилин тому почалася, скільки хвилин тому закінчилася]
const DEVICES = [
  ['gh1-s01', 'Грядка А', 'north', 41.0, 27.4, 0],       // норма
  ['gh1-s02', 'Грядка Б', 'north', 33.0, 29.8, 0,        // попередження: вологість 30–35
    [[42, 30], [600, 480]]],                             // перерви 12 хв і 2 год
  ['gh1-s03', 'Грядка В', 'south', 27.5, 36.2, 0],       // критично: і вологість, і температура
  ['gh1-s04', 'Грядка Г', 'south', 44.0, 26.1, 360],     // немає даних: мовчить 6 хв > 3 періодів
];

// Додає до останніх minutes точок лінійно зростаючу поправку: остання точка = target
function blendTo(pts, target, minutes) {
  const shift = target - pts.at(-1).v;
  const from = Math.max(0, pts.length - minutes);
  for (let i = from; i < pts.length; i++) {
    pts[i].v = Math.round((pts[i].v + (shift * (i - from + 1)) / (pts.length - from)) * 100) / 100;
  }
}

async function startDashboardBed({ now = Date.now(), days = 8, ...opts } = {}) {
  const bed = await startTestbed({ devices: [], ...opts });
  const midnight = Math.floor(now / DAY) * DAY;
  const start = midnight - (days - 1) * DAY;
  DEVICES.forEach(([id, , zone], k) => {
    addDevice(bed.db, id, zone);
    const lag = DEVICES[k][5] * 1000;
    const holes = (DEVICES[k][6] ?? []).map(
      ([a, b]) => [now - a * 60_000, now - b * 60_000]);
    const series = greenhouseSeries({ seed: 42 + k, start, days, incident: k === 0 });
    for (const [metric, pts] of Object.entries(series)) {
      const kept = pts.filter((p) => p.t <= now - lag
        && !holes.some(([from, to]) => p.t >= from && p.t < to));
      // Останнє вимірювання задає статус картки. Ряд плавно підводимо до цільового
      // значення протягом останніх двох годин, щоб на графіку не було стрибка
      const target = { soil_moisture: DEVICES[k][3], temperature: DEVICES[k][4] }[metric];
      if (target !== undefined) blendTo(kept, target, 120);
      // seed пише рівномірний ряд, тож кожен відрізок між перервами — окремо
      let from = 0;
      for (let i = 1; i <= kept.length; i++) {
        if (i < kept.length && kept[i].t - kept[i - 1].t === 60_000) continue;
        seed(bed.db, { device: id, metric, start: kept[from].t, count: i - from,
          step: 60, values: (j) => kept[from + j].v });
        from = i;
      }
    }
  });
  for (const [id, name] of DEVICES) {
    bed.db.prepare('UPDATE devices SET name = ? WHERE device_id = ?').run(name, id);
  }
  return { ...bed, DEVICES };
}

module.exports = { startDashboardBed, DEVICES };
