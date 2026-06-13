import type { Schedule } from '@prisma/client';
import { isScheduleActiveNow, isLiveScheduleVisible } from './scheduler-utils';

/** Latest running / live schedules first, then optional top N. */
export function sortSchedulesForDashboard(
  schedules: Schedule[],
  limit?: number,
  now = new Date()
): Schedule[] {
  const sorted = [...schedules].sort((a, b) => {
      const aLive = a.liveActive && isLiveScheduleVisible(a, now) ? 1 : 0;
      const bLive = b.liveActive && isLiveScheduleVisible(b, now) ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;

      const aRunning = isScheduleActiveNow(a, now) ? 1 : 0;
      const bRunning = isScheduleActiveNow(b, now) ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;

      const aLast = a.lastRun?.getTime() ?? 0;
      const bLast = b.lastRun?.getTime() ?? 0;
      if (aLast !== bLast) return bLast - aLast;

      const aNext = a.nextRun?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bNext = b.nextRun?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return aNext - bNext;
    });

  return limit != null ? sorted.slice(0, limit) : sorted;
}
