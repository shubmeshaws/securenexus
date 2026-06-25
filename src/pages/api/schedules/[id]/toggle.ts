import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import { enforceScheduleAccess } from '@/lib/schedule-access';
import prisma from '@/lib/prisma';
import { computeNextRun } from '@/lib/scheduler';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const existing = await prisma.schedule.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });
  if (!(await enforceScheduleAccess(req, res, id))) return;

  const enabled = !existing.enabled;
  const nextRun = enabled ? computeNextRun({ ...existing, enabled }) : null;

  const schedule = await prisma.schedule.update({
    where: { id },
    data: { enabled, nextRun },
  });

  return res.status(200).json({ schedule });
}

export default requirePermission('scheduleEdit')(handler);
