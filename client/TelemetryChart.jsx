import { memo } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { formatValue, formatDateTime } from './format.js';
import { timeTicks, formatTick, valueScale } from './axes.js';

// Пороги відрізняються штрихом, а не лише кольором
const LIMITS = [
  ['warn', 'попередження', 'var(--warn-line)', '8 5'],
  ['crit', 'критично', 'var(--crit-line)', '2 4'],
];

// Один показник на панелі. Лінія — значення (або середнє інтервалу),
// смуга — від мінімуму до максимуму інтервалу, штрихові лінії — пороги.
// Анімацію й точки вимкнено
export const TelemetryChart = memo(function TelemetryChart({
  rows, unit, decimals = 1, rule, domain, syncId, height = 240, label,
}) {
  const last = rows.findLast((r) => r.v !== null);
  const y = valueScale(rows, rule);
  const x = typeof domain?.[0] === 'number'
    ? timeTicks(domain[0], domain[1]) : null;
  const fmt = (v) => formatValue(v, unit, decimals);
  const summary = last
    ? `${label}: останнє значення ${fmt(last.v)}`
      + `, ${rows.filter((r) => r.v !== null).length} точок на графіку`
    : `${label}: немає даних за вибраний діапазон`;
  return (
    <div role="img" aria-label={summary}>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} syncId={syncId}
                       accessibilityLayer={false}
                       margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="t" type="number" scale="time" domain={domain}
                 ticks={x?.ticks}
                 tickFormatter={(t) => formatTick(t, x?.stepMin ?? 60)} />
          <YAxis domain={y.domain} ticks={y.ticks} width={56}
                 tickFormatter={(v) => formatValue(v, '', decimals)} />
          <Tooltip labelFormatter={formatDateTime} separator=": "
                   itemStyle={{ color: 'var(--ink)' }}
                   formatter={(v, name) => [Array.isArray(v)
                     ? `${fmt(v[0])} … ${fmt(v[1])}` : fmt(v), name]} />
          {rows.some((r) => r.band) && (
            <Area dataKey="band" name="мін … макс" stroke="none"
                  fill="var(--band)" isAnimationActive={false}
                  activeDot={false} />
          )}
          {rule && LIMITS.map(([k, name, color, dash]) => (
            <ReferenceLine key={k} y={rule[k]} stroke={color}
              strokeDasharray={dash}
              label={{ value: `${name} ${formatValue(rule[k], unit, 0)}`,
                position: 'insideBottomLeft', fill: 'var(--muted)',
                fontSize: 12 }} />
          ))}
          <Line dataKey="v" name={label} stroke="var(--series)"
                strokeWidth={2} dot={false} isAnimationActive={false}
                connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
});
