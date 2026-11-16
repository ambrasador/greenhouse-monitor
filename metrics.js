'use strict';
// Каталог метрик: тип визначає, які агрегати мають зміст
const GREENHOUSE = new Map([
  ['temperature',   { unit: '°C', kind: 'gauge', periodSec: 60 }],
  ['humidity',      { unit: '%',  kind: 'gauge', periodSec: 60 }],
  ['soil_moisture', { unit: '%',  kind: 'gauge', periodSec: 60 }],
  ['light',         { unit: 'лк', kind: 'gauge', periodSec: 60 }],
]);

// gauge — миттєва величина; counter — накопичувальний лічильник;
// delta — приріст за період
const AGGREGATES = {
  gauge:   ['avg', 'min', 'max', 'count'],
  counter: ['delta', 'count'],
  delta:   ['sum', 'count'],
};

module.exports = { GREENHOUSE, AGGREGATES };
