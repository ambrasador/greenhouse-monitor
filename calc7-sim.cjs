'use strict';
// Імітатор парку для сценарію спостережуваності (розділ 7): N пристроїв × 4 метрики з періодом T,
// фази рознесені рівномірно; у вікні [burstFrom, burstTo] с додатково йдуть хибні повідомлення.
// Пристрій без з’єднання з брокером нічого не буферизує: пропущені показання рахуються окремо.
// Змінні: N, T, DURATION (с), T0 (мс, спільний початок з драйвером), BURST_FROM, BURST_TO, BURST_RATE, URL, OUT
const mqtt = require('mqtt');
const e = process.env;
const N = Number(e.N ?? 200), T = Number(e.T ?? 60), DURATION = Number(e.DURATION ?? 240);
const T0 = Number(e.T0 ?? Date.now());
const BURST = [Number(e.BURST_FROM ?? 170), Number(e.BURST_TO ?? 185)], BURST_RATE = Number(e.BURST_RATE ?? 20);
const METRICS = [['temperature', (i) => 20 + (i % 7)], ['humidity', (i) => 60 + (i % 9)],
  ['soil_moisture', (i) => 30 + (i % 11)], ['light', (i) => 8000 + 40 * (i % 50)]];

const client = mqtt.connect(e.URL ?? 'mqtt://127.0.0.1:1883', { clientId: 'sim-fleet', reconnectPeriod: 500 });
const sent = { published: 0, skippedOffline: 0, duplicates: 0, invalid: 0 };
const bad = [
  (n) => ({ topic: 'greenhouse/gh1-s001/telemetry', body: JSON.stringify({ metric: 'temperature', value: 150 + n % 10, ts: new Date().toISOString() }) }),  // out_of_range
  () => ({ topic: 'greenhouse/gh1-s001/telemetry', body: '{"metric":' }),                                                                                // bad_json
  () => ({ topic: 'greenhouse/gh1-s001/telemetry', body: JSON.stringify({ metric: 'co2', value: 400, ts: new Date().toISOString() }) }),             // unknown_metric
  () => ({ topic: 'greenhouse/gh1-s001/telemetry', body: JSON.stringify({ metric: 'humidity', value: 55, ts: '2026-13-45T00:00:00Z' }) }),            // bad_ts
];

function publish(topic, body, count = true) {
  if (!client.connected) { sent.skippedOffline++; return false; }
  client.publish(topic, body, { qos: 1 });
  if (count) sent.published++;
  return true;
}

function tick(i) {
  const ts = new Date().toISOString();
  METRICS.forEach(([metric, value]) => {
    const id = `gh1-s${String(i + 1).padStart(3, '0')}`;
    const body = JSON.stringify({ metric, value: value(i), ts });
    if (publish(`greenhouse/${id}/telemetry`, body) && Math.random() < 0.01) {   // повторна доставка QoS 1
      publish(`greenhouse/${id}/telemetry`, body, false); sent.duplicates++;
    }
  });
}

client.once('connect', () => {
  const start = Math.max(Date.now(), T0);
  for (let i = 0; i < N; i++) {                      // кожен пристрій — свій таймер з фазою i·T/N
    const phase = (i * T * 1000) / N;
    let k = 0;
    const next = () => {
      const at = start + phase + k * T * 1000;
      if (at > T0 + DURATION * 1000) return;
      setTimeout(() => { tick(i); k++; next(); }, Math.max(0, at - Date.now()));
    };
    next();
  }
  let n = 0;
  const timer = setInterval(() => {
    const rel = (Date.now() - T0) / 1000;
    if (rel > DURATION) { clearInterval(timer); return; }
    if (rel >= BURST[0] && rel < BURST[1]) {
      for (let j = 0; j < BURST_RATE / 10; j++) {
        const m = bad[n++ % bad.length](n);
        if (publish(m.topic, m.body, false)) sent.invalid++;
      }
    }
  }, 100);
  setTimeout(() => {
    client.end(false, () => {
      const out = { N, T, DURATION, ...sent };
      require('fs').writeFileSync(e.OUT ?? 'results/dashboard-sim.json', JSON.stringify(out, null, 1));
      console.log(JSON.stringify(out));
      process.exit(0);
    });
  }, T0 + DURATION * 1000 + 3000 - Date.now());
});
