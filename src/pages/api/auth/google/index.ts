import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { getGoogleAuthUrl, isGoogleAuthConfigured } from '@/lib/google-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isGoogleAuthConfigured()) {
    return res.status(503).json({
      error:
        'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env',
    });
  }

  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `sn_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  const authUrl = await getGoogleAuthUrl(state);
  return res.redirect(302, authUrl);
}
