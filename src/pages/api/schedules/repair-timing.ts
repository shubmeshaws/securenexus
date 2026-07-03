import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import { repairAllScheduleTiming } from '@/lib/scheduler-utils';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  res.setHeader('Cache-Control', 'no-store');

  const result = await repairAllScheduleTiming();
  return res.status(200).json({
    ...result,
    repairedAt: new Date().toISOString(),
    apiVersion: 'repair-timing-v1',
  });
}

export default requireAuth(requirePermission('scheduleEdit')(handler));
