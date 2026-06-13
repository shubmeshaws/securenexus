import { getAllowedDomain as getAllowedDomainFromSettings } from '@/lib/settings';

export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3005';
}

export async function getAllowedDomain(): Promise<string | null> {
  return getAllowedDomainFromSettings();
}

export function isGoogleAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export async function getGoogleAuthUrl(state: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${getAppUrl()}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });

  const domain = await getAllowedDomain();
  if (domain) params.set('hd', domain);

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface GoogleUserInfo {
  id: string;
  email: string;
  name: string;
  picture?: string;
  hd?: string;
}

export async function exchangeCodeForTokens(code: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${getAppUrl()}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.error || 'Token exchange failed');
  }

  return res.json() as Promise<{ access_token: string }>;
}

export interface VerifiedGoogleToken {
  sub: string;
  email: string;
  email_verified: boolean | string;
  name?: string;
  picture?: string;
  hd?: string;
  aud: string;
}

export async function verifyGoogleAccessToken(accessToken: string): Promise<VerifiedGoogleToken> {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  );

  if (!res.ok) {
    throw new Error('Invalid Google access token');
  }

  const info = (await res.json()) as VerifiedGoogleToken;
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId || info.aud !== clientId) {
    throw new Error('Google token audience mismatch');
  }

  const verified = info.email_verified === true || info.email_verified === 'true';
  if (!verified) {
    throw new Error('Google account email is not verified');
  }

  if (!info.email) {
    throw new Error('Google account has no email');
  }

  return info;
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const verified = await verifyGoogleAccessToken(accessToken);
  return {
    id: verified.sub,
    email: verified.email,
    name: verified.name ?? verified.email,
    picture: verified.picture,
    hd: verified.hd,
  };
}

export async function validateEmailDomain(email: string): Promise<boolean> {
  const allowed = await getAllowedDomain();
  if (!allowed) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain === allowed.toLowerCase();
}

export function buildAuthCookie(token: string): string {
  const maxAge = 7 * 24 * 60 * 60;
  const secure = getAppUrl().startsWith('https') ? '; Secure' : '';
  return `sn_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearAuthCookie(): string {
  return 'sn_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}
