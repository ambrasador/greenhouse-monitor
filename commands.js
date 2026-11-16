'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { ApiError } = require('./problem');

// Допустимі команди й перевірка їхніх параметрів
const COMMANDS = {
  irrigate: (p) => Number.isInteger(p?.duration_sec)
    && p.duration_sec >= 1 && p.duration_sec <= 600,
  set_setpoint: (p) => ['temperature', 'humidity'].includes(p?.metric)
    && Number.isFinite(p?.value),
};
const FINAL = ['acked', 'failed'];

function createCommands({ db, sink, clock = Date.now, ttlSec = 60 }) {
  const iso = (ms = clock()) => new Date(ms).toISOString();
  const byId = db.prepare('SELECT * FROM commands WHERE id = ?');
  const byKey = db.prepare(
    'SELECT * FROM commands WHERE device_id = ? AND idem_key = ?');
  const insert = db.prepare(
    `INSERT INTO commands (id, device_id, name, params, status, idem_key,
                           body_hash, created_at, updated_at, expires_at)
     VALUES (@id, @device_id, @name, @params, 'pending', @idem_key,
             @body_hash, @now, @now, @expires_at)`);
  const pending = db.prepare(
    `SELECT * FROM commands WHERE status = 'pending' AND expires_at > ?`);
  const expire = db.prepare(
    `UPDATE commands SET status = 'expired', updated_at = @now
      WHERE status IN ('pending', 'sent') AND expires_at <= @now`);
  const view = (r) => r && ({ id: r.id, device_id: r.device_id, name: r.name,
    params: JSON.parse(r.params), status: r.status, created_at: r.created_at,
    updated_at: r.updated_at, expires_at: r.expires_at });

  // Перехід стану: UPDATE спрацьовує лише з дозволеного стану
  // й для потрібного пристрою
  const move = db.prepare(
    `UPDATE commands SET status = @to, updated_at = @now
      WHERE id = @id AND status IN (SELECT value FROM json_each(@from))
        AND (@device IS NULL OR device_id = @device)`);
  const transition = (id, to, from, device = null) => move.run({
    id, to, from: JSON.stringify(from), now: iso(), device,
  }).changes === 1;

  // Відправлення повторюване: pending → sent
  async function deliver(row) {
    const { id, name, expires_at } = row;
    try {
      await sink.send(row.device_id,
        { id, name, params: JSON.parse(row.params), expires_at });
      transition(id, 'sent', ['pending']);
    } catch { /* лишається pending: повторить dispatchPending() */ }
  }

  async function create({ deviceId, name, params, idemKey }) {
    const body = JSON.stringify({ name, params });
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const replay = (row) => {
      if (row.body_hash !== bodyHash) {
        throw new ApiError(422, 'idempotency-key-reuse',
          'Ключ ідемпотентності вже використано з іншим тілом');
      }
      return { command: view(row), created: false };
    };
    const prev = idemKey && byKey.get(deviceId, idemKey);
    if (prev) return replay(prev);
    const id = randomUUID();
    try {
      insert.run({
        id, device_id: deviceId, name, params: JSON.stringify(params),
        idem_key: idemKey ?? null, body_hash: bodyHash,
        now: iso(), expires_at: iso(clock() + ttlSec * 1000),
      });
    } catch (e) {                // гонка: інший процес уже вставив цей ключ
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return replay(byKey.get(deviceId, idemKey));
      }
      throw e;
    }
    await deliver(byId.get(id));
    return { command: view(byId.get(id)), created: true };
  }

  return {
    create,
    get: (id) => view(byId.get(id)),
    // підтвердження приймається лише від пристрою, якому адресовано команду
    ack: (id, ok, deviceId = null) => transition(
      id, ok ? 'acked' : 'failed', ['pending', 'sent', 'expired'], deviceId),
    // повтор відправлення, поки не вичерпано TTL
    async dispatchPending() {
      for (const r of pending.all(iso())) await deliver(r);
    },
    expireOverdue: () => expire.run({ now: iso() }).changes,
    FINAL,
  };
}

module.exports = { createCommands, COMMANDS };
