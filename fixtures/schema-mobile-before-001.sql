-- Прив’язка пристрою до облікового запису (claim): один власник на пристрій
CREATE TABLE device_owner (
  device_id  TEXT PRIMARY KEY REFERENCES devices (device_id),
  user_id    TEXT NOT NULL,
  claimed_at TEXT NOT NULL
) WITHOUT ROWID;

-- Адреси push. Адресу видає SDK: реєстраційний токен FCM (firebase_messaging до
-- 16-ї версії) або Firebase Installation ID, FID (з 17-ї). У HTTP v1 їм
-- відповідають поля token і fid; kind каже, яке з них заповнити. Адреса
-- належить одному користувачеві: новий вхід на тому самому телефоні забирає її
-- собі, і попередній власник push не отримує
CREATE TABLE push_tokens (
  token        TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'token' CHECK (kind IN ('token', 'fid')),
  user_id      TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  created_at   TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX push_tokens_user ON push_tokens (user_id);
