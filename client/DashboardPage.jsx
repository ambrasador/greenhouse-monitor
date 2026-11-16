import { useCallback, useMemo, useState } from 'react';
import { StatusGrid } from './StatusGrid.jsx';
import { TelemetryPanel } from './TelemetryPanel.jsx';
import { GREENHOUSE } from './domain.js';
import { buildCards } from './cards.js';
import { useDevices } from './useTelemetry.js';
import { useNow } from './useNow.js';

// Контейнер верхнього рівня: дані з кешу, статуси за годинником, вибір
// картки й діапазону
export function DashboardPage({ config = GREENHOUSE, base = '' }) {
  // Картки опитують з періодом найшвидшої метрики, яка має картку
  const cardPeriod = Math.min(
    ...config.cards.map((k) => config.metrics[k].periodSec));
  const devices = useDevices(base, cardPeriod);
  const now = useNow(10_000);
  const cards = useMemo(
    () => buildCards(devices, config, now), [devices, config, now]);
  const [picked, setPicked] = useState(null);
  const [range, setRange] = useState(config.defaultRange ?? '1h');
  const select = useCallback((id, metric) => setPicked({ id, metric }), []);

  // Поки користувач нічого не вибрав, показуємо першу картку
  const first = cards[0] && { id: cards[0].id, metric: cards[0].metric };
  const selected = picked ?? first ?? null;
  const name = cards.find((c) => c.id === selected?.id)?.name;
  return (
    <main>
      <h1>{config.title}</h1>
      <StatusGrid cards={cards} selected={selected ?? {}}
                  onSelect={select} />
      {selected && (
        <TelemetryPanel config={config} base={base} selected={selected}
                        name={name ?? selected.id}
                        range={range} onRange={setRange} />
      )}
    </main>
  );
}
