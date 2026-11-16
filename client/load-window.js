// Читання останнього вікна з REST: по одній метриці, сторінки за курсором
export function createWindowLoader({ base = '', device, metrics,
  windowSec = 300, fetchFn = (...a) => fetch(...a), now = Date.now }) {
  return async function* loadWindow() {
    const skew = 60_000;                   // запас на неточний годинник клієнта
    const from = new Date(now() - windowSec * 1000 - skew).toISOString();
    const to = new Date(now() + skew).toISOString();
    for (const metric of metrics) {
      let cursor = null;
      do {
        const q = new URLSearchParams({ device, metric, from, to, limit: '1000' });
        if (cursor) q.set('cursor', cursor);
        const res = await fetchFn(`${base}/api/v1/telemetry?${q}`);
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          err.retryAfterMs = Number(res.headers.get('Retry-After') ?? 0) * 1000;
          throw err;
        }
        const { data, next } = await res.json();
        yield data.map((p) => ({ device, metric, ts: p.ts, value: p.value }));
        cursor = next;
      } while (cursor);
    }
  };
}
