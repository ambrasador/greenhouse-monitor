-- Облікові записи. Пароль зберігається лише як хеш scrypt. token_version
-- збільшують, щоб одним UPDATE анулювати всі видані користувачеві токени
CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  pw_hash       TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  token_version INTEGER NOT NULL DEFAULT 1,
  disabled_at   TEXT,
  created_at    TEXT NOT NULL
) WITHOUT ROWID;

-- Область доступу до пристроїв: '*' — усі, 'zone:<зона>', 'device:<id>'
CREATE TABLE grants (
  user_id TEXT NOT NULL REFERENCES users (user_id),
  scope   TEXT NOT NULL,
  PRIMARY KEY (user_id, scope)
) WITHOUT ROWID;

-- Refresh-токени: у базі лише SHA-256 від токена. Токени одного входу
-- утворюють родину; повторне пред’явлення вже використаного токена
-- анулює всю родину
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users (user_id),
  issued_at  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  revoked_at TEXT
) WITHOUT ROWID;
CREATE INDEX refresh_family ON refresh_tokens (family_id);

-- Журнал аудиту: хто, що, над чим і з яким результатом
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL,
  actor   TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  outcome TEXT NOT NULL,
  ip      TEXT,
  detail  TEXT
);
CREATE INDEX audit_ts ON audit_log (ts);

-- Коди прив’язки пристроїв: код надруковано на корпусі, у базі лише SHA-256
CREATE TABLE claim_codes (
  device_id  TEXT PRIMARY KEY REFERENCES devices (device_id),
  code_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
