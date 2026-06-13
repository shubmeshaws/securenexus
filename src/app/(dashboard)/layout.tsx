import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken } from '@/lib/auth';
import { isGoogleAuthConfigured } from '@/lib/google-auth';
import { DashboardShell } from './dashboard-shell';

export default function PodSchedulerLayout({ children }: { children: React.ReactNode }) {
  if (!isGoogleAuthConfigured()) {
    redirect('/login?error=google_auth_not_configured');
  }

  const token = cookies().get('sn_token')?.value;
  if (!token) {
    redirect('/login');
  }

  try {
    verifyToken(token);
  } catch {
    redirect('/api/auth/clear-session?next=/login&error=session_expired');
  }

  return <DashboardShell>{children}</DashboardShell>;
}
