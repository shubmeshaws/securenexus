import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import prisma from '@/lib/prisma';
import { createScheduleSchema } from '@/lib/validation';
import { computeNextRun, ensureSchedulerRunning } from '@/lib/scheduler';
import { enrichSchedulesWithAccountId } from '@/lib/schedule-display';

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  ensureSchedulerRunning();
  const schedules = await prisma.schedule.findMany({ orderBy: { name: 'asc' } });
  const enriched = await enrichSchedulesWithAccountId(schedules);
  return res.status(200).json({ schedules: enriched });
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    ensureSchedulerRunning();
    const parsed = createScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const data = parsed.data;
    const schedule = await prisma.schedule.create({
      data: { ...data, nextRun: null },
    });

    const nextRun = computeNextRun(schedule);
    const updated = await prisma.schedule.update({
      where: { id: schedule.id },
      data: { nextRun },
    });

    return res.status(201).json({ schedule: updated });
  } catch (err) {
    console.error('[schedules] create failed:', err);
    const message = err instanceof Error ? err.message : 'Failed to create schedule';
    return res.status(500).json({ error: message });
  }
}

function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return requirePermission('scheduleEdit')(postHandler)(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

export default requireAuth(handler);
