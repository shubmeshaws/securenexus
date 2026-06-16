import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PROTECTED_PREFIXES = [
  '/dashboard',
  '/infrastructure',
  '/clusters',
  '/schedules',
  '/active-schedules',
  '/activity',
  '/resource-audit',
  '/alerts',
  '/admin',
];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function hasAuthToken(request: NextRequest): boolean {
  return Boolean(request.cookies.get('sn_token')?.value);
}

function isGoogleAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const googleReady = isGoogleAuthConfigured();

  if (isProtected(pathname)) {
    if (!googleReady) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('error', 'google_auth_not_configured');
      return NextResponse.redirect(loginUrl);
    }

    if (!hasAuthToken(request)) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('from', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/getting-started',
    '/login',
    '/dashboard',
    '/dashboard/:path*',
    '/infrastructure',
    '/infrastructure/:path*',
    '/clusters',
    '/clusters/:path*',
    '/schedules',
    '/schedules/:path*',
    '/active-schedules',
    '/active-schedules/:path*',
    '/activity',
    '/activity/:path*',
    '/resource-audit',
    '/resource-audit/:path*',
    '/alerts',
    '/alerts/:path*',
    '/admin',
    '/admin/:path*',
  ],
};
