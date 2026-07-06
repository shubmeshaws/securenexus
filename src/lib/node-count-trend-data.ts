import type { DashboardDateQuery } from './dashboard-date-range';

export type NodePodSeriesId = 'nodes' | 'pods';

export interface NodeCountTrendSeriesSummary {
  latest: number | null;
  average: number | null;
}

export interface NodeCountTrendResponse {
  labels: string[];
  dates: string[];
  days: number;
  periodLabel: string;
  cluster: string;
  availableClusters: string[];
  hasSamples: boolean;
  series: Record<NodePodSeriesId, (number | null)[]>;
  summary: Record<NodePodSeriesId, NodeCountTrendSeriesSummary>;
}

export interface NodeCountTrendQuery extends DashboardDateQuery {
  cluster?: string;
}

export const MAX_NODE_COUNT_TREND_DAYS = 30;

export const EMPTY_NODE_COUNT_TREND: NodeCountTrendResponse = {
  labels: [],
  dates: [],
  days: 0,
  periodLabel: '',
  cluster: '',
  availableClusters: [],
  hasSamples: false,
  series: {
    nodes: [],
    pods: [],
  },
  summary: {
    nodes: { latest: null, average: null },
    pods: { latest: null, average: null },
  },
};

export const NODE_COUNT_TREND_PLACEHOLDER = EMPTY_NODE_COUNT_TREND;

export function formatNodeCount(value: number): string {
  return String(Math.round(value));
}

export function averageNonNull(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v != null);
  if (!nums.length) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

export function latestNonNullValue(data: (number | null)[]): number | null {
  for (let i = data.length - 1; i >= 0; i--) {
    const value = data[i];
    if (value != null) return value;
  }
  return null;
}

export const SERIES_STYLE = {
  color: '#6366F1',
  fillTop: 'rgba(99, 102, 241, 0.32)',
  fillBottom: 'rgba(99, 102, 241, 0.02)',
  barBg: 'rgba(99, 102, 241, 0.75)',
} as const;

/** @deprecated use SERIES_STYLE */
export const YESTERDAY_SERIES_STYLE = SERIES_STYLE;
/** @deprecated use SERIES_STYLE */
export const TODAY_SERIES_STYLE = {
  color: '#22C55E',
  fillTop: 'rgba(34, 197, 94, 0.32)',
  fillBottom: 'rgba(34, 197, 94, 0.02)',
  barBg: 'rgba(34, 197, 94, 0.75)',
} as const;
/** @deprecated */
export const NODES_SERIES_STYLE = SERIES_STYLE;
/** @deprecated */
export const PODS_SERIES_STYLE = TODAY_SERIES_STYLE;
