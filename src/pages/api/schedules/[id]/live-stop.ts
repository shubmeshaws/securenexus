import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import { enforceScheduleAccess } from '@/lib/schedule-access';
import prisma from '@/lib/prisma';
import { stopLiveSchedule } from '@/lib/scheduler';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const schedule = await prisma.schedule.findUnique({ where: { id } });
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (!(await enforceScheduleAccess(req, res, id))) return;

  try {
    await stopLiveSchedule(id, req.user?.email ?? 'live-stop');
    const updated = await prisma.schedule.findUnique({ where: { id } });
    return res.status(200).json({ schedule: updated });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to stop live schedule',
    });
  }
}

export default requirePermission('liveScheduleStop')(handler);
