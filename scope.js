'use strict';
// Область доступу: які пристрої бачить користувач. Запис у таблиці grants —
// '*' (усі), 'zone:<зона>' або 'device:<id>'; адміністратор бачить усе
const VISIBLE_SQL = `(@all = 1 OR EXISTS (
  SELECT 1 FROM grants g WHERE g.user_id = @user
     AND (g.scope = '*' OR g.scope = 'device:' || d.device_id
          OR g.scope = 'zone:' || d.zone)))`;

function createScope(db) {
  const grantsOf = db.prepare(
    'SELECT scope FROM grants WHERE user_id = ?').pluck();
  const zoneOf = db.prepare(
    'SELECT zone FROM devices WHERE device_id = ?').pluck();
  return {
    grantsOf: (user) => grantsOf.all(user.sub),
    canSee(user, device) {
      if (user.role === 'admin') return true;
      const zone = zoneOf.get(device);
      return grantsOf.all(user.sub).some((g) => g === '*'
        || g === `device:${device}`
        || (zone != null && g === `zone:${zone}`));
    },
    canSeeZone: (user, zone) => user.role === 'admin'
      || grantsOf.all(user.sub).some(
        (g) => g === '*' || g === `zone:${zone}`),
    // Параметри SQL для списку пристроїв; сам фільтр — VISIBLE_SQL
    visible: (user) => ({
      all: user.role === 'admin' ? 1 : 0, user: user.sub,
    }),
  };
}

module.exports = { createScope, VISIBLE_SQL };
