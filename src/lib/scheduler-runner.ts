import cron from 'node-cron';
import prisma from './prisma';
import { executeShutdown, executeStartup } from './scheduler-actions';
import { AUTOMATIC_CRON_TRIGGER } from './alert-display';
import {
  computeCurrentLiveStartupAt,
  computeNextRun,
  shouldRunShutdown,
  shouldRunStartup,
  shouldRunStartupCatchup,
  reloadAllSchedules,
} from './scheduler-utils';
import { isOnetimeSchedule } from './schedule-recurrence';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { setHours, setMinutes, setSeconds, setMilliseconds } from 'date-fns';
import type { Schedule } from '@prisma/client';

import { pruneActivityLogsByRetention } from './activity';
import { pruneResourceAuditDataByRetention } from './resource-audit-retention';
import { pruneNodeSamplesByRetention } from './node-sample-retention';

const SCHEDULER_GLOBAL_KEY = '__secureNexusSchedulerStarted__';
const RETENTION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let tickJob: ReturnType<typeof cron.schedule> | null = null;
let lastRetentionPruneAt = 0;

export interface SchedulerTickResult {
  scheduleId: string;
  name: string;
  mode: 'shutdown' | 'startup';
  status: 'success' | 'failed' | 'skipped';
  message?: string;
}

function startOfScheduleMinute(now: Date, tz: string): Date {
  const zoned = toZonedTime(now, tz);
  const floored = setSeconds(
    setMilliseconds(setMinutes(setHours(zoned, zoned.getHours()), zoned.getMinutes()), 0),
    0
  );
  return fromZonedTime(floored, tz);
}

/** Atomically claim this schedule minute so parallel ticks cannot both execute. */
async function tryClaimScheduleRun(schedule: Schedule, now: Date): Promise<boolean> {
  const minuteStart = startOfScheduleMinute(now, schedule.timezone || 'UTC');
  const claim = await prisma.schedule.updateMany({
    where: {
      id: schedule.id,
      OR: [{ lastRun: null }, { lastRun: { lt: minuteStart } }],
    },
    data: { lastRun: now },
  });
  return claim.count > 0;
}

async function tickSchedules(): Promise<SchedulerTickResult[]> {
  const results: SchedulerTickResult[] = [];
  const schedules = await prisma.schedule.findMany({ where: { enabled: true } });
  const now = new Date();

  for (const schedule of schedules) {
    const runShutdown = shouldRunShutdown(schedule, now);
    const runStartup =
      !runShutdown && (shouldRunStartup(schedule, now) || shouldRunStartupCatchup(schedule, now));
    if (!runShutdown && !runStartup) continue;

    const mode = runShutdown ? 'shutdown' : 'startup';
    const previousLastRun = schedule.lastRun;

    const claimed = await tryClaimScheduleRun(schedule, now);
    if (!claimed) {
      results.push({
        scheduleId: schedule.id,
        name: schedule.name,
        mode,
        status: 'skipped',
        message: 'Already claimed this minute',
      });
      continue;
    }

    try {
      if (runShutdown) {
        await executeShutdown(schedule, AUTOMATIC_CRON_TRIGGER, { markLive: true });
      } else {
        await executeStartup(schedule, AUTOMATIC_CRON_TRIGGER);
      }

      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          nextRun: computeNextRun(schedule, now),
          liveActive: runShutdown,
          liveStartupAt: runShutdown ? computeCurrentLiveStartupAt(schedule, now) : null,
          ...(runStartup && isOnetimeSchedule(schedule)
            ? { oneTimeCompleted: true, enabled: false, nextRun: null }
            : {}),
        },
      });

      console.log(`[PodScheduler] Ran ${mode} for schedule "${schedule.name}"`);
      results.push({ scheduleId: schedule.id, name: schedule.name, mode, status: 'success' });
    } catch (err) {
      const message = err instanceof Error ? err.message : `${mode} failed`;
      console.error(`[Scheduler] Error running ${mode} for ${schedule.name}:`, err);
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: { lastRun: previousLastRun },
      });
      results.push({ scheduleId: schedule.id, name: schedule.name, mode, status: 'failed', message });
    }
  }

  return results;
}

export async function runSchedulerTick(): Promise<SchedulerTickResult[]> {
  return tickSchedules();
}

export function initScheduler() {
  const g = globalThis as typeof globalThis & { [SCHEDULER_GLOBAL_KEY]?: boolean };
  if (g[SCHEDULER_GLOBAL_KEY]) return;
  if (tickJob) return;

  g[SCHEDULER_GLOBAL_KEY] = true;
  console.log('[PodScheduler] Initializing schedule runner (every minute)...');
  tickJob = cron.schedule('* * * * *', async () => {
    try {
      await tickSchedules();
      if (Date.now() - lastRetentionPruneAt >= RETENTION_PRUNE_INTERVAL_MS) {
        lastRetentionPruneAt = Date.now();
        await pruneActivityLogsByRetention();
        await pruneResourceAuditDataByRetention();
        await pruneNodeSamplesByRetention();
      }
    } catch (err) {
      console.error('[PodScheduler] Tick error:', err);
    }
  });

  reloadAllSchedules().catch((err) => {
    console.error('[PodScheduler] Failed to compute next runs:', err);
  });
}

/** Safe to call repeatedly — starts the cron runner if it is not already active. */
export function ensureSchedulerRunning() {
  initScheduler();
}

export function stopScheduler() {
  if (tickJob) {
    tickJob.stop();
    tickJob = null;
  }
  const g = globalThis as typeof globalThis & { [SCHEDULER_GLOBAL_KEY]?: boolean };
  delete g[SCHEDULER_GLOBAL_KEY];
}
