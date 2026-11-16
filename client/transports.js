import { io } from 'socket.io-client';

// Коди відмов рукостискання, які виправляє новий токен (розділ 6.5)
const TOKEN_CODES = new Set(['token-expired', 'invalid-token', 'token-revoked']);

// Транспорт Socket.IO: перепідключення вимкнено, ним керує контролер.
// token() повертає чинний токен доступу (сеанс оновлює його сам), renew()
// примусово обмінює refresh-токен; обидві потрібні лише при ввімкненій
// автентифікації
export function socketIoTransport({
  url, device, connect = io, token, renew,
}) {
  let socket;
  return {
    start(h) {
      socket = connect(url, {
        transports: ['websocket'], reconnection: false,
        // функція викликається при кожному (пере)підключенні: токен свіжий
        auth: token && ((cb) => token().then(
          (t) => cb({ token: t }), () => h.onFail('unauthorized'))),
      });
      socket.on('connect', () => {
        socket.timeout(5000).emit('subscribe', { device }, (err, res) => {
          if (err) h.onClose();               // сервер не відповів вчасно
          else if (res.ok) h.onOpen();        // кімнату приєднано
          else h.onFail(res.error);
        });
      });
      socket.on('telemetry:update', ({ device: d, readings }) =>
        h.onReadings(readings.map((r) => ({ device: d, ...r }))));
      socket.on('disconnect', () => h.onClose());
      socket.on('connect_error', (e) => {
        // токен відхилено: обмін і нова спроба
        if (renew && TOKEN_CODES.has(e.data?.code)) {
          renew().then(() => h.onClose(), () => h.onFail('unauthorized'));
        } else h.onClose();
      });
    },
    stop() { socket?.removeAllListeners(); socket?.close(); },
  };
}

// Транспорт SSE: браузер відновлює потік сам (із Last-Event-ID), доки
// відповідь не стане помилкою HTTP; тоді readyState = CLOSED і потік
// створюємо заново. Сторожовий таймер ловить потік, що мовчить.
// ticket() видає квиток для ?ticket= (EventSource не вміє задавати
// заголовки); квиток живе 30 с, тож на кожне створення потоку
// просимо новий
export function sseTransport({ url, device, metrics, silenceMs = 40_000,
  make = (u) => new EventSource(u), ticket }) {
  let es;
  let watchdog;
  let stopped = false;

  function open(h, address) {
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        es.close(); h.onClose();
      }, silenceMs);
    };
    es = make(address);
    alive();
    es.addEventListener('ready', () => { alive(); h.onOpen(); });
    es.addEventListener('hb', alive);
    es.addEventListener('reset', () => h.onGap());
    es.addEventListener('telemetry', (e) => {
      alive();
      h.onReadings([JSON.parse(e.data)]);
    });
    es.onerror = () => {
      clearTimeout(watchdog);  // далі веде лік браузер або контролер
      h.onClose({ willRetry: es.readyState !== 2 });
    };
  }

  return {
    start(h) {
      stopped = false;
      const path = `${url}/api/v1/devices/${device}/stream`;
      const query = `metrics=${metrics.join(',')}`;
      if (!ticket) { open(h, `${path}?${query}`); return; }
      ticket().then(
        (t) => {
          const q = `${query}&ticket=${encodeURIComponent(t)}`;
          if (!stopped) open(h, `${path}?${q}`);
        },
        (e) => {
          if (stopped) return;
          if (e.name === 'SessionExpired') h.onFail('unauthorized');
          else h.onClose();
        });
    },
    stop() { stopped = true; clearTimeout(watchdog); es?.close(); },
  };
}
