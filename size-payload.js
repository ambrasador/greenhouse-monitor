'use strict';
// Розмір відповіді з добою вимірювань (1440 точок) у різних кодуваннях, без стиснення і з gzip
const zlib = require('node:zlib');
const protobuf = require('protobufjs');

const N = 1440, T0 = Date.parse('2026-11-03T00:00:00Z');
let x = 7;
const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const points = Array.from({ length: N }, (_, i) => ({
  ts: new Date(T0 + i * 60_000).toISOString(),
  value: Math.round((21 + 4 * Math.sin((i / 1440) * 2 * Math.PI - 2) + rnd() - 0.5) * 10) / 10 }));

const root = protobuf.parse(`syntax = "proto3";
  message Point { int64 ts_ms = 1; float value = 2; }
  message Series { repeated Point points = 1; }
  message Columns { repeated sint64 ts_delta_ms = 1 [packed = true]; repeated float values = 2 [packed = true]; }`).root;
const Series = root.lookupType('Series'), Columns = root.lookupType('Columns');

const variants = [
  ['JSON: масив об’єктів {ts, value} (відповідь нашого API)', Buffer.from(JSON.stringify({ data: points, next: null }))],
  ['JSON: лише {value} (GraphQL без поля ts)', Buffer.from(JSON.stringify({ data: points.map((p) => ({ value: p.value })) }))],
  ['JSON: стовпці ts (ISO) і value', Buffer.from(JSON.stringify({ ts: points.map((p) => p.ts), value: points.map((p) => p.value) }))],
  ['JSON: стовпці, ts — мілісекунди епохи', Buffer.from(JSON.stringify({ ts: points.map((p) => Date.parse(p.ts)), value: points.map((p) => p.value) }))],
  ['Protobuf: повторюване Point {ts_ms, value}', Buffer.from(Series.encode(Series.fromObject({ points: points.map((p) => ({ ts_ms: Date.parse(p.ts), value: p.value })) })).finish())],
  ['Protobuf: стовпці зі зсувами ts', Buffer.from(Columns.encode(Columns.fromObject({
    ts_delta_ms: points.map((p, i) => (i ? Date.parse(p.ts) - Date.parse(points[i - 1].ts) : Date.parse(p.ts))),
    values: points.map((p) => p.value) })).finish())],
];
const rows = variants.map(([name, buf]) => ({ кодування: name, байт: buf.length,
  gzip: zlib.gzipSync(buf).length, 'на точку': +(buf.length / N).toFixed(1) }));

// агрегат: 24 інтервали по 1 год, поля avg, min, max
const hours = Array.from({ length: 24 }, (_, h) => {
  const v = points.slice(h * 60, h * 60 + 60).map((p) => p.value);
  return { start: new Date(T0 + h * 3_600_000).toISOString(), count: 60,
    avg: v.reduce((a, b) => a + b) / 60, min: Math.min(...v), max: Math.max(...v) };
});
const agg = Buffer.from(JSON.stringify({ data: hours, interval: '1h', tz: 'UTC' }));
rows.push({ кодування: 'JSON: агрегат 24 × 1 год (avg, min, max)', байт: agg.length, gzip: zlib.gzipSync(agg).length, 'на точку': +(agg.length / N).toFixed(1) });
console.table(rows);
