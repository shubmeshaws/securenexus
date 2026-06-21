import type { DashboardDateQuery } from './dashboard-date-range';

export type NodeCountInterval = '15m' | '1h' | '1d';

export type NodePodSeriesId = 'nodes' | 'pods';

export interface NodePodTrendSeries {
  id: NodePodSeriesId;
  label: string;
  data: (number | null)[];
}

export interface NodeCountTrendResponse {
  labels: string[];
  bucketKeys: string[];
  days: number;
  interval: NodeCountInterval;
  isTodayLive: boolean;
  hasSamples: boolean;
  cluster: string;
  availableClusters: string[];
  calendarDate: string;
  previousDate: string | null;
  nextDate: string | null;
  retentionDays: number;
  totalDaysInRange: number;
  captureStartDate: string | null;
  captureStartHour: number | null;
  series: NodePodTrendSeries[];
}

export interface NodeCountTrendQuery extends DashboardDateQuery {
  cluster?: string;
  date?: string;
}

export const EMPTY_NODE_COUNT_TREND: NodeCountTrendResponse = {
  labels: [],
  bucketKeys: [],
  days: 0,
  interval: '1h',
  isTodayLive: false,
  hasSamples: false,
  cluster: '',
  availableClusters: [],
  calendarDate: '',
  previousDate: null,
  nextDate: null,
  retentionDays: 0,
  totalDaysInRange: 0,
  captureStartDate: null,
  captureStartHour: null,
  series: [],
};

export const NODE_COUNT_TREND_PLACEHOLDER = EMPTY_NODE_COUNT_TREND;

export function formatNodeCount(value: number): string {
  return String(Math.round(value));
}

export function nodeCountIntervalLabel(interval: NodeCountInterval): string {
  if (interval === '15m') return '15-minute';
  if (interval === '1h') return 'Hourly';
  return 'Daily';
}

export const NODES_SERIES_STYLE = {
  color: '#534AB7',
  fill: 'rgba(83,74,183,0.08)',
  barBg: 'rgba(83,74,183,0.75)',
} as const;

export const PODS_SERIES_STYLE = {
  color: '#059669',
  fill: 'rgba(5,150,105,0.08)',
  barBg: 'rgba(5,150,105,0.75)',
} as const;

/** @deprecated kept for any legacy imports */
export const BEFORE_STOP_STYLE = NODES_SERIES_STYLE;
/** @deprecated kept for any legacy imports */
export const AFTER_STOP_STYLE = PODS_SERIES_STYLE;

export function parseNodeCountInterval(raw: string | undefined): NodeCountInterval {
  if (raw === '1h' || raw === '1d') return raw;
  return '15m';
}
