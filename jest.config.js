'use strict';
// Три рівні піраміди — три проєкти Jest. Їх запускають окремо (--selectProjects),
// бо вони різняться вартістю: модульні — мілісекунди, інтеграційні — десятки мілісекунд,
// наскрізні — секунди й потребують зібраного клієнта (npm run build:client)
const common = { testEnvironment: 'node', transform: {} };   // код вже CommonJS: babel не потрібен

module.exports = {
  projects: [
    { ...common, displayName: 'unit', testMatch: ['<rootDir>/jest/unit/**/*.spec.js'] },
    { ...common, displayName: 'integration', testTimeout: 10_000,
      testMatch: ['<rootDir>/jest/integration/**/*.spec.js'] },
    { ...common, displayName: 'e2e', testTimeout: 60_000,
      testMatch: ['<rootDir>/jest/e2e/**/*.spec.js'] },
  ],
  coverageProvider: 'v8',
  // Межа покриття стосується модулів, які цей набір перевіряє навмисно; решту (push.js,
  // авторизацію) покриває набір node:test
  collectCoverageFrom: ['alerts.js', 'app.js', 'core.js', 'health.js', 'ops-metrics.js',
    'mqtt-source.js', 'server.js'],
  coverageThreshold: { global: { lines: 85, branches: 70 } },
};
