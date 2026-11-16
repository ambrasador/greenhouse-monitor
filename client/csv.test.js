import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from './csv.js';

const cols = [
  { key: 't', header: 'time', type: 'time' },
  { key: 'v', header: 'value', type: 'number' },
  { key: 'name', header: 'device', type: 'text' },
];

test('заголовок, CRLF, час у ISO 8601, число з крапкою', () => {
  const out = toCsv([{ t: 0, v: 27.4, name: 'gh1' }], cols);
  assert.equal(out, 'time,value,device\r\n1970-01-01T00:00:00.000Z,27.4,gh1\r\n');
});

test('поля з комою, лапками й переносом беруться в лапки, лапки подвоюються', () => {
  const out = toCsv([{ t: 0, v: 1, name: 'Грядка "А", ліва\nсторона' }], cols);
  assert.match(out, /"Грядка ""А"", ліва\nсторона"/);
});

test('текст, що починається на = + - @, не виконується як формула', () => {
  const bad = ['=SUM(A1:A9)', '+1', '-2', '@x', '\tтаб', '\nрядок', '＝1+1'];
  for (const text of bad) {
    const out = toCsv([{ t: 0, v: 1, name: text }], cols);
    const cell = out.slice(out.indexOf('1,') + 2).trimEnd();
    assert.ok(cell.replace(/^"/, '').startsWith("'"), text);
  }
});

test('від’ємне число — не текст, апостроф не додається', () => {
  const out = toCsv([{ t: 0, v: -3.5, name: 'x' }], cols).split('\r\n')[1];
  assert.ok(out.includes(',-3.5,'));
});

test('крапка з комою й десяткова кома для локалей з комою; BOM для Excel', () => {
  const out = toCsv([{ t: 0, v: 27.4, name: 'a;b' }], cols, { delimiter: ';', decimal: ',', bom: true });
  assert.ok(out.startsWith('﻿time;value;device'));
  assert.ok(out.includes(';27,4;"a;b"'));
});

test('порожні й нескінченні значення дають порожню клітинку', () => {
  const out = toCsv([{ t: 0, v: NaN, name: null }], cols).split('\r\n')[1];
  assert.ok(out.endsWith(',,'));
});
