'use strict';
// HEALTHCHECK образу: код 0 — застосунок готовий, 1 — ні. В образі
// node:slim немає curl, тому запит робить вбудований fetch Node.js 22
const port = process.env.PORT ?? 3000;
fetch(`http://127.0.0.1:${port}/readyz`,
  { signal: AbortSignal.timeout(2000) })
  .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
