import { useEffect, useState } from 'react';
import {
  useQuery, useQueries, useQueryClient, keepPreviousData,
} from '@tanstack/react-query';
import { fetchHistory, refreshMs, RANGES } from './history.js';
import { applyLive } from './merge.js';
import { deviceQuery, combineDevices } from './queries.js';
import { HttpError } from './http.js';
import { createLiveFeed } from './livefeed.js';
import { createWindowLoader } from './load-window.js';
import { socketIoTransport } from './transports.js';

// Ключ запиту: усе, від чого залежить відповідь, і нічого зайвого
export const telemetryKey = (device, metric, range) =>
  ['telemetry', device, metric, range];

const MIN = 60_000;
const LIVE_MAX = 3600;        // запобіжник: 1 Гц протягом години

export function useTelemetryHistory(
  { base = '', device, metric, range, periodSec, push = false }) {
  return useQuery({
    queryKey: telemetryKey(device, metric, range),
    queryFn: ({ signal }) => fetchHistory(
      { base, device, metric, range, periodSec, signal }),
    enabled: Boolean(device && metric),
    // Таймер залежить від виду даних: сирі точки «1 год» оновлює потік
    refetchInterval: (q) => refreshMs(range, q.state.data, push),
    // Потоковий ряд не порівнюємо з попереднім покадрово: applyLive сам не
    // створює нового об’єкта, коли змін немає
    structuralSharing: range !== '1h',
    // Попередній графік лишається, поки вантажиться інший діапазон,
    // але не інший пристрій чи показник
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey[1] === device && prevQuery?.queryKey[2] === metric
        ? keepPreviousData(prev) : undefined),
  });
}

// Пристрої: список, а для кожного — окремий запис із полем latest. Картки
// опитують API кожні T/2 (розділ 1: для теплиці опитування достатньо)
export function useDevices(base = '', periodSec = 60) {
  const list = useQuery({
    queryKey: ['devices'],
    queryFn: async ({ signal }) => {
      const ids = [];
      let cursor = null;
      do {
        const url = `${base}/api/v1/devices?limit=1000`
          + (cursor ? `&cursor=${cursor}` : '');
        const res = await fetch(url, { signal });
        if (!res.ok) throw new HttpError(res.status);
        const page = await res.json();
        ids.push(...page.data.map((d) => d.id));
        cursor = page.next;
      } while (cursor);
      return ids;
    },
    staleTime: 5 * MIN,
  });
  return useQueries({
    queries: (list.data ?? []).map((id) => deviceQuery(base, id, periodSec)),
    combine: combineDevices,
  });
}

// Живі точки потрапляють у кеш діапазону «1 год»: ряд на екрані — єдиний,
// а контролер з розділу 3 лишається буфером узгодження. Злиття
// ідемпотентне, тому знімок вікна можна передавати щоразу повністю
export function useLiveTelemetry(
  { base = '', device, metric, enabled = true }) {
  const queryClient = useQueryClient();
  const [conn, setConn] = useState({ status: 'connecting', attempt: 0 });
  useEffect(() => {
    if (!enabled || !device || !metric) return undefined;
    const key = telemetryKey(device, metric, '1h');
    const feed = createLiveFeed({
      transport: socketIoTransport(
        { url: base || location.origin, device }),
      loadWindow: createWindowLoader({ base, device, metrics: [metric] }),
      flushMs: 1000,
      onView: (view) => {
        setConn((c) => (c.status === view.status
          && c.attempt === view.attempt
          ? c : { status: view.status, attempt: view.attempt }));
        const fresh = (view.series[`${device}/${metric}`] ?? [])
          .map((p) => ({ t: Date.parse(p.ts), v: p.value }));
        if (!fresh.length) return;
        // undefined (історії чи нових точок немає) — кеш не змінюється
        queryClient.setQueryData(key, (old) => applyLive(old, fresh,
          { windowMs: RANGES['1h'].ms, max: LIVE_MAX }));
      },
    });
    feed.start();
    return () => feed.stop();
  }, [queryClient, base, device, metric, enabled]);
  return conn;
}
