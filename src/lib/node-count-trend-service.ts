import { subDays } from 'date-fns';
import { SHUTDOWN_ACTIONS } from './dashboard-schedule-actions';
import { isEksShutdownLog } from './shutdown-node-count';
import {
  previousPeriodBuckets,
  resolveCostTrendBuckets,
  type DayBucket,
  type NodeCountMetric,
  type NodeCountStopSeries,
  type NodeCountTrendQuery,
  type NodeCountTrendResponse,
} from './node-count-trend-data';
import {
  getCalendarDateAndHour,
  listRegisteredClusterNames,
  sampleRegisteredClusters,
} from './node-count-sampler';
import prisma from './prisma';

const CACHE_TTL_MS = 30_000;
let trendCache: { key: string; at: number; data: NodeCountTrendResponse } | null = null;

interface HourlySampleRow {
  clusterName: string;
  calendarDate: string;
  hour: number;
  nodeCount: number;
  sampledAt: Date;
}

interface ShutdownLogRow {
  cluster: string;
  timestamp: Date;
  details: string | null;
}

interface HourlyPoint {
  nodeCount: number;
  sampledAt: Date;
}

function roundNodeCount(value: number): number {
  return Math.round(value);
}

function aggregateValues(values: number[], metric: NodeCountMetric): number {
  if (!values.length) return 0;
  if (metric === 'max') return Math.max(...values);
  return roundNodeCount(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function aggregatePeriod(values: number[], metric: NodeCountMetric): number {
  return aggregateValues(values.filter((value) => value > 0), metric);
}

function clusterMatches(logCluster: string, selectedCluster: string): boolean {
  return logCluster === selectedCluster || logCluster.endsWith(`/${selectedCluster}`);
}

function buildHourlyIndex(
  samples: HourlySampleRow[]
): Map<string, Map<string, HourlyPoint[]>> {
  const index = new Map<string, Map<string, HourlyPoint[]>>();
  for (const row of samples) {
    if (!index.has(row.clusterName)) index.set(row.clusterName, new Map());
    const byDate = index.get(row.clusterName)!;
    if (!byDate.has(row.calendarDate)) byDate.set(row.calendarDate, []);
    byDate.get(row.calendarDate)!.push({
      nodeCount: row.nodeCount,
      sampledAt: row.sampledAt,
    });
  }
  for (const byDate of Array.from(index.values())) {
    for (const points of Array.from(byDate.values())) {
      points.sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime());
    }
  }
  return index;
}

function firstShutdownOnDay(
  logs: ShutdownLogRow[],
  clusterName: string,
  calendarDate: string
): Date | null {
  const matches = logs
    .filter((log) => {
      if (!clusterMatches(log.cluster, clusterName)) return false;
      if (!isEksShutdownLog(log.details)) return false;
      const { date } = getCalendarDateAndHour(log.timestamp);
      return date === calendarDate;
    })
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return matches[0]?.timestamp ?? null;
}

function splitBeforeAfter(
  points: HourlyPoint[],
  shutdownAt: Date | null,
  metric: NodeCountMetric
): { before: number; after: number } {
  if (!points.length) return { before: 0, after: 0 };
  if (!shutdownAt) {
    return {
      before: aggregateValues(
        points.map((point) => point.nodeCount),
        metric
      ),
      after: 0,
    };
  }
  const beforeValues = points
    .filter((point) => point.sampledAt < shutdownAt)
    .map((point) => point.nodeCount);
  const afterValues = points
    .filter((point) => point.sampledAt >= shutdownAt)
    .map((point) => point.nodeCount);
  return {
    before: aggregateValues(beforeValues, metric),
    after: aggregateValues(afterValues, metric),
  };
}

function dailyBeforeAfterForCluster(
  clusterName: string,
  buckets: DayBucket[],
  hourlyIndex: Map<string, Map<string, HourlyPoint[]>>,
  shutdownLogs: ShutdownLogRow[],
  metric: NodeCountMetric
): { before: number[]; after: number[] } {
  const byDate = hourlyIndex.get(clusterName);
  const before: number[] = [];
  const after: number[] = [];

  for (const bucket of buckets) {
    const points = byDate?.get(bucket.date) ?? [];
    const shutdownAt = firstShutdownOnDay(shutdownLogs, clusterName, bucket.date);
    const split = splitBeforeAfter(points, shutdownAt, metric);
    before.push(split.before);
    after.push(split.after);
  }

  return { before, after };
}

function emptyResponse(
  metric: NodeCountMetric,
  cluster: string,
  availableClusters: string[]
): NodeCountTrendResponse {
  return {
    labels: [],
    dates: [],
    days: 0,
    metric,
    isTodayLive: false,
    cluster,
    availableClusters,
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
}

function buildResponse(
  buckets: DayBucket[],
  clusterName: string,
  availableClusters: string[],
  before: number[],
  after: number[],
  metric: NodeCountMetric,
  previousBefore: number,
  previousAfter: number,
  todayDate: string
): NodeCountTrendResponse {
  const series: NodeCountStopSeries[] = [
    {
      id: 'before-stop',
      label: 'Before stop',
      data: before,
      total: aggregatePeriod(before, metric),
    },
    {
      id: 'after-stop',
      label: 'After stop',
      data: after,
      total: aggregatePeriod(after, metric),
    },
  ];

  const todayBefore = before.at(-1) ?? 0;
  const todayAfter = after.at(-1) ?? 0;

  return {
    labels: buckets.map((bucket) => bucket.label),
    dates: buckets.map((bucket) => bucket.date),
    days: buckets.length,
    metric,
    isTodayLive: buckets.at(-1)?.date === todayDate,
    cluster: clusterName,
    availableClusters,
    series,
    summary: {
      todayBefore,
      todayAfter,
      periodBefore: series[0].total,
      periodAfter: series[1].total,
      priorBeforeDelta: roundNodeCount(series[0].total - previousBefore),
      priorAfterDelta: roundNodeCount(series[1].total - previousAfter),
    },
  };
}

function cacheKey(query: NodeCountTrendQuery): string {
  return JSON.stringify(query);
}

async function fetchShutdownLogs(since: Date, until: Date): Promise<ShutdownLogRow[]> {
  return prisma.activityLog.findMany({
    where: {
      action: { in: [...SHUTDOWN_ACTIONS] },
      status: 'success',
      timestamp: { gte: since, lte: until },
    },
    orderBy: { timestamp: 'asc' },
    take: 10_000,
    select: {
      cluster: true,
      timestamp: true,
      details: true,
    },
  });
}

export async function getNodeCountTrendData(
  query: NodeCountTrendQuery = {}
): Promise<NodeCountTrendResponse> {
  const metric: NodeCountMetric = query.metric === 'max' ? 'max' : 'average';
  const availableClusters = await listRegisteredClusterNames();
  const selectedCluster =
    query.cluster && availableClusters.includes(query.cluster)
      ? query.cluster
      : availableClusters[0] ?? '';

  const key = cacheKey({ ...query, metric, cluster: selectedCluster });

  if (trendCache && trendCache.key === key && Date.now() - trendCache.at < CACHE_TTL_MS) {
    return trendCache.data;
  }

  if (!availableClusters.length || !selectedCluster) {
    return emptyResponse(metric, '', availableClusters);
  }

  await sampleRegisteredClusters();

  const now = new Date();
  const { date: todayDate } = getCalendarDateAndHour(now);
  const buckets = resolveCostTrendBuckets(query);
  if (!buckets.length) {
    return emptyResponse(metric, selectedCluster, availableClusters);
  }

  const calendarDates = buckets.map((bucket) => bucket.date);
  const lookbackStart = subDays(buckets[0].start, 1);
  const rangeEnd = buckets[buckets.length - 1].end;

  const [samples, shutdownLogs] = await Promise.all([
    prisma.clusterNodeHourlySample.findMany({
      where: {
        clusterName: selectedCluster,
        calendarDate: { in: calendarDates },
      },
      select: {
        clusterName: true,
        calendarDate: true,
        hour: true,
        nodeCount: true,
        sampledAt: true,
      },
    }),
    fetchShutdownLogs(lookbackStart, rangeEnd),
  ]);

  const hourlyIndex = buildHourlyIndex(samples);
  const { before, after } = dailyBeforeAfterForCluster(
    selectedCluster,
    buckets,
    hourlyIndex,
    shutdownLogs,
    metric
  );

  const prevBuckets = previousPeriodBuckets(buckets);
  const prevDates = prevBuckets.map((bucket) => bucket.date);
  const prevSamples =
    prevDates.length > 0
      ? await prisma.clusterNodeHourlySample.findMany({
          where: {
            clusterName: selectedCluster,
            calendarDate: { in: prevDates },
          },
          select: {
            clusterName: true,
            calendarDate: true,
            hour: true,
            nodeCount: true,
            sampledAt: true,
          },
        })
      : [];
  const prevIndex = buildHourlyIndex(prevSamples);
  const prevRange = prevBuckets.length
    ? dailyBeforeAfterForCluster(
        selectedCluster,
        prevBuckets,
        prevIndex,
        shutdownLogs,
        metric
      )
    : { before: [], after: [] };

  const data = buildResponse(
    buckets,
    selectedCluster,
    availableClusters,
    before,
    after,
    metric,
    aggregatePeriod(prevRange.before, metric),
    aggregatePeriod(prevRange.after, metric),
    todayDate
  );
  trendCache = { key, at: Date.now(), data };
  return data;
}

export function invalidateNodeCountTrendCache(): void {
  trendCache = null;
}
