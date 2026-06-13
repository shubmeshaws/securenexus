import { endOfDay, endOfMonth, startOfDay, startOfMonth } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

export const COST_CALENDAR_TZ = process.env.COST_CALENDAR_TZ || 'UTC';

export interface StoppedInterval {
  cluster: string;
  namespace: string;
  start: Date;
  end: Date;
}

export interface ActivityLogSlice {
  action: string;
  cluster: string;
  namespace: string;
  timestamp: Date;
}

/** Calendar day: 12:00 AM – 11:59:59 PM in COST_CALENDAR_TZ. Resets at midnight. */
export function getCalendarDayBounds(now: Date, tz = COST_CALENDAR_TZ): { start: Date; end: Date } {
  const zoned = toZonedTime(now, tz);
  return {
    start: fromZonedTime(startOfDay(zoned), tz),
    end: fromZonedTime(endOfDay(zoned), tz),
  };
}

/** Calendar month: 1st 12:00 AM – last day 11:59:59 PM in COST_CALENDAR_TZ. */
export function getCalendarMonthBounds(now: Date, tz = COST_CALENDAR_TZ): { start: Date; end: Date } {
  const zoned = toZonedTime(now, tz);
  return {
    start: fromZonedTime(startOfMonth(zoned), tz),
    end: fromZonedTime(endOfMonth(zoned), tz),
  };
}

function clipIntervalMs(
  intervalStart: Date,
  intervalEnd: Date,
  rangeStart: Date,
  rangeEnd: Date,
  now: Date
): number {
  const effectiveEnd = Math.min(intervalEnd.getTime(), rangeEnd.getTime(), now.getTime());
  const effectiveStart = Math.max(intervalStart.getTime(), rangeStart.getTime());
  return Math.max(0, effectiveEnd - effectiveStart);
}

export function buildStoppedIntervals(
  logs: ActivityLogSlice[],
  now: Date
): StoppedInterval[] {
  const open = new Map<string, Date>();
  const intervals: StoppedInterval[] = [];

  for (const log of logs) {
    const key = `${log.cluster}::${log.namespace}`;
    if (log.action === 'schedule-shutdown') {
      open.set(key, log.timestamp);
    } else if (log.action === 'schedule-startup') {
      const started = open.get(key);
      if (started) {
        const sep = key.indexOf('::');
        intervals.push({
          cluster: key.slice(0, sep),
          namespace: key.slice(sep + 2),
          start: started,
          end: log.timestamp,
        });
        open.delete(key);
      }
    }
  }

  for (const [key, started] of Array.from(open.entries())) {
    const sep = key.indexOf('::');
    intervals.push({
      cluster: key.slice(0, sep),
      namespace: key.slice(sep + 2),
      start: started,
      end: now,
    });
  }

  return intervals;
}

export function sumStoppedMsInRange(
  intervals: StoppedInterval[],
  rangeStart: Date,
  rangeEnd: Date,
  now: Date
): Map<string, number> {
  const totals = new Map<string, number>();

  for (const interval of intervals) {
    const ms = clipIntervalMs(interval.start, interval.end, rangeStart, rangeEnd, now);
    if (ms <= 0) continue;
    const key = `${interval.cluster}::${interval.namespace}`;
    totals.set(key, (totals.get(key) ?? 0) + ms);
  }

  return totals;
}

export function sumStoppedMsTotal(intervals: StoppedInterval[], now: Date): Map<string, number> {
  const totals = new Map<string, number>();
  for (const interval of intervals) {
    const ms = Math.max(0, Math.min(interval.end.getTime(), now.getTime()) - interval.start.getTime());
    if (ms <= 0) continue;
    const key = `${interval.cluster}::${interval.namespace}`;
    totals.set(key, (totals.get(key) ?? 0) + ms);
  }
  return totals;
}

export function msToHours(ms: number): number {
  return Math.round((ms / 3_600_000) * 100) / 100;
}
