import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { isLiveScheduleVisible, resolveDisplayNextRun, repairAllScheduleTiming } from '@/lib/scheduler-utils';
import { formatTime12h, formatNextRunAt } from '@/lib/utils';
import { isOnetimeSchedule, isWindowSchedule, isCombinedSchedule } from '@/lib/schedule-recurrence';
import { dayLabel } from '@/lib/schedule-window';
import {
  filterSchedulesForUser,
  getScheduleAccessForRequest,
} from '@/lib/schedule-access';

/** Bump when live startup resolution logic changes — verify in Network tab after deploy. */
const LIVE_API_VERSION = 'live-v15';

let legacyTimingRepairDone = false;

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const schedules = await prisma.schedule.findMany({
    where: { enabled: true, liveActive: true },
    orderBy: { name: 'asc' },
  });

  const now = new Date();

  if (!legacyTimingRepairDone) {
    legacyTimingRepairDone = true;
    await repairAllScheduleTiming(now).catch((err) =>
      console.warn('[schedules/live] legacy timing repair failed:', err)
    );
  }

  const access = await getScheduleAccessForRequest(req);
  const visibleSchedules =
    access && req.user
      ? filterSchedulesForUser(schedules, access, req.user.role)
      : schedules;

  const live = await Promise.all(
    visibleSchedules
      .filter((schedule) => isLiveScheduleVisible(schedule, now))
      .map(async (schedule) => {
        const displayNextRun = resolveDisplayNextRun(schedule, now);

        if (
          displayNextRun &&
          (!schedule.liveStartupAt ||
            schedule.liveStartupAt.getTime() !== displayNextRun.getTime() ||
            !schedule.nextRun ||
            schedule.nextRun.getTime() !== displayNextRun.getTime())
        ) {
          await prisma.schedule
            .update({
              where: { id: schedule.id },
              data: { liveStartupAt: displayNextRun, nextRun: displayNextRun },
            })
            .catch((err) =>
              console.warn(
                `[schedules/live] failed to refresh liveStartupAt for "${schedule.name}":`,
                err instanceof Error ? err.message : err
              )
            );
        }

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
          weekendShutdownTime: schedule.weekendShutdownTime,
          weekendStartupTime: schedule.weekendStartupTime,
          weekendDays: schedule.weekendDays,
          recurrence: schedule.recurrence,
          oneTimeShutdownAt: schedule.oneTimeShutdownAt?.toISOString() ?? null,
          oneTimeStartupAt: schedule.oneTimeStartupAt?.toISOString() ?? null,
          shutdownDayOfWeek: schedule.shutdownDayOfWeek,
          startupDayOfWeek: schedule.startupDayOfWeek,
          windowRepeatWeekly: schedule.windowRepeatWeekly,
          oneTimeCompleted: schedule.oneTimeCompleted,
          overnightDays: schedule.overnightDays,
          overnightShutdownTime: schedule.overnightShutdownTime,
          overnightStartupTime: schedule.overnightStartupTime,
          timezone: schedule.timezone,
          daysOfWeek: schedule.daysOfWeek,
          lastRun: schedule.lastRun?.toISOString() ?? null,
          nextRun: displayNextRun?.toISOString() ?? null,
          startupAt: displayNextRun?.toISOString() ?? null,
          message: isOnetimeSchedule(schedule) && displayNextRun
            ? `Stopped until ${formatNextRunAt(displayNextRun, schedule.timezone)}`
            : isCombinedSchedule(schedule) && displayNextRun
              ? `Stopped until ${formatNextRunAt(displayNextRun, schedule.timezone)}`
              : isWindowSchedule(schedule) && displayNextRun
                ? `Stopped until ${formatNextRunAt(displayNextRun, schedule.timezone)}`
                : isWindowSchedule(schedule) && schedule.startupDayOfWeek
                  ? `Stopped until ${dayLabel(schedule.startupDayOfWeek)} ${formatTime12h(schedule.startupTime)} (${schedule.timezone})`
                  : `Stopped until ${formatTime12h(schedule.startupTime)} (${schedule.timezone})`,
        };
      })
  );

  return res.status(200).json({
    apiVersion: LIVE_API_VERSION,
    schedules: live,
    total: live.length,
    checkedAt: now.toISOString(),
  });
}

export default requireAuth(handler);
