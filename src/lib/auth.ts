import jwt, { type SignOptions } from 'jsonwebtoken';
import type { NextApiRequest, NextApiResponse } from 'next';

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

export function requireAuth(
  handler: (req: AuthenticatedRequest, res: NextApiResponse) => Promise<void> | void
) {
  return async (req: AuthenticatedRequest, res: NextApiResponse) => {
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization token required' });
    }
    try {
      req.user = verifyToken(token);
      return handler(req, res);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
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
