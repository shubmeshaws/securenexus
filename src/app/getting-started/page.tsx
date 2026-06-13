import { redirect } from 'next/navigation';
import { GettingStartedPage } from '@/components/auth/getting-started-page';
import { isSetupComplete } from '@/lib/setup';

export const dynamic = 'force-dynamic';

export default async function GettingStarted() {
  if (await isSetupComplete()) {
    redirect('/login');
  }

  return <GettingStartedPage />;
}
