import mqtt from 'mqtt';

// MQTT-over-WebSocket: браузер підписується на топік напряму в брокера.
// clean: true — вкладка не є довговічним клієнтом, черга брокера їй не потрібна
export function mqttTransport({ url, device, version = 5, connect = mqtt.connect }) {
  let client;
  return {
    start(h) {
      client = connect(url, { protocolVersion: version, clean: true,
        reconnectPeriod: 0, connectTimeout: 10_000 });
      client.on('connect', () => {
        client.subscribe(`greenhouse/${device}/telemetry`, { qos: 0 },
          (err) => (err ? h.onClose() : h.onOpen()));    // SUBACK
      });
      client.on('message', (_topic, payload) => {
        const m = JSON.parse(payload.toString());
        // ключ дедуплікації — як у базі: ts із мілісекундами, UTC
        h.onReadings([{ device, ...m, ts: new Date(m.ts).toISOString() }]);
      });
      client.on('close', () => h.onClose());
    },
    stop() { client?.removeAllListeners(); client?.end(true); },
  };
}
