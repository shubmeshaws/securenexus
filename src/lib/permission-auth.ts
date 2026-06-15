import prisma from '@/lib/prisma';
import {
  hasPermission,
  resolveUserPermissions,
  type UserPermissions,
} from '@/lib/user-permissions';
import { requireAuth, type AuthenticatedRequest } from '@/lib/auth';
import type { NextApiResponse } from 'next';

export async function getUserPermissionsForRequest(
  userId: string,
  role: string
): Promise<UserPermissions> {
  if (role === 'admin') return resolveUserPermissions(role, null);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { permissions: true, active: true },
  });
  if (!user?.active) return resolveUserPermissions('viewer', null);
  return resolveUserPermissions(role, user.permissions);
}

export function requirePermission(permission: keyof UserPermissions) {
  return (
    handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void
  ) =>
    requireAuth(async (req, res) => {
      if (!(await enforcePermission(req, res, permission))) return;
      return handler(req, res);
    });
}

export async function enforcePermission(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  permission: keyof UserPermissions
): Promise<boolean> {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }

  if (req.user.role === 'admin') return true;

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { permissions: true },
  });

  if (!hasPermission(req.user.role, user?.permissions, permission)) {
    res.status(403).json({ error: 'You do not have permission for this action.' });
    return false;
  }

  return true;
}
