// Перевірка: PUBACK надсилається після виклику done() у handleMessage?
import { createRequire } from 'node:module';
import net from 'node:net';
import { Aedes } from 'aedes';
const require = createRequire(import.meta.url);
const mqtt = require('mqtt');

const aedes = await Aedes.createBroker();
const server = net.createServer(aedes.handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `mqtt://127.0.0.1:${server.address().port}`;

const t = {};
aedes.on('ack', (packet, client) => {
  if (client?.id === 'sub') t.ack = performance.now();
});

const sub = mqtt.connect(url, { clientId: 'sub', clean: false });
sub.handleMessage = (packet, done) => {
  t.delivered = performance.now();
  setTimeout(() => { t.done = performance.now(); done(); }, 400);
};
await new Promise((r) => sub.once('connect', r));
await new Promise((r) => sub.subscribe('x/y', { qos: 1 }, r));

const pub = mqtt.connect(url, { clientId: 'pub' });
await new Promise((r) => pub.once('connect', r));
pub.publish('x/y', 'hello', { qos: 1 });
await new Promise((r) => setTimeout(r, 900));

const ms = (a, b) => Math.round(t[b] - t[a]);
console.log('delivered→done:', ms('delivered', 'done'), 'мс');
console.log('delivered→PUBACK на брокері:', ms('delivered', 'ack'), 'мс');
process.exit(0);
