import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { ensureSchedulerRunning } from '@/lib/scheduler';
import prisma from '@/lib/prisma';
import { computeNextRun, getScheduleLiveStatus } from '@/lib/scheduler-utils';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  ensureSchedulerRunning();

  const schedules = await prisma.schedule.findMany({ orderBy: { name: 'asc' } });
  const now = new Date();

  return res.status(200).json({
    runnerActive: true,
    checkedAt: now.toISOString(),
    serverTime: now.toISOString(),
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: schedule.appName,
      shutdownTime: schedule.shutdownTime,
      startupTime: schedule.startupTime,
      timezone: schedule.timezone,
      daysOfWeek: schedule.daysOfWeek,
      lastRun: schedule.lastRun?.toISOString() ?? null,
      nextRun: schedule.nextRun?.toISOString() ?? null,
      computedNextRun: computeNextRun(schedule, now)?.toISOString() ?? null,
      live: getScheduleLiveStatus(schedule, now),
    })),
  });
}

export default requireAuth(handler);
