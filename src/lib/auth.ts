import jwt, { type SignOptions } from 'jsonwebtoken';
import type { NextApiRequest, NextApiResponse } from 'next';
import prisma from '@/lib/prisma';

export const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-change-in-production';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  is_seedadmin?: boolean;
}

export interface AuthenticatedRequest extends NextApiRequest {
  user?: AuthUser;
}

export function signToken(user: AuthUser, expiresIn: SignOptions['expiresIn'] = '7d'): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn });
}

export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, JWT_SECRET) as AuthUser;
}

export function getTokenFromRequest(req: NextApiRequest): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.split(' ')[1] ?? null;
  }

  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)sn_token=([^;]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }

  return null;
}

/** Resolve the current user from DB so role/active changes apply without re-login. */
export async function resolveAuthUserFromToken(
  token: string
): Promise<(AuthUser & { active: boolean }) | null> {
  try {
    const claims = verifyToken(token);
    const dbUser = await prisma.user.findUnique({
      where: { id: claims.id },
      select: { id: true, email: true, role: true, active: true },
    });
    if (!dbUser) return null;
    return {
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
      active: dbUser.active,
    };
  } catch {
    return null;
  }
}

export function requireAuth(
  handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void
) {
  return async (req: AuthenticatedRequest, res: NextApiResponse) => {
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization token required' });
    }

    const user = await resolveAuthUserFromToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (!user.active) {
      return res.status(403).json({ error: 'Access denied. Account is not enabled.' });
    }

    req.user = { id: user.id, email: user.email, role: user.role };
    return handler(req, res);
  };
}

export function requireAdmin(
  handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void
) {
  return requireAuth(async (req, res) => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
    }
    return handler(req, res);
  });
}

export type ApiHandler = (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void;

export function methodNotAllowed(res: NextApiResponse, allowed: string[]) {
  res.setHeader('Allow', allowed);
  return res.status(405).json({ error: `Method not allowed. Allowed: ${allowed.join(', ')}` });
}
