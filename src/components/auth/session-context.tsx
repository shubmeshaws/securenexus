'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { canAccessRoute, hasSecurityAccess, isAdminRole, resolveUserPermissions, type UserPermissions } from '@/lib/permissions';
import type { UserScheduleAccess } from '@/lib/api-client';
import { AccessPendingBanner } from '@/components/auth/access-pending-banner';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  active: boolean;
  initials: string;
  permissions: UserPermissions;
  scheduleAccess: UserScheduleAccess;
}

const SESSION_POLL_MS = 120_000;

const SessionContext = createContext<SessionUser | null>(null);

export function useSession() {
  return useContext(SessionContext);
}

export function usePermissions(): UserPermissions {
  const session = useSession();
  return resolveUserPermissions(session?.role ?? 'viewer', session?.permissions);
}

/** Whether the current user may view/act on a specific schedule (scope + role). */
export function useScheduleAccess() {
  const session = useSession();
  const access = session?.scheduleAccess ?? { mode: 'all' as const, scheduleIds: [] };

  return {
    mode: access.mode,
    scheduleIds: access.scheduleIds,
    isScoped: access.mode === 'selected',
    canAccessSchedule: (scheduleId: string) => {
      if (!session?.active) return false;
      if (isAdminRole(session.role)) return true;
      if (access.mode === 'all') return true;
      return access.scheduleIds.includes(scheduleId);
    },
  };
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
    staleTime: 60_000,
    refetchOnWindowFocus: false,
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
      if (!publicSettings.securityModuleEnabled) {
        router.replace('/dashboard');
        return;
      }
      if (!hasSecurityAccess(session.role, session.permissions)) {
        router.replace('/dashboard');
        return;
      }
    }

    if (!canAccessRoute(session.role, pathname, session.permissions)) {
      router.replace('/dashboard');
    }
  }, [session?.active, session?.role, session?.permissions, pathname, router, publicSettings]);

  if (session && !session.active) {
    return <AccessPendingBanner />;
  }

  return <>{children}</>;
}
