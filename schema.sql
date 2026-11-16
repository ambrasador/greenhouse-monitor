-- Історія вимірювань: ключ ідемпотентності є первинним ключем
CREATE TABLE telemetry (
  device_id   TEXT NOT NULL,
  metric      TEXT NOT NULL,
  ts          TEXT NOT NULL,   -- час вимірювання: UTC, ISO 8601, мс
  received_at TEXT NOT NULL,   -- час приймання застосунком, UTC
  value       REAL NOT NULL,
  PRIMARY KEY (device_id, metric, ts)
) WITHOUT ROWID;

-- Останнє значення кожного потоку: читається дашбордом найчастіше
CREATE TABLE latest (
  device_id TEXT NOT NULL,
  metric    TEXT NOT NULL,
  ts        TEXT NOT NULL,
  value     REAL NOT NULL,
  PRIMARY KEY (device_id, metric)
) WITHOUT ROWID;

-- Відхилені повідомлення: діагностика замість мовчазного відкидання
CREATE TABLE rejected (
  id          INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  reason      TEXT NOT NULL,
  raw         TEXT
);
