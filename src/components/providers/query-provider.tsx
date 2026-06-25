'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 120_000,
            retry: 1,
            refetchOnWindowFocus: false,
            refetchIntervalInBackground: false,
          },
        },
      })
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Default page refresh (infrastructure, clusters, activity). */
export const POLL_INTERVAL = 180_000;

/** Schedules / live status — live data still refreshes; manual refresh always available. */
export const SCHEDULE_POLL_INTERVAL = 180_000;

export const scheduleLiveQueryOptions = {
  refetchInterval: SCHEDULE_POLL_INTERVAL,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: false,
  staleTime: 120_000,
} as const;

export const overviewQueryOptions = {
  refetchInterval: SCHEDULE_POLL_INTERVAL,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: false,
  staleTime: 120_000,
} as const;

export const dashboardInsightsQueryOptions = {
  staleTime: 120_000,
  refetchInterval: 180_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: false,
} as const;
