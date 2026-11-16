// Розділ 4: контраст кольорів дашборда та їхній вигляд для дейтеранопії. node calc4-contrast.mjs
import fs from 'node:fs';
import { contrast, deuteranopia, deltaE, luminance } from './client/color.js';

const WHITE = '#FFFFFF';
const BG = '#F6F7F9';
const status = { ok: '#2E7D32', warning: '#F9A825', critical: '#C62828', offline: '#757575' };
const label = { ok: 'Норма', warning: 'Попередження', critical: 'Критично', offline: 'Немає даних' };
const f = (x, d = 2) => x.toFixed(d);

// 1. Текст бейджа на кольоровому тлі (поріг WCAG 1.4.3 для тексту ≈ 15 px жирним: 4,5 : 1)
const badge = Object.entries(status).map(([k, bg]) => {
  const white = contrast(bg, WHITE);
  const black = contrast(bg, '#000000');
  const chosen = k === 'warning' ? '#000000' : '#FFFFFF';
  return { status: label[k], фон: bg, 'білий текст': f(white), 'чорний текст': f(black), обрано: chosen, контраст: f(contrast(bg, chosen)) };
});
console.log('Текст бейджа на тлі статусу');
console.table(badge);

// 2. Нетекстові елементи: смуга картки та лінії графіка проти фону картки (поріг 1.4.11: 3 : 1)
const marks = {
  'смуга «Норма»': status.ok, 'смуга «Попередження»': status.warning, 'смуга «Критично»': status.critical,
  'смуга «Немає даних»': status.offline, 'лінія ряду': '#1565C0', 'лінія порогу «попередження»': '#8A5A00',
  'лінія порогу «критично»': '#C62828', 'сітка': '#E3E6EB',
};
const nonText = Object.entries(marks).map(([name, c]) => ({ елемент: name, колір: c, 'на білому': f(contrast(c, WHITE)), 'на тлі сторінки': f(contrast(c, BG)) }));
console.log('Нетекстові елементи');
console.table(nonText);
const text = { 'основний текст #1B1B1B': '#1B1B1B', 'допоміжний текст #5C6370': '#5C6370' };
console.table(Object.entries(text).map(([k, c]) => ({ текст: k, 'на білому': f(contrast(c, WHITE)), 'на тлі сторінки': f(contrast(c, BG)) })));

// 3. Пари статусів: різниця кольорів ΔE при нормальному зорі та при дейтеранопії
const keys = Object.keys(status);
const pairs = [];
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
  const [a, b] = [status[keys[i]], status[keys[j]]];
  pairs.push({ пара: `${label[keys[i]]} — ${label[keys[j]]}`, 'ΔE норма': f(deltaE(a, b), 1),
    'ΔE дейтеранопія': f(deltaE(deuteranopia(a), deuteranopia(b)), 1),
    'контраст яскравості': f(contrast(a, b)) });
}
console.log('Пари кольорів статусів');
console.table(pairs);
console.table(keys.map((k) => ({ статус: label[k], 'нормальний зір': status[k], 'дейтеранопія': deuteranopia(status[k]),
  'яскравість L': f(luminance(status[k]), 3) })));

fs.writeFileSync('results/contrast.json', JSON.stringify({ badge, nonText, pairs,
  deutan: Object.fromEntries(keys.map((k) => [k, deuteranopia(status[k])])), status }));
