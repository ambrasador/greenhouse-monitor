'use strict';
// Чому тест «пошкоджений запис не проходить» падає приблизно в кожному шістнадцятому запуску
const { hashPassword, verifyPassword } = require('./passwords');
const FAST = { N: 2 ** 10, r: 8, p: 1 };
(async () => {
  const N = 3000;
  let passed = 0;
  const lastChars = {};
  for (let i = 0; i < N; i++) {
    const h = await hashPassword('correct horse battery', FAST);
    const mutated = h.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));          // як у тесті
    const ok = await verifyPassword('correct horse battery', mutated);
    if (ok) { passed++; const c = h.at(-1); lastChars[c] = (lastChars[c] ?? 0) + 1; }
  }
  console.log(JSON.stringify({ N, mutatedStillVerifies: passed, share: passed / N, expected: 1 / 16, lastCharsWhenVerified: lastChars }));
  // виправлена мутація: змінити символ у середині ключа
  let passed2 = 0;
  for (let i = 0; i < N; i++) {
    const h = await hashPassword('correct horse battery', FAST);
    const mutated = h.replace(/.(.{5})$/, (_, tail) => (h.at(-6) === 'A' ? 'B' : 'A') + tail);
    if (await verifyPassword('correct horse battery', mutated)) passed2++;
  }
  console.log(JSON.stringify({ fixedMutation_stillVerifies: passed2, of: N }));
})();
