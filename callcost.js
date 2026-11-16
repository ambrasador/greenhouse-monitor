'use strict';
// Вартість виклику «модуль → модуль» у процесі та «сервіс → сервіс» через HTTP (localhost)
const fs = require('node:fs');
const Module = require('node:module');
const express = require('express');
const autocannon = require('autocannon');

// check() не експортується з core.js: компілюємо копію з додатковим експортом
const src = fs.readFileSync(`${__dirname}/core.js`, 'utf8')
  + '\nmodule.exports.check = check;';
const m = new Module('core-copy'); m.paths = module.paths;
m._compile(src, `${__dirname}/core-copy.js`);
const { check } = m.exports;

const NOW = Date.parse('2026-11-03T12:00:00Z');
const mk = (i) => ({ deviceId: 'gh1-s01', metric: 'temperature',
  value: 15 + (i % 100) / 10, ts: '2026-11-03T11:59:00.000Z' });
let bad = 0; const N = 3e6;
for (let i = 0; i < 2e5; i++) check(mk(i), NOW);          // прогрів JIT
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) if (check(mk(i), NOW)) bad++;
const ns = Number(process.hrtime.bigint() - t0) / N;
console.log(`у процесі: check() разом зі створенням об'єкта — ${ns.toFixed(0)} нс/виклик (відхилено ${bad})`);

const app = express();
app.use(express.json());
app.post('/check', (req, res) => res.json({ reason: check(req.body, NOW) }));
const server = app.listen(3112, async () => {
  const r = await autocannon({
    url: 'http://127.0.0.1:3112/check', method: 'POST', connections: 1,
    duration: 6, headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mk(5)),
  });
  console.log(`через HTTP (localhost, 1 з'єднання): середня затримка ${r.latency.average} мс,`,
    `p99 ${r.latency.p99} мс, ${r.requests.average} запитів/с`);
  server.close(() => process.exit(0));
});
