import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { normalizeAppRole, parseUserPermissions } from '@/lib/user-permissions';

function sanitizeUser(u: Record<string, unknown>) {
  const { passwordHash, permissions, ...safe } = u;
  return {
    ...safe,
    role: normalizeAppRole(typeof safe.role === 'string' ? safe.role : undefined),
    displayName: typeof safe.displayName === 'string' && safe.displayName.trim()
      ? safe.displayName
      : typeof safe.email === 'string'
        ? safe.email
        : 'User',
    email: typeof safe.email === 'string' ? safe.email : '',
    active: Boolean(safe.active),
    permissions:
      permissions !== undefined && permissions !== null
        ? parseUserPermissions(permissions)
        : undefined,
  };
}

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  return res.status(200).json({ users: users.map(sanitizeUser) });
}

export default function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return requireAdmin(getHandler)(req, res);
  return methodNotAllowed(res, ['GET']);
}
