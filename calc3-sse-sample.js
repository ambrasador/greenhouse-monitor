'use strict';
// Знімок початку потоку SSE з реального сервера → examples/sse-stream.txt
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startTestbed } = require('./testbed');

(async () => {
  const bed = await startTestbed({ sse: { retryMs: 3000, heartbeatMs: 1500, rnd: () => 0.4 } });
  const body = await new Promise((resolve) => {
    let out = '';
    const req = http.get({ host: '127.0.0.1', port: bed.httpPort,
      path: '/api/v1/devices/gh1-s01/stream?metrics=temperature,humidity' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      setTimeout(async () => {
        const t0 = Math.floor((Date.now() - 2000) / 1000) * 1000;
        await bed.publish('gh1-s01', { metric: 'temperature', value: 21.4, ts: new Date(t0).toISOString() });
        await bed.publish('gh1-s01', { metric: 'humidity', value: 55.1, ts: new Date(t0).toISOString() });
      }, 300);
      setTimeout(() => { req.destroy(); resolve(out); }, 2200);
    });
  });
  const dst = path.join(__dirname, 'examples', 'sse-stream.txt');
  fs.writeFileSync(dst, body.replace(/\r\n/g, '\n'));
  process.stdout.write(body);
  await bed.stop();
  process.exit(0);
})();
