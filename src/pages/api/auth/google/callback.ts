import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { signToken } from '@/lib/auth';
import prisma from '@/lib/prisma';
import {
  buildAuthCookie,
  exchangeCodeForTokens,
  fetchGoogleUserInfo,
  getAllowedDomain,
  isGoogleAuthConfigured,
  validateEmailDomain,
} from '@/lib/google-auth';
import { getNewUserAccessEnabled } from '@/lib/settings';
import { DEFAULT_NEW_USER_PERMISSIONS } from '@/lib/user-permissions';

function getOAuthState(req: NextApiRequest): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  const match = cookie.match(/(?:^|;\s*)sn_oauth_state=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isGoogleAuthConfigured()) {
    return res.redirect(302, '/login?error=google_auth_not_configured');
  }

  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(302, `/login?error=${encodeURIComponent(String(error))}`);
  }

  if (!code || typeof code !== 'string') {
    return res.redirect(302, '/login?error=missing_code');
  }

  const savedState = getOAuthState(req);
  if (!savedState || state !== savedState) {
    return res.redirect(302, '/login?error=invalid_state');
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const profile = await fetchGoogleUserInfo(tokens.access_token);

    if (!(await validateEmailDomain(profile.email))) {
      const allowed = (await getAllowedDomain()) || 'your organization';
      return res.redirect(
        302,
        `/login?error=${encodeURIComponent(`Only @${allowed} accounts are allowed`)}`
      );
    }

    const email = profile.email.toLowerCase();
    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      const userCount = await prisma.user.count();
      const isFirstUser = userCount === 0;
      const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const newUserAccessEnabled = isFirstUser ? true : await getNewUserAccessEnabled();
      user = await prisma.user.create({
        data: {
          email,
          displayName: profile.name || profile.email,
          passwordHash,
          role: isFirstUser ? 'admin' : 'viewer',
          active: newUserAccessEnabled,
          permissions: isFirstUser ? undefined : { ...DEFAULT_NEW_USER_PERMISSIONS },
        },
      });
    } else if (user.displayName !== (profile.name || profile.email)) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { displayName: profile.name || profile.email },
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    const token = signToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    res.setHeader('Set-Cookie', [
      buildAuthCookie(token),
      'sn_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ]);
    return res.redirect(302, '/dashboard');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Authentication failed';
    return res.redirect(302, `/login?error=${encodeURIComponent(message)}`);
  }
}
