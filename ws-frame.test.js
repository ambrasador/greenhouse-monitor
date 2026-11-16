'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { WebSocketServer } = require('ws');
const { acceptKey, encodeFrame, decodeFrame } = require('./ws-frame');

// Приклади з RFC 6455
test('Sec-WebSocket-Accept для ключа з п. 1.3 RFC 6455', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('кадри «Hello» з п. 5.7 RFC 6455: без маски і з маскою', () => {
  assert.deepEqual([...encodeFrame('Hello')], [0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  const key = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  assert.deepEqual([...encodeFrame('Hello', { mask: true, key })],
    [0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
});

test('довжина корисного навантаження: 7 бітів, 16 бітів, 64 біти', () => {
  for (const [n, header] of [[125, 2], [126, 4], [65535, 4], [65536, 10]]) {
    const f = encodeFrame(Buffer.alloc(n, 0x61));
    assert.equal(f.length, header + n, `n = ${n}`);
    assert.equal(decodeFrame(f).payload.length, n);
  }
  const masked = encodeFrame(Buffer.alloc(100, 1), { mask: true });
  assert.equal(masked.length, 2 + 4 + 100);          // маска додає 4 байти
});

test('неповний кадр повертає null; два кадри в буфері розбираються по одному', () => {
  const a = encodeFrame('перший');
  const b = encodeFrame('другий', { opcode: 0x2 });
  assert.equal(decodeFrame(a.subarray(0, a.length - 1)), null);
  const both = Buffer.concat([a, b]);
  const f1 = decodeFrame(both);
  assert.equal(f1.payload.toString(), 'перший');
  const f2 = decodeFrame(both.subarray(f1.size));
  assert.deepEqual([f2.opcode, f2.payload.toString()], [2, 'другий']);
});

// Сирий клієнт на net.Socket проти справжнього сервера ws
test('рукостискання вручну: 101, Accept збігається, кадри ходять в обидва боки', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (c) => c.on('message', (m) => c.send(`луна: ${m}`)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const sock = net.connect(port, '127.0.0.1');
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  sock.write(['GET /chat HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket',
    'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
  let buf = Buffer.alloc(0);
  const until = (pred) => new Promise((resolve) => {
    const check = () => { const v = pred(buf); if (v) { sock.off('data', on); resolve(v); } };
    const on = (d) => { buf = Buffer.concat([buf, d]); check(); };
    sock.on('data', on); check();
  });
  const end = await until((b) => { const i = b.indexOf('\r\n\r\n'); return i < 0 ? 0 : i + 4; });
  const head = buf.subarray(0, end).toString();
  assert.match(head, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(head, new RegExp(`Sec-WebSocket-Accept: ${acceptKey(key).replace(/\+/g, '\\+')}`, 'i'));
  buf = buf.subarray(end);

  sock.write(encodeFrame('привіт', { mask: true }));
  const frame = await until((b) => decodeFrame(b));
  assert.equal(frame.masked, false);                 // сервер не маскує
  assert.equal(frame.payload.toString(), 'луна: привіт');
  sock.destroy();
  wss.close();
  await new Promise((r) => server.close(r));
});
