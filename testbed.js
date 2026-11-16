'use strict';
// Стенд розділу 3 в одному процесі: брокер Aedes (TCP і WebSocket), приймання
// з брокера, API, Socket.IO, SSE і статика демонстраційної сторінки
const net = require('node:net');
const path = require('node:path');
const express = require('express');
const mqtt = require('mqtt');
const { Aedes } = require('aedes');
const { createServer: brokerServer } = require('aedes-server-factory');
const { makeDb, addDevice } = require('./testkit');
const { createApp } = require('./app');
const { createFeed } = require('./feed');
const { createMqttSource } = require('./mqtt-source');
const { createServer } = require('./server');
const { attachRealtime } = require('./realtime');

async function startTestbed({ devices = [['gh1-s01', 'north']], windowMs = 100,
  ioOptions, sse = {}, dist = path.join(__dirname, 'client/dist') } = {}) {
  const aedes = await Aedes.createBroker();
  const tcp = net.createServer(aedes.handle);
  const ws = brokerServer(aedes, { ws: true });
  await Promise.all([new Promise((r) => tcp.listen(0, '127.0.0.1', r)),
    new Promise((r) => ws.listen(0, '127.0.0.1', r))]);
  const mqttUrl = `mqtt://127.0.0.1:${tcp.address().port}`;
  const wsPort = ws.address().port;

  const db = makeDb();
  for (const [id, zone] of devices) addDevice(db, id, zone);
  const feed = createFeed({ windowMs });
  const source = createMqttSource({ url: mqttUrl, clientId: 'ingest-bed',
    filter: 'greenhouse/+/telemetry' });
  const ingestApp = createApp({ db, source, onStored: feed.publish });
  await ingestApp.start();

  const state = { mqttConnected: true, lastReadingAt: null };
  const app = createServer({ db, state, sink: { async send() {} }, feed, sse,
    limits: { rate: 10_000, burst: 10_000, ingest: { rate: 10_000, burst: 10_000 } } });
  app.use(express.static(dist));
  const http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const realtime = attachRealtime(http, { db, feed, ioOptions,
    cors: { origin: '*' } });

  const device = mqtt.connect(mqttUrl, { clientId: 'sim-devices' });
  await new Promise((r) => device.once('connect', r));
  const publish = (id, body, qos = 1) => new Promise((resolve, reject) =>
    device.publish(`greenhouse/${id}/telemetry`, JSON.stringify(body), { qos },
      (e) => (e ? reject(e) : resolve())));

  return {
    db, feed, aedes, realtime, http, publish, ingestApp,
    httpPort: http.address().port, wsPort, mqttUrl,
    async stop() {
      await new Promise((r) => device.end(false, {}, r));
      await ingestApp.stop();
      await realtime.close();
      http.closeAllConnections();
      ws.closeAllConnections?.();
      await new Promise((r) => ws.close(r));
      await new Promise((r) => aedes.close(r));
      tcp.close();
    },
  };
}

module.exports = { startTestbed };
