'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: true,
            refetchIntervalInBackground: false,
          },
        },
      })
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Default page refresh (infrastructure, clusters, activity). */
export const POLL_INTERVAL = 60_000;

/** Schedules / live badge — aligned with dashboard refresh cadence. */
export const SCHEDULE_POLL_INTERVAL = 30_000;

export const scheduleLiveQueryOptions = {
  refetchInterval: SCHEDULE_POLL_INTERVAL,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  staleTime: 20_000,
} as const;
