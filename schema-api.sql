-- Реєстр пристроїв: відрізняє «невідомий пристрій» від «пристрій без даних»
CREATE TABLE devices (
  device_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  zone       TEXT,
  created_at TEXT NOT NULL
) WITHOUT ROWID;

-- Команди пристроям: життєвий цикл pending → sent → acked | failed | expired
CREATE TABLE commands (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL REFERENCES devices (device_id),
  name       TEXT NOT NULL,
  params     TEXT NOT NULL,            -- JSON
  status     TEXT NOT NULL,
  idem_key   TEXT,
  body_hash  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (device_id, idem_key)
) WITHOUT ROWID;

-- Налаштування пристрою: version зростає на 1 при кожній зміні й править за ETag
CREATE TABLE device_settings (
  device_id  TEXT PRIMARY KEY REFERENCES devices (device_id),
  body       TEXT NOT NULL,            -- JSON
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
