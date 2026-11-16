// Вимірювання малювання лінійного графіка: Recharts (типові й налаштовані параметри),
// Chart.js (типові, без проріджування, LTTB), чистий SVG-шлях і чистий canvas 2D.
// Сторінка керується з Playwright: window.runCase(lib, n)
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { Chart, LineController, LineElement, PointElement, LinearScale, Decimation, Tooltip as CjTooltip } from 'chart.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, Decimation, CjTooltip);

const W = 800;
const H = 300;
const DAY = 86_400_000;
const NS = 'http://www.w3.org/2000/svg';

// Ряд за 7 діб: добова хвиля 25 ± 4 °C і шум; крок = 7 діб / n
function makeData(n) {
  const step = (7 * DAY) / n;
  let s = 12345;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, (_, i) => ({ t: i * step, v: 25 + 4 * Math.sin((2 * Math.PI * i * step) / DAY) + (rnd() - 0.5) }));
}
const slide = (data) => {                                // нова точка праворуч, найстарішу прибрано
  const last = data[data.length - 1];
  const step = last.t - data[data.length - 2].t;
  const t = last.t + step;
  return [...data.slice(1), { t, v: 25 + 4 * Math.sin((2 * Math.PI * t) / DAY) + (Math.random() - 0.5) }];
};

const recharts = (tuned) => ({
  mount(el, data) {
    const root = createRoot(el);
    const render = (d) => flushSync(() => root.render(
      <LineChart width={W} height={H} data={d} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} />
        <YAxis domain={[18, 32]} />
        <Tooltip />
        {tuned
          ? <Line dataKey="v" dot={false} isAnimationActive={false} stroke="#1565c0" />
          : <Line dataKey="v" stroke="#1565c0" />}
      </LineChart>));
    render(data);
    let cur = data;
    return {
      update: () => { cur = slide(cur); render(cur); },
      hover: el.querySelector('.recharts-wrapper'),
      destroy: () => root.unmount(),
    };
  },
});

const chartjs = (variant) => ({
  mount(el, data) {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    el.appendChild(canvas);
    const points = data.map((p) => ({ x: p.t, y: p.v }));
    const tuned = variant !== 'default';
    const options = {
      responsive: false, scales: { x: { type: 'linear' }, y: { min: 18, max: 32 } },
      plugins: { legend: { display: false } },
    };
    const dataset = { data: points, borderColor: '#1565c0', borderWidth: 1.5 };
    if (tuned) { options.animation = false; options.parsing = false; options.normalized = true; dataset.pointRadius = 0; }
    if (variant === 'lttb') options.plugins.decimation = { enabled: true, algorithm: 'lttb', samples: 500 };
    const chart = new Chart(canvas, { type: 'line', data: { datasets: [dataset] }, options });
    return {
      update: () => {
        const last = points[points.length - 1];
        const step = last.x - points[points.length - 2].x;
        const t = last.x + step;
        points.shift();
        points.push({ x: t, y: 25 + 4 * Math.sin((2 * Math.PI * t) / DAY) + (Math.random() - 0.5) });
        chart.update(tuned ? 'none' : undefined);
      },
      hover: canvas,
      destroy: () => chart.destroy(),
    };
  },
});

const toPath = (d) => {
  const t0 = d[0].t;
  const k = (W - 1) / (d[d.length - 1].t - t0);
  const parts = new Array(d.length);
  for (let i = 0; i < d.length; i++) parts[i] = `${i ? 'L' : 'M'}${((d[i].t - t0) * k).toFixed(1)} ${(H - ((d[i].v - 18) / 14) * H).toFixed(1)}`;
  return parts.join('');
};
const svgPath = {
  mount(el, data) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#1565c0'); path.setAttribute('stroke-width', '1.5');
    svg.appendChild(path); el.appendChild(svg);
    let cur = data;
    path.setAttribute('d', toPath(cur));
    return { update: () => { cur = slide(cur); path.setAttribute('d', toPath(cur)); }, hover: null, destroy: () => svg.remove() };
  },
};

const canvas2d = {
  mount(el, data) {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H; el.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#1565c0'; ctx.lineWidth = 1.5;
    const draw = (d) => {
      const t0 = d[0].t;
      const k = (W - 1) / (d[d.length - 1].t - t0);
      ctx.clearRect(0, 0, W, H);
      ctx.beginPath();
      for (let i = 0; i < d.length; i++) {
        const x = (d[i].t - t0) * k;
        const y = H - ((d[i].v - 18) / 14) * H;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    };
    let cur = data;
    draw(cur);
    return { update: () => { cur = slide(cur); draw(cur); }, hover: null, destroy: () => canvas.remove() };
  },
};

const LIBS = {
  'recharts-default': recharts(false),
  'recharts-tuned': recharts(true),
  'chartjs-default': chartjs('default'),
  'chartjs-plain': chartjs('plain'),
  'chartjs-lttb': chartjs('lttb'),
  'svg-path': svgPath,
  'canvas-2d': canvas2d,
};
window.libs = Object.keys(LIBS);

const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// Цикл «кадр за кадром»: у кожному кадрі виконується дія; повертає кадри за секунду
// й медіану синхронної частини дії
function loop(action, ms = 2000, warm = 500) {
  return new Promise((resolve) => {
    let start; let frames = 0; const work = [];
    const tick = (now) => {
      start ??= now;
      const t0 = performance.now();
      action(frames);
      const dt = performance.now() - t0;
      if (now - start > warm) { frames += 1; work.push(dt); }
      if (now - start < warm + ms) requestAnimationFrame(tick);
      else resolve({ fps: (frames * 1000) / (now - start - warm), work: median(work) });
    };
    requestAnimationFrame(tick);
  });
}

window.runCase = async (lib, n) => {
  const host = document.getElementById('host');
  const data = makeData(n);
  const adapter = LIBS[lib];
  const t0 = performance.now();
  const chart = adapter.mount(host, data);
  const sync = performance.now() - t0;
  await frame();
  const first = performance.now() - t0;                  // від початку побудови до першого кадру
  const nodes = host.querySelectorAll('*').length;
  await new Promise((r) => setTimeout(r, 1200));          // поки відпрацюють вбудовані анімації
  const append = await loop(() => chart.update());
  let hover = null;
  if (chart.hover) {
    const rect = chart.hover.getBoundingClientRect();
    hover = await loop((i) => {
      const x = rect.left + 60 + ((i * 7) % (rect.width - 80));
      chart.hover.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: rect.top + 150 }));
    });
  }
  chart.destroy();
  return { lib, n, sync, first, nodes, appendFps: append.fps, appendWork: append.work,
    hoverFps: hover?.fps ?? null };
};
