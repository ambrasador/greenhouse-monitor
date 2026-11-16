// M3: скільки push за добу дає поріг, біля якого шумить датчик.
// Правила — справжній createAlertTracker з push.js; шум — гаусів, зерно фіксоване.
//   node calc5-m3.mjs [out.json]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createAlertTracker } = require('./push');
const { mulberry32 } = require('./fault-proxy');

const OUT = process.argv[2] ?? 'results/m3.json';
const DAY = 1440;                  // вимірювань за добу, період 60 с
const T0 = Date.parse('2026-11-04T00:00:00.000Z');
const SEEDS = 30;
const WARN = 35;

function gauss(rnd) {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

// Сценарії: «біля порога» — середнє рівно на порозі; «висихання» — реальний спад 40 → 29
const SCENARIOS = {
  hover: () => WARN,
  drying: (i) => 40 - (11 * i) / (DAY - 1),
};

const POLICIES = {
  naive: null,                                       // кожне вимірювання нижче порога
  edge: { hysteresis: 0, cooldownMs: 0 },            // лише перехід через поріг
  cooldown: { hysteresis: 0, cooldownMs: 600_000 },  // перехід + пауза 10 хв
  hyst1: { hysteresis: 1, cooldownMs: 0 },
  hyst2: { hysteresis: 2, cooldownMs: 0 },
  full: { hysteresis: 2, cooldownMs: 600_000 },      // як у системі
};

function pushesPerDay(policy, scenario, sigma, seed) {
  const rnd = mulberry32(seed);
  let now = T0;
  const tracker = policy === null ? null
    : createAlertTracker({ ...policy, clock: () => now });
  let n = 0;
  for (let i = 0; i < DAY; i++) {
    const value = SCENARIOS[scenario](i) + sigma * gauss(rnd);
    now = T0 + i * 60_000;
    const ts = new Date(now).toISOString();
    if (tracker === null) {
      if (value < WARN) n++;
    } else if (tracker.evaluate({ device: 'gh1-s01', metric: 'soil_moisture', ts, value })) {
      n++;
    }
  }
  return n;
}

const stat = (xs) => ({ mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1),
  min: Math.min(...xs), max: Math.max(...xs) });

const out = [];
for (const scenario of Object.keys(SCENARIOS)) {
  for (const sigma of [0.3, 0.6, 1.0]) {
    for (const [name, policy] of Object.entries(POLICIES)) {
      const xs = Array.from({ length: SEEDS }, (_, s) => pushesPerDay(policy, scenario, sigma, 1000 + s));
      out.push({ scenario, sigma, policy: name, ...stat(xs) });
    }
  }
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const scenario of Object.keys(SCENARIOS)) {
  console.log(`\n${scenario}`);
  for (const sigma of [0.3, 0.6, 1.0]) {
    console.log(`σ=${sigma}: ` + out.filter((r) => r.scenario === scenario && r.sigma === sigma)
      .map((r) => `${r.policy} ${r.mean} [${r.min}..${r.max}]`).join(' | '));
  }
}
