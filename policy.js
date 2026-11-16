'use strict';
// Політика доступу як дані: дія → ролі, яким її дозволено. Цей самий об’єкт
// читають middleware guard і тест матриці «роль × кінцева точка»; окремої копії
// правил, що могла б розійтися з кодом, немає
const ROLES = ['viewer', 'operator', 'admin'];

const ACTIONS = {
  'self:read':      ['viewer', 'operator', 'admin'],
  'push:write':     ['viewer', 'operator', 'admin'],
  'device:read':    ['viewer', 'operator', 'admin'],
  'telemetry:read': ['viewer', 'operator', 'admin'],
  'stream:read':    ['viewer', 'operator', 'admin'],
  'settings:read':  ['viewer', 'operator', 'admin'],
  'settings:write': ['operator', 'admin'],
  'command:create': ['operator', 'admin'],
  'command:read':   ['operator', 'admin'],
  'device:claim':   ['operator', 'admin'],
  'audit:read':     ['admin'],
  'ingest:write':   [],                 // лише підписана інтеграція, жодна роль користувача
};

module.exports = { ROLES, ACTIONS };
