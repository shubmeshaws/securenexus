import type { Schedule as ApiSchedule } from '@/lib/api-client';
import { isScheduleInStoppedWindow } from '@/lib/scheduler-utils';
import type { Schedule as PrismaSchedule } from '@prisma/client';

/** API schedules use ISO date strings; timing helpers expect Date objects. */
function scheduleForStopCheck(schedule: ApiSchedule): PrismaSchedule {
  return {
    ...schedule,
    oneTimeShutdownAt: schedule.oneTimeShutdownAt
      ? new Date(schedule.oneTimeShutdownAt)
      : null,
    oneTimeStartupAt: schedule.oneTimeStartupAt ? new Date(schedule.oneTimeStartupAt) : null,
    lastRun: schedule.lastRun ? new Date(schedule.lastRun) : null,
    nextRun: schedule.nextRun ? new Date(schedule.nextRun) : null,
    liveStartupAt: null,
    savedWorkloadReplicas: null,
    pausedArgoApps: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as PrismaSchedule;
}

/** True when the schedule should show as stopped in UI (matches Live Schedules count). */
export function isScheduleActivelyStopped(schedule: ApiSchedule, now = new Date()): boolean {
  if (schedule.liveStopSource === 'manual') return true;
  if (!schedule.liveActive) return false;
  return isScheduleInStoppedWindow(scheduleForStopCheck(schedule), now);
}
