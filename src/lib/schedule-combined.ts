import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { addDays, setHours, setMinutes, getDay } from 'date-fns';
import type { Schedule } from '@prisma/client';
import {
  dayLabel,
  isoDayOfWeek,
  isInWindowStoppedPeriod,
  nextShutdownAfter,
  shutdownInstantAtOrBefore,
  startupAfterShutdown,
  type WindowSchedule,
} from './schedule-window';

export type CombinedSchedule = Pick<
  Schedule,
  | 'recurrence'
  | 'timezone'
  | 'shutdownTime'
  | 'startupTime'
  | 'shutdownDayOfWeek'
  | 'startupDayOfWeek'
  | 'overnightDays'
  | 'overnightShutdownTime'
  | 'overnightStartupTime'
  | 'enabled'
>;

function parseHm(time: string): { h: number; m: number } {
  const [h, m] = time.split(':').map(Number);
  return { h, m };
}

function instantOnDay(anchor: Date, hour: number, minute: number, tz: string): Date {
  const zoned = toZonedTime(anchor, tz);
  const local = setMinutes(setHours(zoned, hour), minute);
  return fromZonedTime(local, tz);
}

function asWindowSchedule(schedule: CombinedSchedule): WindowSchedule {
  return {
    recurrence: 'window',
    timezone: schedule.timezone,
    shutdownTime: schedule.shutdownTime,
    startupTime: schedule.startupTime,
    shutdownDayOfWeek: schedule.shutdownDayOfWeek,
    startupDayOfWeek: schedule.startupDayOfWeek,
    windowRepeatWeekly: true,
    oneTimeShutdownAt: null,
    oneTimeStartupAt: null,
    oneTimeCompleted: false,
    enabled: schedule.enabled,
  };
}

/** Same-calendar-day overnight stop (e.g. Tue 00:00 → Tue 07:00). */
export function isInOvernightStoppedPeriod(schedule: CombinedSchedule, now: Date): boolean {
  const days = schedule.overnightDays ?? [];
  const shutdownTime = schedule.overnightShutdownTime;
  const startupTime = schedule.overnightStartupTime;
  if (!days.length || !shutdownTime || !startupTime) return false;

  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dow = isoDayOfWeek(zoned);
  if (!days.includes(dow)) return false;

  const { h: shH, m: shM } = parseHm(shutdownTime);
  const { h: stH, m: stM } = parseHm(startupTime);
  const minutesNow = zoned.getHours() * 60 + zoned.getMinutes();
  const shutdownMinutes = shH * 60 + shM;
  const startupMinutes = stH * 60 + stM;

  if (shutdownMinutes >= startupMinutes) return false;
  return minutesNow >= shutdownMinutes && minutesNow < startupMinutes;
}

export function isInCombinedStoppedPeriod(schedule: CombinedSchedule, now: Date): boolean {
  return (
    isInWindowStoppedPeriod(asWindowSchedule(schedule), now) ||
    isInOvernightStoppedPeriod(schedule, now)
  );
}

function overnightStartupOnDay(schedule: CombinedSchedule, anchor: Date): Date | null {
  const startupTime = schedule.overnightStartupTime;
  if (!startupTime) return null;
  const { h, m } = parseHm(startupTime);
  return instantOnDay(anchor, h, m, schedule.timezone || 'UTC');
}

function overnightShutdownOnDay(schedule: CombinedSchedule, anchor: Date): Date | null {
  const shutdownTime = schedule.overnightShutdownTime;
  if (!shutdownTime) return null;
  const { h, m } = parseHm(shutdownTime);
  return instantOnDay(anchor, h, m, schedule.timezone || 'UTC');
}

function enumerateCombinedEvents(schedule: CombinedSchedule, from: Date, horizonDays = 14): Date[] {
  const tz = schedule.timezone || 'UTC';
  const zonedFrom = toZonedTime(from, tz);
  const events: Date[] = [];
  const window = asWindowSchedule(schedule);
  const overnightDays = schedule.overnightDays ?? [];

  for (let offset = 0; offset <= horizonDays; offset++) {
    const candidate = addDays(zonedFrom, offset);
    const dow = isoDayOfWeek(candidate);

    if (dow === schedule.shutdownDayOfWeek) {
      const instant = overnightShutdownOnDay(
        { ...schedule, overnightShutdownTime: schedule.shutdownTime },
        candidate
      );
      if (instant) events.push(instant);
    }
    if (dow === schedule.startupDayOfWeek) {
      const instant = overnightStartupOnDay(
        { ...schedule, overnightStartupTime: schedule.startupTime },
        candidate
      );
      if (instant) events.push(instant);
    }

    if (overnightDays.includes(dow) && schedule.overnightShutdownTime && schedule.overnightStartupTime) {
      const sh = overnightShutdownOnDay(schedule, candidate);
      const st = overnightStartupOnDay(schedule, candidate);
      if (sh) events.push(sh);
      if (st) events.push(st);
    }
  }

  // Cross-day events via window helpers
  const nextSh = nextShutdownAfter(window, from);
  if (nextSh) events.push(nextSh);
  const lastSh = shutdownInstantAtOrBefore(window, from);
  if (lastSh) {
    const st = startupAfterShutdown(window, lastSh);
    if (st) events.push(st);
  }

  return Array.from(new Set(events.map((d) => d.getTime())))
    .map((t) => new Date(t))
    .sort((a, b) => a.getTime() - b.getTime());
}

export function nextCombinedStartupAfter(schedule: CombinedSchedule, from: Date): Date | null {
  if (isInWindowStoppedPeriod(asWindowSchedule(schedule), from)) {
    const lastShutdown = shutdownInstantAtOrBefore(asWindowSchedule(schedule), from);
    if (lastShutdown) {
      const startup = startupAfterShutdown(asWindowSchedule(schedule), lastShutdown);
      if (startup && startup > from) return startup;
    }
  }

  if (isInOvernightStoppedPeriod(schedule, from)) {
    const tz = schedule.timezone || 'UTC';
    const zoned = toZonedTime(from, tz);
    const startup = overnightStartupOnDay(schedule, zoned);
    if (startup && startup > from) return startup;
  }

  const events = enumerateCombinedEvents(schedule, from).filter((d) => d > from);
  for (const event of events) {
    const tz = schedule.timezone || 'UTC';
    const zoned = toZonedTime(event, tz);
    const dow = isoDayOfWeek(zoned);

    if (dow === schedule.startupDayOfWeek) {
      const { h, m } = parseHm(schedule.startupTime);
      if (zoned.getHours() === h && zoned.getMinutes() === m) return event;
    }

    if (
      schedule.overnightDays?.includes(dow) &&
      schedule.overnightStartupTime
    ) {
      const { h, m } = parseHm(schedule.overnightStartupTime);
      if (zoned.getHours() === h && zoned.getMinutes() === m) return event;
    }
  }

  return null;
}

export function nextCombinedShutdownAfter(schedule: CombinedSchedule, from: Date): Date | null {
  const events = enumerateCombinedEvents(schedule, from).filter((d) => d > from);
  for (const event of events) {
    const tz = schedule.timezone || 'UTC';
    const zoned = toZonedTime(event, tz);
    const dow = isoDayOfWeek(zoned);

    if (dow === schedule.shutdownDayOfWeek) {
      const { h, m } = parseHm(schedule.shutdownTime);
      if (zoned.getHours() === h && zoned.getMinutes() === m) return event;
    }

    if (
      schedule.overnightDays?.includes(dow) &&
      schedule.overnightShutdownTime
    ) {
      const { h, m } = parseHm(schedule.overnightShutdownTime);
      if (zoned.getHours() === h && zoned.getMinutes() === m) return event;
    }
  }
  return nextShutdownAfter(asWindowSchedule(schedule), from);
}

export function shouldRunCombinedShutdown(schedule: CombinedSchedule, now: Date): boolean {
  if (shouldRunWindowShutdownCombined(schedule, now)) return true;
  return shouldRunOvernightShutdown(schedule, now);
}

export function shouldRunCombinedStartup(schedule: CombinedSchedule, now: Date): boolean {
  if (shouldRunWindowStartupCombined(schedule, now)) return true;
  return shouldRunOvernightStartup(schedule, now);
}

function shouldRunWindowShutdownCombined(schedule: CombinedSchedule, now: Date): boolean {
  const shutdownDay = schedule.shutdownDayOfWeek;
  if (!shutdownDay) return false;
  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  if (isoDayOfWeek(zoned) !== shutdownDay) return false;
  const { h, m } = parseHm(schedule.shutdownTime);
  return zoned.getHours() === h && zoned.getMinutes() === m;
}

function shouldRunWindowStartupCombined(schedule: CombinedSchedule, now: Date): boolean {
  const startupDay = schedule.startupDayOfWeek;
  if (!startupDay) return false;
  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  if (isoDayOfWeek(zoned) !== startupDay) return false;
  const { h, m } = parseHm(schedule.startupTime);
  return zoned.getHours() === h && zoned.getMinutes() === m;
}

function shouldRunOvernightShutdown(schedule: CombinedSchedule, now: Date): boolean {
  const days = schedule.overnightDays ?? [];
  const shutdownTime = schedule.overnightShutdownTime;
  if (!days.length || !shutdownTime) return false;
  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dow = isoDayOfWeek(zoned);
  if (!days.includes(dow)) return false;
  const { h, m } = parseHm(shutdownTime);
  return zoned.getHours() === h && zoned.getMinutes() === m;
}

function shouldRunOvernightStartup(schedule: CombinedSchedule, now: Date): boolean {
  const days = schedule.overnightDays ?? [];
  const startupTime = schedule.overnightStartupTime;
  if (!days.length || !startupTime) return false;
  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dow = isoDayOfWeek(zoned);
  if (!days.includes(dow)) return false;
  const { h, m } = parseHm(startupTime);
  return zoned.getHours() === h && zoned.getMinutes() === m;
}

/**
 * Today's overnight startup instant on the schedule timezone calendar day, if that
 * weekday is configured and the instant is strictly before `now`.
 */
export function todaysOvernightStartupInstant(
  schedule: CombinedSchedule,
  now: Date
): Date | null {
  const days = schedule.overnightDays ?? [];
  if (!days.length || !schedule.overnightStartupTime) return null;

  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dow = isoDayOfWeek(zoned);
  if (!days.includes(dow)) return null;

  const startup = overnightStartupOnDay(schedule, zoned);
  if (!startup || now <= startup) return null;
  return startup;
}

/** Retry a missed same-day overnight startup (e.g. nights 13:05→13:07) after the window ends. */
export function shouldRunMissedCombinedOvernightStartup(
  schedule: CombinedSchedule,
  now: Date,
  lastRun: Date | null,
  catchupMs = 30 * 60 * 1000
): boolean {
  if (shouldRunOvernightStartup(schedule, now)) return false;
  if (isInOvernightStoppedPeriod(schedule, now)) return false;

  const missedAt = todaysOvernightStartupInstant(schedule, now);
  if (!missedAt) return false;
  if (now.getTime() - missedAt.getTime() > catchupMs) return false;
  if (lastRun && lastRun >= missedAt) return false;

  return true;
}

export function computeCurrentLiveStartupAtCombined(
  schedule: CombinedSchedule,
  now: Date
): Date | null {
  if (isInCombinedStoppedPeriod(schedule, now)) {
    return nextCombinedStartupAfter(schedule, now);
  }
  return nextCombinedStartupAfter(schedule, now);
}

export function computeNextRunCombined(schedule: CombinedSchedule, from: Date): Date | null {
  if (!schedule.enabled) return null;
  if (isInCombinedStoppedPeriod(schedule, from)) {
    return nextCombinedStartupAfter(schedule, from);
  }
  return nextCombinedShutdownAfter(schedule, from);
}

export function formatCombinedScheduleSummary(
  schedule: Pick<
    CombinedSchedule,
    | 'shutdownDayOfWeek'
    | 'startupDayOfWeek'
    | 'shutdownTime'
    | 'startupTime'
    | 'overnightDays'
    | 'overnightShutdownTime'
    | 'overnightStartupTime'
  >
): string {
  const cross = `${dayLabel(schedule.shutdownDayOfWeek)} ${schedule.shutdownTime} → ${dayLabel(schedule.startupDayOfWeek)} ${schedule.startupTime}`;
  const nights = (schedule.overnightDays ?? [])
    .slice()
    .sort((a, b) => a - b)
    .map((d) => dayLabel(d))
    .join(', ');
  const nightTimes =
    schedule.overnightShutdownTime && schedule.overnightStartupTime
      ? ` · nights ${schedule.overnightShutdownTime}–${schedule.overnightStartupTime}`
      : '';
  return nights
    ? `${cross} + ${nights}${nightTimes} · weekly`
    : `${cross} · weekly`;
}

/** All ISO days that can trigger a shutdown or startup for this combined schedule. */
export function combinedActiveDays(
  schedule: Pick<
    CombinedSchedule,
    'shutdownDayOfWeek' | 'startupDayOfWeek' | 'overnightDays'
  >
): number[] {
  const days = new Set<number>();
  if (schedule.shutdownDayOfWeek) days.add(schedule.shutdownDayOfWeek);
  if (schedule.startupDayOfWeek) days.add(schedule.startupDayOfWeek);
  for (const d of schedule.overnightDays ?? []) days.add(d);
  return Array.from(days).sort((a, b) => a - b);
}
