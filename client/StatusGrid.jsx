import { DeviceCard } from './DeviceCard.jsx';
import { summarize } from './status.js';

// Презентаційний компонент: сітка карток і зведений рядок. Порядок карток
// фіксований (за пристроєм, потім за метрикою), тож картка не переїжджає,
// коли змінюється її статус
export function StatusGrid({ cards, selected, onSelect }) {
  const n = summarize(cards.map((c) => c.level));
  const isSelected = (c) =>
    selected.id === c.id && selected.metric === c.metric;
  return (
    <section aria-labelledby="grid-title">
      <h2 id="grid-title">Пристрої</h2>
      <p className="summary" role="status">
        {n.ok} норма · {n.warning} попередження · {n.critical} критично
        · {n.offline} немає даних
      </p>
      <ul className="grid">
        {cards.map(({ key, ...card }) => (
          <li key={key}>
            <DeviceCard {...card} selected={isSelected(card)}
                        onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </section>
  );
}
