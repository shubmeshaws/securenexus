import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { enforcePermission } from '@/lib/permission-auth';
import { executeInstantStop } from '@/lib/instant-schedule-actions';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  if (!(await enforcePermission(req, res, 'instantSchedule'))) return;

  try {
    const run = await executeInstantStop(id, req.user?.email ?? 'manual');
    return res.status(200).json({ run });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to stop instant schedule',
    });
  }
}

export default requireAuth(handler);
