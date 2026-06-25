import prisma from '@/lib/prisma';
import {
  isAdminRole,
  parseUserPermissions,
  type ScheduleAccessMode,
} from '@/lib/user-permissions';
import type { AuthenticatedRequest } from '@/lib/auth';
import type { NextApiResponse } from 'next';

export interface UserScheduleAccess {
  mode: ScheduleAccessMode;
  scheduleIds: string[];
}

export async function loadUserScheduleAccess(
  userId: string,
  role: string,
  permissionsRaw: unknown
): Promise<UserScheduleAccess> {
  if (isAdminRole(role)) {
    return { mode: 'all', scheduleIds: [] };
  }

  const permissions = parseUserPermissions(permissionsRaw);
  if (permissions.scheduleAccessMode !== 'selected') {
    return { mode: 'all', scheduleIds: [] };
  }

  const grants = await prisma.userScheduleGrant.findMany({
    where: { userId },
    select: { scheduleId: true },
  });
  return { mode: 'selected', scheduleIds: grants.map((g) => g.scheduleId) };
}

export function canAccessScheduleId(
  access: UserScheduleAccess,
  scheduleId: string,
  role: string
): boolean {
  if (isAdminRole(role)) return true;
  if (access.mode === 'all') return true;
  return access.scheduleIds.includes(scheduleId);
}

export function filterSchedulesForUser<T extends { id: string }>(
  items: T[],
  access: UserScheduleAccess,
  role: string
): T[] {
  if (isAdminRole(role) || access.mode === 'all') return items;
  const allowed = new Set(access.scheduleIds);
  return items.filter((item) => allowed.has(item.id));
}

export async function getScheduleAccessForRequest(
  req: AuthenticatedRequest
): Promise<UserScheduleAccess | null> {
  if (!req.user) return null;
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { permissions: true },
  });
  return loadUserScheduleAccess(req.user.id, req.user.role, user?.permissions);
}

export async function enforceScheduleAccess(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  scheduleId: string
): Promise<boolean> {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }

  const access = await getScheduleAccessForRequest(req);
  if (!access) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }

  if (canAccessScheduleId(access, scheduleId, req.user.role)) return true;

  res.status(403).json({ error: 'You do not have access to this schedule.' });
  return false;
}

export async function replaceUserScheduleGrants(
  userId: string,
  scheduleIds: string[]
): Promise<void> {
  const uniqueIds = Array.from(new Set(scheduleIds));
  await prisma.$transaction([
    prisma.userScheduleGrant.deleteMany({ where: { userId } }),
    ...uniqueIds.map((scheduleId) =>
      prisma.userScheduleGrant.create({ data: { userId, scheduleId } })
    ),
  ]);
}

export async function clearUserScheduleGrants(userId: string): Promise<void> {
  await prisma.userScheduleGrant.deleteMany({ where: { userId } });
}
