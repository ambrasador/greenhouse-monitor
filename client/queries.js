import { HttpError } from './http.js';

// Параметри запиту одного пристрою для useQueries. Загальні налаштування
// кешу (dashboard.jsx) вимикають повторний запит при поверненні до вкладки,
// а картки — виняток: статус залежить від віку даних, і після паузи їх
// треба оновити одразу, а не за таймером. Запит дешевий: один на пристрій
export const deviceQuery = (base, id, periodSec = 60) => ({
  queryKey: ['device', id],
  queryFn: async ({ signal }) => {
    const res = await fetch(`${base}/api/v1/devices/${id}`, { signal });
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  staleTime: periodSec * 250,       // T/4: швидкі повернення без запиту
  refetchInterval: periodSec * 500, // T/2: опитування, поки вкладка видима
  refetchOnWindowFocus: true,       // після паузи — одразу, якщо застаріло
});

// Окрема функція модуля: бібліотека викликає combine заново лише тоді, коли
// змінилися відповіді, а результат структурно ділиться між викликами
export const combineDevices = (results) =>
  results.map((r) => r.data).filter(Boolean);
