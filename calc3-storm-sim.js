'use strict';
// Імітація шторму на великих U з реальними реалізаціями затримок:
// клас Backoff із socket.io-client і delay() із client/backoff.js.
// Сервер недоступний downMs, невдала спроба коштує 0 мс (ECONNREFUSED)
const fs = require('node:fs');
const path = require('node:path');
const { Backoff } = require('./node_modules/socket.io-client/build/cjs/contrib/backo2.js');

// DOWN — тривалість збою, мс; список через кому дає розгортку (файл storm-sim-sweep.json)
const DOWNS = String(process.argv[2] ?? 5000).split(',').map(Number);
const SWEEP = DOWNS.length > 1;
const UU = (process.env.SIM_U ?? '1000,10000,100000').split(',').map(Number);

async function main() {
  const { delay } = await import('./client/backoff.js');
  const policies = {
    default: () => { const b = new Backoff({ min: 1000, max: 5000, jitter: 0.5 }); return () => b.duration(); },
    nojitter: () => { const b = new Backoff({ min: 1000, max: 5000, jitter: 0 }); return () => b.duration(); },
    full: () => { let n = 0; return () => delay(++n, { base: 1000, cap: 30_000 }); },
    full5: () => { let n = 0; return () => delay(++n, { base: 5000, cap: 60_000 }); },
    full10: () => { let n = 0; return () => delay(++n, { base: 10_000, cap: 120_000 }); },
    full120: () => { let n = 0; return () => delay(++n, { base: 1000, cap: 120_000 }); },
    fixed: () => () => 3000 + Math.floor(Math.random() * 3000),       // retry із SSE: 3–6 с
  };
  const out = [];
  for (const DOWN of DOWNS) for (const U of UU) {
    for (const [name, make] of Object.entries(policies)) {
      const buckets = new Map();
      let maxT = 0; let attempts = 0;
      const times = new Float64Array(U);
      for (let i = 0; i < U; i++) {
        const next = make();
        let t = 0;
        for (;;) {
          t += next();
          attempts += 1;
          if (t >= DOWN) break;
        }
        times[i] = t;
        const b = Math.floor(t / 100);
        buckets.set(b, (buckets.get(b) ?? 0) + 1);
        maxT = Math.max(maxT, t);
      }
      times.sort();
      let peak1000 = 0;
      for (const [b] of buckets) {
        let s = 0; for (let k = 0; k < 10; k++) s += buckets.get(b + k) ?? 0;
        peak1000 = Math.max(peak1000, s);
      }
      let peak100 = 0; for (const n of buckets.values()) peak100 = Math.max(peak100, n);
      const row = { policy: name, U, downMs: DOWN, p50: times[Math.floor(U * 0.5)], p95: times[Math.floor(U * 0.95)],
        p100: maxT, peakPer100ms: peak100, peakPerSec: peak1000, attemptsPerClient: +(attempts / U).toFixed(2) };
      out.push({ ...row, arrivals100ms: [...buckets].sort((a, b) => a[0] - b[0]) });
      console.log(JSON.stringify(row));
    }
  }
  const file = process.env.SIM_OUT ?? (SWEEP ? 'storm-sim-sweep' : `storm-sim-${DOWNS[0]}`);
  fs.writeFileSync(path.join(__dirname, `results/${file}.json`), JSON.stringify(out));
}
main();
