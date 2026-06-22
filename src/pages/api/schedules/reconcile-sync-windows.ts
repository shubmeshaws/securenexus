import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import {
  getSyncWindowReconcileJob,
  startSyncWindowReconcileJob,
} from '@/lib/schedule-sync-window-job';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return res.status(200).json(getSyncWindowReconcileJob());
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const started = startSyncWindowReconcileJob();
  if (!started) {
    return res.status(200).json(getSyncWindowReconcileJob());
  }

  return res.status(202).json(getSyncWindowReconcileJob());
}

export default requireAuth(requirePermission('scheduleEdit')(handler));
