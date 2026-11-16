'use strict';
// Демонстрація розділу 4: дашборд теплиці з чотирма пристроями й живим потоком для
// «Грядки А». Запуск: npm run build:client && node demo-dashboard.js
const fs = require('node:fs');
const path = require('node:path');
const { startDashboardBed } = require('./dash-bed');

if (!fs.existsSync(path.join(__dirname, 'client/dist/dashboard.js'))) {
  console.error('Немає client/dist/dashboard.js: спершу виконайте npm run build:client');
  process.exit(1);
}

(async () => {
  const bed = await startDashboardBed();
  // Живий потік: Грядка А звітує щосекунди (в реальності — раз на 60 с)
  const timer = setInterval(() => {
    const t = Date.now();
    const wave = (mid, amp, min) => mid + amp * Math.sin((2 * Math.PI * t) / (min * 60_000));
    for (const [metric, v] of [['soil_moisture', wave(41, 0.6, 7)], ['temperature', wave(27.4, 1.2, 5)]]) {
      bed.publish('gh1-s01', { metric, value: Math.round(v * 100) / 100,
        ts: new Date(t).toISOString() }).catch(() => {});
    }
  }, 1000);
  console.log(`Дашборд: http://127.0.0.1:${bed.httpPort}/dashboard.html`);
  const stop = async () => { clearInterval(timer); await bed.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
