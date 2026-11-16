import { useMemo } from 'react';
import { TelemetryChart } from './TelemetryChart.jsx';
import { RangeSwitch } from './RangeSwitch.jsx';
import { useTelemetryHistory, useLiveTelemetry } from './useTelemetry.js';
import { chartRows, isStreamed } from './history.js';
import { toCsv } from './csv.js';

const COLUMNS = [
  { key: 't', header: 'time', type: 'time' },
  { key: 'v', header: 'value', type: 'number' },
  { key: 'lo', header: 'min', type: 'number' },
  { key: 'hi', header: 'max', type: 'number' },
];

const CONN = {
  connecting: 'З’єднання…', online: 'Онлайн',
  reconnecting: 'Перепідключення', failed: 'Збій',
};

function download(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'),
    { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

// Контейнер графіка: історія з кешу, живі точки для діапазону «1 год»,
// проріджування до бюджету й експорт того, що намальовано
export function TelemetryPanel(
  { config, base, selected, name, range, onRange }) {
  const { id, metric } = selected;
  const m = config.metrics[metric];
  const { data, isPending, isPlaceholderData, isError, refetch } =
    useTelemetryHistory(
      { base, device: id, metric, range, periodSec: m.periodSec,
        push: config.push });
  // Потік підключаємо, лише коли на екрані сирі точки «1 год», а не заміна
  const live = !isPlaceholderData && isStreamed(range, data, config.push);
  const conn = useLiveTelemetry({ base, device: id, metric, enabled: live });

  // Дорога робота — лише коли змінився результат запиту, а не стан зв’язку
  const rows = useMemo(() => chartRows(data), [data]);
  const domain = data
    ? [data.from, Math.max(data.to, rows.at(-1)?.t ?? 0)]
    : ['dataMin', 'dataMax'];
  // Рядки gap — лише розриви лінії, у файл вони не потрапляють
  const exportCsv = () => download(
    toCsv(rows.filter((r) => !r.gap), COLUMNS, { bom: true }),
    `${id}-${metric}-${range}.csv`);

  return (
    <section aria-labelledby="panel-title" aria-busy={isPlaceholderData}
             className={isPlaceholderData ? 'panel--loading' : undefined}>
      <h2 id="panel-title">{m.label}: {name}</h2>
      <div className="toolbar">
        <RangeSwitch value={range} onChange={onRange} />
        <button type="button" onClick={exportCsv}
                disabled={!rows.length || isPlaceholderData}>
          Експорт у CSV
        </button>
        {isPlaceholderData && (
          <span role="status" className="conn">Завантаження діапазону…</span>
        )}
        {live && (
          <span role="status" className="conn">
            {CONN[conn.status]}
            {conn.status === 'reconnecting' && `, спроба ${conn.attempt}`}
          </span>
        )}
      </div>
      {isError && (
        <p role="alert">Не вдалося завантажити дані.{' '}
          <button type="button" onClick={() => refetch()}>Повторити</button>
        </p>
      )}
      {isPending ? <p>Завантаження…</p> : data && (
        <TelemetryChart rows={rows} unit={m.unit} decimals={m.decimals}
                        rule={m.rule} domain={domain} label={m.label} />
      )}
    </section>
  );
}
