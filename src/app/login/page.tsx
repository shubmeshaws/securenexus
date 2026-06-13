import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LoginPage } from '@/components/auth/login-page';
import { verifyToken } from '@/lib/auth';
import { isSetupComplete } from '@/lib/setup';

export const dynamic = 'force-dynamic';

export default async function Login({
  searchParams,
}: {
  searchParams?: { error?: string };
}) {
  if (!(await isSetupComplete())) {
    redirect('/getting-started');
  }

  const sessionExpired = searchParams?.error === 'session_expired';
  const token = cookies().get('sn_token')?.value;

  if (token && !sessionExpired) {
    try {
      verifyToken(token);
      redirect('/dashboard');
    } catch {
      redirect('/api/auth/clear-session?next=/login&error=session_expired');
    }
  }

  return (
    <Suspense fallback={<div className="min-h-screen bg-white" />}>
      <LoginPage />
    </Suspense>
  );
}
