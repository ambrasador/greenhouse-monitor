'use strict';

// Очікування умови опитуванням. Тест іде далі, щойно умова виконалась, а не через
// фіксований sleep: на швидкій машині він коротший, на повільній — не падає
async function waitFor(check, { timeoutMs = 3000, stepMs = 10, what = 'умова' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`не дочекались: ${what} (${timeoutMs} мс)`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

module.exports = { waitFor };
