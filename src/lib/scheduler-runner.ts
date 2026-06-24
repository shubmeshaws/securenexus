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
  isScheduleInStoppedWindow,
  reloadAllSchedules,
} from './scheduler-utils';
import { isOnetimeSchedule, completesAfterStartup } from './schedule-recurrence';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { setHours, setMinutes, setSeconds, setMilliseconds } from 'date-fns';
import type { Schedule } from '@prisma/client';

import { pruneActivityLogsByRetention } from './activity';
import { pruneResourceAuditDataByRetention } from './resource-audit-retention';
import { pruneNodeSamplesByRetention } from './node-sample-retention';
import {
  runInSchedulePool,
  SCHEDULE_EXECUTION_CONCURRENCY,
} from './schedule-execution-pool';
import { reconcileStoppedScheduleSyncWindows } from './schedule-sync-window-reconcile';

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

/**
 * Self-heal: a schedule still flagged stopped (liveActive) by the SCHEDULER, but currently
 * outside its stopped window, should be running. shouldRunStartupCatchup only retries within
 * a 2h window after the startup time, so a startup that failed/was missed beyond that window
 * leaves the schedule stranded as "Scheduled stop" until the next day. This has no time cap
 * and respects manual stops (which must persist until a manual start).
 */
function shouldReconcileToStarted(schedule: Schedule, now: Date): boolean {
  if (!schedule.enabled || !schedule.liveActive) return false;
  if (schedule.liveStopSource === 'manual') return false;
  if (shouldRunShutdown(schedule, now)) return false;
  return !isScheduleInStoppedWindow(schedule, now);
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

async function executeClaimedSchedule(
  schedule: Schedule,
  now: Date,
  mode: 'shutdown' | 'startup',
  runShutdown: boolean,
  runStartup: boolean,
  previousLastRun: Date | null
): Promise<SchedulerTickResult> {
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
        ...(runShutdown
          ? { liveStopSource: 'scheduled', liveStoppedBy: null }
          : { liveStopSource: null, liveStoppedBy: null }),
        ...(runStartup && completesAfterStartup(schedule)
          ? { oneTimeCompleted: true, enabled: false, nextRun: null }
          : {}),
      },
    });

    console.log(`[PodScheduler] Ran ${mode} for schedule "${schedule.name}"`);
    return { scheduleId: schedule.id, name: schedule.name, mode, status: 'success' };
  } catch (err) {
    const message = err instanceof Error ? err.message : `${mode} failed`;
    console.error(`[Scheduler] Error running ${mode} for ${schedule.name}:`, err);
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { lastRun: previousLastRun },
    });
    return { scheduleId: schedule.id, name: schedule.name, mode, status: 'failed', message };
  }
}

async function tickSchedules(): Promise<SchedulerTickResult[]> {
  const results: SchedulerTickResult[] = [];
  const schedules = await prisma.schedule.findMany({ where: { enabled: true } });
  const now = new Date();

  type PendingRun = {
    schedule: Schedule;
    mode: 'shutdown' | 'startup';
    runShutdown: boolean;
    runStartup: boolean;
    previousLastRun: Date | null;
  };

  const pending: PendingRun[] = [];

  for (const schedule of schedules) {
    const runShutdown = shouldRunShutdown(schedule, now);
    const runStartup =
      !runShutdown &&
      (shouldRunStartup(schedule, now) ||
        shouldRunStartupCatchup(schedule, now) ||
        shouldReconcileToStarted(schedule, now));
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

    pending.push({ schedule, mode, runShutdown, runStartup, previousLastRun });
  }

  if (pending.length === 0) {
    return results;
  }

  // Ticks may overlap (e.g. 9:00 batch still running when 9:02 tick fires).
  // Global pool caps total concurrent schedule executions across all ticks.
  const runResults = await Promise.all(
    pending.map((item) =>
      runInSchedulePool(() =>
        executeClaimedSchedule(
          item.schedule,
          now,
          item.mode,
          item.runShutdown,
          item.runStartup,
          item.previousLastRun
        )
      )
    )
  );

  return [...results, ...runResults];
}

export async function runSchedulerTick(): Promise<SchedulerTickResult[]> {
  return tickSchedules();
}

export function initScheduler() {
  const g = globalThis as typeof globalThis & { [SCHEDULER_GLOBAL_KEY]?: boolean };
  if (g[SCHEDULER_GLOBAL_KEY]) return;
  if (tickJob) return;

  g[SCHEDULER_GLOBAL_KEY] = true;
  console.log(
    `[PodScheduler] Initializing schedule runner (every minute, concurrency=${SCHEDULE_EXECUTION_CONCURRENCY})...`
  );
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

  reconcileStoppedScheduleSyncWindows().catch((err) => {
    console.error('[PodScheduler] Failed to reconcile stopped sync windows:', err);
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
