'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { canAccessRoute, resolveUserPermissions, type UserPermissions } from '@/lib/permissions';
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

const SESSION_POLL_MS = 5_000;

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
    staleTime: 2_000,
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

  useEffect(() => {
    if (!session?.active || !pathname) return;
    if (!canAccessRoute(session.role, pathname)) {
      router.replace('/dashboard');
    }
  }, [session?.active, session?.role, pathname, router]);

  if (session && !session.active) {
    return <AccessPendingBanner />;
  }

  return <>{children}</>;
}
