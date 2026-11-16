'use strict';
const mqtt = require('mqtt');
const ACK = /^greenhouse\/([A-Za-z0-9_-]{1,32})\/acks$/;

// Канал команд: публікація команд пристроям і прийом їхніх підтверджень (порт CommandSink)
function createMqttCommandChannel({ url, clientId = 'api-1', sendTimeoutMs = 2000 }) {
  const client = mqtt.connect(url, { clientId, clean: false, reconnectPeriod: 2000 });
  let onAck = () => {};
  client.on('connect', () => client.subscribe('greenhouse/+/acks', { qos: 1 }));
  // Те саме правило, що в розділі 1: PUBACK пристрою — лише після запису підтвердження в базу
  client.handleMessage = (packet, done) => {
    const m = ACK.exec(packet.topic);
    let p = null;
    try { p = JSON.parse(packet.payload.toString('utf8')); } catch { /* сміття в топіку ігноруємо */ }
    if (m && typeof p?.id === 'string') onAck({ deviceId: m[1], id: p.id, ok: p.ok === true });  // збій БД: без PUBACK
    done();
  };
  return {
    // mqtt.js при розриві ставить QoS 1 у чергу й викликає callback лише після PUBACK, тож без
    // перевірки HTTP-запит висів би до відновлення зв’язку. Відмова швидка: команда лишається pending
    send: (deviceId, cmd) => new Promise((resolve, reject) => {
      if (!client.connected) return reject(new Error('брокер недоступний'));
      const timer = setTimeout(() => reject(new Error('PUBACK не отримано')), sendTimeoutMs);
      client.publish(`greenhouse/${deviceId}/commands`, JSON.stringify(cmd), { qos: 1 },
        (err) => { clearTimeout(timer); return err ? reject(err) : resolve(); });
    }),
    connected: () => client.connected,
    onAck(fn) { onAck = fn; },
    ready: () => new Promise((resolve) => client.once('connect', resolve)),
    close: () => new Promise((resolve) => client.end(false, {}, resolve)),
  };
}

module.exports = { createMqttCommandChannel };
