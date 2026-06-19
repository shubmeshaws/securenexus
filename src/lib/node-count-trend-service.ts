import { max as maxDate, subDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { SHUTDOWN_ACTIONS, STARTUP_ACTIONS } from './dashboard-schedule-actions';
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
import { listRegisteredClusterNames, sampleRegisteredClusters } from './node-count-sampler';
import { getNodeSampleCaptureStartAt } from './node-sample-retention';
import { IST_TIMEZONE } from './utils';
import prisma from './prisma';

const CACHE_TTL_MS = 30_000;
let trendCache: { key: string; at: number; data: NodeCountTrendResponse } | null = null;

interface HourlySampleRow {
  nodeCount: number;
  sampledAt: Date;
}

interface ScheduleEventLogRow {
  cluster: string;
  timestamp: Date;
  details: string | null;
  action: string;
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

function istCalendarDate(sampledAt: Date): string {
  return formatInTimeZone(sampledAt, IST_TIMEZONE, 'yyyy-MM-dd');
}

function istDayBounds(calendarDate: string): { start: Date; end: Date } {
  return {
    start: fromZonedTime(`${calendarDate}T00:00:00`, IST_TIMEZONE),
    end: fromZonedTime(`${calendarDate}T23:59:59.999`, IST_TIMEZONE),
  };
}

function buildHourlyIndex(
  samples: HourlySampleRow[],
  calendarDates: Set<string>
): Map<string, HourlyPoint[]> {
  const index = new Map<string, HourlyPoint[]>();

  for (const row of samples) {
    const date = istCalendarDate(row.sampledAt);
    if (!calendarDates.has(date)) continue;

    if (!index.has(date)) index.set(date, []);
    index.get(date)!.push({
      nodeCount: row.nodeCount,
      sampledAt: row.sampledAt,
    });
  }

  for (const points of Array.from(index.values())) {
    points.sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime());
  }

  return index;
}

function isScheduleEventLog(details: string | null): boolean {
  return isEksShutdownLog(details);
}

function firstEventOnDay(
  logs: ScheduleEventLogRow[],
  clusterName: string,
  calendarDate: string,
  actions: readonly string[]
): Date | null {
  const matches = logs
    .filter((log) => {
      if (!clusterMatches(log.cluster, clusterName)) return false;
      if (!isScheduleEventLog(log.details)) return false;
      if (!actions.includes(log.action)) return false;
      return istCalendarDate(log.timestamp) === calendarDate;
    })
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return matches[0]?.timestamp ?? null;
}

function isBeforeStopSample(
  sampledAt: Date,
  startupAt: Date | null,
  shutdownAt: Date | null
): boolean {
  const t = sampledAt.getTime();

  if (startupAt && shutdownAt) {
    const startupMs = startupAt.getTime();
    const shutdownMs = shutdownAt.getTime();
    if (startupMs < shutdownMs) {
      return t >= startupMs && t < shutdownMs;
    }
    if (shutdownMs < startupMs) {
      return t >= startupMs;
    }
    return false;
  }

  if (startupAt) {
    return t >= startupAt.getTime();
  }

  if (shutdownAt) {
    return t < shutdownAt.getTime();
  }

  return true;
}

function splitBeforeAfter(
  points: HourlyPoint[],
  startupAt: Date | null,
  shutdownAt: Date | null,
  metric: NodeCountMetric
): { before: number; after: number } {
  if (!points.length) return { before: 0, after: 0 };

  const beforeValues: number[] = [];
  const afterValues: number[] = [];

  for (const point of points) {
    if (isBeforeStopSample(point.sampledAt, startupAt, shutdownAt)) {
      beforeValues.push(point.nodeCount);
    } else {
      afterValues.push(point.nodeCount);
    }
  }

  return {
    before: aggregateValues(beforeValues, metric),
    after: aggregateValues(afterValues, metric),
  };
}

function dailyBeforeAfterForCluster(
  clusterName: string,
  buckets: DayBucket[],
  hourlyIndex: Map<string, HourlyPoint[]>,
  scheduleLogs: ScheduleEventLogRow[],
  metric: NodeCountMetric
): { before: number[]; after: number[] } {
  const before: number[] = [];
  const after: number[] = [];

  for (const bucket of buckets) {
    const points = hourlyIndex.get(bucket.date) ?? [];
    const startupAt = firstEventOnDay(scheduleLogs, clusterName, bucket.date, STARTUP_ACTIONS);
    const shutdownAt = firstEventOnDay(scheduleLogs, clusterName, bucket.date, SHUTDOWN_ACTIONS);
    const split = splitBeforeAfter(points, startupAt, shutdownAt, metric);
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

async function fetchScheduleEventLogs(since: Date, until: Date): Promise<ScheduleEventLogRow[]> {
  return prisma.activityLog.findMany({
    where: {
      action: { in: [...SHUTDOWN_ACTIONS, ...STARTUP_ACTIONS] },
      status: 'success',
      timestamp: { gte: since, lte: until },
    },
    orderBy: { timestamp: 'asc' },
    take: 10_000,
    select: {
      cluster: true,
      timestamp: true,
      details: true,
      action: true,
    },
  });
}

async function fetchSamplesForRange(
  clusterName: string,
  startDate: string,
  endDate: string,
  captureStart: Date | null
): Promise<HourlySampleRow[]> {
  const { start: rangeStart } = istDayBounds(startDate);
  const { end: rangeEnd } = istDayBounds(endDate);
  const sampleStart = maxDate([rangeStart, captureStart ?? rangeStart]);

  return prisma.clusterNodeHourlySample.findMany({
    where: {
      clusterName,
      sampledAt: { gte: sampleStart, lte: rangeEnd },
    },
    orderBy: { sampledAt: 'asc' },
    select: {
      nodeCount: true,
      sampledAt: true,
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
  const todayDate = formatInTimeZone(now, IST_TIMEZONE, 'yyyy-MM-dd');
  const buckets = resolveCostTrendBuckets(query, IST_TIMEZONE);
  if (!buckets.length) {
    return emptyResponse(metric, selectedCluster, availableClusters);
  }

  const calendarDates = new Set(buckets.map((bucket) => bucket.date));
  const lookbackStart = subDays(buckets[0].start, 1);
  const rangeEnd = buckets[buckets.length - 1].end;
  const captureStart = await getNodeSampleCaptureStartAt();

  const [samples, scheduleLogs] = await Promise.all([
    fetchSamplesForRange(
      selectedCluster,
      buckets[0].date,
      buckets[buckets.length - 1].date,
      captureStart
    ),
    fetchScheduleEventLogs(lookbackStart, rangeEnd),
  ]);

  const hourlyIndex = buildHourlyIndex(samples, calendarDates);
  const { before, after } = dailyBeforeAfterForCluster(
    selectedCluster,
    buckets,
    hourlyIndex,
    scheduleLogs,
    metric
  );

  const prevBuckets = previousPeriodBuckets(buckets, IST_TIMEZONE);
  const prevDates = new Set(prevBuckets.map((bucket) => bucket.date));
  const prevSamples =
    prevBuckets.length > 0
      ? await fetchSamplesForRange(
          selectedCluster,
          prevBuckets[0].date,
          prevBuckets[prevBuckets.length - 1].date,
          captureStart
        )
      : [];
  const prevIndex = buildHourlyIndex(prevSamples, prevDates);
  const prevRange = prevBuckets.length
    ? dailyBeforeAfterForCluster(
        selectedCluster,
        prevBuckets,
        prevIndex,
        scheduleLogs,
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
