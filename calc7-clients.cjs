'use strict';
// Клієнти для сценарію спостережуваності: три потоки SSE, п’ять з’єднань Socket.IO (кімната зони north),
// періодичні запити API, кілька хибних входів.
// Змінні: BASE, USER, PASS, T0 (мс), SSE_FROM, SSE_TO, WS_FROM, WS_TO, WS_N, BADLOGIN_AT (с від T0), DURATION, OUT
const { io } = require('socket.io-client');
const e = process.env;
const BASE = e.BASE ?? 'http://localhost:8080/api/v1', T0 = Number(e.T0 ?? Date.now());
const SSE = [Number(e.SSE_FROM ?? 40), Number(e.SSE_TO ?? 160)], BAD_AT = Number(e.BADLOGIN_AT ?? 140);
const WS = [Number(e.WS_FROM ?? 60), Number(e.WS_TO ?? 150)], WS_N = Number(e.WS_N ?? 5);
const DURATION = Number(e.DURATION ?? 240);
const events = [];
const at = (s) => new Promise((r) => setTimeout(r, Math.max(0, T0 + s * 1000 - Date.now())));
const note = (what, extra = {}) => events.push({ t: +((Date.now() - T0) / 1000).toFixed(2), what, ...extra });

async function main() {
  const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: e.USER, password: e.PASS }) });
  const token = (await login.json()).access_token;
  const auth = { Authorization: `Bearer ${token}` };
  const aborts = [];
  const stats = { sseEvents: 0, wsFrames: 0, http: {} };

  const streams = (async () => {
    await at(SSE[0]);
    for (const id of ['gh1-s001', 'gh1-s002', 'gh1-s003']) {
      const ac = new AbortController(); aborts.push(ac);
      fetch(`${BASE}/devices/${id}/stream`, { headers: auth, signal: ac.signal }).then(async (res) => {
        const reader = res.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; stats.sseEvents += (Buffer.from(value).toString().match(/^event:/gm) ?? []).length; }
      }).catch(() => {});
    }
    note('sse-open', { streams: 3 });
    await at(SSE[1]);
    aborts.forEach((a) => a.abort());
    note('sse-close');
  })();

  const sockets = (async () => {
    await at(WS[0]);
    const origin = new URL(BASE).origin, open = [];
    for (let i = 0; i < WS_N; i++) {
      const s = io(origin, { transports: ['websocket'], auth: { token }, reconnection: false });
      s.on('connect', () => s.emit('subscribe', { zone: 'north' }, () => {}));
      s.on('telemetry:update', () => { stats.wsFrames++; });
      open.push(s);
    }
    note('ws-open', { clients: WS_N });
    await at(WS[1]);
    open.forEach((s) => s.close());
    note('ws-close');
  })();

  const poll = (async () => {
    await at(10);
    for (let i = 0; Date.now() < T0 + (DURATION - 10) * 1000; i++) {
      const url = i % 10 === 9 ? `${BASE}/devices/nope` : (i % 2 ? `${BASE}/devices/gh1-s001` : `${BASE}/devices`);
      const r = await fetch(url, { headers: auth }); await r.arrayBuffer();
      stats.http[r.status] = (stats.http[r.status] ?? 0) + 1;
      await new Promise((r2) => setTimeout(r2, 1000));
    }
  })();

  const bad = (async () => {
    await at(BAD_AT);
    for (let i = 0; i < 12; i++) {                    // розпилення: різні імена, один пароль
      const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `user${i}`, password: 'password123' }) });
      await r.arrayBuffer();
      stats.http[`login${r.status}`] = (stats.http[`login${r.status}`] ?? 0) + 1;
    }
    note('bad-logins', { names: 12 });
  })();

  await Promise.all([streams, sockets, poll, bad]);
  const out = { events, ...stats };
  require('fs').writeFileSync(e.OUT ?? 'results/dashboard-clients.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
