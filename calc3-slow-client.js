'use strict';
// Клієнт Socket.IO, якого батьківський процес заморожує після підписки
const { io } = require('socket.io-client');
const s = io(`http://127.0.0.1:${process.argv[2]}`, { transports: ['websocket'], reconnection: false });
s.on('connect', () => s.emit('subscribe', { device: 'gh1-s01' }, () => process.send('ready')));
s.on('telemetry:update', () => {});
