'use strict';
const pino = require('pino');

// Журнал — потік рядків JSON у стандартний вивід (12-factor, фактор XI):
// процес не керує файлами, їх збирає оточення. Рівень задає LOG_LEVEL.
// Поля, у яких могли б опинитися секрети, замінюються до запису рядка
const REDACT = ['req.headers.authorization', 'req.headers.cookie',
  'password', 'token', 'refresh_token', 'secret'];

// Рівень повідомлень, які модулі розділів 1–6 передають як log(msg, поля)
const LEVELS = {
  unhandled: 'error', audit_failed: 'error', feed_error: 'error',
  dispatch_failed: 'error', 'push-failed': 'error', 'fcm-config': 'error',
  'fcm-invalid': 'warn', broker_down: 'warn',
};

function createLogger({ level = process.env.LOG_LEVEL ?? 'info',
  destination } = {}) {
  const logger = pino({
    level,
    base: { service: 'greenhouse' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT, censor: '[скрито]' },
  }, destination);
  const log = (msg, fields = {}) =>
    logger[LEVELS[msg] ?? 'info'](fields, msg);
  return { logger, log };
}

module.exports = { createLogger, REDACT };
