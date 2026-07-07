import type { NextApiResponse } from 'next';
import { requireAuth, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import {
  hasSecurityTabAccess,
  isAdminRole,
  type SecurityTabPermission,
} from '@/lib/user-permissions';
import { assertSecurityModuleEnabled } from '@/lib/security-service';

type HandlerReturn = void | NextApiResponse;

export function requireSecurityTab(tab: SecurityTabPermission) {
  return (
    handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<HandlerReturn> | HandlerReturn
  ) =>
    requireAuth(async (req, res) => {
      try {
        await assertSecurityModuleEnabled();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Security module is disabled';
        return res.status(403).json({ error: message });
      }
      if (!(await enforceSecurityTab(req, res, tab))) return;
      return handler(req, res);
    });
}

export async function enforceSecurityTab(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  tab: SecurityTabPermission
): Promise<boolean> {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }

  if (isAdminRole(req.user.role)) return true;

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { permissions: true, active: true },
  });

  if (!user?.active) {
    res.status(403).json({ error: 'Access denied. Account is not enabled.' });
    return false;
  }

  if (!hasSecurityTabAccess(req.user.role, user.permissions, tab)) {
    res.status(403).json({ error: 'You do not have permission to access this security feature.' });
    return false;
  }

  return true;
}
