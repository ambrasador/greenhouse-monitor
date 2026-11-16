'use strict';
// Клієнти, що підключаються з постійною інтенсивністю rate за секунду протягом
// seconds: connect → subscribe → ack → читання вікна з REST. Міряємо resync
// (від події connect до готовності), як у досліді «шторм»
const { io } = require('socket.io-client');

async function ramp({ port, rate, seconds }) {
  const url = `http://127.0.0.1:${port}`;
  const total = Math.round(rate * seconds);
  const clients = [];
  const lat = [];
  let done = 0;
  const from = new Date(Date.now() - 360_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const q = new URLSearchParams({ device: 'gh1-s01', metric: 'temperature', from, to, limit: '1000' });
  const start = Date.now();
  let started = 0;
  await new Promise((resolve) => {
    const tick = () => {
      const due = Math.min(total, Math.floor(((Date.now() - start) / 1000) * rate) + 1);
      while (started < due) {
        started += 1;
        const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
        clients.push(socket);
        socket.on('connect', () => {
          const t1 = Date.now();
          socket.emit('subscribe', { device: 'gh1-s01' }, async (a) => {
            if (a?.ok) await fetch(`${url}/api/v1/telemetry?${q}`).then((r) => r.json()).catch(() => {});
            lat.push(Date.now() - t1);
            done += 1;
            if (done === total) resolve();
          });
        });
        socket.on('connect_error', () => { done += 1; if (done === total) resolve(); });
      }
      if (started < total) setTimeout(tick, 2);
    };
    tick();
    setTimeout(resolve, (seconds + 30) * 1000);        // страховка
  });
  const wall = Date.now() - start;
  clients.forEach((s) => { s.removeAllListeners(); s.close(); });
  lat.sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.ceil(lat.length * p) - 1)];
  return { total, ok: lat.length, wall, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: lat.at(-1) };
}

process.on('message', async (m) => {
  try { process.send({ id: m.id, result: await ramp(m.args) }); }
  catch (e) { process.send({ id: m.id, error: e.stack }); }
});
process.send({ ready: true });
