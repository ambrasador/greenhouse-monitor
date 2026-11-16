'use strict';
const { createIngest } = require('./core');

// Корінь композиції: ядро отримує джерело ззовні і не знає про MQTT
function createApp({ db, source, clock = Date.now, onStored, observe = () => {} }) {
  const ingest = createIngest(db, clock, onStored);
  const stats = { stored: 0, duplicate: 0, rejected: 0 };
  const count = (res) => {
    stats[res === 'stored' || res === 'duplicate' ? res : 'rejected']++;
    return res;
  };
  source.onReading((reading) => {
    const t0 = process.hrtime.bigint();
    const res = ingest.accept(reading);
    observe(res, Number(process.hrtime.bigint() - t0) / 1e9);   // метрики: результат і тривалість
    return count(res);
  });
  source.onReject((reason, raw) => {
    observe(reason);                                             // відхилено до перевірки: часу немає
    return count(ingest.reject(reason, raw));
  });
  return {
    stats,
    start: () => source.start(),
    stop: () => source.stop(),
  };
}

module.exports = { createApp };
