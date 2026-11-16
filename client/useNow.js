import { useEffect, useState } from 'react';

// Поточний час, що оновлюється таймером: без нього картка, від якої не
// надходять дані, ніколи не перерахує свій статус. Повернення у вкладку
// оновлює час негайно, бо браузер може відкладати таймери вкладки у тлі
export function useNow(intervalMs = 10_000, clock = Date.now) {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const tick = () => setNow(clock());
    const id = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, clock]);
  return now;
}
