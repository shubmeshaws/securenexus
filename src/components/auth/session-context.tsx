'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { canAccessRoute, isAdminRole, resolveUserPermissions, type UserPermissions } from '@/lib/permissions';
import { AccessPendingBanner } from '@/components/auth/access-pending-banner';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  active: boolean;
  initials: string;
  permissions: UserPermissions;
}

const SESSION_POLL_MS = 60_000;

const SessionContext = createContext<SessionUser | null>(null);

export function useSession() {
  return useContext(SessionContext);
}

export function usePermissions(): UserPermissions {
  const session = useSession();
  return resolveUserPermissions(session?.role ?? 'viewer', session?.permissions);
}

async function fetchSession() {
  return apiFetch<{ user: SessionUser }>('/api/auth/me');
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({
    queryKey: ['auth-me'],
    queryFn: async () => {
      try {
        return await fetchSession();
      } catch {
        return null;
      }
    },
    refetchInterval: SESSION_POLL_MS,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  return (
    <SessionContext.Provider value={data?.user ?? null}>{children}</SessionContext.Provider>
  );
}

export function AccessGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();

  const { data: publicSettings } = useQuery({
    queryKey: ['public-settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/public', { credentials: 'include' });
      if (!res.ok) return { securityModuleEnabled: false };
      return res.json() as Promise<{ securityModuleEnabled?: boolean }>;
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!session?.active || !pathname) return;

    if (pathname.startsWith('/security')) {
      if (publicSettings === undefined) return;
      if (!isAdminRole(session.role) || !publicSettings.securityModuleEnabled) {
        router.replace('/dashboard');
        return;
      }
    }

    if (!canAccessRoute(session.role, pathname)) {
      router.replace('/dashboard');
    }
  }, [session?.active, session?.role, pathname, router, publicSettings]);

  if (session && !session.active) {
    return <AccessPendingBanner />;
  }

  return <>{children}</>;
}
