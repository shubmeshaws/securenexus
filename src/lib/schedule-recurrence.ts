import { toZonedTime, fromZonedTime } from 'date-fns-tz';

export type ScheduleRecurrence = 'daily' | 'onetime' | 'split' | 'window';

/** Weekly-repeating schedules (daily + weekday/weekend split + window) — i.e. not one-time. */
export function isDailySchedule(schedule: { recurrence?: string | null }): boolean {
  return schedule.recurrence !== 'onetime' && !isWindowOnce(schedule);
}

export function isOnetimeSchedule(schedule: { recurrence?: string | null }): boolean {
  return schedule.recurrence === 'onetime';
}

/** Cross-day window that runs only once (recurrence=window, windowRepeatWeekly=false). */
export function isWindowOnce(schedule: {
  recurrence?: string | null;
  windowRepeatWeekly?: boolean | null;
}): boolean {
  return schedule.recurrence === 'window' && schedule.windowRepeatWeekly === false;
}

/** Stop-day → start-day schedule (Fri stop, Mon start, etc.). */
export function isWindowSchedule(schedule: { recurrence?: string | null }): boolean {
  return schedule.recurrence === 'window';
}

/** Schedules that auto-disable after the startup run completes. */
export function completesAfterStartup(schedule: {
  recurrence?: string | null;
  windowRepeatWeekly?: boolean | null;
}): boolean {
  return isOnetimeSchedule(schedule) || isWindowOnce(schedule);
}

export function isWindowRepeating(schedule: {
  recurrence?: string | null;
  windowRepeatWeekly?: boolean | null;
}): boolean {
  return schedule.recurrence === 'window' && schedule.windowRepeatWeekly !== false;
}

/** Split schedules apply different times on weekdays (Mon–Fri) vs weekends (Sat–Sun). */
export function isSplitSchedule(schedule: { recurrence?: string | null }): boolean {
  return schedule.recurrence === 'split';
}

/** True when the schedule instant matches the current minute in the schedule timezone. */
export function matchesScheduleMinute(
  schedule: { timezone?: string | null },
  targetAt: Date,
  now = new Date()
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

/** Parse `datetime-local` value as a wall-clock time in the given timezone. */
export function parseZonedDatetimeInput(value: string, timezone: string): Date {
  const [datePart, timePart] = value.split('T');
  if (!datePart || !timePart) throw new Error('Invalid date and time');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  if (
    [year, month, day, hour, minute].some((n) => Number.isNaN(n)) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error('Invalid date and time');
  }
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  return fromZonedTime(local, timezone);
}

/** Format a UTC instant for `datetime-local` inputs in the given timezone. */
export function formatZonedDatetimeInput(date: Date, timezone: string): string {
  const zoned = toZonedTime(date, timezone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${zoned.getFullYear()}-${pad(zoned.getMonth() + 1)}-${pad(zoned.getDate())}T${pad(zoned.getHours())}:${pad(zoned.getMinutes())}`;
}

/** Derive HH:mm from a UTC instant in the schedule timezone (for table display). */
export function timeFromZonedInstant(date: Date, timezone: string): string {
  const zoned = toZonedTime(date, timezone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(zoned.getHours())}:${pad(zoned.getMinutes())}`;
}

export function defaultOnetimeShutdownInput(timezone: string): string {
  const now = new Date();
  const zoned = toZonedTime(now, timezone);
  zoned.setHours(zoned.getHours() + 1, 0, 0, 0);
  return formatZonedDatetimeInput(fromZonedTime(zoned, timezone), timezone);
}

export function defaultOnetimeStartupInput(shutdownInput: string, timezone: string): string {
  const shutdown = parseZonedDatetimeInput(shutdownInput, timezone);
  const startup = new Date(shutdown.getTime() + 30 * 60 * 1000);
  return formatZonedDatetimeInput(startup, timezone);
}
