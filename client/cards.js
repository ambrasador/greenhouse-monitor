// Картки дашборда: пристрій × метрика з config.cards. Чиста функція від
// відповідей API (device.latest = [{ metric, ts, value }]) і поточного часу
import { evaluateStatus } from './status.js';
import { formatValue } from './format.js';

export function buildCards(devices, config, now) {
  const cards = [];
  for (const d of devices) {
    for (const metric of config.cards) {
      const m = config.metrics[metric];
      const reading = d.latest?.find((l) => l.metric === metric) ?? null;
      const level = evaluateStatus(
        reading, m.rule, { now, periodSec: m.periodSec });
      cards.push({
        key: `${d.id}/${metric}`, id: d.id, metric, name: d.name,
        label: m.label,
        text: level === 'offline'
          ? '—' : formatValue(reading.value, m.unit, m.decimals),
        updatedAt: reading?.ts ?? null, level,
      });
    }
  }
  return cards;
}
