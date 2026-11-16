'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHealthState, trackBroker } = require('./health');

// Клієнт MQTT замінює EventEmitter із полем connected: перевіряємо лише реакцію на його події
function setup(connected = true) {
  const client = Object.assign(new EventEmitter(), { connected });
  const state = createHealthState();
  const events = [];
  trackBroker(client, state, { clock: () => 42_000, log: (msg) => events.push(msg) });
  return { client, state, events };
}

test('перехід «брокер недоступний — доступний» потрапляє в журнал один раз', () => {
  const { client, state, events } = setup();
  assert.equal(state.mqttConnected, true);
  client.emit('close'); client.emit('close'); client.emit('close');   // повтори спроб під час збою
  assert.equal(state.mqttConnected, false);
  client.emit('connect'); client.emit('connect');
  assert.equal(state.mqttConnected, true);
  assert.deepEqual(events, ['broker_down', 'broker_up']);
});

test('показання від брокера оновлюють час останнього повідомлення, інші пакети — ні', () => {
  const { client, state } = setup();
  assert.equal(state.lastReadingAt, null);
  client.emit('packetreceive', { cmd: 'pingresp' });
  assert.equal(state.lastReadingAt, null);
  client.emit('packetreceive', { cmd: 'publish' });
  assert.equal(state.lastReadingAt, 42_000);
});

test('початковий стан береться з клієнта і в журнал не потрапляє', () => {
  const { state, events } = setup(false);
  assert.equal(state.mqttConnected, false);
  assert.deepEqual(events, []);
});
