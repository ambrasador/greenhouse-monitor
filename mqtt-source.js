'use strict';
const mqtt = require('mqtt');
const TOPIC = /^greenhouse\/([A-Za-z0-9_-]{1,32})\/telemetry$/;

class DecodeError extends Error {}

// Переклад «мови брокера» (топік + JSON) у внутрішню модель Reading
function decode(topic, payload) {
  const m = TOPIC.exec(topic);
  if (!m) throw new DecodeError('bad_topic');
  let p;
  try { p = JSON.parse(payload.toString('utf8')); }
  catch { throw new DecodeError('bad_json'); }
  if (p === null || typeof p !== 'object')
    throw new DecodeError('bad_json');
  return { deviceId: m[1], metric: p.metric, value: p.value, ts: p.ts };
}

function createMqttSource({ url, clientId, filter }) {
  let onReading = () => {};
  let onReject = () => {};
  const source = {
    onReading(fn) { onReading = fn; },
    onReject(fn) { onReject = fn; },
    start() {
      const client = mqtt.connect(url,
        { clientId, clean: false, reconnectPeriod: 2000 });
      // PUBACK піде лише після done(): повідомлення вже в базі
      client.handleMessage = (packet, done) => {
        try {
          onReading(decode(packet.topic, packet.payload));
        } catch (e) {
          if (!(e instanceof DecodeError)) throw e;  // збій БД: без ACK
          onReject(e.message, `${packet.topic} ${packet.payload}`);
        }
        done();
      };
      client.on('connect', () => client.subscribe(filter, { qos: 1 }));
      source.client = client;
      return new Promise((resolve) => client.once('connect', resolve));
    },
    stop() {
      return new Promise((resolve) =>
        source.client.end(false, {}, resolve));
    },
  };
  return source;
}

module.exports = { createMqttSource, decode };
