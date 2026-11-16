'use strict';

// Журнал аудиту в тій самій базі. Збій запису не повинен зупиняти запит,
// але має бути видимим: він іде в журнал процесу
function createAudit({ db, clock = Date.now, log = () => {}, onRecord = () => {} }) {
  const insert = db.prepare(
    `INSERT INTO audit_log (ts, actor, action, target, outcome, ip, detail)
     VALUES (@ts, @actor, @action, @target, @outcome, @ip, @detail)`);
  const page = db.prepare(
    `SELECT id, ts, actor, action, target, outcome, ip, detail FROM audit_log
      WHERE id < @before AND (@actor IS NULL OR actor = @actor)
      ORDER BY id DESC LIMIT @limit`);

  return {
    record({ actor, action, target, outcome = 'ok', ip, detail }) {
      onRecord(action, outcome);          // лічильник подій для сповіщень (розділ 7)
      try {
        insert.run({ ts: new Date(clock()).toISOString(), actor: actor ?? null, action,
          target: target ?? null, outcome, ip: ip ?? null,
          detail: detail === undefined ? null : JSON.stringify(detail) });
      } catch (e) {
        log('audit_failed', { action, message: e.message });
      }
    },
    list({ before = Number.MAX_SAFE_INTEGER, limit = 100, actor = null } = {}) {
      return page.all({ before, limit, actor }).map((r) => ({ ...r, detail: r.detail && JSON.parse(r.detail) }));
    },
  };
}

module.exports = { createAudit };
