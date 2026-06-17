'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { BrandSubbranding } from '@/components/brand/brand-logo';

function GoogleIcon() {
  return (
    <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

const ERROR_MESSAGES: Record<string, string> = {
  google_auth_not_configured:
    'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.',
  session_expired: 'Your session has expired. Please sign in again.',
};

function formatError(raw: string): string {
  return ERROR_MESSAGES[raw] ?? decodeURIComponent(raw);
}

export function LoginPage() {
  const searchParams = useSearchParams();
  const error = searchParams?.get('error');
  const [googleAuthConfigured, setGoogleAuthConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/settings/public')
      .then((res) => res.json())
      .then((data: { googleAuthConfigured?: boolean }) => {
        setGoogleAuthConfigured(Boolean(data.googleAuthConfigured));
      })
      .catch(() => setGoogleAuthConfigured(false));
  }, []);

  const authReady = googleAuthConfigured === true;

  return (
    <div className="login-page relative flex min-h-screen items-center justify-center overflow-hidden bg-white px-4">
      <div className="login-orb login-orb-1" aria-hidden />
      <div className="login-orb login-orb-2" aria-hidden />
      <div className="login-orb login-orb-3" aria-hidden />

      <div className="login-card relative z-10 w-full max-w-md animate-slide-up">
        <div className="mb-8 text-center">
          <h1 className="font-brand text-3xl font-bold tracking-tight sm:text-4xl">
            <span className="text-zinc-900">Secure</span>
            <span className="brand-accent">Nexus</span>
          </h1>
          <BrandSubbranding className="mt-1.5" />
          <p className="mt-3 text-sm text-zinc-500">Sign in to manage your EKS infrastructure</p>
        </div>

        {error && (
          <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {formatError(error)}
          </div>
        )}

        {googleAuthConfigured === false && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Google OAuth credentials are missing. Configure GOOGLE_CLIENT_ID and
            GOOGLE_CLIENT_SECRET in your environment before signing in.
          </div>
        )}

        {authReady ? (
          <button
            type="button"
            onClick={() => {
              window.location.href = '/api/auth/google';
            }}
            className="login-google-btn group flex w-full items-center justify-center gap-3 rounded-xl border border-zinc-200 bg-white px-5 py-3.5 text-sm font-medium text-zinc-700 shadow-sm transition-all hover:border-zinc-300 hover:shadow-md active:scale-[0.98]"
          >
            <GoogleIcon />
            <span>Login with Google</span>
          </button>
        ) : googleAuthConfigured === false ? (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-3.5 text-center text-sm text-zinc-500">
            Sign-in is unavailable until Google OAuth is configured.
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-3.5 text-center text-sm text-zinc-500">
            Checking sign-in configuration…
          </div>
        )}

        <p className="mt-6 text-center text-xs text-zinc-400">Organization accounts only</p>
      </div>
    </div>
  );
}
