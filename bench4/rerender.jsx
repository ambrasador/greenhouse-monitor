// Скільки разів перемальовуються картки, коли оновлюється один із восьми рядів.
// Варіанти передавання даних: контекст, пропси (з memo й без), зовнішнє сховище.
// Картка містить діаграму Recharts на 60 точок, тож зайве перемальовування видно за часом
import React, { createContext, memo, useContext, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LineChart, Line } from 'recharts';

const CARDS = 8;
const POINTS = 60;
const ids = Array.from({ length: CARDS }, (_, i) => `c${i}`);
const counts = { card: 0, spark: 0, parent: 0 };

const initial = () => Object.fromEntries(ids.map((id, k) => [id, {
  last: 20 + k,
  points: Array.from({ length: POINTS }, (_, i) => ({ t: i, v: 20 + k + Math.sin(i / 5 + k) })),
}]));
let tick = POINTS;
const next = (s) => {                                    // нова точка: масив змінюється лише в цього ряду
  const v = 20 + Math.sin(tick / 5) * 3 + (tick % 7) * 0.1;
  tick += 1;
  return { last: v, points: [...s.points.slice(1), { t: tick, v }] };
};

function SparkBody({ points }) {
  counts.spark += 1;
  return (
    <LineChart width={160} height={48} data={points}>
      <Line dataKey="v" dot={false} isAnimationActive={false} stroke="#1565c0" strokeWidth={1.5} />
    </LineChart>
  );
}
const SparkMemo = memo(SparkBody);

function CardBody({ id, last, points, Spark }) {
  counts.card += 1;
  return (<li><b>{id}</b> {last.toFixed(1)}<Spark points={points} /></li>);
}

// 1–2. Контекст зі значеннями всіх рядів
const Ctx = createContext(null);
function CtxCard({ id, Spark }) {
  const s = useContext(Ctx)[id];
  return <CardBody id={id} last={s.last} points={s.points} Spark={Spark} />;
}
function CtxApp({ Spark, expose }) {
  counts.parent += 1;
  const [state, setState] = useState(initial);
  expose((id) => setState((st) => ({ ...st, [id]: next(st[id]) })));
  return (<Ctx.Provider value={state}><ul>{ids.map((id) => <CtxCard key={id} id={id} Spark={Spark} />)}</ul></Ctx.Provider>);
}

// 3–4. Дані в стані батька, до дітей — пропси
const CardMemo = memo(CardBody);
function PropsApp({ Card, Spark, expose }) {
  counts.parent += 1;
  const [state, setState] = useState(initial);
  expose((id) => setState((st) => ({ ...st, [id]: next(st[id]) })));
  return (<ul>{ids.map((id) => <Card key={id} id={id} last={state[id].last} points={state[id].points} Spark={Spark} />)}</ul>);
}

// 5. Зовнішнє сховище: картка підписана на свій ряд
function createStore() {
  let data = initial();
  const subs = new Set();
  return {
    get: (id) => data[id],
    set: (id) => { data = { ...data, [id]: next(data[id]) }; subs.forEach((f) => f()); },
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  };
}
function StoreCard({ id, store, Spark }) {
  const s = useSyncExternalStore(store.subscribe, () => store.get(id));
  return <CardBody id={id} last={s.last} points={s.points} Spark={Spark} />;
}
function StoreApp({ store, Spark }) {
  counts.parent += 1;
  return (<ul>{ids.map((id) => <StoreCard key={id} id={id} store={store} Spark={Spark} />)}</ul>);
}

const Plain = (props) => <SparkBody {...props} />;
// Типова помилка: масив для діаграми збирається в тілі рендера, тож посилання щоразу нове
const Fresh = ({ points }) => <SparkBody points={points.map((p) => ({ t: p.t, v: p.v }))} />;

const VARIANTS = {
  'контекст': { app: (e) => <CtxApp Spark={Plain} expose={e} /> },
  'контекст + memo діаграми': { app: (e) => <CtxApp Spark={SparkMemo} expose={e} /> },
  'пропси без memo': { app: (e) => <PropsApp Card={CardBody} Spark={Plain} expose={e} /> },
  'пропси без memo, нова data': { app: (e) => <PropsApp Card={CardBody} Spark={Fresh} expose={e} /> },
  'пропси + memo картки': { app: (e) => <PropsApp Card={CardMemo} Spark={SparkMemo} expose={e} /> },
  'сховище + селектор': { store: true },
};

window.runVariant = async (name, rounds = 8) => {
  const v = VARIANTS[name];
  const root = createRoot(document.getElementById('root'));
  let push;
  const store = v.store ? createStore() : null;
  const expose = (f) => { push = f; };
  flushSync(() => root.render(v.store
    ? <StoreApp store={store} Spark={Plain} />
    : v.app(expose)));
  const update = (id) => flushSync(() => (store ? store.set(id) : push(id)));
  for (const id of ids) update(id);                      // прогрів: перший кадр не рахуємо
  counts.card = counts.spark = counts.parent = 0;
  const t0 = performance.now();
  for (let r = 0; r < rounds; r++) for (const id of ids) update(id);
  const ms = performance.now() - t0;
  const out = { name, updates: rounds * CARDS, ...counts, ms };
  root.unmount();
  return out;
};
window.variants = Object.keys(VARIANTS);
