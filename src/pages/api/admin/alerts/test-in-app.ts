import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { logActivityFromRequest } from '@/lib/activity';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  await logActivityFromRequest(req, {
    action: 'schedule-run',
    cluster: 'test-cluster',
    namespace: 'default',
    appName: 'test-workload',
    triggeredBy: req.user?.email ?? 'admin',
    status: 'success',
    message: 'Test in-app notification from SecureNexus Alerts',
  });

  return res.status(200).json({
    ok: true,
    message: 'Test notification created — check the bell icon in the top bar',
  });
}

export default requireAdmin(handler);
