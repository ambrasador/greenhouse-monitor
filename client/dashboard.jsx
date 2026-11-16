import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DashboardPage } from './DashboardPage.jsx';
import { shouldRetry } from './http.js';

// Налаштування кешу для всього дашборда; окремий запит змінює їх лише з
// причини. ?cache=default вмикає типові значення бібліотеки, щоб
// порівняти їх у вимірюваннях
const TUNED = {
  staleTime: 60_000,               // хвилину дані вважаються свіжими
  gcTime: 10 * 60_000,             // невикористаний запис живе 10 хв
  refetchOnWindowFocus: false,     // свіжість дають потік і таймер
  retry: shouldRetry,              // 4xx не повторюємо
};
const tuned = new URLSearchParams(location.search).get('cache') !== 'default';
const queryClient = new QueryClient(tuned ? { defaultOptions: { queries: TUNED } } : {});
window.__queryClient = queryClient;           // для вимірювань і тестів у браузері
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DashboardPage base={location.origin} />
    </QueryClientProvider>
  </StrictMode>,
);
