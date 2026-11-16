'use strict';
const net = require('node:net');

// TCP-проксі, який імітує втрату зв’язку: cut(ms) обриває всі з’єднання
// і на ms мілісекунд відмовляє в нових. Журнал attempts — те, що побачив би
// сервер: момент і доля кожної спроби підключення
function createProxy(targetPort, { host = '127.0.0.1' } = {}) {
  const sockets = new Set();
  const attempts = [];                      // { t, ok }
  const t0 = Date.now();
  let downUntil = 0;
  let mode = 'reset';                       // reset — обрив TCP; 503 — відповідь HTTP
  const server = net.createServer((client) => {
    const t = Date.now() - t0;
    if (Date.now() < downUntil) {
      attempts.push({ t, ok: false });
      if (mode === '503') {
        client.on('error', () => {});
        client.once('data', () => client.end(
          'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
        return;
      }
      return client.destroy();
    }
    attempts.push({ t, ok: true });
    const upstream = net.connect(targetPort, host);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => { sockets.delete(s); (s === client ? upstream : client).destroy(); });
      s.on('error', () => {});
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return {
    listen: () => new Promise((r) => server.listen(0, host, () => r(server.address().port))),
    cut(ms, how = 'reset') {
      downUntil = Date.now() + ms;
      mode = how;
      for (const s of sockets) s.destroy();
    },
    attempts,
    elapsed: () => Date.now() - t0,
    close() { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)); },
  };
}

module.exports = { createProxy };
