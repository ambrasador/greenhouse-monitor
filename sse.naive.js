'use strict';
const { ApiError } = require('./problem');

const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

// SSE-потік одного пристрою. Поле id — ts події: після обриву браузер сам
// надішле останній id у заголовку Last-Event-ID, і сервер повторить усе,
// що було з цього ts (включно: ts не унікальний між метриками)
function createStreamHandler({ db, feed, metrics, heartbeatMs = 15_000,
  retryMs = 3000, maxBuffered = 1 << 20, replayLimit = 1000, perClient = 6,
  rnd = Math.random }) {
  const known = db.prepare('SELECT 1 FROM devices WHERE device_id = ?');
  const since = db.prepare(
    `SELECT metric, ts, value FROM telemetry
      WHERE device_id = @device AND ts >= @from
        AND metric IN (SELECT value FROM json_each(@metrics))
      ORDER BY ts LIMIT @limit`);
  const open = new Map();                  // клієнт → кількість потоків

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
    const n = open.get(req.ip) ?? 0;
    if (n >= perClient) {
      throw new ApiError(429, 'too-many-streams', 'Забагато відкритих потоків');
    }
    open.set(req.ip, n + 1);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',           // nginx не буферизує потік
    });
    // Кадр SSE: id = ts, щоб після обриву браузер повернув останній ts
    const frame = (r) => `id: ${r.ts}\nevent: telemetry\n`
      + `data: ${JSON.stringify({ device, ...r })}\n\n`;
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
    const timer = setInterval(
      () => res.write('event: hb\ndata: {}\n\n'), heartbeatMs);
    res.on('close', () => {
      clearInterval(timer);
      unsubscribe();
      open.set(req.ip, open.get(req.ip) - 1);
    });
  };
}

module.exports = { createStreamHandler };
