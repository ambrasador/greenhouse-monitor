// Розділ 4: для кожного з п’яти доменів — скільки точок і який interval дає кожен
// із трьох діапазонів, хто оновлює ряд (потік чи таймер) і яку кількість
// пристроїв на екрані витримує опитування карток за критерієм розділу 1
// (R_poll = U · n / P ≤ R_read / 3, R_read = 4 000 запитів за секунду)
import { pickInterval, INTERVALS } from './client/intervals.js';
import { refreshMs } from './client/history.js';

// T — період звітування, U — кількість екранів (таблиця розділу 1), push — прапорець домену
const DOMAINS = [
  ['Теплиця', 60, 20, true], ['Розумний будинок', 300, 2000, false],
  ['Облік комунальних послуг', 900, 5000, false],
  ['Транспортний парк', 5, 10, false], ['Інфраструктура громади', 300, 50, false]];
const RANGES = [['1 год', '1h', 3_600_000], ['24 год', '24h', 86_400_000], ['7 днів', '7d', 604_800_000]];
const R_READ = 4000;
const ms = (n) => INTERVALS.find(([k]) => k === n)[1];
const fmt = (v) => (v === false ? 'потік' : `${v / 1000} с`);

for (const [name, T, U, push] of DOMAINS) {
  const P = T / 2;
  const cells = RANGES.map(([label, key, rms]) => {
    const raw = Math.floor(rms / (T * 1000));
    const iv = pickInterval(rms, T * 1000, 500);
    const data = iv ? { kind: 'buckets', everyMs: ms(iv) } : { kind: 'raw', everyMs: T * 1000 };
    const refresh = fmt(refreshMs(key, data, push));
    return `${label}: ${iv ? `${raw} → ${iv}` : `${raw} сирих`}, оновлення ${refresh}`;
  });
  const nMax = (R_READ * P) / (3 * U);
  console.log(`${name.padEnd(26)} T=${String(T).padStart(3)} с  офлайн>${3 * T} с  P=${P} с  U=${U}  n_max=${Math.round(nMax)}`);
  console.log(`   ${cells.join(' | ')}`);
}

// Парк: 300 пристроїв на екрані, 10 диспетчерів
const parkLoad = (P) => (10 * 300) / P;
console.log(`Парк, n = 300: P=2,5 с → ${parkLoad(2.5)} запитів/с (${(parkLoad(2.5) / (R_READ / 3) * 100).toFixed(0)} % порога); P=5 с → ${parkLoad(5)} (${(parkLoad(5) / (R_READ / 3) * 100).toFixed(0)} %)`);
console.log(`Парк, межа за P=2,5 с: U_max=${Math.floor((R_READ * 2.5) / (3 * 300))} диспетчерів; трафік 300 × 0,4 КБ / ${2.5} с = ${(300 * 0.4 / 2.5).toFixed(0)} КБ/с, ${((300 * 0.4 / 2.5) * 86400 / 1e6).toFixed(2)} ГБ/добу`);
