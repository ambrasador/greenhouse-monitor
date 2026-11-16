import { HttpError } from './http.js';

// Сеанс вебклієнта. Токени живуть лише в пам’яті сторінки: з localStorage їх прочитав би
// будь-який скрипт на сторінці, і вони пережили б вихід. Ціна — новий вхід після
// оновлення сторінки; про альтернативи (HttpOnly-cookie через BFF) див. розділ 6.7
export class SessionExpired extends Error {
  constructor() {
    super('Сеанс завершено: потрібен новий вхід');
    this.name = 'SessionExpired';
  }
}

// Типи Problem, за якими 401 означає «токен непридатний», а не «ім’я чи пароль хибні»
const BAD_TOKEN = /\/(token-expired|invalid-token|token-revoked)$/;

export function createSession({ base = '', fetchFn = (...a) => fetch(...a),
  now = Date.now, skewMs = 30_000, onSignedOut = () => {} }) {
  let tokens = null;                 // { access, refresh, expiresAt }
  let inflight = null;               // обмін refresh-токена, що триває

  const api = (path) => `${base}/api/v1${path}`;
  const post = (path, body) => fetchFn(api(path), { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const keep = (r) => {
    tokens = { access: r.access_token, refresh: r.refresh_token,
      expiresAt: now() + r.expires_in * 1000 };
  };
  const clear = () => {
    const was = tokens !== null;
    tokens = null;
    if (was) onSignedOut();
  };
  const failure = (res) => {
    const e = new HttpError(res.status);
    e.retryAfterMs = Number(res.headers.get('Retry-After') ?? 0) * 1000;
    return e;
  };

  async function login(username, password) {
    const res = await post('/auth/login', { username, password });
    if (!res.ok) throw failure(res);
    keep(await res.json());
  }

  async function exchange() {
    const res = await post('/auth/refresh', { refresh_token: tokens.refresh });
    if (res.status === 400 || res.status === 401) {   // invalid-grant: родину анульовано
      clear();
      throw new SessionExpired();
    }
    if (!res.ok) throw failure(res);                  // 5xx, 429: токени лишаємо, виклик повторять
    keep(await res.json());
  }

  // Один обмін на всіх: refresh-токен одноразовий, тож два паралельні обміни
  // дали б повторне пред’явлення старого. used — токен, з яким запит дістав 401:
  // якщо пару вже оновлено, ще один обмін не потрібен
  function refresh(used = tokens?.access) {
    if (!tokens) return Promise.reject(new SessionExpired());
    if (tokens.access !== used) return Promise.resolve();
    inflight ??= exchange().finally(() => { inflight = null; });
    return inflight;
  }

  async function accessToken() {
    if (!tokens) throw new SessionExpired();
    if (tokens.expiresAt - now() < skewMs) await refresh();    // до закінчення, а не після 401
    return tokens.access;
  }

  // fetch із токеном; на 401 «токен непридатний» — один обмін і один повтор
  async function authFetch(url, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken();
      const res = await fetchFn(url, { ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` } });
      if (res.status !== 401 || attempt > 0) return res;
      const problem = await res.clone().json().catch(() => null);
      if (!BAD_TOKEN.test(problem?.type ?? '')) return res;
      await refresh(token);
    }
  }

  async function streamTicket(device) {
    const res = await authFetch(api(`/devices/${encodeURIComponent(device)}/stream-ticket`),
      { method: 'POST' });
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()).ticket;
  }

  async function logout() {
    const token = tokens?.refresh;
    clear();                                          // спершу локально: вихід не залежить від мережі
    if (token) await post('/auth/logout', { refresh_token: token }).catch(() => {});
  }

  return { login, logout, authFetch, accessToken, refresh: () => refresh(), streamTicket,
    signedIn: () => tokens !== null };
}
