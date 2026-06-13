import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken } from '@/lib/auth';
import { isSetupComplete } from '@/lib/setup';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const token = cookies().get('sn_token')?.value;
  if (token) {
    try {
      verifyToken(token);
      redirect('/dashboard');
    } catch {
      redirect('/api/auth/clear-session?next=/login&error=session_expired');
    }
  }
  if (!(await isSetupComplete())) redirect('/getting-started');
  redirect('/login');
}
