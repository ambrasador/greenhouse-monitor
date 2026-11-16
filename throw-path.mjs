// Що буде, якщо запис у БД впав (виняток не DecodeError)?
import { createRequire } from 'node:module';
import net from 'node:net';
import { Aedes } from 'aedes';
const require = createRequire(import.meta.url);
const { createMqttSource } = require('./mqtt-source');
const mqtt = require('mqtt');

const aedes = await Aedes.createBroker();
const server = net.createServer(aedes.handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `mqtt://127.0.0.1:${server.address().port}`;
let acked = 0;
aedes.on('ack', (p, c) => { if (c?.id === 'ingest-1') acked++; });

process.on('uncaughtException', (e) => {
  console.log('uncaughtException:', e.message, '| PUBACK надіслано:', acked);
  process.exit(0);
});
const source = createMqttSource({ url, clientId: 'ingest-1', filter: 'greenhouse/+/telemetry' });
source.onReading(() => { throw new Error('SQLITE_BUSY: база зайнята'); });
await source.start();
const pub = mqtt.connect(url, { clientId: 'gh1-s01' });
await new Promise((r) => pub.once('connect', r));
pub.publish('greenhouse/gh1-s01/telemetry',
  JSON.stringify({ metric: 'temperature', value: 20, ts: new Date().toISOString() }), { qos: 1 });
await new Promise((r) => setTimeout(r, 800));
console.log('процес живий, PUBACK надіслано:', acked);
process.exit(0);
