// Дозволені значення interval в API (розділ 2): хвилини й години — дільники
// 60 і 24, доба
const MIN = 60_000;
export const INTERVALS = [
  ['1m', MIN], ['2m', 2 * MIN], ['3m', 3 * MIN], ['4m', 4 * MIN],
  ['5m', 5 * MIN], ['6m', 6 * MIN], ['10m', 10 * MIN], ['12m', 12 * MIN],
  ['15m', 15 * MIN], ['20m', 20 * MIN], ['30m', 30 * MIN],
  ['1h', 60 * MIN], ['2h', 120 * MIN], ['3h', 180 * MIN], ['4h', 240 * MIN],
  ['6h', 360 * MIN], ['8h', 480 * MIN], ['12h', 720 * MIN],
  ['1d', 1440 * MIN],
];

// Найменший дозволений інтервал, за якого вікно дає не більше budget точок;
// null, якщо сирих точок (періодів звітування у вікні) і так ≤ budget
export function pickInterval(rangeMs, periodMs, budget = 500) {
  if (rangeMs / periodMs <= budget) return null;
  const found = INTERVALS.find(
    ([, ms]) => ms >= periodMs && rangeMs / ms <= budget);
  return found ? found[0] : INTERVALS.at(-1)[0];
}
