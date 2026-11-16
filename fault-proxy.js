'use strict';
// HTTP-проксі, що губить відповіді: запит доходить до сервера й виконується,
// а клієнт відповіді не отримує (обрив після пересилання), або запит не доходить
// взагалі. Рішення — з генератора mulberry32 із зерном, тож прогін повторюваний.
// Для SSE не годиться: проксі збирає відповідь повністю
const http = require('node:http');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createFaultProxy({ targetPort, host = '127.0.0.1', lossAfter = 0, lossBefore = 0, seed = 1 }) {
  const cfg = { lossAfter, lossBefore };
  let rnd = mulberry32(seed);
  const stats = { requests: 0, droppedBefore: 0, droppedAfter: 0, passed: 0 };
  const server = http.createServer((req, res) => {
    stats.requests++;
    // два числа на запит, щоб послідовність не залежала від гілки
    const [uBefore, uAfter] = [rnd(), rnd()];
    if (uBefore < cfg.lossBefore) {
      stats.droppedBefore++;
      req.resume();
      return req.socket.destroy();
    }
    const up = http.request({ host, port: targetPort, method: req.method, path: req.url,
      headers: req.headers }, (ures) => {
      const parts = [];
      ures.on('data', (c) => parts.push(c));
      ures.on('end', () => {
        if (uAfter < cfg.lossAfter) {          // сервер уже все зробив
          stats.droppedAfter++;
          return req.socket.destroy();
        }
        stats.passed++;
        res.writeHead(ures.statusCode, ures.headers);
        res.end(Buffer.concat(parts));
      });
    });
    up.on('error', () => req.socket.destroy());
    req.pipe(up);
  });
  return {
    stats,
    configure({ lossAfter: a, lossBefore: b, seed: s }) {
      if (a !== undefined) cfg.lossAfter = a;
      if (b !== undefined) cfg.lossBefore = b;
      if (s !== undefined) rnd = mulberry32(s);
    },
    listen: () => new Promise((r) => server.listen(0, host, () => r(server.address().port))),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

module.exports = { createFaultProxy, mulberry32 };
