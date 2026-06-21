import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { addDays, setHours, setMinutes, getDay } from 'date-fns';
import type { Schedule } from '@prisma/client';
import { isWindowOnce, isWindowRepeating } from './schedule-recurrence';

/** ISO day-of-week (1=Mon … 7=Sun) for a zoned date. */
export function isoDayOfWeek(date: Date): number {
  const d = getDay(date);
  return d === 0 ? 7 : d;
}

export type WindowSchedule = Pick<
  Schedule,
  | 'recurrence'
  | 'timezone'
  | 'shutdownTime'
  | 'startupTime'
  | 'shutdownDayOfWeek'
  | 'startupDayOfWeek'
  | 'windowRepeatWeekly'
  | 'oneTimeShutdownAt'
  | 'oneTimeStartupAt'
  | 'oneTimeCompleted'
  | 'enabled'
>;

function parseHm(time: string): { h: number; m: number } {
  const [h, m] = time.split(':').map(Number);
  return { h, m };
}

/** Instant on `anchor` calendar day at HH:mm in schedule timezone. */
function instantOnDay(anchor: Date, hour: number, minute: number, tz: string): Date {
  const zoned = toZonedTime(anchor, tz);
  const local = setMinutes(setHours(zoned, hour), minute);
  return fromZonedTime(local, tz);
}

/** Shutdown instant on the given ISO weekday at or before `from` (same week cycle scan). */
export function shutdownInstantAtOrBefore(
  schedule: WindowSchedule,
  from: Date
): Date | null {
  const shutdownDay = schedule.shutdownDayOfWeek;
  if (!shutdownDay) return null;
  const tz = schedule.timezone || 'UTC';
  const { h, m } = parseHm(schedule.shutdownTime);

  const zonedFrom = toZonedTime(from, tz);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = addDays(zonedFrom, -offset);
    if (isoDayOfWeek(candidate) !== shutdownDay) continue;
    const instant = instantOnDay(candidate, h, m, tz);
    if (instant <= from) return instant;
  }
  return null;
}

/** Next shutdown strictly after `from`. */
export function nextShutdownAfter(schedule: WindowSchedule, from: Date): Date | null {
  const shutdownDay = schedule.shutdownDayOfWeek;
  if (!shutdownDay) return null;
  const tz = schedule.timezone || 'UTC';
  const { h, m } = parseHm(schedule.shutdownTime);
  const zonedFrom = toZonedTime(from, tz);

  for (let offset = 0; offset <= 14; offset++) {
    const candidate = addDays(zonedFrom, offset);
    if (isoDayOfWeek(candidate) !== shutdownDay) continue;
    const instant = instantOnDay(candidate, h, m, tz);
    if (instant > from) return instant;
  }
  return null;
}

/** Startup instant that follows a given shutdown in the same cycle. */
export function startupAfterShutdown(schedule: WindowSchedule, shutdownUtc: Date): Date | null {
  const startupDay = schedule.startupDayOfWeek;
  if (!startupDay) return null;
  const tz = schedule.timezone || 'UTC';
  const { h, m } = parseHm(schedule.startupTime);
  const shutdownZoned = toZonedTime(shutdownUtc, tz);

  for (let offset = 0; offset <= 7; offset++) {
    const candidate = addDays(shutdownZoned, offset);
    if (isoDayOfWeek(candidate) !== startupDay) continue;
    const instant = instantOnDay(candidate, h, m, tz);
    if (instant > shutdownUtc) return instant;
  }
  return null;
}

/** Next startup strictly after `from`. */
export function nextStartupAfter(schedule: WindowSchedule, from: Date): Date | null {
  const lastShutdown = shutdownInstantAtOrBefore(schedule, from);
  if (lastShutdown) {
    const cycleStartup = startupAfterShutdown(schedule, lastShutdown);
    if (cycleStartup && cycleStartup > from) return cycleStartup;
  }

  const nextShutdown = nextShutdownAfter(schedule, from);
  if (!nextShutdown) return null;
  return startupAfterShutdown(schedule, nextShutdown);
}

export function isInWindowStoppedPeriod(schedule: WindowSchedule, now: Date): boolean {
  if (isWindowOnce(schedule)) {
    const shutdownAt = schedule.oneTimeShutdownAt;
    const startupAt = schedule.oneTimeStartupAt;
    if (!shutdownAt || !startupAt) return false;
    return now >= shutdownAt && now < startupAt;
  }

  const lastShutdown = shutdownInstantAtOrBefore(schedule, now);
  if (!lastShutdown) return false;
  const startup = startupAfterShutdown(schedule, lastShutdown);
  if (!startup) return false;
  return now >= lastShutdown && now < startup;
}

export function shouldRunWindowShutdown(schedule: WindowSchedule, now: Date): boolean {
  if (isWindowOnce(schedule)) {
    if (!schedule.enabled || schedule.oneTimeCompleted || !schedule.oneTimeShutdownAt) return false;
    return matchesMinute(schedule, schedule.oneTimeShutdownAt, now);
  }

  const shutdownDay = schedule.shutdownDayOfWeek;
  if (!shutdownDay) return false;
  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  if (isoDayOfWeek(zoned) !== shutdownDay) return false;
  const { h, m } = parseHm(schedule.shutdownTime);
  return zoned.getHours() === h && zoned.getMinutes() === m;
}

export function shouldRunWindowStartup(schedule: WindowSchedule, now: Date): boolean {
  if (isWindowOnce(schedule)) {
    if (!schedule.enabled || schedule.oneTimeCompleted || !schedule.oneTimeStartupAt) return false;
    return matchesMinute(schedule, schedule.oneTimeStartupAt, now);
  }

  const startupDay = schedule.startupDayOfWeek;
  if (!startupDay) return false;
  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  if (isoDayOfWeek(zoned) !== startupDay) return false;
  const { h, m } = parseHm(schedule.startupTime);
  return zoned.getHours() === h && zoned.getMinutes() === m;
}

export function computeCurrentLiveStartupAtWindow(
  schedule: WindowSchedule,
  now: Date
): Date | null {
  if (isWindowOnce(schedule)) return schedule.oneTimeStartupAt;

  const lastShutdown = shutdownInstantAtOrBefore(schedule, now);
  if (!lastShutdown) return nextStartupAfter(schedule, now);
  const startup = startupAfterShutdown(schedule, lastShutdown);
  if (startup && startup > now) return startup;
  const nextShutdown = nextShutdownAfter(schedule, now);
  if (!nextShutdown) return null;
  return startupAfterShutdown(schedule, nextShutdown);
}

export function computeNextRunWindow(schedule: WindowSchedule, from: Date): Date | null {
  if (!schedule.enabled) return null;

  if (isWindowOnce(schedule)) {
    if (schedule.oneTimeCompleted) return null;
    const shutdownAt = schedule.oneTimeShutdownAt;
    const startupAt = schedule.oneTimeStartupAt;
    if (!shutdownAt || !startupAt) return null;
    if (shutdownAt > from) return shutdownAt;
    if (startupAt > from) return startupAt;
    return null;
  }

  if (isInWindowStoppedPeriod(schedule, from)) {
    return nextStartupAfter(schedule, from);
  }
  return nextShutdownAfter(schedule, from);
}

function matchesMinute(
  schedule: Pick<Schedule, 'timezone'>,
  targetAt: Date,
  now: Date
): boolean {
  const tz = schedule.timezone || 'UTC';
  const zonedNow = toZonedTime(now, tz);
  const zonedTarget = toZonedTime(targetAt, tz);
  return (
    zonedNow.getFullYear() === zonedTarget.getFullYear() &&
    zonedNow.getMonth() === zonedTarget.getMonth() &&
    zonedNow.getDate() === zonedTarget.getDate() &&
    zonedNow.getHours() === zonedTarget.getHours() &&
    zonedNow.getMinutes() === zonedTarget.getMinutes()
  );
}

export function dayLabel(day: number | null | undefined): string {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (!day || day < 1 || day > 7) return '?';
  return labels[day - 1] ?? '?';
}

export function formatWindowScheduleSummary(
  schedule: Pick<
    Schedule,
    | 'windowRepeatWeekly'
    | 'shutdownDayOfWeek'
    | 'startupDayOfWeek'
    | 'shutdownTime'
    | 'startupTime'
  >
): string {
  if (schedule.windowRepeatWeekly === false) return 'Stop day → Start day (once)';
  const stop = `${dayLabel(schedule.shutdownDayOfWeek)} ${schedule.shutdownTime}`;
  const start = `${dayLabel(schedule.startupDayOfWeek)} ${schedule.startupTime}`;
  return `${stop} → ${start} · weekly`;
}
