'use strict';
// Зонд для calc7-pyramid.mjs: підключається через NODE_OPTIONS=--require до кожного процесу
// node --test і при завершенні дописує у PROBE_OUT, чи процес відкривав сокети та чи завантажував SQLite
const net = require('node:net');
const fs = require('node:fs');
const seen = { net: false };
const wrap = (proto, name) => {
  const orig = proto[name];
  proto[name] = function (...a) { seen.net = true; return orig.apply(this, a); };
};
wrap(net.Server.prototype, 'listen');
wrap(net.Socket.prototype, 'connect');
process.on('exit', () => {
  if (!process.env.PROBE_OUT || !process.argv[1]) return;
  const db = Object.keys(require.cache).some((k) => k.includes('better-sqlite3/lib'));
  fs.appendFileSync(process.env.PROBE_OUT,
    JSON.stringify({ file: process.argv[1], net: seen.net, db }) + '\n');
});
