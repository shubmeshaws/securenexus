import { resolveCostTrendBuckets, type CostTrendQuery } from './cost-savings-trend-data';

export type DashboardDatePreset = '7' | '14' | '30' | 'custom';

export interface DashboardDateRange {
  preset: DashboardDatePreset;
  customFrom: string;
  customTo: string;
}

export type DashboardDateQuery = CostTrendQuery;

export const DEFAULT_DASHBOARD_DATE_RANGE: DashboardDateRange = {
  preset: '14',
  customFrom: '',
  customTo: '',
};

export const DASHBOARD_DATE_SELECT_CLASS =
  'h-8 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/30';

export function isDashboardDateRangeReady(range: DashboardDateRange): boolean {
  if (range.preset !== 'custom') return true;
  return Boolean(range.customFrom && range.customTo);
}

export function getDashboardPeriodLabel(range: DashboardDateRange): string {
  if (range.preset === 'custom' && range.customFrom && range.customTo) {
    return `${range.customFrom} → ${range.customTo}`;
  }
  if (range.preset === 'custom') return 'Custom range';
  return `Last ${range.preset} days`;
}

export function dashboardDateRangeToQuery(range: DashboardDateRange): DashboardDateQuery {
  if (range.preset === 'custom' && range.customFrom && range.customTo) {
    return { from: range.customFrom, to: range.customTo };
  }
  return { days: range.preset === 'custom' ? 14 : Number(range.preset) };
}

export function buildDashboardDateQueryString(range: DashboardDateRange): string {
  const query = dashboardDateRangeToQuery(range);
  if (query.from && query.to) {
    return `from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}`;
  }
  return `days=${query.days ?? 14}`;
}

export function appendDashboardDateQuery(basePath: string, range: DashboardDateRange): string {
  const qs = buildDashboardDateQueryString(range);
  const sep = basePath.includes('?') ? '&' : '?';
  return `${basePath}${sep}${qs}`;
}

export function parseDashboardDateQuery(query: {
  days?: string | string[];
  from?: string | string[];
  to?: string | string[];
}): DashboardDateQuery {
  const from = typeof query.from === 'string' ? query.from : undefined;
  const to = typeof query.to === 'string' ? query.to : undefined;
  if (from && to) {
    return { from, to };
  }
  const daysRaw = typeof query.days === 'string' ? Number(query.days) : NaN;
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 14;
  return { days };
}

export function resolveDashboardRangeBounds(query: DashboardDateQuery = { days: 14 }): {
  rangeStart: Date;
  rangeEnd: Date;
  days: number;
} {
  const buckets = resolveCostTrendBuckets(query);
  if (!buckets.length) {
    const now = new Date();
    return { rangeStart: now, rangeEnd: now, days: 0 };
  }
  return {
    rangeStart: buckets[0].start,
    rangeEnd: buckets[buckets.length - 1].end,
    days: buckets.length,
  };
}
