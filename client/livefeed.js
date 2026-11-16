import { createStore } from './series.js';
import { delay } from './backoff.js';

// Контролер живого потоку. Не знає ні транспорту, ні React.
// Транспорт повідомляє про події через обробники:
//   onOpen()         — сервер підтвердив підписку (не просто TCP-з’єднання)
//   onReadings(list) — нові вимірювання { device, metric, ts, value }
//   onGap()          — можливі пропуски: перечитати вікно
//   onClose(info)    — зв’язок утрачено; info.willRetry — транспорт відновиться сам
//   onFail(reason)   — помилка, яку повтор не виправить
export function createLiveFeed({ transport, loadWindow, onView, maxPoints = 300,
  flushMs = 1000, delayFor = delay, now = Date.now }) {
  const store = createStore(maxPoints);
  const state = { status: 'connecting', attempt: 0, error: null, dataAt: null,
    applied: 0, dups: 0 };
  const timer = { retry: null, sync: null, flush: null };
  let dirty = false;
  let current = null;                      // обробники чинного підключення

  const publish = () => {
    dirty = false;
    onView({ ...state, series: store.snapshot() });
  };
  const setStatus = (status, error = null) => {
    Object.assign(state, { status, error });
    publish();                             // стан зв’язку не тротлять
  };
  const apply = (list) => {
    for (const r of list) {
      const added = store.apply(r);
      state[added ? 'applied' : 'dups'] += 1;
      dirty = added || dirty;
    }
    if (list.length) state.dataAt = now();
  };

  // Початкове завантаження й відновлення — це одна й та сама функція
  async function sync(h, tries = 0) {
    try {
      for await (const page of loadWindow()) {
        if (h !== current) return;         // підключення вже інше
        apply(page);
      }
    } catch (e) {
      if (h !== current) return;
      const wait = e.retryAfterMs || delayFor(tries + 1);
      timer.sync = setTimeout(() => sync(h, tries + 1), wait);
    }
  }

  function connect() {
    const h = current = {
      closed: false,
      onOpen() {
        if (h !== current) return;
        state.attempt = 0;
        setStatus('online');
        sync(h);
      },
      onReadings(list) { if (h === current) apply(list); },
      onGap() { if (h === current) sync(h); },
      onClose({ willRetry = false } = {}) {
        if (h !== current || (h.closed && !willRetry)) return;
        h.closed = !willRetry;
        state.attempt += 1;
        setStatus('reconnecting');
        if (!willRetry) {                  // перепідключаємо самі
          transport.stop();
          timer.retry = setTimeout(connect, delayFor(state.attempt));
        }
      },
      onFail(reason) {
        if (h !== current) return;
        transport.stop();
        setStatus('failed', reason);
      },
    };
    transport.start(h);
  }

  return {
    start() {
      timer.flush = setInterval(() => dirty && publish(), flushMs);
      publish();
      connect();
    },
    stop() {
      current = null;
      Object.values(timer).forEach(clearTimeout);   // clearTimeout чистить і interval
      transport.stop();
    },
  };
}
