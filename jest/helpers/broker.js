'use strict';
const net = require('node:net');

// Брокер MQTT у пам’яті процесу тесту. Порт 0 означає «будь-який вільний»,
// тому паралельні запуски не конфліктують; port вказують лише при
// перезапуску брокера
async function startBroker(port = 0) {
  // Aedes 1.x — пакет лише ESM, а require() у Jest його не завантажить;
  // динамічний import працює з --experimental-vm-modules (package.json)
  const { Aedes } = await import('aedes');
  const aedes = await Aedes.createBroker();
  const server = net.createServer(aedes.handle);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address();
  return {
    port: actual,
    url: `mqtt://127.0.0.1:${actual}`,
    // close() розриває з’єднання клієнтів: так виглядає падіння брокера
    stop: async () => {
      await new Promise((resolve) => aedes.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startBroker };
