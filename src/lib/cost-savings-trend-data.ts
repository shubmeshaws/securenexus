import { addDays, differenceInCalendarDays, endOfDay, format, startOfDay, subDays } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { COST_CALENDAR_TZ } from './cost-calendar';

export interface CostSavingsClusterSeries {
  id: string;
  data: number[];
  total: number;
}

export interface CostSavingsTrendResponse {
  labels: string[];
  dates: string[];
  days: number;
  clusters: CostSavingsClusterSeries[];
  summary: {
    today: number;
    thisMonth: number;
    lastMonthDelta: number;
  };
}

export interface CostTrendQuery {
  days?: number;
  from?: string;
  to?: string;
}

export interface DayBucket {
  label: string;
  date: string;
  start: Date;
  end: Date;
}

const CHART_PALETTE = [
  { color: '#534AB7', fill: 'rgba(83,74,183,0.08)', barBg: 'rgba(83,74,183,0.7)', dashed: false },
  { color: '#1D9E75', fill: 'rgba(29,158,117,0.07)', barBg: 'rgba(29,158,117,0.7)', dashed: true },
  { color: '#2563eb', fill: 'rgba(37,99,235,0.08)', barBg: 'rgba(37,99,235,0.7)', dashed: false },
  { color: '#d97706', fill: 'rgba(217,119,6,0.08)', barBg: 'rgba(217,119,6,0.7)', dashed: true },
  { color: '#7c3aed', fill: 'rgba(124,58,237,0.08)', barBg: 'rgba(124,58,237,0.7)', dashed: false },
  { color: '#0891b2', fill: 'rgba(8,145,178,0.08)', barBg: 'rgba(8,145,178,0.7)', dashed: true },
] as const;

/** @deprecated use getClusterChartStyle */
export const CLUSTER_CHART_COLORS: Record<
  string,
  { color: string; fill: string; barBg: string; dashed?: boolean }
> = {
  'dr-eks-cluster': CHART_PALETTE[0],
  'dev-eks-cluster': CHART_PALETTE[1],
};

export function getClusterChartStyle(clusterId: string) {
  if (CLUSTER_CHART_COLORS[clusterId]) return CLUSTER_CHART_COLORS[clusterId];
  let hash = 0;
  for (let i = 0; i < clusterId.length; i++) {
    hash = (hash + clusterId.charCodeAt(i) * (i + 1)) % CHART_PALETTE.length;
  }
  return CHART_PALETTE[hash];
}

function dayBounds(day: Date, tz: string): { start: Date; end: Date } {
  const zoned = toZonedTime(day, tz);
  return {
    start: fromZonedTime(startOfDay(zoned), tz),
    end: fromZonedTime(endOfDay(zoned), tz),
  };
}

export function resolveCostTrendBuckets(query: CostTrendQuery = {}): DayBucket[] {
  const tz = COST_CALENDAR_TZ;
  const now = new Date();

  if (query.from && query.to) {
    const fromDay = toZonedTime(new Date(`${query.from}T12:00:00`), tz);
    const toDay = toZonedTime(new Date(`${query.to}T12:00:00`), tz);
    const dayCount = Math.max(1, differenceInCalendarDays(toDay, fromDay) + 1);
    const buckets: DayBucket[] = [];
    for (let i = 0; i < dayCount; i++) {
      const day = addDays(fromDay, i);
      const bounds = dayBounds(day, tz);
      buckets.push({
        label: format(day, 'MMM d'),
        date: format(day, 'yyyy-MM-dd'),
        ...bounds,
      });
    }
    return buckets;
  }

  const days = Math.min(Math.max(query.days ?? 14, 1), 90);
  const zonedEnd = toZonedTime(now, tz);
  return Array.from({ length: days }, (_, index) => {
    const offset = days - 1 - index;
    const day = subDays(zonedEnd, offset);
    const bounds = dayBounds(day, tz);
    return {
      label: format(day, 'MMM d'),
      date: format(day, 'yyyy-MM-dd'),
      ...bounds,
    };
  });
}

export function previousPeriodBuckets(buckets: DayBucket[]): DayBucket[] {
  if (!buckets.length) return [];
  const tz = COST_CALENDAR_TZ;
  const firstDay = toZonedTime(buckets[0].start, tz);
  const count = buckets.length;
  return Array.from({ length: count }, (_, index) => {
    const day = subDays(firstDay, count - index);
    const bounds = dayBounds(day, tz);
    return {
      label: format(day, 'MMM d'),
      date: format(day, 'yyyy-MM-dd'),
      ...bounds,
    };
  });
}

export const EMPTY_COST_SAVINGS_TREND: CostSavingsTrendResponse = {
  labels: [],
  dates: [],
  days: 0,
  clusters: [],
  summary: {
    today: 0,
    thisMonth: 0,
    lastMonthDelta: 0,
  },
};

export const COST_SAVINGS_TREND_PLACEHOLDER = EMPTY_COST_SAVINGS_TREND;
