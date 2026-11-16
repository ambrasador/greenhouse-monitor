'use strict';
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';   // RFC 6455, п. 1.3

// Відповідь сервера на Sec-WebSocket-Key: SHA-1(ключ + GUID) у base64
const acceptKey = (key) =>
  crypto.createHash('sha1').update(key + GUID).digest('base64');

// Кадр без фрагментації (FIN = 1). Клієнт мусить маскувати, сервер — ні
function encodeFrame(payload, { opcode = 0x1, mask = false, key } = {}) {
  const body = Buffer.from(payload);
  const n = body.length;
  const m = mask ? 0x80 : 0;
  let head;
  if (n < 126) {
    head = Buffer.from([0x80 | opcode, m | n]);
  } else if (n < 65536) {
    head = Buffer.from([0x80 | opcode, m | 126, n >> 8, n & 255]);
  } else {
    head = Buffer.alloc(10);
    head.writeUInt8(0x80 | opcode, 0);
    head.writeUInt8(m | 127, 1);
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  if (!mask) return Buffer.concat([head, body]);
  const k = key ?? crypto.randomBytes(4);
  const out = Buffer.from(body);
  for (let i = 0; i < n; i++) out[i] ^= k[i % 4];
  return Buffer.concat([head, k, out]);
}

// Розбір одного кадру з початку буфера; null, якщо кадр неповний
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let n = buf[1] & 0x7f;
  let pos = 2;
  if (n === 126) { if (buf.length < 4) return null; n = buf.readUInt16BE(2); pos = 4; }
  else if (n === 127) { if (buf.length < 10) return null; n = Number(buf.readBigUInt64BE(2)); pos = 10; }
  const end = pos + (masked ? 4 : 0) + n;
  if (buf.length < end) return null;
  const payload = Buffer.from(buf.subarray(end - n, end));
  if (masked) {
    const k = buf.subarray(pos, pos + 4);
    for (let i = 0; i < n; i++) payload[i] ^= k[i % 4];
  }
  return { fin: (buf[0] & 0x80) !== 0, opcode: buf[0] & 0x0f, masked, payload, size: end };
}

module.exports = { acceptKey, encodeFrame, decodeFrame };
