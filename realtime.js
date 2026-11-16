'use strict';
const { Server } = require('socket.io');

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_ROOMS = 20;                      // підписок на одне з’єднання

// Кімнати: device:<id> — один пристрій, zone:<зона> — усі пристрої зони.
// auth (розділ 6) вмикає перевірку токена при підключенні й права на
// кімнату; origins — дозволені значення Origin для браузерів (рідні
// клієнти його не надсилають)
function attachRealtime(httpServer, {
  db, feed, cors, ioOptions, auth, origins, maxQueue = 500, sweepMs = 1000,
  recoveryMs = 0, revalidateMs = 30_000, clock = Date.now,
}) {
  const io = new Server(httpServer, {
    cors,
    allowRequest: origins && ((req, ok) => ok(null, !req.headers.origin
      || origins.includes(req.headers.origin))),
    // Відновлення стану Socket.IO вимкнено: клієнт узгоджує ряд через REST.
    // Ціна ввімкнення — розділ 3.3.3
    connectionStateRecovery: recoveryMs > 0
      ? { maxDisconnectionDuration: recoveryMs } : undefined,
    ...ioOptions,
  });
  const exists = {
    device: db.prepare('SELECT 1 FROM devices WHERE device_id = ?'),
    zone: db.prepare('SELECT 1 FROM devices WHERE zone = ? LIMIT 1'),
  };
  const zoneOf = db.prepare('SELECT zone FROM devices WHERE device_id = ?');

  // Токен у socket.handshake.auth.token: у URL його немає, тож він не
  // потрапляє в журнали
  if (auth) {
    io.use((socket, next) => {
      try {
        socket.data.user =
          auth.identifySocket(socket.handshake.auth?.token);
        next();
      } catch (e) {
        next(Object.assign(new Error('unauthorized'),
          { data: { code: e.code ?? 'unauthorized' } }));
      }
    });
  }

  io.on('connection', (socket) => {
    const user = socket.data.user;
    // з’єднання живе довше за токен: у момент exp його закриває сервер
    if (user) {
      const left = Math.max(0, user.exp * 1000 - clock());
      const timer = setTimeout(() => socket.disconnect(true), left);
      socket.on('disconnect', () => clearTimeout(timer));
    }
    socket.on('subscribe', async (req, ack = () => {}) => {
      const kind = req?.device !== undefined ? 'device' : 'zone';
      const name = req?.[kind];
      const fail = (error) => ack({ ok: false, error });
      const valid = typeof name === 'string' && NAME.test(name);
      if (!valid) return fail('bad_name');
      if (!exists[kind].get(name)) return fail('unknown');
      if (socket.rooms.size > MAX_ROOMS) return fail('too_many_rooms');
      // Немає права — та сама відповідь, що й для неіснуючої кімнати
      if (user && !auth.canSubscribe(user, kind, name)) {
        return fail('unknown');
      }
      await socket.join(`${kind}:${name}`);
      ack({ ok: true });                   // підтвердження — після join
    });
  });

  // Кадр на пристрій за вікно шини; у двох кімнатах клієнт отримає його раз
  const unsubscribe = feed.subscribe('*', (device, readings) => {
    const zone = zoneOf.get(device)?.zone;
    const rooms = io.to(`device:${device}`);
    (zone ? rooms.to(`zone:${zone}`) : rooms)
      .emit('telemetry:update', { device, readings });
  });

  // Клієнт, що перестав читати, накопичує кадри в черзі engine.io аж до
  // тайм-ауту ping (45 с). Закриваємо його, щойно черга перевищить maxQueue:
  // клієнт перепідключиться й перечитає вікно з API. close(true) не чекає
  // спорожнення черги; socket.disconnect(true) чекав би його вічно
  const sweep = setInterval(() => {
    for (const s of io.sockets.sockets.values()) {
      if (s.conn.writeBuffer.length > maxQueue) s.conn.close(true);
    }
  }, sweepMs);
  sweep.unref();

  // Токен перевірено при підключенні, а обліковий запис міг змінитися: раз на revalidateMs
  // кожне з’єднання звіряється з базою (один запит за первинним ключем на сокет)
  const recheck = auth && setInterval(() => {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.user && !auth.stillValid(s.data.user)) s.disconnect(true);
    }
  }, revalidateMs);
  recheck?.unref();

  function close() {
    clearInterval(sweep);
    clearInterval(recheck);
    unsubscribe();
    return io.close();
  }
  return { io, close };
}

module.exports = { attachRealtime };
