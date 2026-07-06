import type { DashboardDateQuery } from './dashboard-date-range';

export type NodePodSeriesId = 'nodes' | 'pods';

export interface DayTrendSeries {
  date: string;
  label: string;
  data: (number | null)[];
  latest: number | null;
}

export interface NodeCountTrendResponse {
  /** Hourly x-axis labels (12:00 AM … 11:00 PM) */
  labels: string[];
  days: number;
  periodLabel: string;
  cluster: string;
  availableClusters: string[];
  hasSamples: boolean;
  hourlyByDay: Record<NodePodSeriesId, DayTrendSeries[]>;
}

export interface NodeCountTrendQuery extends DashboardDateQuery {
  cluster?: string;
}

export const MAX_NODE_COUNT_TREND_DAYS = 30;

export const EMPTY_NODE_COUNT_TREND: NodeCountTrendResponse = {
  labels: [],
  days: 0,
  periodLabel: '',
  cluster: '',
  availableClusters: [],
  hasSamples: false,
  hourlyByDay: {
    nodes: [],
    pods: [],
  },
};

export const NODE_COUNT_TREND_PLACEHOLDER = EMPTY_NODE_COUNT_TREND;

export function formatNodeCount(value: number): string {
  return String(Math.round(value));
}

export function latestNonNullValue(data: (number | null)[]): number | null {
  for (let i = data.length - 1; i >= 0; i--) {
    const value = data[i];
    if (value != null) return value;
  }
  return null;
}

export const YESTERDAY_SERIES_STYLE = {
  color: '#6366F1',
  fillTop: 'rgba(99, 102, 241, 0.32)',
  fillBottom: 'rgba(99, 102, 241, 0.02)',
  barBg: 'rgba(99, 102, 241, 0.75)',
} as const;

export const TODAY_SERIES_STYLE = {
  color: '#22C55E',
  fillTop: 'rgba(34, 197, 94, 0.32)',
  fillBottom: 'rgba(34, 197, 94, 0.02)',
  barBg: 'rgba(34, 197, 94, 0.75)',
} as const;

/** Muted palette for days older than yesterday */
export const OLDER_DAY_LINE_COLORS = [
  '#94a3b8',
  '#a78bfa',
  '#f472b6',
  '#fb923c',
  '#38bdf8',
  '#e879f9',
  '#4ade80',
  '#facc15',
  '#f87171',
  '#2dd4bf',
  '#c084fc',
  '#60a5fa',
  '#fbbf24',
  '#34d399',
  '#f97316',
  '#818cf8',
  '#fb7185',
  '#22d3ee',
  '#a3e635',
  '#e11d48',
  '#0ea5e9',
  '#d946ef',
  '#84cc16',
  '#06b6d4',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#eab308',
] as const;

export function dayTrendLineStyle(index: number, total: number) {
  if (index === total - 1) return TODAY_SERIES_STYLE;
  if (index === total - 2) return YESTERDAY_SERIES_STYLE;
  const color = OLDER_DAY_LINE_COLORS[index % OLDER_DAY_LINE_COLORS.length];
  return {
    color,
    fillTop: `${color}33`,
    fillBottom: `${color}05`,
    barBg: `${color}BF`,
  };
}

export function dayTrendShouldFill(index: number, total: number): boolean {
  return index >= total - 2;
}

export function colorWithAlpha(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    const hex = color.length === 4
      ? color
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : color.slice(1);
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

export type DayTrendHighlight = 'default' | 'emphasized' | 'muted';

export function resolveDayTrendHighlight(
  date: string,
  selectedDates: ReadonlySet<string>,
  selectionEnabled: boolean
): DayTrendHighlight {
  if (!selectionEnabled || selectedDates.size === 0) return 'default';
  return selectedDates.has(date) ? 'emphasized' : 'muted';
}

/** @deprecated */
export const NODES_SERIES_STYLE = YESTERDAY_SERIES_STYLE;
/** @deprecated */
export const PODS_SERIES_STYLE = TODAY_SERIES_STYLE;
/** @deprecated */
export const SERIES_STYLE = YESTERDAY_SERIES_STYLE;
