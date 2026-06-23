import type { DashboardDateQuery } from './dashboard-date-range';

export type NodePodSeriesId = 'nodes' | 'pods';

export interface DayTrendSeries {
  date: string;
  data: (number | null)[];
  latest: number | null;
}

export interface MetricDayComparison {
  today: DayTrendSeries;
  yesterday: DayTrendSeries;
}

export interface NodeCountTrendResponse {
  labels: string[];
  cluster: string;
  availableClusters: string[];
  hasSamples: boolean;
  comparison: Record<NodePodSeriesId, MetricDayComparison>;
}

export interface NodeCountTrendQuery extends DashboardDateQuery {
  cluster?: string;
}

export const EMPTY_NODE_COUNT_TREND: NodeCountTrendResponse = {
  labels: [],
  cluster: '',
  availableClusters: [],
  hasSamples: false,
  comparison: {
    nodes: {
      today: { date: '', data: [], latest: null },
      yesterday: { date: '', data: [], latest: null },
    },
    pods: {
      today: { date: '', data: [], latest: null },
      yesterday: { date: '', data: [], latest: null },
    },
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

/** @deprecated kept for any legacy imports */
export const NODES_SERIES_STYLE = YESTERDAY_SERIES_STYLE;
/** @deprecated kept for any legacy imports */
export const PODS_SERIES_STYLE = TODAY_SERIES_STYLE;
/** @deprecated kept for any legacy imports */
export const BEFORE_STOP_STYLE = YESTERDAY_SERIES_STYLE;
/** @deprecated kept for any legacy imports */
export const AFTER_STOP_STYLE = TODAY_SERIES_STYLE;
