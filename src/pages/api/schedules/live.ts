import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { computeCurrentLiveStartupAt, isLiveScheduleVisible } from '@/lib/scheduler-utils';
import { formatTime12h, formatNextRunAt } from '@/lib/utils';
import { isOnetimeSchedule } from '@/lib/schedule-recurrence';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const schedules = await prisma.schedule.findMany({
    where: { enabled: true, liveActive: true },
    orderBy: { name: 'asc' },
  });

  const now = new Date();
  const live = schedules
    .filter((schedule) => isLiveScheduleVisible(schedule, now))
    .map((schedule) => {
      const startupAt =
        schedule.liveStartupAt ??
        computeCurrentLiveStartupAt(schedule, now);
      return {
        id: schedule.id,
        name: schedule.name,
        cluster: schedule.cluster,
        namespace: schedule.namespace,
        scope: schedule.scope,
        appName: schedule.appName,
        workloadKind: schedule.workloadKind,
        excludedWorkloads: schedule.excludedWorkloads,
        shutdownTime: schedule.shutdownTime,
        startupTime: schedule.startupTime,
        recurrence: schedule.recurrence,
        oneTimeShutdownAt: schedule.oneTimeShutdownAt?.toISOString() ?? null,
        oneTimeStartupAt: schedule.oneTimeStartupAt?.toISOString() ?? null,
        timezone: schedule.timezone,
        daysOfWeek: schedule.daysOfWeek,
        lastRun: schedule.lastRun?.toISOString() ?? null,
        nextRun: schedule.nextRun?.toISOString() ?? null,
        startupAt: startupAt?.toISOString() ?? null,
        message: isOnetimeSchedule(schedule) && startupAt
          ? `Stopped until ${formatNextRunAt(startupAt, schedule.timezone)}`
          : `Stopped until ${formatTime12h(schedule.startupTime)} (${schedule.timezone})`,
      };
    });

  return res.status(200).json({
    schedules: live,
    total: live.length,
    checkedAt: now.toISOString(),
  });
}

export default requireAuth(handler);
