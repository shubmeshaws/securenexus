import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import {
  getSyncWindowReconcileJob,
  startSyncWindowReconcileJob,
} from '@/lib/schedule-sync-window-job';

function setNoCacheHeaders(res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  setNoCacheHeaders(res);

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
