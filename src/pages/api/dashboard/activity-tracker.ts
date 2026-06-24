import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getScheduleActivityTracker } from '@/lib/schedule-activity-tracker';

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const tracker = await getScheduleActivityTracker(force);
    return res.status(200).json(tracker);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load activity tracker';
    return res.status(500).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireAuth(handler);
