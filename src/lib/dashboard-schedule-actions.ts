import { addDays, differenceInCalendarDays, endOfDay, format, startOfDay, subDays } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import prisma from './prisma';
import { COST_CALENDAR_TZ } from './cost-calendar';

export const SHUTDOWN_ACTIONS = ['schedule-shutdown', 'infra-shutdown', 'scale-down'] as const;
export const STARTUP_ACTIONS = ['schedule-startup', 'infra-startup', 'scale-up'] as const;

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DEMO_SHUTDOWN_PATTERN = [4, 3, 5, 4, 6, 2, 1];
const DEMO_STARTUP_PATTERN = [4, 3, 5, 4, 6, 2, 1];

export interface ScheduleActionsChartResponse {
  labels: string[];
  dates: string[];
  days: number;
  shutdowns: number[];
  startups: number[];
  summary: {
    total: number;
    shutdowns: number;
    startups: number;
  };
}

export interface ScheduleActionsQuery {
  days?: number;
  from?: string;
  to?: string;
}

interface DayBucket {
  label: string;
  date: string;
  start: Date;
  end: Date;
}

function dayBounds(day: Date, tz: string): { start: Date; end: Date } {
  const zoned = toZonedTime(day, tz);
  return {
    start: fromZonedTime(startOfDay(zoned), tz),
    end: fromZonedTime(endOfDay(zoned), tz),
  };
}

function labelForDay(day: Date, dayCount: number): string {
  return dayCount <= 7 ? WEEKDAY_SHORT[day.getDay()] : format(day, 'MMM d');
}

function resolveActionBuckets(query: ScheduleActionsQuery = {}): { days: number; buckets: DayBucket[] } {
  const tz = COST_CALENDAR_TZ;
  const now = new Date();

  if (query.from && query.to) {
    const fromDay = toZonedTime(new Date(`${query.from}T12:00:00`), tz);
    const toDay = toZonedTime(new Date(`${query.to}T12:00:00`), tz);
    const dayCount = Math.max(1, differenceInCalendarDays(toDay, fromDay) + 1);
    const buckets: DayBucket[] = [];
    for (let i = 0; i < dayCount; i++) {
      const day = addDays(fromDay, i);
      const { start, end } = dayBounds(day, tz);
      buckets.push({
        label: labelForDay(day, dayCount),
        date: format(day, 'yyyy-MM-dd'),
        start,
        end,
      });
    }
    return { days: dayCount, buckets };
  }

  const days = Math.min(Math.max(query.days ?? 14, 1), 90);
  const zonedEnd = toZonedTime(now, tz);
  const buckets = Array.from({ length: days }, (_, index) => {
    const offset = days - 1 - index;
    const day = subDays(zonedEnd, offset);
    const { start, end } = dayBounds(day, tz);
    return {
      label: labelForDay(day, days),
      date: format(day, 'yyyy-MM-dd'),
      start,
      end,
    };
  });
  return { days, buckets };
}

function demoSeries(pattern: number[], length: number): number[] {
  return Array.from({ length }, (_, i) => pattern[i % pattern.length]);
}

function buildResponseFromBuckets(
  buckets: DayBucket[],
  shutdowns: number[],
  startups: number[]
): ScheduleActionsChartResponse {
  const shutdownTotal = shutdowns.reduce((sum, n) => sum + n, 0);
  const startupTotal = startups.reduce((sum, n) => sum + n, 0);
  return {
    labels: buckets.map((b) => b.label),
    dates: buckets.map((b) => b.date),
    days: buckets.length,
    shutdowns,
    startups,
    summary: {
      total: shutdownTotal + startupTotal,
      shutdowns: shutdownTotal,
      startups: startupTotal,
    },
  };
}

export function getScheduleActionsPlaceholder(query: ScheduleActionsQuery = {}): ScheduleActionsChartResponse {
  const { buckets } = resolveActionBuckets(query);
  return buildResponseFromBuckets(
    buckets,
    demoSeries(DEMO_SHUTDOWN_PATTERN, buckets.length),
    demoSeries(DEMO_STARTUP_PATTERN, buckets.length)
  );
}

export async function getScheduleActionsChartData(
  query: ScheduleActionsQuery = {}
): Promise<ScheduleActionsChartResponse> {
  const { buckets } = resolveActionBuckets(query);
  const rangeStart = buckets[0].start;
  const rangeEnd = buckets[buckets.length - 1].end;

  const logs = await prisma.activityLog.findMany({
    where: {
      status: 'success',
      timestamp: { gte: rangeStart, lte: rangeEnd },
      action: { in: [...SHUTDOWN_ACTIONS, ...STARTUP_ACTIONS] },
    },
    select: { action: true, timestamp: true },
  });

  const shutdowns = buckets.map(() => 0);
  const startups = buckets.map(() => 0);

  for (const log of logs) {
    const idx = buckets.findIndex((b) => log.timestamp >= b.start && log.timestamp <= b.end);
    if (idx < 0) continue;
    if ((SHUTDOWN_ACTIONS as readonly string[]).includes(log.action)) {
      shutdowns[idx] += 1;
    } else if ((STARTUP_ACTIONS as readonly string[]).includes(log.action)) {
      startups[idx] += 1;
    }
  }

  return buildResponseFromBuckets(buckets, shutdowns, startups);
}

export const SCHEDULE_ACTIONS_PLACEHOLDER = getScheduleActionsPlaceholder({ days: 14 });
