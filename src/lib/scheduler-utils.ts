import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { addDays, setHours, setMinutes, getDay, isBefore } from 'date-fns';
import { isOvernightSchedule as isOvernightScheduleTimes, formatNextRunAt } from './utils';
import {
  isDailySchedule,
  isOnetimeSchedule,
  matchesScheduleMinute,
} from './schedule-recurrence';
import prisma from './prisma';
import type { Schedule } from '@prisma/client';

function computeNextRunDaily(schedule: Schedule, fromDate = new Date()): Date | null {
  if (schedule.daysOfWeek.length === 0) return null;

  const tz = schedule.timezone || 'UTC';
  const zonedNow = toZonedTime(fromDate, tz);

  for (let offset = 0; offset < 8; offset++) {
    const candidate = addDays(zonedNow, offset);
    const dayOfWeek = getDay(candidate) === 0 ? 7 : getDay(candidate);
    if (!schedule.daysOfWeek.includes(dayOfWeek)) continue;

    const [shH, shM] = schedule.shutdownTime.split(':').map(Number);
    const [stH, stM] = schedule.startupTime.split(':').map(Number);

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
  return computeNextRunDaily(schedule, fromDate);
}

/** Startup time for the current stopped window (stable across polls). */
export function computeCurrentLiveStartupAt(schedule: Schedule, now = new Date()): Date | null {
  if (!schedule.enabled) return null;

  if (isOnetimeSchedule(schedule)) {
    return schedule.oneTimeStartupAt;
  }

  if (schedule.daysOfWeek.length === 0) return null;

  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const [stH, stM] = schedule.startupTime.split(':').map(Number);
  const [shH, shM] = schedule.shutdownTime.split(':').map(Number);
  const startupMinutes = stH * 60 + stM;
  const shutdownMinutes = shH * 60 + shM;
  const minutesNow = zoned.getHours() * 60 + zoned.getMinutes();

  let startupLocal = setMinutes(setHours(zoned, stH), stM);

  if (startupMinutes < shutdownMinutes) {
    if (minutesNow >= shutdownMinutes) {
      startupLocal = setMinutes(setHours(addDays(zoned, 1), stH), stM);
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

  if (schedule.daysOfWeek.length === 0) return null;

  const tz = schedule.timezone || 'UTC';
  const zonedNow = toZonedTime(fromDate, tz);
  const [stH, stM] = schedule.startupTime.split(':').map(Number);

  for (let offset = 0; offset < 8; offset++) {
    const candidate = addDays(zonedNow, offset);
    const dayOfWeek = getDay(candidate) === 0 ? 7 : getDay(candidate);
    if (!schedule.daysOfWeek.includes(dayOfWeek)) continue;

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

  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dayOfWeek = getDay(zoned) === 0 ? 7 : getDay(zoned);
  if (!schedule.daysOfWeek.includes(dayOfWeek)) return false;

  const [h, m] = schedule.shutdownTime.split(':').map(Number);
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

  if (schedule.daysOfWeek.length === 0) return false;

  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dayOfWeek = getDay(zoned) === 0 ? 7 : getDay(zoned);
  if (!schedule.daysOfWeek.includes(dayOfWeek)) return false;

  const [shH, shM] = schedule.shutdownTime.split(':').map(Number);
  const [stH, stM] = schedule.startupTime.split(':').map(Number);
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
  if (!isScheduleDayToday(schedule, now)) return false;
  return !isScheduleActiveNow(schedule, now);
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

  const tz = schedule.timezone || 'UTC';
  const zoned = toZonedTime(now, tz);
  const dayOfWeek = getDay(zoned) === 0 ? 7 : getDay(zoned);
  if (!schedule.daysOfWeek.includes(dayOfWeek)) return false;

  const [h, m] = schedule.startupTime.split(':').map(Number);
  return zoned.getHours() === h && zoned.getMinutes() === m;
}

const STARTUP_CATCHUP_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Retry startup if the exact minute was missed or failed while still in a stopped window. */
export function shouldRunStartupCatchup(schedule: Schedule, now = new Date()): boolean {
  if (!schedule.enabled || !schedule.liveActive) return false;
  if (shouldRunStartup(schedule, now)) return false;

  const startupAt = computeCurrentLiveStartupAt(schedule, now);
  if (!startupAt || now < startupAt) return false;
  if (now.getTime() - startupAt.getTime() > STARTUP_CATCHUP_WINDOW_MS) return false;
  if (schedule.lastRun && schedule.lastRun >= startupAt) return false;

  if (isDailySchedule(schedule)) {
    const tz = schedule.timezone || 'UTC';
    const zoned = toZonedTime(now, tz);
    const dayOfWeek = getDay(zoned) === 0 ? 7 : getDay(zoned);
    if (!schedule.daysOfWeek.includes(dayOfWeek)) return false;
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
  return isOvernightScheduleTimes(schedule.shutdownTime, schedule.startupTime);
}

export function formatScheduleStartupLabel(schedule: Schedule, now = new Date()): string | undefined {
  const startupAt = computeCurrentLiveStartupAt(schedule, now);
  if (!startupAt) return undefined;
  return formatNextRunAt(startupAt, schedule.timezone);
}

export async function reloadSchedule(scheduleId: string) {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) return;

  const nextRun = computeNextRun(schedule);
  await prisma.schedule.update({
    where: { id: scheduleId },
    data: { nextRun },
  });
}

export async function reloadAllSchedules() {
  const schedules = await prisma.schedule.findMany();
  for (const schedule of schedules) {
    const nextRun = computeNextRun(schedule);
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { nextRun },
    });
  }
}
