// Числа для таблиць і відповідей до питань розділу 6, що рахуються формулами або вибираються з коду.
// Усе, що можна взяти з коду еталона, береться з нього: політика доступу — з policy.js, маршрути — з
// застосунку, лічильник повторів і ліміти — зі справжніх модулів із керованим годинником.
// Виміри M1–M7 лежать у results/*.json; тут вони лише читаються.
//   node calc6-answers.mjs [out.json]
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { ROLES, ACTIONS } = require('./policy');
const { makeSecure, routesOf, WEBHOOK_SECRET, FAST } = require('./auth-kit');
const { createLimiter } = require('./ratelimit');
const { createVerifier, sign } = require('./webhook-sign');
const { cellKm } = require('./privacy');
const { newCode } = require('./claim-codes');

const read = (name) => JSON.parse(readFileSync(new URL(`results/${name}.json`, import.meta.url)));
const scrypt = read('scrypt');
const webhook = read('webhook');
const jwt = read('jwt');
const privacy = read('privacy');
const refreshM = read('refresh');
const out = {};
const FAST_INGEST_RPS = 100;   // limits.ingest.rate у server.js

// Параметри п’яти доменів із розділів 1 і 4: N пристроїв, m метрик, період T, U екранів
const DOMAINS = [
  { id: 'greenhouse', name: 'Теплиця', N: 200, m: 4, T: 60, U: 20 },
  { id: 'home', name: 'Розумний будинок', N: 3000, m: 1, T: 300, U: 2000 },
  { id: 'metering', name: 'Лічильники', N: 100000, m: 1, T: 900, U: 5000 },
  { id: 'fleet', name: 'Парк', N: 300, m: 1, T: 5, U: 10 },
  { id: 'community', name: 'Громада', N: 1500, m: 1, T: 300, U: 50 },
].map((d) => ({ ...d, lambda: (d.N * d.m) / d.T }));

// 1. Ліміт входу: скільки спроб за добу пропускає кошик (модуль ratelimit.js, керований годинник)
function attemptsPerDay(rate, burst, stepSec = 1) {
  let now = 0;
  const lim = createLimiter({ rate, burst, clock: () => now });
  let ok = 0;
  for (now = 0; now <= 86_400_000; now += stepSec * 1000) if (lim.take('k').ok) ok++;   // від 00:00:00 до 24:00:00 включно
  return ok;
}
const perName = attemptsPerDay(1 / 60, 5);
const perIp = attemptsPerDay(1 / 10, 20);
out.throttle = {
  perName, perIp,
  days10k: 10_000 / perName,
  hours1k: (1_000 / perName) * 24,
  days1e6: 1e6 / perName,
  // «розпилення»: один пароль проти багатьох імен з однієї адреси
  spray: DOMAINS.map((d) => ({ id: d.id, U: d.U, top10Days: (10 * d.U * 10) / 86_400 })),
};

// 2. PKCE: вектор із додатка B RFC 7636 і довжина верифікатора
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = createHash('sha256').update(verifier).digest('base64url');
out.pkce = { verifier, challenge, expected: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  ok: challenge === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  verifierLen: verifier.length, octetsFor43: Math.ceil((43 * 6) / 8) };

// 3. Код прив’язки: 80 біт; порівняння із шестицифровим PIN
const code = newCode();
const dayGuesses = perName;
out.claim = {
  example: code, bits: 80, format: /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test(code),
  halfSpaceDays80: 2 ** 79 / dayGuesses,
  halfSpaceYears80: 2 ** 79 / dayGuesses / 365.25,
  pinMeanDays: 1e6 / 2 / dayGuesses,
  pin1000AccountsHours: (1e6 / 2 / (dayGuesses * 1000)) * 24,
};

// 4. Секрет вебхука: час перебору для вимірюваної швидкості на одному ядрі
const rate = webhook.guessPerSec;
const space = {
  'шість цифр': 10 ** 6, 'вісім малих літер': 26 ** 8, 'вісім літер і цифр': 62 ** 8,
  'дванадцять літер і цифр': 62 ** 12, '32 випадкові байти': 2 ** 256,
};
out.secret = {
  guessPerSec: rate,
  rows: Object.entries(space).map(([name, n]) => ({ name, space: n, sec: n / rate / 2,
    days: n / rate / 2 / 86_400, years: n / rate / 2 / 86_400 / 365.25 })),
};

// 5. Кеш повторів: найбільший розмір map у модулі webhook-sign при рівномірному потоці λ запитів/с
function replayPeak(lambda, skewSec, seconds = 3000) {
  let now = Date.parse('2026-11-05T09:00:00Z');
  const clock = () => now;
  const v = createVerifier({ secrets: [WEBHOOK_SECRET], clock });
  let peak = 0;
  let i = 0;
  const step = 1000 / lambda;
  for (let t = 0; t < seconds * 1000; t += step) {
    now += step;
    const raw = Buffer.from(`m${i++}`);
    const why = v(sign(WEBHOOK_SECRET, raw, Math.floor(now / 1000) + skewSec), raw);
    if (why) throw new Error(`несподівана відмова ${why}`);
    peak = Math.max(peak, v.size());
  }
  return peak;
}
const BYTES_PER_ENTRY = webhook.replay.bytesPerEntry;
out.replay = {
  bytesPerEntry: BYTES_PER_ENTRY,
  probe: [10, 50].map((l) => ({ lambda: l, peakExact: replayPeak(l, 0), peakAhead: replayPeak(l, 300) })),
  domains: DOMAINS.map((d) => ({ id: d.id, lambda: d.lambda, entries600: d.lambda * 600,
    entries900: d.lambda * 900, mb600: (d.lambda * 600 * BYTES_PER_ENTRY) / 1e6,
    mb900: (d.lambda * 900 * BYTES_PER_ENTRY) / 1e6 })),
};

// 6. Місткість шлюзу хешування за виміром M1 (параметри OWASP N = 2^15, r = 8, p = 3)
const owasp = scrypt.rows.find((r) => r.N === 32768 && r.p === 3);
const hashSec = owasp.ms.median / 1000;
const GATE = 2;
const QUEUE = 32;
out.gate = {
  hashMs: owasp.ms.median, concurrency: GATE, queue: QUEUE,
  capacityPerSec: GATE / hashSec, maxQueueWaitSec: QUEUE / (GATE / hashSec),
  admittedAtOnce: GATE + QUEUE,
  domains: DOMAINS.map((d) => ({ id: d.id, U: d.U, allLoginSec: d.U / (GATE / hashSec),
    refreshPerSec: d.U / 900, shedShare60s: Math.max(0, 1 - (GATE / hashSec) / (d.U / 60)) })),
  offlinePerSec: owasp.parallelPerSec,
  offlineDict1e6Hours: 1e6 / owasp.parallelPerSec / 3600,
  shaPerSec: privacy.pseudonym.shaPerSec,
  shaOverScrypt: privacy.pseudonym.shaPerSec / owasp.parallelPerSec,
};

// 7. Матриця «роль × дія» з policy.js і відповідність маршрутів діям у справжньому застосунку
const matrix = Object.entries(ACTIONS).map(([action, roles]) => ({
  action, ...Object.fromEntries(ROLES.map((r) => [r, roles.includes(r)])) }));
const allowed = Object.fromEntries(ROLES.map((r) => [r, matrix.filter((m) => m[r]).length]));
const bed = await makeSecure({ params: FAST });
const routes = routesOf(bed.app);
const byAction = {};
for (const r of routes) (byAction[r.action ?? '(без дії)'] ??= []).push(r.key);
out.rbac = {
  roles: ROLES, actions: matrix.length, cells: matrix.length * ROLES.length,
  allowed, allowedTotal: Object.values(allowed).reduce((a, b) => a + b, 0), matrix,
  routes: routes.length, byAction,
  counts: Object.fromEntries(Object.entries(byAction).map(([a, l]) => [a, l.length])),
};

// 8. Розмір токена: base64url без доповнення, 4n/3 символів
const b64 = (bytes) => Math.ceil((bytes * 4) / 3);
const body = jwt.parts.header + jwt.parts.payload + 2;
const hsBytes = jwt.rows.find((r) => r.label === 'HS256, KeyObject').tokenBytes;
out.jwt = {
  sigChars: { HS256: b64(32), RS256: b64(256), ES256: b64(64) },
  tokenBytes: Object.fromEntries(['HS256', 'RS256', 'ES256'].map((a) => [a,
    body + { HS256: b64(32), RS256: b64(256), ES256: b64(64) }[a]])),
  measured: jwt.rows.map((r) => ({ alg: r.alg, tokenBytes: r.tokenBytes })),
  headerLine: 'Authorization: Bearer '.length,
  perRequestBytes: 'Authorization: Bearer '.length + hsBytes + 2,
  at4000rps: (('Authorization: Bearer '.length + hsBytes + 2) * 4000) / 1e6,
};

// 9. Строк зберігання: скільки рядків на добу і скільки часу забирає нічне прибирання пакетами
const batchMs = privacy.retention.results.find((r) => r.batch === 5000);
out.retention = {
  batch: 5000, batchMedianMs: batchMs.medianMs, batchMaxMs: batchMs.maxMs,
  domains: DOMAINS.map((d) => {
    const rows = (d.N * d.m * 86_400) / d.T;
    return { id: d.id, rowsPerDay: rows, batches: Math.ceil(rows / 5000),
      totalSec: Math.ceil(rows / 5000) * (batchMs.medianMs / 1000) };
  }),
};

// 10. Сітка координат: розмір комірки для міст (довгота зменшується як cos φ)
const CITIES = [['Херсон', 46.6354], ['Одеса', 46.4825], ['Львів', 49.8397], ['Харків', 49.9935], ['Київ', 50.4501]];
out.grid = CITIES.flatMap(([city, lat]) => [0.01, 0.001].map((deg) => {
  const k = cellKm(lat, deg);
  return { city, lat, deg, ns: k.northSouth, ew: k.eastWest, maxErr: Math.hypot(k.northSouth, k.eastWest) / 2 };
}));

// 11. Псевдоніми: перебір простору ідентифікаторів зі швидкістю SHA-256
const sha = privacy.pseudonym.shaPerSec;
out.pseudonym = [1e6, 1e9, 1e12].map((n) => ({ space: n, sec: n / sha, min: n / sha / 60, days: n / sha / 86_400 }));

// 12. Відкликання довгих з’єднань: найгірше запізнення = період перевірки
out.revoke = { sseHeartbeatSec: 15, socketRevalidateSec: 30, accessTtlSec: 900 };

// 13. Ротація refresh-токена: рядки, що накопичує сеанс з обміном щоразу при спливанні токена доступу
const rowsPerSession = refreshM.steadyRowsPerSession;
out.refresh = {
  exchangeUs: refreshM.exchangeUs.median, exchangesPerSec: refreshM.exchangesPerSec,
  bytesPerRow: refreshM.bytesPerRow, rowsPerDay: refreshM.rowsPerDay, rowsPerSession,
  mibPerSession: (rowsPerSession * refreshM.bytesPerRow) / 2 ** 20,
  domains: DOMAINS.map((d) => ({ id: d.id, U: d.U, rowsPerDay: d.U * refreshM.rowsPerDay,
    steadyRows: d.U * rowsPerSession, steadyMiB: (d.U * rowsPerSession * refreshM.bytesPerRow) / 2 ** 20,
    exchangesPerSec: d.U / 900, loginShare: (d.U / 900) * (refreshM.exchangeUs.median / 1e6) })),
};

// 14. Частка ядра, яку забирає перевірка токена при потоці читання R (розділ 4: 4 000 запитів за секунду)
out.jwt.coreShare = Object.fromEntries(jwt.rows.map((r) => [r.label, (r.verifyUs * 4000) / 1e6]));

// 15. Вебхук: пакет із 500 подій (зразок з тестів), запас до ліміту 256 КБ і найгірша вартість підписів
// під атакою: ліміт ingest (100 запитів за секунду з адреси), тіло на межі ліміту, два секрети
const sampleEvent = (i) => ({ device_id: `gh1-s${String(i % 200).padStart(2, '0')}`, metric: 'humidity',
  value: 55.5, ts: new Date(1.8e12 + i * 1000).toISOString() });
const batchBytes = Buffer.byteLength(JSON.stringify({ events: Array.from({ length: 500 }, (_, i) => sampleEvent(i)) }));
const limitBytes = webhook.cost.at(-1).bytes;
const worst = webhook.cost.at(-1).hmacUs;
out.webhook = {
  batch500Bytes: batchBytes, bytesPerEvent: batchBytes / 500, limitBytes, headroom: limitBytes / batchBytes,
  throughputMBs: limitBytes / worst, floodRps: FAST_INGEST_RPS, secrets: 2,
  floodCoreShare: FAST_INGEST_RPS * 2 * worst / 1e6,
  ratio: webhook.cost.map((r) => ({ bytes: r.bytes, ratio: r.withReplayUs / r.hmacUs })),
};
// 3-bis. Код прив’язки у витоку бази: SHA-256 швидкий, але 80 біт випадковості перебрати неможливо,
// а шестицифровий PIN під тим самим хешем падає за долю секунди
out.claim.offlineSha256Years80 = 2 ** 79 / privacy.pseudonym.shaPerSec / 86_400 / 365.25;
out.claim.offlineSha256PinSec = 1e6 / privacy.pseudonym.shaPerSec;

const path = process.argv[2] ?? new URL('results/answers.json', import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 2));
const p = (k, v) => console.log(k.padEnd(28), typeof v === 'object' ? JSON.stringify(v) : v);
p('спроб/добу на ім’я', perName); p('спроб/добу з адреси', perIp);
p('PKCE ок', out.pkce.ok); p('код', code);
p('кеш повторів, піки', out.replay.probe);
p('шлюз, вх/с', out.gate.capacityPerSec.toFixed(2));
p('матриця дозволено', out.rbac.allowed); p('маршрутів', routes.length); p('за діями', out.rbac.counts);
p('JWT, символів підпису', out.jwt.sigChars); p('JWT, байтів', out.jwt.tokenBytes);
process.exit(0);
