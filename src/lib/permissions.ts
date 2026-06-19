export type AppRole = 'admin' | 'analyst' | 'viewer';

export const ADMIN_ONLY_ROUTES = ['/clusters', '/activity', '/alerts', '/admin', '/security'] as const;

export const VIEWER_ROUTES = ['/dashboard', '/schedules', '/active-schedules', '/contact'] as const;

export const ROLE_LABELS: Record<AppRole, string> = {
  admin: 'Admin',
  analyst: 'Analyst',
  viewer: 'User',
};

import {
  isAdminRole,
  resolveUserPermissions,
  hasPermission,
} from '@/lib/user-permissions';
export { isAdminRole, resolveUserPermissions, hasPermission };
export type { UserPermissions } from '@/lib/user-permissions';

export function canAccessRoute(role: string, pathname: string): boolean {
  if (isAdminRole(role)) return true;

  if (role === 'viewer') {
    return VIEWER_ROUTES.some(
      (route) => pathname === route || pathname.startsWith(`${route}/`)
    );
  }

  return !ADMIN_ONLY_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
}

export function getVisibleNavHrefs(role: string, active: boolean): string[] {
  const all = [
    '/dashboard',
    '/infrastructure',
    '/clusters',
    '/schedules',
    '/active-schedules',
    '/activity',
    '/resource-audit',
    '/alerts',
    '/contact',
    '/security',
    '/admin',
  ];
  if (!active) return all;
  return all.filter((href) => canAccessRoute(role, href));
}
