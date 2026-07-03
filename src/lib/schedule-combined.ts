import type { Schedule } from '@prisma/client';
import {
  dayLabel,
  coerceIsoDay,
  wallClockParts,
  isoDayOfWeekInTz,
  isoDayOfWeekWall,
  dayAnchorInTz,
  isInWindowStoppedPeriod,
  nextShutdownAfter,
  shutdownInstantAtOrBefore,
  startupAfterShutdown,
  instantOnScheduleDay,
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

function asWindowSchedule(schedule: CombinedSchedule): WindowSchedule {
  return {
    recurrence: 'window',
    timezone: schedule.timezone,
    shutdownTime: schedule.shutdownTime,
    startupTime: schedule.startupTime,
    shutdownDayOfWeek: coerceIsoDay(schedule.shutdownDayOfWeek),
    startupDayOfWeek: coerceIsoDay(schedule.startupDayOfWeek),
    windowRepeatWeekly: true,
    oneTimeShutdownAt: null,
    oneTimeStartupAt: null,
    oneTimeCompleted: false,
    enabled: schedule.enabled,
  };
}

/**
 * Fri long-stop exit always uses Mon (1). Legacy rows stored startupDay=Tue (2), which
 * makes Startup At show Tuesday instead of Monday after the weekend stop.
 */
export function longStopWindowSchedule(schedule: CombinedSchedule): WindowSchedule {
  const window = asWindowSchedule(schedule);
  if (coerceIsoDay(schedule.shutdownDayOfWeek) === 5) {
    return { ...window, startupDayOfWeek: 1 };
  }
  return window;
}

/** Exit startup for the active long-stop window (e.g. Fri 23:30 → Mon 07:30). */
export function combinedLongStopExitStartup(
  schedule: CombinedSchedule,
  from: Date
): Date | null {
  const window = longStopWindowSchedule(schedule);
  if (!isInWindowStoppedPeriod(window, from)) return null;
  const lastShutdown = shutdownInstantAtOrBefore(window, from);
  if (!lastShutdown) return null;
  return startupAfterShutdown(window, lastShutdown);
}

/** Same-calendar-day overnight stop (e.g. Tue 00:00 → Tue 07:00). */
export function isInOvernightStoppedPeriod(schedule: CombinedSchedule, now: Date): boolean {
  const days = (schedule.overnightDays ?? [])
    .map((d) => coerceIsoDay(d))
    .filter((d): d is number => d != null);
  const shutdownTime = schedule.overnightShutdownTime;
  const startupTime = schedule.overnightStartupTime;
  if (!days.length || !shutdownTime || !startupTime) return false;

  const tz = schedule.timezone || 'UTC';
  const dow = isoDayOfWeekInTz(now, tz);
  if (!days.includes(dow)) return false;

  const { h: shH, m: shM } = parseHm(shutdownTime);
  const { h: stH, m: stM } = parseHm(startupTime);
  const { hour, minute } = wallClockParts(now, tz);
  const minutesNow = hour * 60 + minute;
  const shutdownMinutes = shH * 60 + shM;
  const startupMinutes = stH * 60 + stM;

  if (shutdownMinutes >= startupMinutes) return false;
  return minutesNow >= shutdownMinutes && minutesNow < startupMinutes;
}

export function isInCombinedStoppedPeriod(schedule: CombinedSchedule, now: Date): boolean {
  return (
    isInWindowStoppedPeriod(longStopWindowSchedule(schedule), now) ||
    isInOvernightStoppedPeriod(schedule, now)
  );
}

function overnightStartupOnDay(schedule: CombinedSchedule, anchor: Date): Date | null {
  const startupTime = schedule.overnightStartupTime;
  if (!startupTime) return null;
  const { h, m } = parseHm(startupTime);
  return instantOnScheduleDay(anchor, h, m, schedule.timezone || 'UTC');
}

function overnightShutdownOnDay(schedule: CombinedSchedule, anchor: Date): Date | null {
  const shutdownTime = schedule.overnightShutdownTime;
  if (!shutdownTime) return null;
  const { h, m } = parseHm(shutdownTime);
  return instantOnScheduleDay(anchor, h, m, schedule.timezone || 'UTC');
}

function enumerateCombinedEvents(schedule: CombinedSchedule, from: Date, horizonDays = 14): Date[] {
  const tz = schedule.timezone || 'UTC';
  const { year, month, day } = wallClockParts(from, tz);
  const events: Date[] = [];
  const window = longStopWindowSchedule(schedule);
  const overnightDays = schedule.overnightDays ?? [];

  for (let offset = 0; offset <= horizonDays; offset++) {
    const candidate = new Date(year, month, day + offset);
    const cy = candidate.getFullYear();
    const cm = candidate.getMonth();
    const cd = candidate.getDate();
    const dow = isoDayOfWeekWall(cy, cm, cd);
    const dayAnchor = dayAnchorInTz(cy, cm, cd, tz);

    const shutdownDay = coerceIsoDay(schedule.shutdownDayOfWeek);
    const startupDay = coerceIsoDay(schedule.startupDayOfWeek);
    if (shutdownDay != null && dow === shutdownDay) {
      const instant = overnightShutdownOnDay(
        { ...schedule, overnightShutdownTime: schedule.shutdownTime },
        dayAnchor
      );
      if (instant) events.push(instant);
    }
    if (startupDay != null && dow === startupDay) {
      const instant = overnightStartupOnDay(
        { ...schedule, overnightStartupTime: schedule.startupTime },
        dayAnchor
      );
      if (instant) events.push(instant);
    }

    if (overnightDays.includes(dow) && schedule.overnightShutdownTime && schedule.overnightStartupTime) {
      const sh = overnightShutdownOnDay(schedule, dayAnchor);
      const st = overnightStartupOnDay(schedule, dayAnchor);
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
  const window = longStopWindowSchedule(schedule);
  const longStopExit = combinedLongStopExitStartup(schedule, from);
  if (longStopExit) return longStopExit;

  const lastShutdown = shutdownInstantAtOrBefore(window, from);
  if (lastShutdown) {
    const exitStartup = startupAfterShutdown(window, lastShutdown);
    if (exitStartup && from >= lastShutdown && from < exitStartup) {
      return exitStartup;
    }
  }

  if (isInOvernightStoppedPeriod(schedule, from)) {
    const tz = schedule.timezone || 'UTC';
    const startup = overnightStartupOnDay(schedule, from);
    if (startup) return startup;
  }

  const events = enumerateCombinedEvents(schedule, from).filter((d) => d > from);
  const startupDay = coerceIsoDay(schedule.startupDayOfWeek);
  const overnightDays = (schedule.overnightDays ?? [])
    .map((d) => coerceIsoDay(d))
    .filter((d): d is number => d != null);

  for (const event of events) {
    const tz = schedule.timezone || 'UTC';
    const dow = isoDayOfWeekInTz(event, tz);
    const { hour, minute } = wallClockParts(event, tz);

    if (startupDay != null && dow === startupDay) {
      const { h, m } = parseHm(schedule.startupTime);
      if (hour === h && minute === m) return event;
    }

    if (
      overnightDays.includes(dow) &&
      schedule.overnightStartupTime
    ) {
      const { h, m } = parseHm(schedule.overnightStartupTime);
      if (hour === h && minute === m) return event;
    }
  }

  return null;
}

export function nextCombinedShutdownAfter(schedule: CombinedSchedule, from: Date): Date | null {
  const events = enumerateCombinedEvents(schedule, from).filter((d) => d > from);
  for (const event of events) {
    const tz = schedule.timezone || 'UTC';
    const dow = isoDayOfWeekInTz(event, tz);
    const { hour, minute } = wallClockParts(event, tz);

    if (dow === schedule.shutdownDayOfWeek) {
      const { h, m } = parseHm(schedule.shutdownTime);
      if (hour === h && minute === m) return event;
    }

    if (
      schedule.overnightDays?.includes(dow) &&
      schedule.overnightShutdownTime
    ) {
      const { h, m } = parseHm(schedule.overnightShutdownTime);
      if (hour === h && minute === m) return event;
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
  const shutdownDay = coerceIsoDay(schedule.shutdownDayOfWeek);
  if (!shutdownDay) return false;
  const tz = schedule.timezone || 'UTC';
  if (isoDayOfWeekInTz(now, tz) !== shutdownDay) return false;
  const { h, m } = parseHm(schedule.shutdownTime);
  const parts = wallClockParts(now, tz);
  return parts.hour === h && parts.minute === m;
}

function shouldRunWindowStartupCombined(schedule: CombinedSchedule, now: Date): boolean {
  const startupDay = coerceIsoDay(schedule.startupDayOfWeek);
  if (!startupDay) return false;
  const tz = schedule.timezone || 'UTC';
  if (isoDayOfWeekInTz(now, tz) !== startupDay) return false;
  const { h, m } = parseHm(schedule.startupTime);
  const parts = wallClockParts(now, tz);
  return parts.hour === h && parts.minute === m;
}

function shouldRunOvernightShutdown(schedule: CombinedSchedule, now: Date): boolean {
  const days = schedule.overnightDays ?? [];
  const shutdownTime = schedule.overnightShutdownTime;
  if (!days.length || !shutdownTime) return false;
  const tz = schedule.timezone || 'UTC';
  const dow = isoDayOfWeekInTz(now, tz);
  if (!days.includes(dow)) return false;
  const { h, m } = parseHm(shutdownTime);
  const parts = wallClockParts(now, tz);
  return parts.hour === h && parts.minute === m;
}

function shouldRunOvernightStartup(schedule: CombinedSchedule, now: Date): boolean {
  const days = schedule.overnightDays ?? [];
  const startupTime = schedule.overnightStartupTime;
  if (!days.length || !startupTime) return false;
  const tz = schedule.timezone || 'UTC';
  const dow = isoDayOfWeekInTz(now, tz);
  if (!days.includes(dow)) return false;
  const { h, m } = parseHm(startupTime);
  const parts = wallClockParts(now, tz);
  return parts.hour === h && parts.minute === m;
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
  const dow = isoDayOfWeekInTz(now, tz);
  if (!days.includes(dow)) return null;

  const startup = overnightStartupOnDay(schedule, now);
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

/**
 * Today's long-stop exit startup (e.g. Mon 07:30 after Fri→Mon stop), if that instant
 * is strictly before `now` on the startup weekday.
 */
export function todaysLongStopStartupInstant(
  schedule: CombinedSchedule,
  now: Date
): Date | null {
  const startupDay = coerceIsoDay(schedule.startupDayOfWeek);
  if (!startupDay || !schedule.startupTime) return null;

  const tz = schedule.timezone || 'UTC';
  if (isoDayOfWeekInTz(now, tz) !== startupDay) return null;

  const startup = overnightStartupOnDay(
    { ...schedule, overnightStartupTime: schedule.startupTime },
    now
  );
  if (!startup || now <= startup) return null;

  const window = longStopWindowSchedule(schedule);
  const lastShutdown = shutdownInstantAtOrBefore(window, startup);
  if (!lastShutdown) return null;
  const expectedExit = startupAfterShutdown(window, lastShutdown);
  if (!expectedExit || expectedExit.getTime() !== startup.getTime()) return null;

  return startup;
}

/** Retry a missed long-stop startup (e.g. Mon 07:30 after Fri→Mon weekend stop). */
export function shouldRunMissedCombinedLongStopStartup(
  schedule: CombinedSchedule,
  now: Date,
  lastRun: Date | null,
  catchupMs = 2 * 60 * 60 * 1000
): boolean {
  if (shouldRunWindowStartupCombined(schedule, now)) return false;
  if (isInCombinedStoppedPeriod(schedule, now)) return false;

  const missedAt = todaysLongStopStartupInstant(schedule, now);
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
