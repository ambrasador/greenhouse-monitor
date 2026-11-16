// Конфігурація домену «Теплиця»: назви, одиниці, пороги й період
// звітування. Для іншого домену змінюється цей файл, а не компоненти
export const GREENHOUSE = {
  title: 'Теплиця',
  push: true,                  // «1 год» живить потік розділу 3, не таймер
  defaultRange: '1h',          // з якого діапазону починається графік
  cards: ['soil_moisture', 'temperature'],     // метрики, для яких є картки
  metrics: {
    soil_moisture: {
      label: 'Вологість ґрунту', unit: '%', decimals: 1, periodSec: 60,
      rule: { direction: 'below', warn: 35, crit: 30 } },
    temperature: {
      label: 'Температура повітря', unit: '°C', decimals: 1, periodSec: 60,
      rule: { direction: 'above', warn: 32, crit: 35 } },
    humidity: {
      label: 'Вологість повітря', unit: '%', decimals: 1, periodSec: 60,
      rule: null },
    light: {
      label: 'Освітленість', unit: 'лк', decimals: 0, periodSec: 60,
      rule: null },
  },
};
