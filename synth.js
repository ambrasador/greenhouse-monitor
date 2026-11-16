'use strict';
// Відтворюваний тижневий ряд теплиці для вимірювань розділу 4. Усі параметри — навчальні
// припущення. Генератор детермінований: однакове зерно дає однаковий ряд

// mulberry32: малий генератор псевдовипадкових чисел із зерном
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Нормальний розподіл за методом Бокса — Мюллера
function normal(rand) {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Інцидент: заклинило кватирку на четверту добу о 14:20 за UTC. Гаусів сплеск
// з σ = 4,67 хв перевищує поріг 35 °C приблизно 9 хв; вершину ряду задано рівно 38,6 °C
const INCIDENT = { day: 3, minuteOfDay: 14 * 60 + 20, sigmaMin: 4.67, peak: 38.6 };

// start — початок першої доби (мс, UTC, опівночі), stepSec — крок вимірювань. Година доби
// береться з абсолютного часу, тож фаза добового циклу збігається з годинником UTC
function greenhouseSeries({ seed = 42, start, days = 7, stepSec = 60, incident = true, noise = 1 }) {
  const rand = rng(seed);
  const n = Math.round((days * DAY) / (stepSec * 1000));
  const out = { temperature: [], humidity: [], soil_moisture: [], light: [] };
  let soil = 48;
  let peakIdx = -1;
  for (let i = 0; i < n; i++) {
    const t = start + i * stepSec * 1000;
    const h = (t % DAY) / HOUR;                               // година доби за UTC
    const sun = Math.sin((2 * Math.PI * (h - 9)) / 24);       // максимум о 15:00
    let temp = 24 + 5 * sun + 0.3 * noise * normal(rand);
    if (incident) {
      const m = (t - start) / 60_000 - (INCIDENT.day * 1440 + INCIDENT.minuteOfDay);
      const base = 24 + 5 * Math.sin((2 * Math.PI * (INCIDENT.minuteOfDay / 60 - 9)) / 24);
      const amp = INCIDENT.peak - base;
      temp += amp * Math.exp(-0.5 * (m / INCIDENT.sigmaMin) ** 2);
      if (m === 0) peakIdx = i;
    }
    // вологість повітря обернено залежить від температури; ґрунт сохне й поливається
    const hum = 62 - 14 * sun + 1.2 * noise * normal(rand);
    soil -= 0.004 * stepSec / 60 * (1 + 0.5 * Math.max(0, sun)) + 0.002 * Math.abs(normal(rand));
    if (soil < 31) soil = 52;                                  // полив
    const light = Math.max(0, 52_000 * Math.sin((2 * Math.PI * (h - 6)) / 24) ** 3 * (h > 6 && h < 18 ? 1 : 0));
    out.temperature.push({ t, v: Math.round(temp * 100) / 100 });
    out.humidity.push({ t, v: Math.round(Math.min(100, Math.max(0, hum)) * 10) / 10 });
    out.soil_moisture.push({ t, v: Math.round(soil * 100) / 100 });
    out.light.push({ t, v: Math.round(light) });
  }
  if (peakIdx >= 0) out.temperature[peakIdx].v = INCIDENT.peak;
  return out;
}

// Умовний маршрут транспортного засобу: рух із поворотами (8–22 м/с) і стоянки (2–30 хв).
// Шум GPS — нормальний із σ = 3 м по кожній осі. Повертає [{ t, lat, lon }]
function fleetTrack({ seed = 7, start, hours = 8, stepSec = 5, noiseM = 3,
  lat0 = 46.64, lon0 = 32.62 }) {
  const rand = rng(seed);
  const R = 6_371_008.8;
  const n = Math.round((hours * 3600) / stepSec);
  const out = [];
  let [x, y, heading] = [0, 0, rand() * 2 * Math.PI];
  let mode = 'drive';
  let left = 0;                                  // кроків до зміни режиму
  let speed = 0;
  let toTurn = 0;
  for (let i = 0; i < n; i++) {
    if (left <= 0) {
      mode = mode === 'drive' ? 'stop' : 'drive';
      left = Math.round((mode === 'drive' ? 300 + 2100 * rand() : 120 + 1680 * rand()) / stepSec);
      speed = mode === 'drive' ? 8 + 14 * rand() : 0;
    }
    left -= 1;
    if (mode === 'drive') {
      toTurn -= 1;
      if (toTurn <= 0) {                         // поворот на перехресті
        heading += (rand() < 0.5 ? -1 : 1) * (0.35 + 1.2 * rand());
        toTurn = Math.round((30 + 170 * rand()) / stepSec);
      }
      heading += 0.004 * normal(rand);           // повільний дрейф курсу
      x += speed * stepSec * Math.cos(heading);
      y += speed * stepSec * Math.sin(heading);
    }
    const nx = x + noiseM * normal(rand);
    const ny = y + noiseM * normal(rand);
    out.push({ t: start + i * stepSec * 1000,
      lat: lat0 + (ny / R) * (180 / Math.PI),
      lon: lon0 + (nx / (R * Math.cos((lat0 * Math.PI) / 180))) * (180 / Math.PI) });
  }
  return out;
}

module.exports = { greenhouseSeries, fleetTrack, rng, normal, INCIDENT, HOUR, DAY };
