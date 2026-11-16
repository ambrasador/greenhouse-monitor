import { memo } from 'react';
import { StatusBadge } from './StatusBadge.jsx';

const clock = (iso) => new Date(iso).toLocaleTimeString('uk-UA');

// Презентаційний компонент: усе, що він показує, прийшло через props.
// Пропси — рядки й булеві значення, тому memo не перемальовує картку,
// доки вони не змінилися
export const DeviceCard = memo(function DeviceCard({
  id, metric, name, label, text, level, updatedAt, selected, onSelect,
}) {
  return (
    <button type="button" className={`device-card device-card--${level}`}
            aria-pressed={selected} onClick={() => onSelect(id, metric)}>
      <span className="device-card__name">{name}</span>
      <span className="device-card__metric">{label}</span>
      <strong className="device-card__value">{text}</strong>
      <StatusBadge level={level} />
      <time dateTime={updatedAt ?? undefined}>
        {updatedAt ? clock(updatedAt) : 'немає оновлень'}
      </time>
    </button>
  );
});
