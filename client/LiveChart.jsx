import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';

const LABEL = { connecting: 'З’єднання…', online: 'Онлайн',
  reconnecting: 'Перепідключення', failed: 'Збій' };

// Вік даних рахується від годинника клієнта, тож лічильник оновлюється щосекунди
function useAge(dataAt) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return dataAt === null ? null : Math.round((now - dataAt) / 1000);
}

// Подання не знає, звідки дані: view дає хук useLiveFeed
export function LiveChart({ view, series, unit = '', staleSec = 10 }) {
  const points = view.series[series] ?? [];
  const age = useAge(view.dataAt);
  const stale = view.status === 'online' && age !== null && age > staleSec;
  return (
    <section>
      <p role="status" data-status={view.status}>
        {LABEL[view.status]}
        {view.status === 'reconnecting' && `, спроба ${view.attempt}`}
        {stale && ` · дані застаріли: ${age} с без оновлень`}
      </p>
      <LineChart width={640} height={240} data={points}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="ts" tickFormatter={(t) => t.slice(11, 19)} minTickGap={48} />
        <YAxis domain={['auto', 'auto']} unit={unit} />
        <Line dataKey="value" dot={false} isAnimationActive={false} />
      </LineChart>
    </section>
  );
}
