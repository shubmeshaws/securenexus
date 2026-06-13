import type { NextApiRequest, NextApiResponse } from 'next';
import { clearAuthCookie } from '@/lib/google-auth';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const next = typeof req.query.next === 'string' ? req.query.next : '/login';
  const error = typeof req.query.error === 'string' ? req.query.error : null;
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/login';
  const destination = error
    ? `${safeNext}?error=${encodeURIComponent(error)}`
    : safeNext;

  res.setHeader('Set-Cookie', clearAuthCookie());
  return res.redirect(302, destination);
}
