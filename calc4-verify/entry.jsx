import React from 'react';
import { createRoot } from 'react-dom/client';
import { Chart, LineController, LineElement, PointElement, LinearScale } from 'chart.js';
import { TelemetryChart } from '../client/TelemetryChart.jsx';

Chart.register(LineController, LineElement, PointElement, LinearScale);

// Chart.js: скільки відрізків реально малюється (lineTo) для ряду з n точок
window.countLineTo = (n, tuned) => {
  const W = 800; const H = 300;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let calls = 0;
  const orig = ctx.lineTo.bind(ctx);
  ctx.lineTo = (...a) => { calls += 1; return orig(...a); };
  const origP = Path2D.prototype.lineTo;
  Path2D.prototype.lineTo = function lineTo(...a) { calls += 1; return origP.apply(this, a); };
  const pts = Array.from({ length: n }, (_, i) => ({ x: i, y: 25 + 4 * Math.sin(i / 50) + Math.random() }));
  const options = { responsive: false, animation: false, scales: { x: { type: 'linear' }, y: { min: 18, max: 32 } } };
  const dataset = { data: pts, borderColor: '#1565c0', borderWidth: 1.5 };
  if (tuned) { options.parsing = false; options.normalized = true; dataset.pointRadius = 0; }
  const chart = new Chart(canvas, { type: 'line', data: { datasets: [dataset] }, options });
  calls = 0;
  chart.update('none');
  const out = calls;
  Path2D.prototype.lineTo = origP;
  chart.destroy(); canvas.remove();
  return out;
};

// Recharts: два TelemetryChart із спільним syncId
window.mountSync = () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ t: 1_700_000_000_000 + i * 60_000, v: 20 + Math.sin(i / 8) * 5 }));
  const rows2 = rows.map((r) => ({ ...r, v: 40 + Math.cos(r.t / 1e6) * 5 }));
  const el = document.createElement('div');
  el.style.width = '700px';
  document.body.appendChild(el);
  const domain = [rows[0].t, rows.at(-1).t];
  createRoot(el).render(
    <div>
      <div id="a"><TelemetryChart rows={rows} unit="°C" label="A" domain={domain} syncId="s" height={160} /></div>
      <div id="b"><TelemetryChart rows={rows2} unit="%" label="B" domain={domain} syncId="s" height={160} /></div>
    </div>);
};
