import {
  addDays,
  addMonths,
  getDaysInMonth,
  setHours,
  setMilliseconds,
  setMinutes,
  setSeconds,
} from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

export const AUTOMATION_SCHEDULE_FREQUENCIES = [
  { id: 'daily', label: 'Every day', description: 'Runs once per day at the scheduled time' },
  { id: 'weekly', label: 'Once a week', description: 'Runs on selected weekdays' },
  { id: 'monthly', label: 'Once a month', description: 'Runs on a specific day each month' },
  { id: 'quarterly', label: 'Every 3 months', description: 'Runs every quarter from the anchor date' },
  { id: 'semiannual', label: 'Every 6 months', description: 'Runs twice a year from the anchor date' },
  { id: 'yearly', label: 'Once a year', description: 'Runs on the same date every year' },
  { id: 'once', label: 'Once at specific date & time', description: 'Single run — no repeat' },
] as const;

export type AutomationScheduleFrequency = (typeof AUTOMATION_SCHEDULE_FREQUENCIES)[number]['id'];

export interface AutomationScheduleInput {
  scheduleFrequency: AutomationScheduleFrequency;
  scheduleTime: string;
  scheduleDays: number[];
  scheduleDayOfMonth: number | null;
  scheduleMonth: number | null;
  scheduleStartDate: string | null;
  timezone: string;
}

export interface AutomationScheduleRow extends AutomationScheduleInput {
  enabled: boolean;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseScheduleTime(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(':').map(Number);
  return { hours: Number.isFinite(h) ? h : 0, minutes: Number.isFinite(m) ? m : 0 };
}

function automationRunInstant(
  year: number,
  month: number,
  day: number,
  time: string,
  timezone: string
): Date {
  const { hours, minutes } = parseScheduleTime(time);
  return fromZonedTime(new Date(year, month - 1, day, hours, minutes, 0, 0), timezone);
}

function atScheduleTimeOnZonedDay(zonedDay: Date, time: string, timezone: string): Date {
  const { hours, minutes } = parseScheduleTime(time);
  const local = setSeconds(
    setMilliseconds(setMinutes(setHours(zonedDay, hours), minutes), 0),
    0
  );
  return fromZonedTime(local, timezone);
}

function dayOfMonthMatches(zonedDay: Date, dayOfMonth: number): boolean {
  const maxDay = getDaysInMonth(zonedDay);
  return zonedDay.getDate() === Math.min(dayOfMonth, maxDay);
}

function parseAnchorParts(dateStr: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day };
}

export function normalizeScheduleFrequency(value: string | null | undefined): AutomationScheduleFrequency {
  const match = AUTOMATION_SCHEDULE_FREQUENCIES.find((row) => row.id === value);
  return match?.id ?? 'weekly';
}

export function validateAutomationSchedule(input: AutomationScheduleInput): string | null {
  if (!input.scheduleTime.trim()) return 'Schedule time is required.';

  if (input.scheduleFrequency === 'weekly' && input.scheduleDays.length === 0) {
    return 'Select at least one weekday for weekly schedules.';
  }

  if (
    (input.scheduleFrequency === 'monthly' ||
      input.scheduleFrequency === 'quarterly' ||
      input.scheduleFrequency === 'semiannual') &&
    !input.scheduleDayOfMonth
  ) {
    return 'Select the day of month for this schedule.';
  }

  if (input.scheduleFrequency === 'yearly') {
    if (!input.scheduleMonth) return 'Select the month for yearly schedules.';
    if (!input.scheduleDayOfMonth) return 'Select the day of month for yearly schedules.';
  }

  if (
    (input.scheduleFrequency === 'once' ||
      input.scheduleFrequency === 'quarterly' ||
      input.scheduleFrequency === 'semiannual') &&
    !input.scheduleStartDate?.trim()
  ) {
    return 'Start date is required for this schedule type.';
  }

  return null;
}

export function formatAutomationScheduleSummary(input: AutomationScheduleInput): string {
  const time = input.scheduleTime;
  const tz = input.timezone;

  switch (input.scheduleFrequency) {
    case 'daily':
      return `Daily at ${time} ${tz}`;
    case 'weekly': {
      const days =
        input.scheduleDays.length > 0
          ? input.scheduleDays.map((d) => WEEKDAY_SHORT[d] ?? String(d)).join(', ')
          : '—';
      return `Weekly on ${days} at ${time} ${tz}`;
    }
    case 'monthly':
      return `Monthly on day ${input.scheduleDayOfMonth ?? '—'} at ${time} ${tz}`;
    case 'quarterly':
      return `Every 3 months from ${input.scheduleStartDate ?? '—'} (day ${input.scheduleDayOfMonth ?? '—'}) at ${time} ${tz}`;
    case 'semiannual':
      return `Every 6 months from ${input.scheduleStartDate ?? '—'} (day ${input.scheduleDayOfMonth ?? '—'}) at ${time} ${tz}`;
    case 'yearly':
      return `Yearly on ${input.scheduleMonth ?? '—'}/${input.scheduleDayOfMonth ?? '—'} at ${time} ${tz}`;
    case 'once':
      return `Once on ${input.scheduleStartDate ?? '—'} at ${time} ${tz}`;
    default:
      return `${time} ${tz}`;
  }
}

export function startOfAutomationMinute(now: Date, timezone: string): Date {
  const zoned = toZonedTime(now, timezone);
  const floored = setSeconds(
    setMilliseconds(setMinutes(setHours(zoned, zoned.getHours()), zoned.getMinutes()), 0),
    0
  );
  return fromZonedTime(floored, timezone);
}

export function matchesAutomationScheduleMinute(row: AutomationScheduleRow, now = new Date()): boolean {
  if (!row.enabled) return false;

  const timezone = row.timezone || 'UTC';
  const zonedNow = toZonedTime(now, timezone);
  const { hours, minutes } = parseScheduleTime(row.scheduleTime);
  if (zonedNow.getHours() !== hours || zonedNow.getMinutes() !== minutes) return false;

  const jsDay = zonedNow.getDay();

  switch (row.scheduleFrequency) {
    case 'daily':
      return true;
    case 'weekly':
      return row.scheduleDays.includes(jsDay);
    case 'monthly':
      return dayOfMonthMatches(zonedNow, row.scheduleDayOfMonth ?? 1);
    case 'yearly':
      return (
        zonedNow.getMonth() + 1 === (row.scheduleMonth ?? 1) &&
        dayOfMonthMatches(zonedNow, row.scheduleDayOfMonth ?? 1)
      );
    case 'once': {
      if (!row.scheduleStartDate) return false;
      const anchor = parseAnchorParts(row.scheduleStartDate);
      return (
        zonedNow.getFullYear() === anchor.year &&
        zonedNow.getMonth() + 1 === anchor.month &&
        zonedNow.getDate() === anchor.day
      );
    }
    case 'quarterly':
    case 'semiannual': {
      if (!row.scheduleStartDate || !row.scheduleDayOfMonth) return false;
      const step = row.scheduleFrequency === 'quarterly' ? 3 : 6;
      const anchor = parseAnchorParts(row.scheduleStartDate);
      let cursor = new Date(anchor.year, anchor.month - 1, 1);
      for (let i = 0; i < 80; i++) {
        const year = cursor.getFullYear();
        const month = cursor.getMonth() + 1;
        const maxDay = getDaysInMonth(cursor);
        const day = Math.min(row.scheduleDayOfMonth, maxDay);
        if (
          zonedNow.getFullYear() === year &&
          zonedNow.getMonth() + 1 === month &&
          zonedNow.getDate() === day
        ) {
          return true;
        }
        if (
          year > zonedNow.getFullYear() ||
          (year === zonedNow.getFullYear() && month > zonedNow.getMonth() + 1)
        ) {
          break;
        }
        cursor = addMonths(cursor, step);
      }
      return false;
    }
    default:
      return false;
  }
}

function computeNextIntervalRun(
  row: AutomationScheduleRow,
  fromDate: Date,
  stepMonths: number
): Date | null {
  if (!row.scheduleStartDate || !row.scheduleDayOfMonth) return null;
  const timezone = row.timezone || 'UTC';
  const anchor = parseAnchorParts(row.scheduleStartDate);
  let cursor = new Date(anchor.year, anchor.month - 1, 1);

  for (let i = 0; i < 120; i++) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;
    const maxDay = getDaysInMonth(cursor);
    const day = Math.min(row.scheduleDayOfMonth, maxDay);
    const candidate = automationRunInstant(year, month, day, row.scheduleTime, timezone);
    if (candidate > fromDate) return candidate;
    cursor = addMonths(cursor, stepMonths);
  }

  return null;
}

export function computeAutomationNextRun(row: AutomationScheduleRow, fromDate = new Date()): Date | null {
  if (!row.enabled) return null;

  const timezone = row.timezone || 'UTC';
  const zonedNow = toZonedTime(fromDate, timezone);

  if (row.scheduleFrequency === 'once') {
    if (!row.scheduleStartDate) return null;
    const anchor = parseAnchorParts(row.scheduleStartDate);
    const runAt = automationRunInstant(
      anchor.year,
      anchor.month,
      anchor.day,
      row.scheduleTime,
      timezone
    );
    return runAt > fromDate ? runAt : null;
  }

  if (row.scheduleFrequency === 'quarterly') {
    return computeNextIntervalRun(row, fromDate, 3);
  }

  if (row.scheduleFrequency === 'semiannual') {
    return computeNextIntervalRun(row, fromDate, 6);
  }

  const searchDays = row.scheduleFrequency === 'weekly' ? 370 : 400;

  for (let offset = 0; offset < searchDays; offset++) {
    const zonedDay = addDays(zonedNow, offset);
    const jsDay = zonedDay.getDay();

    let matches = false;
    switch (row.scheduleFrequency) {
      case 'daily':
        matches = true;
        break;
      case 'weekly':
        matches = row.scheduleDays.includes(jsDay);
        break;
      case 'monthly':
        matches = dayOfMonthMatches(zonedDay, row.scheduleDayOfMonth ?? 1);
        break;
      case 'yearly':
        matches =
          zonedDay.getMonth() + 1 === (row.scheduleMonth ?? 1) &&
          dayOfMonthMatches(zonedDay, row.scheduleDayOfMonth ?? 1);
        break;
      default:
        matches = false;
    }

    if (!matches) continue;

    const candidate = atScheduleTimeOnZonedDay(zonedDay, row.scheduleTime, timezone);
    if (candidate > fromDate) return candidate;
  }

  return null;
}

export function automationScheduleRowFromRecord(row: {
  enabled: boolean;
  scheduleFrequency?: string | null;
  scheduleTime: string;
  scheduleDays: unknown;
  scheduleDayOfMonth?: number | null;
  scheduleMonth?: number | null;
  scheduleStartDate?: string | null;
  timezone: string;
}): AutomationScheduleRow {
  return {
    enabled: row.enabled,
    scheduleFrequency: normalizeScheduleFrequency(row.scheduleFrequency),
    scheduleTime: row.scheduleTime,
    scheduleDays: Array.isArray(row.scheduleDays)
      ? row.scheduleDays.filter((item): item is number => typeof item === 'number')
      : [],
    scheduleDayOfMonth: row.scheduleDayOfMonth ?? null,
    scheduleMonth: row.scheduleMonth ?? null,
    scheduleStartDate: row.scheduleStartDate ?? null,
    timezone: row.timezone,
  };
}
