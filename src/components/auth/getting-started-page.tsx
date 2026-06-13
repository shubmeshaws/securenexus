'use client';

import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Database, Layers, Rocket, ICON_STROKE } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { OnboardingActionButton, OnboardingShell } from '@/components/auth/onboarding-shell';
import { cn } from '@/lib/utils';

type Step = 1 | 2 | 3;
type StepDirection = 'forward' | 'back';

const STEP_META: Record<Step, { subtitle: string; icon: typeof Rocket }> = {
  1: { subtitle: 'Welcome — let\'s prepare your SecureNexus workspace', icon: Rocket },
  2: { subtitle: 'Verify your PostgreSQL database connection', icon: Database },
  3: { subtitle: 'Initialize the application database schema', icon: Layers },
};

export function GettingStartedPage() {
  const [step, setStep] = useState<Step>(1);
  const [direction, setDirection] = useState<StepDirection>('forward');
  const [animating, setAnimating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dbOk, setDbOk] = useState(false);
  const [schemaExists, setSchemaExists] = useState(false);
  const [schemaCreated, setSchemaCreated] = useState(false);

  useEffect(() => {
    if (step !== 3) return;
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((data: { schemaExists?: boolean }) => {
        if (data.schemaExists) {
          setSchemaExists(true);
          setSchemaCreated(false);
        }
      })
      .catch(() => undefined);
  }, [step]);

  const goToStep = useCallback((next: Step, dir: StepDirection = 'forward') => {
    if (animating || next === step) return;
    setDirection(dir);
    setAnimating(true);
    setError(null);
    setMessage(null);
    setTimeout(() => {
      setStep(next);
      setAnimating(false);
    }, 280);
  }, [animating, step]);

  const handleGetStarted = () => goToStep(2);

  const handleCheckDb = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/setup/check-db', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) {
        setError(data.message ?? 'Database connection failed');
        setDbOk(false);
        return;
      }
      setDbOk(true);
      setMessage(data.message);
      setTimeout(() => goToStep(3), 600);
    } catch {
      setError('Could not reach the setup API. Is the server running?');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSchema = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/setup/schema', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) {
        setError(data.message ?? 'Schema setup failed');
        return;
      }
      setSchemaExists(true);
      setSchemaCreated(data.created);
      setMessage(data.message);
    } catch {
      setError('Schema request failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleFinish = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/complete', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.message ?? 'Could not finalize setup');
        setLoading(false);
        return;
      }
      window.location.assign('/login');
    } catch {
      setError('Could not finalize setup.');
      setLoading(false);
    }
  };

  const meta = STEP_META[step];
  const Icon = meta.icon;
  const slideClass = animating
    ? direction === 'forward'
      ? 'onboarding-step-exit-forward'
      : 'onboarding-step-exit-back'
    : direction === 'forward'
      ? 'onboarding-step-enter-forward'
      : 'onboarding-step-enter';

  return (
    <OnboardingShell subtitle={meta.subtitle} step={step} totalSteps={3}>
      <div className={cn('onboarding-step-panel', slideClass)} key={step}>
        <div className="mb-6 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10 ring-1 ring-blue-500/20">
            <Icon className="h-7 w-7 text-blue-500" strokeWidth={ICON_STROKE} />
          </div>
        </div>

        {step === 1 && (
          <>
            <p className="mb-6 text-center text-sm leading-relaxed text-zinc-600">
              First-time setup takes less than a minute. We&apos;ll verify your database,
              create the required tables, then take you to login.
            </p>
            <OnboardingActionButton onClick={handleGetStarted}>Get Started</OnboardingActionButton>
          </>
        )}

        {step === 2 && (
          <>
            <p className="mb-6 text-center text-sm leading-relaxed text-zinc-600">
              Confirm that <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">DATABASE_URL</code> in
              your <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">.env</code> is correct and
              PostgreSQL is reachable.
            </p>
            {dbOk && message && (
              <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <AppIcon icon={BadgeCheck} className="mt-0.5 shrink-0" />
                <span>{message}</span>
              </div>
            )}
            <OnboardingActionButton onClick={handleCheckDb} loading={loading}>
              Check DB Connections
            </OnboardingActionButton>
          </>
        )}

        {step === 3 && (
          <>
            <p className="mb-6 text-center text-sm leading-relaxed text-zinc-600">
              {schemaExists
                ? 'Your database schema is ready. Continue to the login page.'
                : 'Create SecureNexus tables (users, schedules, clusters, settings) in your database.'}
            </p>
            {schemaExists && (
              <div className="mb-4 flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                <AppIcon icon={BadgeCheck} className="mt-0.5 shrink-0" />
                <span>
                  {schemaCreated
                    ? 'Database schema created successfully.'
                    : 'Database schema already exists.'}
                </span>
              </div>
            )}
            {!schemaExists ? (
              <OnboardingActionButton onClick={handleCreateSchema} loading={loading}>
                Create database schema
              </OnboardingActionButton>
            ) : (
              <OnboardingActionButton onClick={handleFinish} loading={loading}>
                Continue to Login
              </OnboardingActionButton>
            )}
          </>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {message && !error && step === 3 && !schemaExists && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {message}
          </div>
        )}

        {step > 1 && step < 3 && !loading && (
          <button
            type="button"
            onClick={() => goToStep((step - 1) as Step, 'back')}
            className="mt-4 w-full text-center text-xs text-zinc-400 transition-colors hover:text-zinc-600"
          >
            Back
          </button>
        )}
      </div>
    </OnboardingShell>
  );
}
