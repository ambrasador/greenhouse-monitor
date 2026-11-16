'use strict';
// Шина зафіксованих вимірювань. Ядро приймання викликає publish лише після
// COMMIT, тож підписник ніколи не побачить подію, якої немає в базі.
// Події копичаться у вікні windowMs і доходять пакетом на пристрій:
// пакет з 500 подій webhook стає одним викликом, а не п’ятьмастами.
// Збій підписника не має впливати на приймання
function createFeed({ windowMs = 100, onError = () => {} } = {}) {
  const subs = new Map();                // пристрій або '*' → множина fn
  const pending = new Map();             // пристрій → вимірювання вікна
  let timer = null;

  function subscribe(key, fn) {          // fn(device, readings)
    const set = subs.get(key) ?? new Set();
    subs.set(key, set.add(fn));
    return () => {
      set.delete(fn);
      if (set.size === 0) subs.delete(key);
    };
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    for (const [device, readings] of pending) {
      for (const key of [device, '*']) {
        for (const fn of subs.get(key) ?? []) {
          try { fn(device, readings); } catch (e) { onError(e); }
        }
      }
    }
    pending.clear();
  }

  function publish({ device, metric, ts, value }) {
    const list = pending.get(device) ?? [];
    pending.set(device, list);
    list.push({ metric, ts, value });
    timer ??= setTimeout(flush, windowMs);
  }

  const size = () =>
    [...subs.values()].reduce((n, set) => n + set.size, 0);
  return { publish, subscribe, flush, size };
}

module.exports = { createFeed };
