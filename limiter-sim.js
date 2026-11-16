'use strict';
// Імітація: клієнт надсилає 5 запитів за секунду; ліміт 1 запит/с, місткість 10; потім три екземпляри за балансувальником
const fs = require('node:fs');
const { createLimiter } = require('./ratelimit');

function simulate({ instances, reqPerSec, seconds, rate = 1, burst = 10 }) {
  let now = 0;
  const lim = Array.from({ length: instances }, () => createLimiter({ rate, burst, clock: () => now }));
  const perSecond = [];
  let n = 0;
  for (let s = 0; s < seconds; s++) {
    let ok = 0;
    for (let i = 0; i < reqPerSec; i++) {
      now = s * 1000 + Math.floor((i * 1000) / reqPerSec);
      if (lim[n++ % instances].take('client').ok) ok++;
    }
    perSecond.push(ok);
  }
  return perSecond;
}
const one = simulate({ instances: 1, reqPerSec: 5, seconds: 30 });
const three = simulate({ instances: 3, reqPerSec: 5, seconds: 30 });
const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log(JSON.stringify({ one_instance_first10s: one.slice(0, 10), accepted_30s: sum(one), three_instances_accepted_30s: sum(three),
  three_first10s: three.slice(0, 10) }));
fs.writeFileSync(`${__dirname}/../calc2/limiter-sim.json`, JSON.stringify({ one, three }));
