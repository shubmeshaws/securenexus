import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import { ensureSchedulerRunning } from '@/lib/scheduler';
import { reconcileStoppedScheduleSyncWindows } from '@/lib/schedule-sync-window-reconcile';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  ensureSchedulerRunning();
  const result = await reconcileStoppedScheduleSyncWindows();
  return res.status(200).json(result);
}

export default requireAuth(requirePermission('scheduleEdit')(handler));
