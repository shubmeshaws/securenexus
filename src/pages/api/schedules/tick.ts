import type { NextApiResponse } from 'next';
import { requireAuth, requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { ensureSchedulerRunning, runSchedulerTick } from '@/lib/scheduler';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  ensureSchedulerRunning();
  const results = await runSchedulerTick();

  return res.status(200).json({
    checkedAt: new Date().toISOString(),
    results,
    ran: results.filter((r) => r.status === 'success').length,
  });
}

export default requireAdmin(handler);
