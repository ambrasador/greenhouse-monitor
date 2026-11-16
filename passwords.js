'use strict';
const { scrypt, randomBytes, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { ApiError } = require('./problem');

const scryptAsync = promisify(scrypt);

// OWASP Password Storage Cheat Sheet: N = 2^15, r = 8, p = 3 (32 МіБ)
const DEFAULT_PARAMS = { N: 2 ** 15, r: 8, p: 3 };
const KEY_LEN = 32;
// scrypt потребує 128·N·r байтів; Node за замовчуванням дозволяє лише
// 32 МіБ разом зі службовими буферами, тож межу піднімаємо з запасом
const maxmem = ({ N, r }) => 256 * N * r;

const derive = (password, salt, prm) => scryptAsync(
  password.normalize('NFKC'), salt, KEY_LEN,
  { ...prm, maxmem: maxmem(prm) });

// Формат запису: scrypt$N$r$p$сіль$ключ (base64url); параметри живуть
// разом із хешем
async function hashPassword(password, prm = DEFAULT_PARAMS) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, prm);
  return ['scrypt', prm.N, prm.r, prm.p, salt.toString('base64url'),
    key.toString('base64url')].join('$');
}

function parse(stored) {
  const [alg, N, r, p, salt, key] = String(stored).split('$');
  const prm = { N: Number(N), r: Number(r), p: Number(p) };
  const sane = alg === 'scrypt' && key !== undefined
    && Number.isInteger(Math.log2(prm.N)) && prm.N >= 2 ** 10
    && Number.isInteger(prm.r) && prm.r >= 1 && Number.isInteger(prm.p)
    && prm.p >= 1 && prm.p <= 16 && 128 * prm.N * prm.r <= 2 ** 28;
  return sane ? { prm, salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') } : null;
}

async function verifyPassword(password, stored) {
  const rec = parse(stored);
  if (!rec) return false;
  const got = await derive(password, rec.salt, rec.prm);
  return got.length === rec.key.length && timingSafeEqual(got, rec.key);
}

const needsRehash = (stored, prm = DEFAULT_PARAMS) => {
  const rec = parse(stored);
  return !rec || rec.prm.N !== prm.N || rec.prm.r !== prm.r || rec.prm.p !== prm.p;
};

// Не більше `limit` хешувань одночасно, ще до `maxQueue` чекають. Кожне
// хешування займає потік пулу libuv (4 за замовчуванням) і десятки
// мегабайтів
function createGate(limit, maxQueue) {
  let active = 0;
  const waiting = [];
  return async (work) => {
    if (active < limit) active++;
    else if (waiting.length < maxQueue) {
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      throw new ApiError(503, 'busy', 'Сервер зайнятий, повторіть пізніше',
        {}, { 'Retry-After': '1' });
    }
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();            // місце переходить до наступного в черзі
      else active--;
    }
  };
}

function createPasswordService({ params = DEFAULT_PARAMS, concurrency = 2, maxQueue = 32 } = {}) {
  const gate = createGate(concurrency, maxQueue);
  return {
    params,
    hash: (password) => gate(() => hashPassword(password, params)),
    verify: (password, stored) => gate(() => verifyPassword(password, stored)),
    needsRehash: (stored) => needsRehash(stored, params),
  };
}

module.exports = { DEFAULT_PARAMS, hashPassword, verifyPassword, needsRehash, createGate, createPasswordService };
