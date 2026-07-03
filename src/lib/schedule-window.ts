import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import type { Schedule } from '@prisma/client';
import { isWindowOnce, isWindowRepeating } from './schedule-recurrence';

/** Wall-clock parts for an instant in a schedule timezone (independent of process TZ). */
export function wallClockParts(instant: Date, tz: string) {
  const z = toZonedTime(instant, tz);
  return {
    year: z.getFullYear(),
    month: z.getMonth(),
    day: z.getDate(),
    hour: z.getHours(),
    minute: z.getMinutes(),
    second: z.getSeconds(),
  };
}

/** ISO day-of-week (1=Mon … 7=Sun) for an instant in `tz`. */
export function isoDayOfWeekInTz(instant: Date, tz: string): number {
  const { year, month, day } = wallClockParts(instant, tz);
  return isoDayOfWeekWall(year, month, day);
}

/** ISO day-of-week from wall-calendar Y/M/D (month 0-based). */
export function isoDayOfWeekWall(year: number, month: number, day: number): number {
  const d = new Date(year, month, day).getDay();
  return d === 0 ? 7 : d;
}

function calendarInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string
): Date {
  return fromZonedTime(new Date(year, month, day, hour, minute, 0, 0), tz);
}

/** Noon anchor on a wall-calendar day in `tz` (for same-day time lookups). */
export function dayAnchorInTz(year: number, month: number, day: number, tz: string): Date {
  return calendarInstant(year, month, day, 12, 0, tz);
}

/** ISO day-of-week (1=Mon … 7=Sun) for a Date's local getters (legacy). */
export function isoDayOfWeek(date: Date): number {
  const d = date.getDay();
  return d === 0 ? 7 : d;
}

/** Normalize schedule day fields — DB/JSON may store numeric strings. */
export function coerceIsoDay(day: number | null | undefined): number | null {
  if (day == null) return null;
  const n = Number(day);
  return Number.isFinite(n) && n >= 1 && n <= 7 ? Math.trunc(n) : null;
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

/** Instant on `anchor` calendar day at HH:mm:00.000 in schedule timezone. */
export function instantOnScheduleDay(
  anchor: Date,
  hour: number,
  minute: number,
  tz: string
): Date {
  const { year, month, day } = wallClockParts(anchor, tz);
  return calendarInstant(year, month, day, hour, minute, tz);
}

function instantOnDay(anchor: Date, hour: number, minute: number, tz: string): Date {
  return instantOnScheduleDay(anchor, hour, minute, tz);
}

/** Shutdown instant on the given ISO weekday at or before `from` (same week cycle scan). */
export function shutdownInstantAtOrBefore(
  schedule: WindowSchedule,
  from: Date
): Date | null {
  const shutdownDay = coerceIsoDay(schedule.shutdownDayOfWeek);
  if (!shutdownDay) return null;
  const tz = schedule.timezone || 'UTC';
  const { h, m } = parseHm(schedule.shutdownTime);

  const { year, month, day } = wallClockParts(from, tz);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(year, month, day - offset);
    const cy = candidate.getFullYear();
    const cm = candidate.getMonth();
    const cd = candidate.getDate();
    if (isoDayOfWeekWall(cy, cm, cd) !== shutdownDay) continue;
    const instant = calendarInstant(cy, cm, cd, h, m, tz);
    if (instant <= from) return instant;
  }
  return null;
}

/** Next shutdown strictly after `from`. */
export function nextShutdownAfter(schedule: WindowSchedule, from: Date): Date | null {
  const shutdownDay = coerceIsoDay(schedule.shutdownDayOfWeek);
  if (!shutdownDay) return null;
  const tz = schedule.timezone || 'UTC';
  const { h, m } = parseHm(schedule.shutdownTime);

  const { year, month, day } = wallClockParts(from, tz);
  for (let offset = 0; offset <= 14; offset++) {
    const candidate = new Date(year, month, day + offset);
    const cy = candidate.getFullYear();
    const cm = candidate.getMonth();
    const cd = candidate.getDate();
    if (isoDayOfWeekWall(cy, cm, cd) !== shutdownDay) continue;
    const instant = calendarInstant(cy, cm, cd, h, m, tz);
    if (instant > from) return instant;
  }
  return null;
}

/** Startup instant that follows a given shutdown in the same cycle. */
export function startupAfterShutdown(schedule: WindowSchedule, shutdownUtc: Date): Date | null {
  const startupDay = coerceIsoDay(schedule.startupDayOfWeek);
  if (!startupDay) return null;
  const tz = schedule.timezone || 'UTC';
  const { h, m } = parseHm(schedule.startupTime);

  const { year, month, day } = wallClockParts(shutdownUtc, tz);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(year, month, day + offset);
    const cy = candidate.getFullYear();
    const cm = candidate.getMonth();
    const cd = candidate.getDate();
    if (isoDayOfWeekWall(cy, cm, cd) !== startupDay) continue;
    const instant = calendarInstant(cy, cm, cd, h, m, tz);
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

  const shutdownDay = coerceIsoDay(schedule.shutdownDayOfWeek);
  if (!shutdownDay) return false;
  const tz = schedule.timezone || 'UTC';
  if (isoDayOfWeekInTz(now, tz) !== shutdownDay) return false;
  const { h, m } = parseHm(schedule.shutdownTime);
  const parts = wallClockParts(now, tz);
  return parts.hour === h && parts.minute === m;
}

export function shouldRunWindowStartup(schedule: WindowSchedule, now: Date): boolean {
  if (isWindowOnce(schedule)) {
    if (!schedule.enabled || schedule.oneTimeCompleted || !schedule.oneTimeStartupAt) return false;
    return matchesMinute(schedule, schedule.oneTimeStartupAt, now);
  }

  const startupDay = coerceIsoDay(schedule.startupDayOfWeek);
  if (!startupDay) return false;
  const tz = schedule.timezone || 'UTC';
  if (isoDayOfWeekInTz(now, tz) !== startupDay) return false;
  const { h, m } = parseHm(schedule.startupTime);
  const parts = wallClockParts(now, tz);
  return parts.hour === h && parts.minute === m;
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
  const nowParts = wallClockParts(now, tz);
  const targetParts = wallClockParts(targetAt, tz);
  return (
    nowParts.year === targetParts.year &&
    nowParts.month === targetParts.month &&
    nowParts.day === targetParts.day &&
    nowParts.hour === targetParts.hour &&
    nowParts.minute === targetParts.minute
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
