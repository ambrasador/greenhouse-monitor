import { Profiler, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveChart } from './LiveChart.jsx';
import { useLiveFeed } from './useLiveFeed.js';
import { createWindowLoader } from './load-window.js';
import { socketIoTransport, sseTransport } from './transports.js';
import { mqttTransport } from './transport-mqtt.js';

// Демонстраційна сторінка: ?kind=socketio|sse|mqtt&device=…&metric=…&mqtt=ws://…
const q = new URLSearchParams(location.search);
const kind = q.get('kind') ?? 'socketio';
const device = q.get('device') ?? 'gh1-s01';
const metric = q.get('metric') ?? 'temperature';
const flushMs = Number(q.get('flush') ?? 1000);
const base = location.origin;

const transports = {
  socketio: () => socketIoTransport({ url: base, device }),
  sse: () => sseTransport({ url: base, device, metrics: [metric],
    silenceMs: Number(q.get('silence') ?? 40_000) }),
  mqtt: () => mqttTransport({ url: q.get('mqtt'), device,
    version: Number(q.get('mqttv') ?? 5) }),
};

window.__log = [];
window.__commits = 0;
const t0 = performance.now();

function Page() {
  const view = useLiveFeed(() => ({
    transport: transports[kind](),
    loadWindow: createWindowLoader({ base, device, metrics: [metric] }),
    flushMs,
  }), [kind, device, metric]);
  window.__view = view;
  const last = window.__log.at(-1);
  if (!last || last[1] !== view.status || last[2] !== view.attempt) {
    window.__log.push([Math.round(performance.now() - t0), view.status, view.attempt]);
  }
  return (
    <Profiler id="chart" onRender={() => { window.__commits += 1; }}>
      <LiveChart view={view} series={`${device}/${metric}`} unit=" °C" />
    </Profiler>
  );
}

const app = <Page />;
createRoot(document.getElementById('root'))
  .render(q.get('strict') === '1' ? <StrictMode>{app}</StrictMode> : app);
