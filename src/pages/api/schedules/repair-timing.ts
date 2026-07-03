import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import { repairAllScheduleTiming, resetTimingRepairVersion } from '@/lib/scheduler-utils';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  res.setHeader('Cache-Control', 'no-store');

  resetTimingRepairVersion();
  const result = await repairAllScheduleTiming();
  return res.status(200).json({
    ...result,
    repairedAt: new Date().toISOString(),
    apiVersion: 'repair-timing-v2',
    timingRepairVersion: 3,
  });
}

export default requireAuth(requirePermission('scheduleEdit')(handler));
