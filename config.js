'use strict';
// Конфігурація безпеки зі змінних середовища (12-factor, фактор III). Хибна
// конфігурація зупиняє запуск, а повідомлення називає всі проблеми одразу;
// значень секретів у ньому немає
const MIN_KEY_BYTES = 32;     // RFC 7518, 3.2: ключ HS256 не коротший за вихід SHA-256

function loadSecurityConfig(env = process.env) {
  if (env.AUTH_DISABLED === '1') return { enabled: false };    // лише для старих демо
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };

  // JWT_KEYS="k2:<base64>,k1:<base64>", JWT_CURRENT=k2: старий ключ лишається для
  // перевірки, поки не спливуть видані ним токени
  const keys = {};
  for (const item of (env.JWT_KEYS ?? '').split(',').filter(Boolean)) {
    const i = item.indexOf(':');
    if (i < 1) { check(false, 'JWT_KEYS: очікується kid:base64'); continue; }
    const kid = item.slice(0, i);
    const secret = Buffer.from(item.slice(i + 1), 'base64');
    check(/^[\w-]{1,16}$/.test(kid), 'JWT_KEYS: kid — до 16 символів [A-Za-z0-9_-]');
    check(secret.length >= MIN_KEY_BYTES, `JWT_KEYS: ключ ${kid} коротший за ${MIN_KEY_BYTES} байтів`);
    check(new Set(secret).size >= 8, `JWT_KEYS: ключ ${kid} схожий на заповнювач`);
    keys[kid] = secret;
  }
  check(Object.keys(keys).length > 0, 'JWT_KEYS: не задано');
  check(Object.hasOwn(keys, env.JWT_CURRENT ?? ''), 'JWT_CURRENT: немає серед JWT_KEYS');

  // WEBHOOK_SECRETS="новий,старий": підпис приймається за будь-яким
  const webhookSecrets = (env.WEBHOOK_SECRETS ?? '').split(',').filter(Boolean);
  check(webhookSecrets.length > 0, 'WEBHOOK_SECRETS: не задано');
  check(webhookSecrets.every((s) => s.length >= MIN_KEY_BYTES), `WEBHOOK_SECRETS: кожен секрет від ${MIN_KEY_BYTES} символів`);
  check(webhookSecrets.every((s) => new Set(s).size >= 8), 'WEBHOOK_SECRETS: секрет схожий на заповнювач');

  // INGEST_DEVICES — шаблон ідентифікаторів, які вправі надсилати вимірювання через вебхук
  let devicePattern;
  try { devicePattern = new RegExp(env.INGEST_DEVICES ?? '^[\\w-]+$'); }
  catch { check(false, 'INGEST_DEVICES: не є регулярним виразом'); }

  const origins = (env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
  check(origins.every((o) => /^https?:\/\/[^/]+$/.test(o)), 'ALLOWED_ORIGINS: очікуються origin без шляху');

  if (errors.length) throw new Error(`Некоректна конфігурація безпеки:\n - ${errors.join('\n - ')}`);
  return { enabled: true, keys, current: env.JWT_CURRENT, webhookSecrets, devicePattern, origins };
}

// Для журналу: ідентифікатори та кількості, ніколи самі значення
const describe = (cfg) => (cfg.enabled
  ? { auth: true, jwt_kids: Object.keys(cfg.keys), jwt_current: cfg.current,
      webhook_secrets: cfg.webhookSecrets.length, origins: cfg.origins }
  : { auth: false });

module.exports = { loadSecurityConfig, describe, MIN_KEY_BYTES };
