// Числа й час у форматі користувача: десяткова кома, нерозривний пробіл
// перед одиницею
const NBSP = '\u00A0';
const cache = new Map();         // Intl.NumberFormat дорогий: створюємо раз

export function formatValue(value, unit = '', decimals = 1) {
  if (!cache.has(decimals)) {
    cache.set(decimals, new Intl.NumberFormat('uk-UA', {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }));
  }
  const text = cache.get(decimals).format(value);
  return unit ? `${text}${NBSP}${unit}` : text;
}

export const formatTime = (ms) => new Date(ms).toLocaleTimeString('uk-UA',
  { hour: '2-digit', minute: '2-digit' });
export const formatDateTime = (ms) => new Date(ms).toLocaleString('uk-UA',
  { dateStyle: 'short', timeStyle: 'medium' });
