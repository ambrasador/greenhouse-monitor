// Експеримент: втрата PUBACK → повторна доставка (DUP=1) → дублікат у застосунку
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';
import { Aedes } from 'aedes';

const require = createRequire(import.meta.url);
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const { createApp } = require('./app');
const { createMqttSource } = require('./mqtt-source');

const aedes = await Aedes.createBroker();
const server = net.createServer(aedes.handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `mqtt://127.0.0.1:${server.address().port}`;

const acks = [];
aedes.on('ack', (packet, client) => {
  if (client?.id === 'ingest-1') acks.push(Date.now());
});

const db = new Database(':memory:');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const source = createMqttSource({
  url, clientId: 'ingest-1', filter: 'greenhouse/+/telemetry',
});
const app = createApp({ db, source });
await app.start();

// Спостерігач: журнал доставок + імітація втрати PUBACK для першої
const deliveries = [];
const inner = source.client.handleMessage;
let lostOnce = false;
source.client.handleMessage = (packet, done) => {
  const t0 = Date.now();
  inner.call(source.client, packet, (...args) => {
    const last = deliveries.at(-1);
    if (!lostOnce) {            // зв'язок рветься до відправлення PUBACK
      lostOnce = true;
      last.ack = 'втрачено';
      source.client.stream.destroy();
      return;
    }
    last.ack = 'надіслано';
    done(...args);
  });
  const s = app.stats;
  deliveries.at(-1).result = `stored=${s.stored} dup=${s.duplicate} rej=${s.rejected}`;
  deliveries.at(-1).ms = Date.now() - t0;
};
source.client.on('packetreceive', (p) => {
  if (p.cmd === 'publish') {
    deliveries.push({ topic: p.topic, dup: p.dup, qos: p.qos,
      payload: String(p.payload).slice(0, 60) });
  }
});

// Видавець: пристрій публікує з QoS 1
const pub = mqtt.connect(url, { clientId: 'gh1-s01' });
await new Promise((r) => pub.once('connect', r));
const now = Date.now();
const iso = (offsetSec) => new Date(now - offsetSec * 1000).toISOString();
const send = (obj, raw) => new Promise((r) =>
  pub.publish('greenhouse/gh1-s01/telemetry',
    raw ?? JSON.stringify(obj), { qos: 1 }, r));

await send({ metric: 'temperature', value: 20.0, ts: iso(60) });  // m1
await new Promise((r) => setTimeout(r, 2600));                    // реконект
await send({ metric: 'temperature', value: 21.0, ts: iso(30) });  // m2
await send({ metric: 'temperature', value: 21.0, ts: iso(30) });  // m2 знову
await send({ metric: 'temperature', value: 19.0, ts: iso(90) });  // m0 (старіше)
await send(null, '{oops');                                        // сміття
await new Promise((r) => setTimeout(r, 300));

console.log('Доставки до застосунку:');
deliveries.forEach((d, i) => console.log(i + 1, JSON.stringify(d)));
console.log('stats', app.stats);
console.log('telemetry:', db.prepare(
  'SELECT ts, value FROM telemetry ORDER BY ts').all());
console.log('latest:', db.prepare('SELECT ts, value FROM latest').all());
console.log('rejected:', db.prepare('SELECT reason, raw FROM rejected').all());

await new Promise((r) => pub.end(false, {}, r));
await app.stop();
await new Promise((r) => aedes.close(r));
server.close();
process.exit(0);
