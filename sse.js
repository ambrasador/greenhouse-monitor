'use strict';
const { ApiError } = require('./problem');

const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

// SSE-потік одного пристрою. Поле id — ts події: після обриву браузер сам
// надішле останній id у заголовку Last-Event-ID, і сервер повторить усе,
// що було з цього ts (включно: ts не унікальний між метриками)
// keyOf — кого рахувати в ліміті потоків (IP або користувач після входу);
// maxLifetimeMs > 0 закриває потік, щоб клієнт переавторизувався (розділ 6.5);
// valid(req) перевіряється при кожному hb: вимкнений користувач втрачає потік за ≤ heartbeatMs
function createStreamHandler({ db, feed, metrics, heartbeatMs = 15_000,
  retryMs = 3000, maxBuffered = 1 << 20, replayLimit = 1000, perClient = 6,
  rnd = Math.random, keyOf = (req) => req.ip, maxLifetimeMs = 0, valid = () => true }) {
  const known = db.prepare('SELECT 1 FROM devices WHERE device_id = ?');
  const since = db.prepare(
    `SELECT metric, ts, value FROM telemetry
      WHERE device_id = @device AND ts >= @from
        AND metric IN (SELECT value FROM json_each(@metrics))
      ORDER BY ts LIMIT @limit`);
  const open = new Map();                  // клієнт → кількість потоків
  const frames = new WeakMap();            // вимірювання → готовий кадр

  return (req, res) => {
    const device = req.params.id;
    const wanted = (req.query.metrics ?? [...metrics.keys()].join(','))
      .split(',');
    if (!known.get(device)) {
      throw new ApiError(404, 'device-not-found', 'Пристрій не знайдено');
    }
    if (wanted.some((m) => !metrics.has(m))) {
      throw new ApiError(400, 'invalid-query', 'Невідома метрика');
    }
    const who = keyOf(req);
    const n = open.get(who) ?? 0;
    if (n >= perClient) {
      throw new ApiError(429, 'too-many-streams', 'Забагато відкритих потоків');
    }
    open.set(who, n + 1);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',           // nginx не буферизує потік
    });
    // Кадр SSE: id = ts, щоб після обриву браузер повернув останній ts.
    // Рядок будують один раз на вимірювання: об’єкт спільний для всіх клієнтів
    const frame = (r) => {
      let f = frames.get(r);
      if (f === undefined) {
        f = `id: ${r.ts}\nevent: telemetry\n`
          + `data: ${JSON.stringify({ device, ...r })}\n\n`;
        frames.set(r, f);
      }
      return f;
    };
    const send = (readings) => {
      if (res.writableLength > maxBuffered) return res.destroy();
      res.write(readings.map(frame).join(''));      // одне записування на пакет
    };
    // 1. спершу підписка, 2. потім читання: подія не потрапить між ними
    const unsubscribe = feed.subscribe(device, (_device, readings) => {
      const mine = readings.filter((r) => wanted.includes(r.metric));
      if (mine.length) send(mine);
    });
    // retry із випадковою добавкою: після рестарту клієнти не прийдуть разом
    res.write(`retry: ${retryMs + Math.floor(rnd() * retryMs)}\n\n`);
    const last = req.get('Last-Event-ID');
    if (last && TS.test(last)) {
      const rows = since.all({ device, from: last, limit: replayLimit + 1,
        metrics: JSON.stringify(wanted) });
      if (rows.length > replayLimit) res.write('event: reset\ndata: {}\n\n');
      else if (rows.length) send(rows);
    }
    res.write('event: ready\ndata: {}\n\n');   // підписку підтверджено

    // hb — іменована подія, а не коментар: коментар невидимий для JavaScript,
    // і клієнт не зміг би за ним помітити, що потік мовчить
    const timer = setInterval(() => {
      if (!valid(req)) return res.end();
      res.write('event: hb\ndata: {}\n\n');
    }, heartbeatMs);
    const life = maxLifetimeMs > 0
      ? setTimeout(() => res.end(), maxLifetimeMs) : null;
    res.on('close', () => {
      clearInterval(timer);
      clearTimeout(life);
      unsubscribe();
      open.set(who, open.get(who) - 1);
    });
  };
}

module.exports = { createStreamHandler };
