import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import { clearSecureNexusSyncWindows } from '@/lib/schedule-sync-window-clear';

function setNoCacheHeaders(res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  setNoCacheHeaders(res);

  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const result = await clearSecureNexusSyncWindows();
  return res.status(200).json(result);
}

export default requireAuth(requirePermission('scheduleEdit')(handler));
