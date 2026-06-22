import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { enforcePermission } from '@/lib/permission-auth';
import { executeInstantStart, listActiveInstantRuns } from '@/lib/instant-schedule-actions';
import { instantStartSchema } from '@/lib/validation';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const runs = await listActiveInstantRuns();
    return res.status(200).json({ runs });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  if (!(await enforcePermission(req, res, 'instantSchedule'))) return;

  const parsed = instantStartSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const run = await executeInstantStart({
      ...parsed.data,
      startedBy: req.user?.email ?? 'manual',
    });
    return res.status(201).json({ run });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to start instant schedule',
    });
  }
}

export default requireAuth(handler);
