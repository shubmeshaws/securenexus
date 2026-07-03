import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { addDays, setHours, setMinutes, getDay, isBefore } from 'date-fns';
import { isOvernightSchedule as isOvernightScheduleTimes, formatNextRunAt } from './utils';
import {
  isDailySchedule,
  isOnetimeSchedule,
  isWindowSchedule,
  isCombinedSchedule,
  isWindowOnce,
  matchesScheduleMinute,
} from './schedule-recurrence';
import {
  computeCurrentLiveStartupAtWindow,
  computeNextRunWindow,
  isInWindowStoppedPeriod,
  nextShutdownAfter,
  shouldRunWindowShutdown,
  shouldRunWindowStartup,
  type WindowSchedule,
} from './schedule-window';
import {
  computeCurrentLiveStartupAtCombined,
  computeNextRunCombined,
  combinedLongStopExitStartup,
  isInCombinedStoppedPeriod,
  nextCombinedShutdownAfter,
  shouldRunCombinedShutdown,
  shouldRunCombinedStartup,
  shouldRunMissedCombinedOvernightStartup,
  shouldRunMissedCombinedLongStopStartup,
  todaysLongStopStartupInstant,
  todaysOvernightStartupInstant,
  combinedActiveDays,
} from './schedule-combined';
import { coerceIsoDay } from './schedule-window';
import prisma from './prisma';
import type { Schedule } from '@prisma/client';

/** ISO day-of-week (1=Mon … 7=Sun) for a zoned date. */
function isoDayOfWeek(date: Date): number {
  const d = getDay(date);
  return d === 0 ? 7 : d;
}

/**
 * Resolve the shutdown/startup HH:mm that apply on a given ISO weekday. For
 * `split` schedules, days listed in `weekendDays` use the weekend window and all
 * other active days use the default (weekday) window; non-split recurrences
 * always use the default window.
 */
export function effectiveTimesForDay(
  schedule: Pick<
    Schedule,
    'recurrence' | 'shutdownTime' | 'startupTime' | 'weekendShutdownTime' | 'weekendStartupTime' | 'weekendDays'
  >,
  isoDay: number
): { shutdownTime: string; startupTime: string } {
  // Fall back to Sat/Sun for legacy split schedules saved without explicit days.
  const weekendDays = schedule.weekendDays?.length ? schedule.weekendDays : [6, 7];
  if (
    schedule.recurrence === 'split' &&
    weekendDays.includes(isoDay) &&
    schedule.weekendShutdownTime &&
    schedule.weekendStartupTime
  ) {
    return {
      shutdownTime: schedule.weekendShutdownTime,
      startupTime: schedule.weekendStartupTime,
    };
  }
  return { shutdownTime: schedule.shutdownTime, startupTime: schedule.startupTime };
}

function computeNextRunDaily(schedule: Schedule, fromDate = new Date()): Date | null {
  if (schedule.daysOfWeek.length === 0) return null;

  const tz = schedule.timezone || 'UTC';
  const zonedNow = toZonedTime(fromDate, tz);

  for (let offset = 0; offset < 8; offset++) {
    const candidate = addDays(zonedNow, offset);
    const dayOfWeek = isoDayOfWeek(candidate);
    if (!schedule.daysOfWeek.includes(dayOfWeek)) continue;

    const { shutdownTime, startupTime } = effectiveTimesForDay(schedule, dayOfWeek);
    const [shH, shM] = shutdownTime.split(':').map(Number);
    const [stH, stM] = startupTime.split(':').map(Number);

    const shutdownLocal = setMinutes(setHours(candidate, shH), shM);
    const startupLocal = setMinutes(setHours(candidate, stH), stM);

    const shutdownUtc = fromZonedTime(shutdownLocal, tz);
    const startupUtc = fromZonedTime(startupLocal, tz);

    const candidates: Date[] = [];
    if (offset > 0 || isBefore(zonedNow, shutdownLocal)) candidates.push(shutdownUtc);
    if (offset > 0 || isBefore(zonedNow, startupLocal)) candidates.push(startupUtc);

    const future = candidates.filter((d) => d > fromDate).sort((a, b) => a.getTime() - b.getTime());
    if (future.length > 0) return future[0];
  }

  return null;
}

function computeNextRunOnetime(schedule: Schedule, fromDate = new Date()): Date | null {
  if (schedule.oneTimeCompleted) return null;

  const shutdownAt = schedule.oneTimeShutdownAt;
  const startupAt = schedule.oneTimeStartupAt;
  if (!shutdownAt || !startupAt) return null;

  if (shutdownAt > fromDate) return shutdownAt;
  if (schedule.liveActive && startupAt > fromDate) return startupAt;
  if (startupAt > fromDate) return startupAt;

  return null;
}

export function computeNextRun(schedule: Schedule, fromDate = new Date()): Date | null {
  if (!schedule.enabled) return null;
  if (isOnetimeSchedule(schedule)) return computeNextRunOnetime(schedule, fromDate);
  if (isCombinedSchedule(schedule)) return computeNextRunCombined(schedule, fromDate);
  if (isWindowSchedule(schedule)) return computeNextRunWindow(schedule, fromDate);
  return computeNextRunDaily(schedule, fromDate);
}

/** Startup time for the current stopped window (stable across polls). */
export function computeCurrentLiveStartupAt(schedule: Schedule, now = new Date()): Date | null {
  if (!schedule.enabled) return null;

  if (isOnetimeSchedule(schedule)) {
    return schedule.oneTimeStartupAt;
  }

  if (isCombinedSchedule(schedule)) {
    return computeCurrentLiveStartupAtCombined(schedule, now);
  }

  if (isWindowSchedule(schedule)) {
    return computeCurrentLiveStartupAtWindow(schedule, now);
  }

  if (schedule.daysOfWeek.length === 0) return null;

  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const todayDow = isoDayOfWeek(zoned);
  const today = effectiveTimesForDay(schedule, todayDow);
  const [stH, stM] = today.startupTime.split(':').map(Number);
  const [shH, shM] = today.shutdownTime.split(':').map(Number);
  const startupMinutes = stH * 60 + stM;
  const shutdownMinutes = shH * 60 + shM;
  const minutesNow = zoned.getHours() * 60 + zoned.getMinutes();

  let startupLocal = setMinutes(setHours(zoned, stH), stM);

  if (startupMinutes < shutdownMinutes) {
    if (minutesNow >= shutdownMinutes) {
      // Overnight window: startup falls on the next day — use that day's times.
      const tomorrow = addDays(zoned, 1);
      const tomorrowStartup = effectiveTimesForDay(schedule, isoDayOfWeek(tomorrow)).startupTime;
      const [stH2, stM2] = tomorrowStartup.split(':').map(Number);
      startupLocal = setMinutes(setHours(tomorrow, stH2), stM2);
    }
  }

  return fromZonedTime(startupLocal, tz);
}

export function computeNextStartupAt(schedule: Schedule, fromDate = new Date()): Date | null {
  if (!schedule.enabled) return null;

  if (isOnetimeSchedule(schedule)) {
    if (schedule.oneTimeCompleted || !schedule.oneTimeStartupAt) return null;
    return schedule.oneTimeStartupAt > fromDate ? schedule.oneTimeStartupAt : null;
  }

  if (isCombinedSchedule(schedule)) {
    const startup = computeCurrentLiveStartupAtCombined(schedule, fromDate);
    if (startup && startup > fromDate) return startup;
    return null;
  }

  if (isWindowSchedule(schedule)) {
    const startup = computeCurrentLiveStartupAtWindow(schedule, fromDate);
    if (startup && startup > fromDate) return startup;
    return null;
  }

  if (schedule.daysOfWeek.length === 0) return null;

  const tz = schedule.timezone || 'UTC';
  const zonedNow = toZonedTime(fromDate, tz);

  for (let offset = 0; offset < 8; offset++) {
    const candidate = addDays(zonedNow, offset);
    const dayOfWeek = isoDayOfWeek(candidate);
    if (!schedule.daysOfWeek.includes(dayOfWeek)) continue;

    const [stH, stM] = effectiveTimesForDay(schedule, dayOfWeek).startupTime.split(':').map(Number);
    const startupLocal = setMinutes(setHours(candidate, stH), stM);
    const startupUtc = fromZonedTime(startupLocal, tz);
    if (startupUtc > fromDate) return startupUtc;
  }

  return null;
}

export function alreadyRanThisMinute(schedule: Schedule, now = new Date()): boolean {
  if (!schedule.lastRun) return false;
  const tz = schedule.timezone || 'UTC';
  const zonedNow = toZonedTime(now, tz);
  const zonedLast = toZonedTime(schedule.lastRun, tz);
  return (
    zonedLast.getFullYear() === zonedNow.getFullYear() &&
    zonedLast.getMonth() === zonedNow.getMonth() &&
    zonedLast.getDate() === zonedNow.getDate() &&
    zonedLast.getHours() === zonedNow.getHours() &&
    zonedLast.getMinutes() === zonedNow.getMinutes()
  );
}

export function shouldRunShutdown(schedule: Schedule, now = new Date()): boolean {
  if (isOnetimeSchedule(schedule)) {
    if (!schedule.enabled || schedule.oneTimeCompleted || !schedule.oneTimeShutdownAt) return false;
    return matchesScheduleMinute(schedule, schedule.oneTimeShutdownAt, now);
  }

  if (isCombinedSchedule(schedule)) {
    if (!schedule.enabled) return false;
    return shouldRunCombinedShutdown(schedule, now);
  }

  if (isWindowSchedule(schedule)) {
    if (!schedule.enabled || (isWindowOnce(schedule) && schedule.oneTimeCompleted)) return false;
    return shouldRunWindowShutdown(schedule, now);
  }

  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dayOfWeek = isoDayOfWeek(zoned);
  if (!schedule.daysOfWeek.includes(dayOfWeek)) return false;

  const [h, m] = effectiveTimesForDay(schedule, dayOfWeek).shutdownTime.split(':').map(Number);
  return zoned.getHours() === h && zoned.getMinutes() === m;
}

export type ScheduleLivePhase = 'executing' | 'active' | 'idle';

export interface ScheduleLiveStatus {
  phase: ScheduleLivePhase;
  action: 'shutdown' | 'startup' | null;
  message: string;
}

const EXECUTING_WINDOW_MS = 90_000;

export function isScheduleDayToday(schedule: Schedule, now = new Date()): boolean {
  if (isOnetimeSchedule(schedule)) {
    if (!schedule.oneTimeShutdownAt || !schedule.oneTimeStartupAt) return false;
    const tz = schedule.timezone || 'UTC';
    const zoned = toZonedTime(now, tz);
    const shutdownZoned = toZonedTime(schedule.oneTimeShutdownAt, tz);
    const startupZoned = toZonedTime(schedule.oneTimeStartupAt, tz);
    const todayKey = `${zoned.getFullYear()}-${zoned.getMonth()}-${zoned.getDate()}`;
    const shutdownKey = `${shutdownZoned.getFullYear()}-${shutdownZoned.getMonth()}-${shutdownZoned.getDate()}`;
    const startupKey = `${startupZoned.getFullYear()}-${startupZoned.getMonth()}-${startupZoned.getDate()}`;
    return todayKey === shutdownKey || todayKey === startupKey;
  }

  if (isCombinedSchedule(schedule)) {
    const tz = schedule.timezone || 'UTC';
    const zoned = toZonedTime(now, tz);
    return combinedActiveDays(schedule).includes(isoDayOfWeek(zoned));
  }

  if (isWindowSchedule(schedule)) {
    if (isWindowOnce(schedule)) {
      return isScheduleDayToday({ ...schedule, recurrence: 'onetime' }, now);
    }
    const tz = schedule.timezone || 'UTC';
    const zoned = toZonedTime(now, tz);
    const dow = isoDayOfWeek(zoned);
    return dow === schedule.shutdownDayOfWeek || dow === schedule.startupDayOfWeek;
  }

  if (schedule.daysOfWeek.length === 0) return false;
  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dayOfWeek = getDay(zoned) === 0 ? 7 : getDay(zoned);
  return schedule.daysOfWeek.includes(dayOfWeek);
}

function isScheduleActiveNowOnetime(schedule: Schedule, now = new Date()): boolean {
  const shutdownAt = schedule.oneTimeShutdownAt;
  const startupAt = schedule.oneTimeStartupAt;
  if (!shutdownAt || !startupAt) return true;

  if (now < shutdownAt) return true;
  if (now >= shutdownAt && now < startupAt) return false;
  return true;
}

/** Running window: startup time → shutdown time (deployment should be up). */
export function isScheduleActiveNow(schedule: Schedule, now = new Date()): boolean {
  if (!schedule.enabled) return false;

  if (isOnetimeSchedule(schedule)) {
    if (schedule.oneTimeCompleted) return true;
    return isScheduleActiveNowOnetime(schedule, now);
  }

  if (isCombinedSchedule(schedule)) {
    return !isInCombinedStoppedPeriod(schedule, now);
  }

  if (isWindowSchedule(schedule)) {
    if (isWindowOnce(schedule) && schedule.oneTimeCompleted) return true;
    return !isInWindowStoppedPeriod(schedule, now);
  }

  if (schedule.daysOfWeek.length === 0) return false;

  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dayOfWeek = isoDayOfWeek(zoned);
  if (!schedule.daysOfWeek.includes(dayOfWeek)) return false;

  const { shutdownTime, startupTime } = effectiveTimesForDay(schedule, dayOfWeek);
  const [shH, shM] = shutdownTime.split(':').map(Number);
  const [stH, stM] = startupTime.split(':').map(Number);
  const minutesNow = zoned.getHours() * 60 + zoned.getMinutes();
  const startupMinutes = stH * 60 + stM;
  const shutdownMinutes = shH * 60 + shM;

  if (startupMinutes < shutdownMinutes) {
    return minutesNow >= startupMinutes && minutesNow < shutdownMinutes;
  }

  return minutesNow >= startupMinutes || minutesNow < shutdownMinutes;
}

/** Stopped window: shutdown time → startup time (deployment should be down). */
export function isScheduleInStoppedWindow(schedule: Schedule, now = new Date()): boolean {
  if (!schedule.enabled) return false;
  if (isOnetimeSchedule(schedule)) {
    const shutdownAt = schedule.oneTimeShutdownAt;
    const startupAt = schedule.oneTimeStartupAt;
    if (!shutdownAt || !startupAt) return false;
    return now >= shutdownAt && now < startupAt;
  }
  if (isCombinedSchedule(schedule)) {
    return isInCombinedStoppedPeriod(schedule, now);
  }
  if (isWindowSchedule(schedule)) {
    if (isWindowOnce(schedule) && schedule.oneTimeCompleted) return false;
    return isInWindowStoppedPeriod(schedule, now);
  }
  if (!isScheduleDayToday(schedule, now)) return false;
  return !isScheduleActiveNow(schedule, now);
}

/**
 * Startup instant shown for a live (stopped) schedule. Recomputes from the schedule
 * definition while inside a stop window so stale `liveStartupAt` rows (e.g. Tue nightly
 * after a Fri→Mon long stop) do not distort the countdown.
 */
export function resolveLiveStartupAt(schedule: Schedule, now = new Date()): Date | null {
  if (isScheduleInStoppedWindow(schedule, now)) {
    return computeCurrentLiveStartupAt(schedule, now);
  }
  return schedule.liveStartupAt ?? computeCurrentLiveStartupAt(schedule, now);
}

/**
 * Next-run instant for UI and persistence. While stopped inside a window, show the
 * exit startup — not a stale pre-shutdown shutdown time still sitting in the DB.
 */
export function resolveDisplayNextRun(schedule: Schedule, now = new Date()): Date | null {
  if (!schedule.enabled) return null;
  if (schedule.liveActive && isScheduleInStoppedWindow(schedule, now)) {
    return computeCurrentLiveStartupAt(schedule, now);
  }
  return computeNextRun(schedule, now);
}

export function isLiveScheduleVisible(schedule: Schedule, now = new Date()): boolean {
  return schedule.liveActive && isScheduleInStoppedWindow(schedule, now);
}

export function getScheduleLiveStatus(schedule: Schedule, now = new Date()): ScheduleLiveStatus {
  if (!schedule.enabled) {
    if (isOnetimeSchedule(schedule) && schedule.oneTimeCompleted) {
      return { phase: 'idle', action: null, message: 'One-time schedule completed' };
    }
    return { phase: 'idle', action: null, message: 'Disabled' };
  }

  if (shouldRunShutdown(schedule, now)) {
    return { phase: 'executing', action: 'shutdown', message: 'Running shutdown now' };
  }

  if (shouldRunStartup(schedule, now) || shouldRunStartupCatchup(schedule, now)) {
    return { phase: 'executing', action: 'startup', message: 'Running startup now' };
  }

  if (schedule.lastRun) {
    const elapsed = now.getTime() - schedule.lastRun.getTime();
    if (elapsed >= 0 && elapsed < EXECUTING_WINDOW_MS) {
      return {
        phase: 'executing',
        action: null,
        message: 'Schedule run in progress',
      };
    }
  }

  if (isLiveScheduleVisible(schedule, now)) {
    const startupLabel = isOnetimeSchedule(schedule) && schedule.oneTimeStartupAt
      ? schedule.oneTimeStartupAt.toISOString()
      : schedule.startupTime;
    return {
      phase: 'active',
      action: null,
      message: `Stopped until ${startupLabel} (${schedule.timezone})`,
    };
  }

  if (isScheduleActiveNow(schedule, now)) {
    const shutdownLabel = isOnetimeSchedule(schedule) && schedule.oneTimeShutdownAt
      ? schedule.oneTimeShutdownAt.toISOString()
      : schedule.shutdownTime;
    return {
      phase: 'idle',
      action: null,
      message: `Running until ${shutdownLabel} (${schedule.timezone})`,
    };
  }

  return {
    phase: 'idle',
    action: null,
    message: schedule.nextRun ? `Next run ${schedule.nextRun.toISOString()}` : 'No upcoming run',
  };
}

export function shouldRunStartup(schedule: Schedule, now = new Date()): boolean {
  if (isOnetimeSchedule(schedule)) {
    if (!schedule.enabled || schedule.oneTimeCompleted || !schedule.oneTimeStartupAt) return false;
    return matchesScheduleMinute(schedule, schedule.oneTimeStartupAt, now);
  }

  if (isCombinedSchedule(schedule)) {
    if (!schedule.enabled) return false;
    return shouldRunCombinedStartup(schedule, now);
  }

  if (isWindowSchedule(schedule)) {
    if (!schedule.enabled || (isWindowOnce(schedule) && schedule.oneTimeCompleted)) return false;
    return shouldRunWindowStartup(schedule, now);
  }

  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dayOfWeek = isoDayOfWeek(zoned);
  if (!schedule.daysOfWeek.includes(dayOfWeek)) return false;

  const [h, m] = effectiveTimesForDay(schedule, dayOfWeek).startupTime.split(':').map(Number);
  return zoned.getHours() === h && zoned.getMinutes() === m;
}

const STARTUP_CATCHUP_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Short same-day retry after combined overnight micro-windows (e.g. 13:05→13:07). */
const OVERNIGHT_STARTUP_CATCHUP_MS = 30 * 60 * 1000;
/**
 * Do not self-heal startup when a scheduled shutdown is this soon — prevents a
 * reconcile startup (stale liveActive) from racing a long-stop shutdown (e.g. Fri 23:29
 * startup vs Fri 23:30 shutdown on combined schedules).
 */
const RECONCILE_STARTUP_BEFORE_SHUTDOWN_MS = 15 * 60 * 1000;

/** Next scheduled shutdown instant strictly after `from`. */
export function nextScheduledShutdownAfter(schedule: Schedule, from: Date): Date | null {
  if (isCombinedSchedule(schedule)) {
    return nextCombinedShutdownAfter(schedule, from);
  }
  if (isWindowSchedule(schedule)) {
    return nextShutdownAfter(schedule as WindowSchedule, from);
  }
  if (isOnetimeSchedule(schedule)) {
    const at = schedule.oneTimeShutdownAt;
    return at && at > from ? at : null;
  }
  if (schedule.daysOfWeek.length === 0) return null;

  const tz = schedule.timezone || 'UTC';
  const zonedNow = toZonedTime(from, tz);
  for (let offset = 0; offset < 8; offset++) {
    const candidate = addDays(zonedNow, offset);
    const dayOfWeek = isoDayOfWeek(candidate);
    if (!schedule.daysOfWeek.includes(dayOfWeek)) continue;

    const { shutdownTime } = effectiveTimesForDay(schedule, dayOfWeek);
    const [shH, shM] = shutdownTime.split(':').map(Number);
    const shutdownLocal = setMinutes(setHours(candidate, shH), shM);
    const shutdownUtc = fromZonedTime(shutdownLocal, tz);
    if (shutdownUtc > from) return shutdownUtc;
  }
  return null;
}

/**
 * Self-heal: schedule still flagged stopped (liveActive) but currently outside its stop
 * window — should be running. Skips when a scheduled shutdown is imminent so reconcile
 * does not race the long-stop cron (e.g. combined Fri 23:30 stop after overnight flag).
 *
 * Do NOT gate on liveStartupAt — a stale future timestamp (e.g. Tue nightly after a
 * missed Mon long-stop startup) would block recovery forever.
 */
export function shouldReconcileToStarted(schedule: Schedule, now: Date): boolean {
  if (!schedule.enabled || !schedule.liveActive) return false;
  if (schedule.liveStopSource === 'manual' || schedule.liveStopSource === 'manual-start') {
    return false;
  }
  if (shouldRunShutdown(schedule, now)) return false;
  if (isScheduleInStoppedWindow(schedule, now)) return false;

  const nextShutdown = nextScheduledShutdownAfter(schedule, now);
  if (
    nextShutdown &&
    nextShutdown.getTime() - now.getTime() <= RECONCILE_STARTUP_BEFORE_SHUTDOWN_MS
  ) {
    return false;
  }

  return true;
}

/** Retry startup if the exact minute was missed or failed while still in a stopped window. */
export function shouldRunStartupCatchup(schedule: Schedule, now = new Date()): boolean {
  if (!schedule.enabled) return false;
  if (shouldRunStartup(schedule, now)) return false;

  // Combined overnight: once the 2–5 min night window ends, generic catchup looks at the
  // *next* startup (days away) and never retries today's missed 13:07 startup.
  if (isCombinedSchedule(schedule)) {
    if (
      shouldRunMissedCombinedLongStopStartup(
        schedule,
        now,
        schedule.lastRun,
        STARTUP_CATCHUP_WINDOW_MS
      )
    ) {
      return true;
    }
    if (
      shouldRunMissedCombinedOvernightStartup(
        schedule,
        now,
        schedule.lastRun,
        OVERNIGHT_STARTUP_CATCHUP_MS
      )
    ) {
      return true;
    }
  }

  if (!schedule.liveActive) return false;

  let startupAt = computeCurrentLiveStartupAt(schedule, now);

  // When already outside the overnight window, use today's missed instant — not the next week.
  if (
    isCombinedSchedule(schedule) &&
    startupAt &&
    startupAt > now &&
    !isInCombinedStoppedPeriod(schedule, now)
  ) {
    const missedLongStop = todaysLongStopStartupInstant(schedule, now);
    if (missedLongStop) startupAt = missedLongStop;
    else {
      const missedToday = todaysOvernightStartupInstant(schedule, now);
      if (missedToday) startupAt = missedToday;
    }
  }

  if (!startupAt || now < startupAt) return false;
  if (now.getTime() - startupAt.getTime() > STARTUP_CATCHUP_WINDOW_MS) return false;
  if (schedule.lastRun && schedule.lastRun >= startupAt) return false;

  if (isDailySchedule(schedule)) {
    const tz = schedule.timezone || 'UTC';
    const zoned = toZonedTime(now, tz);
    const dayOfWeek = getDay(zoned) === 0 ? 7 : getDay(zoned);
    if (isCombinedSchedule(schedule)) {
      const dow = isoDayOfWeek(zoned);
      const active = combinedActiveDays(schedule);
      if (!active.includes(dow) && !isInCombinedStoppedPeriod(schedule, now)) return false;
    } else if (isWindowSchedule(schedule)) {
      const dow = isoDayOfWeek(zoned);
      if (dow !== schedule.startupDayOfWeek) return false;
    } else if (!schedule.daysOfWeek.includes(dayOfWeek)) {
      return false;
    }
  }

  return true;
}

export function isOvernightSchedule(schedule: Schedule): boolean {
  if (isOnetimeSchedule(schedule)) {
    const shutdownAt = schedule.oneTimeShutdownAt;
    const startupAt = schedule.oneTimeStartupAt;
    if (!shutdownAt || !startupAt) return false;
    return startupAt > shutdownAt && startupAt.getTime() - shutdownAt.getTime() > 12 * 60 * 60 * 1000;
  }
  if (isCombinedSchedule(schedule) || isWindowSchedule(schedule)) {
    return true;
  }
  return isOvernightScheduleTimes(schedule.shutdownTime, schedule.startupTime);
}

export function formatScheduleStartupLabel(schedule: Schedule, now = new Date()): string | undefined {
  const startupAt = resolveLiveStartupAt(schedule, now);
  if (!startupAt) return undefined;
  return formatNextRunAt(startupAt, schedule.timezone);
}

export async function reloadSchedule(scheduleId: string) {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) return;

  const nextRun = resolveDisplayNextRun(schedule);
  await prisma.schedule.update({
    where: { id: scheduleId },
    data: { nextRun },
  });
}

export interface ScheduleTimingRepairResult {
  schedulesScanned: number;
  schedulesUpdated: number;
  startupDaysCorrected: number;
}

/** Bump after timing repair logic changes to re-run once per server boot. */
export const TIMING_REPAIR_VERSION = 3;

let timingRepairVersionApplied = 0;

/**
 * Fri→Mon combined long stops must use startupDayOfWeek=1 (Mon). Legacy rows used 2 (Tue).
 */
function needsLegacyCombinedStartupDayRepair(schedule: Schedule): boolean {
  if (!isCombinedSchedule(schedule)) return false;
  if (coerceIsoDay(schedule.shutdownDayOfWeek) !== 5) return false;
  return coerceIsoDay(schedule.startupDayOfWeek) !== 1;
}

/** Recompute and persist nextRun / liveStartupAt for all enabled schedules. */
export async function repairAllScheduleTiming(now = new Date()): Promise<ScheduleTimingRepairResult> {
  const schedules = await prisma.schedule.findMany({ where: { enabled: true } });
  let schedulesUpdated = 0;
  let startupDaysCorrected = 0;

  for (const schedule of schedules) {
    let working = schedule;

    if (needsLegacyCombinedStartupDayRepair(schedule)) {
      working = await prisma.schedule.update({
        where: { id: schedule.id },
        data: { startupDayOfWeek: 1 },
      });
      startupDaysCorrected++;
    }

    const nextRun = resolveDisplayNextRun(working, now);
    const longStopExit = isCombinedSchedule(working)
      ? combinedLongStopExitStartup(working, now)
      : null;
    const resolvedNextRun = longStopExit ?? nextRun;
    const inStop = working.liveActive && isScheduleInStoppedWindow(working, now);

    const data: { nextRun?: Date | null; liveStartupAt?: Date | null } = {};
    if (resolvedNextRun && (!working.nextRun || working.nextRun.getTime() !== resolvedNextRun.getTime())) {
      data.nextRun = resolvedNextRun;
    }
    if (inStop && resolvedNextRun) {
      if (!working.liveStartupAt || working.liveStartupAt.getTime() !== resolvedNextRun.getTime()) {
        data.liveStartupAt = resolvedNextRun;
      }
    } else if (!working.liveActive && working.liveStartupAt) {
      data.liveStartupAt = null;
    }

    if (Object.keys(data).length === 0) continue;

    await prisma.schedule.update({ where: { id: working.id }, data });
    schedulesUpdated++;
  }

  if (schedulesUpdated > 0 || startupDaysCorrected > 0) {
    console.log(
      `[PodScheduler] Timing repair: ${schedulesUpdated} row(s) updated, ` +
        `${startupDaysCorrected} startup day(s) Fri→Mon corrected`
    );
  }

  return { schedulesScanned: schedules.length, schedulesUpdated, startupDaysCorrected };
}

/** Run timing repair once per server boot for each TIMING_REPAIR_VERSION. */
export async function ensureTimingRepairApplied(now = new Date()): Promise<void> {
  if (timingRepairVersionApplied >= TIMING_REPAIR_VERSION) return;
  await repairAllScheduleTiming(now).catch((err) =>
    console.warn('[PodScheduler] Timing repair failed:', err)
  );
  timingRepairVersionApplied = TIMING_REPAIR_VERSION;
}

/** Force timing repair on next boot (e.g. after manual repair-timing POST). */
export function resetTimingRepairVersion(): void {
  timingRepairVersionApplied = 0;
}

export async function reloadAllSchedules() {
  await repairAllScheduleTiming();
}
