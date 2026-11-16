'use strict';
// Тестова реалізація порту TelemetrySource: без брокера і мережі
function createFakeSource() {
  let onReading = () => {};
  let onReject = () => {};
  return {
    onReading(fn) { onReading = fn; },
    onReject(fn) { onReject = fn; },
    async start() {},
    async stop() {},
    push(reading) { return onReading(reading); },
    pushBad(reason, raw) { return onReject(reason, raw); },
  };
}

module.exports = { createFakeSource };
