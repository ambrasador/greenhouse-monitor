'use strict';

// Стан для проб /readyz і для метрик: чи є з’єднання з брокером і коли
// надійшло останнє повідомлення. Окрема функція, щоб main.js і тести
// слідкували за клієнтом однаково
function createHealthState() {
  return { mqttConnected: false, lastReadingAt: null };
}

function trackBroker(client, state,
  { clock = Date.now, log = () => {} } = {}) {
  // Журнал отримує перехід, а не кожну подію: поки брокера немає, клієнт
  // повторює спроби й щоразу видає close
  const set = (up) => {
    if (state.mqttConnected === up) return;
    state.mqttConnected = up;
    log(up ? 'broker_up' : 'broker_down');
  };
  state.mqttConnected = client.connected;
  client.on('connect', () => set(true));
  client.on('close', () => set(false));
  client.on('packetreceive', (p) => {
    if (p.cmd === 'publish') state.lastReadingAt = clock();
  });
}

module.exports = { createHealthState, trackBroker };
