// M4: вартість підпису й перевірки токена доступу для HS256, RS256 (2048 біт) і ES256 (P-256) та
// розмір токена. Ті самі claims, що в еталоні (iss, aud, sub, role, ver, sid, iat, exp, jti), та сама
// бібліотека jsonwebtoken. Кожна цифра — медіана п’яти серій.
//   node calc6-jwt.mjs [out.json]
import { createSecretKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const hmac = randomBytes(32);
const hmacKey = createSecretKey(hmac);
const ALGS = [
  { alg: 'HS256', label: 'HS256, секрет-буфер', sign: hmac, verify: hmac, iters: 20_000 },
  { alg: 'HS256', label: 'HS256, KeyObject', sign: hmacKey, verify: hmacKey, iters: 20_000 },
  { alg: 'RS256', sign: rsa.privateKey, verify: rsa.publicKey, iters: 600 },
  { alg: 'ES256', sign: ec.privateKey, verify: ec.publicKey, iters: 2_000 },
];
const now = Math.floor(Date.now() / 1000);
const claims = () => ({ sub: randomUUID(), role: 'operator', ver: 3, sid: randomUUID(), jti: randomUUID(), iat: now, exp: now + 900 });
const opts = (alg) => ({ algorithm: alg, issuer: 'greenhouse-api', audience: 'greenhouse-api', keyid: 'k1', header: { typ: 'at+jwt' } });
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

const rows = [];
for (const { alg, label = alg, sign, verify, iters } of ALGS) {
  const tokens = Array.from({ length: Math.min(iters, 500) }, () => jwt.sign(claims(), sign, opts(alg)));
  const signT = [];
  const verT = [];
  for (let s = 0; s < 5; s++) {
    let t = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) jwt.sign(claims(), sign, opts(alg));
    signT.push(Number(process.hrtime.bigint() - t) / 1e3 / iters);                 // мкс
    t = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      jwt.verify(tokens[i % tokens.length], verify, { algorithms: [alg], issuer: 'greenhouse-api', audience: 'greenhouse-api', clockTimestamp: now });
    }
    verT.push(Number(process.hrtime.bigint() - t) / 1e3 / iters);
  }
  const row = { alg, label, tokenBytes: Buffer.byteLength(tokens[0]), signUs: median(signT), verifyUs: median(verT),
    verifyPerSec: 1e6 / median(verT), signPerSec: 1e6 / median(signT) };
  rows.push(row);
  console.log(`${label.padEnd(20)} токен ${row.tokenBytes} Б  підпис ${row.signUs.toFixed(1)} мкс (${Math.round(row.signPerSec)}/с)  перевірка ${row.verifyUs.toFixed(1)} мкс (${Math.round(row.verifyPerSec)}/с)`);
}
// розбір без перевірки підпису — це не автентифікація, лише вартість base64 і JSON.parse
const [h, p] = jwt.sign(claims(), hmac, opts('HS256')).split('.');
console.log(`частини HS256: заголовок ${h.length} + claims ${p.length} + підпис 43 символи`);
writeFileSync(process.argv[2] ?? 'results/jwt.json', JSON.stringify({ node: process.version, jsonwebtoken: require('jsonwebtoken/package.json').version, rows,
  parts: { header: h.length, payload: p.length, signature: 43 } }, null, 2));
