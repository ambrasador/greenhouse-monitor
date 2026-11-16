'use strict';
// Запуск стенда для тестів Dart: друкує адреси одним рядком JSON і чекає сигналу
const { startMobileBed } = require('./mobile-bed');

const opts = JSON.parse(process.env.BED_OPTIONS ?? '{}');
startMobileBed(opts).then((bed) => {
  console.log(JSON.stringify({ api: bed.api, lossy: bed.lossy, ctl: bed.ctl }));
  const stop = () => bed.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
});
