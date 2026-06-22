import { resolveCostTrendBuckets, type CostTrendQuery } from './cost-savings-trend-data';

export type DashboardDatePreset = '7' | '14' | '30' | 'custom';

export interface DashboardDateRange {
  preset: DashboardDatePreset;
  customFrom: string;
  customTo: string;
}

export type DashboardDateQuery = CostTrendQuery;

export const DEFAULT_DASHBOARD_DAYS = 7;

export const DEFAULT_DASHBOARD_DATE_RANGE: DashboardDateRange = {
  preset: '7',
  customFrom: '',
  customTo: '',
};

const DASHBOARD_SELECT_CHEVRON =
  "bg-[length:0.75rem] bg-[position:right_0.625rem_center] bg-no-repeat [background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]";

const DASHBOARD_FILTER_BASE =
  'h-8 min-w-0 rounded-lg border border-border bg-background text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/30';

export const DASHBOARD_FILTER_INPUT_CLASS = `${DASHBOARD_FILTER_BASE} px-2.5`;

export const DASHBOARD_DATE_SELECT_CLASS = [
  DASHBOARD_FILTER_BASE,
  'w-auto appearance-none pl-2.5 pr-7',
  DASHBOARD_SELECT_CHEVRON,
].join(' ');

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
  return { days: range.preset === 'custom' ? DEFAULT_DASHBOARD_DAYS : Number(range.preset) };
}

export function buildDashboardDateQueryString(range: DashboardDateRange): string {
  const query = dashboardDateRangeToQuery(range);
  if (query.from && query.to) {
    return `from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}`;
  }
  return `days=${query.days ?? DEFAULT_DASHBOARD_DAYS}`;
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
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : DEFAULT_DASHBOARD_DAYS;
  return { days };
}

export function resolveDashboardRangeBounds(query: DashboardDateQuery = { days: DEFAULT_DASHBOARD_DAYS }): {
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
