import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';

function sanitizeUser(u: Record<string, unknown>) {
  const { passwordHash, ...safe } = u;
  return safe;
}

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  return res.status(200).json({ users: users.map(sanitizeUser) });
}

export default function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return requireAdmin(getHandler)(req, res);
  return methodNotAllowed(res, ['GET']);
}
