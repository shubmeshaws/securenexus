import type { AdminUser } from '@/lib/api-client';
import { normalizeAppRole } from '@/lib/user-permissions';
import { formatRelativeTime } from '@/lib/utils';

const ROLE_LABELS: Record<'admin' | 'analyst' | 'viewer', string> = {
  admin: 'Admin',
  analyst: 'Analyst',
  viewer: 'User',
};

/** Lowercase blob of all user fields shown in the admin table (for client-side search). */
export function userSearchText(user: AdminUser): string {
  const role = normalizeAppRole(user.role);
  return [
    user.displayName,
    user.email,
    role,
    ROLE_LABELS[role],
    user.active ? 'enabled access active' : 'disabled access inactive',
    user.lastLogin ? formatRelativeTime(user.lastLogin) : 'never',
    user.lastLogin,
    user.createdAt,
    user.id,
  ]
    .filter((part) => part != null && String(part).trim())
    .join(' ')
    .toLowerCase();
}

export function filterUsersByQuery(users: AdminUser[], query: string): AdminUser[] {
  const q = query.trim().toLowerCase();
  if (!q) return users;
  return users.filter((user) => userSearchText(user).includes(q));
}
