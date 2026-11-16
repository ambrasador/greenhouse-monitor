'use strict';
// Демонстрація розділу 3: стенд (брокер, приймання, API, Socket.IO, SSE) і генератор
// вимірювань одного пристрою. Запуск: npm run build:client && node demo.js
// Адреси сторінки виводяться в консоль; зупинка — Ctrl+C
const fs = require('node:fs');
const path = require('node:path');
const { startTestbed } = require('./testbed');

if (!fs.existsSync(path.join(__dirname, 'client/dist/app.js'))) {
  console.error('Немає client/dist/app.js: спершу виконайте npm run build:client');
  process.exit(1);
}

const DEVICE = 'gh1-s01';
// метрика: [середнє значення, амплітуда, період синусоїди, хв]
const SHAPE = {
  temperature: [22, 3, 20],
  humidity: [60, 10, 25],
  soil_moisture: [35, 5, 40],
  light: [9000, 6000, 30],
};

const value = (metric, t) => {
  const [mid, amp, periodMin] = SHAPE[metric];
  const wave = amp * Math.sin((2 * Math.PI * t) / (periodMin * 60_000));
  const noise = (Math.random() - 0.5) * amp * 0.1;
  return Math.round(Math.max(0, mid + wave + noise) * 100) / 100;
};

(async () => {
  const bed = await startTestbed({ devices: [[DEVICE, 'north']] });
  const send = (t) => Promise.all(Object.keys(SHAPE).map((metric) =>
    bed.publish(DEVICE, { metric, value: value(metric, t), ts: new Date(t).toISOString() })));

  const now = Date.now();
  for (let t = now - 300_000; t < now; t += 1000) await send(t);     // історія за 5 хв
  const timer = setInterval(() => send(Date.now()).catch(() => {}), 1000);

  const page = `http://127.0.0.1:${bed.httpPort}/index.html?device=${DEVICE}&metric=temperature`;
  console.log(`Socket.IO:        ${page}&kind=socketio`);
  console.log(`SSE:              ${page}&kind=sse`);
  console.log(`MQTT через WS:    ${page}&kind=mqtt&mqtt=ws://127.0.0.1:${bed.wsPort}&mqttv=4`);
  console.log('Метрики: temperature, humidity, soil_moisture, light (параметр metric)');

  const stop = async () => { clearInterval(timer); await bed.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
