'use client';

import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { setClientSettings } from '@/lib/client-settings';

async function fetchPublicSettings() {
  const res = await fetch('/api/settings/public', { credentials: 'include' });
  if (!res.ok) return { demoMode: false, apiBaseUrl: '' };
  return res.json() as Promise<{ demoMode: boolean; apiBaseUrl: string }>;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({
    queryKey: ['public-settings'],
    queryFn: fetchPublicSettings,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (data) setClientSettings(data);
  }, [data]);

  return <>{children}</>;
}
