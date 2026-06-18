import {
  getClusterChartStyle,
  resolveCostTrendBuckets,
  previousPeriodBuckets,
  type DayBucket,
} from './cost-savings-trend-data';

export { getClusterChartStyle, resolveCostTrendBuckets, previousPeriodBuckets };
export type { DayBucket };

export type NodeCountMetric = 'average' | 'max';

export type NodeCountStopPhase = 'before-stop' | 'after-stop';

export interface NodeCountStopSeries {
  id: NodeCountStopPhase;
  label: string;
  data: number[];
  total: number;
}

export interface NodeCountTrendResponse {
  labels: string[];
  dates: string[];
  days: number;
  metric: NodeCountMetric;
  isTodayLive: boolean;
  cluster: string;
  availableClusters: string[];
  series: NodeCountStopSeries[];
  summary: {
    todayBefore: number;
    todayAfter: number;
    periodBefore: number;
    periodAfter: number;
    priorBeforeDelta: number;
    priorAfterDelta: number;
  };
}

export interface NodeCountTrendQuery {
  days?: number;
  from?: string;
  to?: string;
  metric?: NodeCountMetric;
  cluster?: string;
}

export const EMPTY_NODE_COUNT_TREND: NodeCountTrendResponse = {
  labels: [],
  dates: [],
  days: 0,
  metric: 'average',
  isTodayLive: false,
  cluster: '',
  availableClusters: [],
  series: [],
  summary: {
    todayBefore: 0,
    todayAfter: 0,
    periodBefore: 0,
    periodAfter: 0,
    priorBeforeDelta: 0,
    priorAfterDelta: 0,
  },
};

export const NODE_COUNT_TREND_PLACEHOLDER = EMPTY_NODE_COUNT_TREND;

export function formatNodeCount(value: number): string {
  return String(Math.round(value));
}

export function nodeCountMetricLabel(metric: NodeCountMetric): string {
  return metric === 'max' ? 'Max node count' : 'Average node count';
}

export const BEFORE_STOP_STYLE = {
  color: '#534AB7',
  fill: 'rgba(83,74,183,0.08)',
  barBg: 'rgba(83,74,183,0.75)',
} as const;

export const AFTER_STOP_STYLE = {
  color: '#d97706',
  fill: 'rgba(217,119,6,0.08)',
  barBg: 'rgba(217,119,6,0.75)',
} as const;
