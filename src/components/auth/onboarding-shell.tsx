'use client';

import { BrandSubbranding } from '@/components/brand/brand-logo';
import { cn } from '@/lib/utils';

export function OnboardingShell({
  children,
  subtitle,
  step,
  totalSteps,
}: {
  children: React.ReactNode;
  subtitle: string;
  step: number;
  totalSteps: number;
}) {
  return (
    <div className="login-page relative flex min-h-screen items-center justify-center overflow-hidden bg-white px-4">
      <div className="login-orb login-orb-1" aria-hidden />
      <div className="login-orb login-orb-2" aria-hidden />
      <div className="login-orb login-orb-3" aria-hidden />

      <div className="login-card relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="font-brand text-3xl font-bold tracking-tight sm:text-4xl">
            <span className="text-zinc-900">Secure</span>
            <span className="brand-accent">Nexus</span>
          </h1>
          <BrandSubbranding className="mt-1.5" />
          <p className="mt-3 text-sm text-zinc-500">{subtitle}</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-500',
                  i + 1 === step ? 'w-8 bg-blue-500' : i + 1 < step ? 'w-3 bg-blue-300' : 'w-3 bg-zinc-200'
                )}
              />
            ))}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function OnboardingActionButton({
  children,
  onClick,
  disabled,
  loading,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className="onboarding-primary-btn flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-sm font-semibold text-white shadow-sm transition-all hover:shadow-md active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
      ) : null}
      {children}
    </button>
  );
}
