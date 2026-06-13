import type { NextApiResponse } from 'next';
import prisma from '@/lib/prisma';
import { getTokenFromRequest, verifyToken, type AuthenticatedRequest } from '@/lib/auth';
import { resolveUserPermissions } from '@/lib/user-permissions';

export default async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const claims = verifyToken(token);
    const dbUser = await prisma.user.findUnique({ where: { id: claims.id } });
    if (!dbUser) return res.status(401).json({ error: 'User not found' });

    const initials = dbUser.displayName
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || dbUser.email.slice(0, 2).toUpperCase();

    return res.status(200).json({
      user: {
        id: dbUser.id,
        email: dbUser.email,
        displayName: dbUser.displayName,
        role: dbUser.role,
        active: dbUser.active,
        initials: initials || 'SN',
        permissions: resolveUserPermissions(dbUser.role, dbUser.permissions),
      },
    });
  } catch {
    return res.status(401).json({ error: 'Invalid session' });
  }
}
