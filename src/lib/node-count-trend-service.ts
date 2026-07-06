import { addDays, format, max as maxDate, parseISO } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  type NodeCountTrendQuery,
  type NodeCountTrendResponse,
  type NodePodSeriesId,
  MAX_NODE_COUNT_TREND_DAYS,
  averageNonNull,
  latestNonNullValue,
} from './node-count-trend-data';
import {
  parseDashboardDateQuery,
  resolveDashboardRangeBounds,
  type DashboardDateQuery,
} from './dashboard-date-range';
import { listRegisteredClusterNames } from './node-count-sampler';
import { getNodeSampleCaptureStartAt } from './node-sample-retention';
import { IST_TIMEZONE } from './utils';
import prisma from './prisma';

const CACHE_TTL_MS = 60_000;
const COMPARISON_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

let trendCache: { key: string; at: number; data: NodeCountTrendResponse } | null = null;

interface HourlySample {
  count: number;
  sampledAt: Date;
}

function capTrendQuery(query: DashboardDateQuery): DashboardDateQuery {
  const parsed = parseDashboardDateQuery({
    days: query.days != null ? String(query.days) : undefined,
    from: query.from,
    to: query.to,
  });
  if (parsed.from && parsed.to) {
    const fromDay = parseISO(parsed.from);
    const toDay = parseISO(parsed.to);
    const span =
      Math.floor((toDay.getTime() - fromDay.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (span > MAX_NODE_COUNT_TREND_DAYS) {
      const trimmedFrom = format(
        addDays(toDay, -(MAX_NODE_COUNT_TREND_DAYS - 1)),
        'yyyy-MM-dd'
      );
      return { from: trimmedFrom, to: parsed.to };
    }
    return parsed;
  }
  return { days: Math.min(parsed.days ?? 7, MAX_NODE_COUNT_TREND_DAYS) };
}

function istDateAndHour(sampledAt: Date): { date: string; hour: number } {
  return {
    date: formatInTimeZone(sampledAt, IST_TIMEZONE, 'yyyy-MM-dd'),
    hour: Number.parseInt(formatInTimeZone(sampledAt, IST_TIMEZONE, 'H'), 10),
  };
}

function listDatesInclusive(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cursor = parseISO(startDate);
  const end = parseISO(endDate);
  while (cursor <= end) {
    dates.push(format(cursor, 'yyyy-MM-dd'));
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function bucketCountsByIstHour(
  samples: HourlySample[],
  calendarDate: string,
  allowedHours: number[]
): Map<number, number> {
  const allowed = new Set(allowedHours);
  const byHour = new Map<number, HourlySample>();

  for (const sample of samples) {
    const { date, hour } = istDateAndHour(sample.sampledAt);
    if (date !== calendarDate || !allowed.has(hour)) continue;
    const existing = byHour.get(hour);
    if (!existing || sample.sampledAt > existing.sampledAt) {
      byHour.set(hour, sample);
    }
  }

  const counts = new Map<number, number>();
  for (const [hour, sample] of Array.from(byHour.entries())) {
    counts.set(hour, sample.count);
  }
  return counts;
}

function latestCountForDay(samples: HourlySample[], calendarDate: string): number | null {
  const byHour = bucketCountsByIstHour(samples, calendarDate, COMPARISON_HOURS);
  for (let hour = 23; hour >= 0; hour--) {
    if (byHour.has(hour)) return byHour.get(hour)!;
  }
  return null;
}

function dayChartLabel(calendarDate: string, dayCount: number): string {
  const day = parseISO(calendarDate);
  return dayCount <= 7
    ? formatInTimeZone(day, IST_TIMEZONE, 'EEE')
    : formatInTimeZone(day, IST_TIMEZONE, 'd MMM');
}

function emptyResponse(cluster: string, availableClusters: string[]): NodeCountTrendResponse {
  return {
    labels: [],
    dates: [],
    days: 0,
    periodLabel: '',
    cluster,
    availableClusters,
    hasSamples: false,
    series: { nodes: [], pods: [] },
    summary: {
      nodes: { latest: null, average: null },
      pods: { latest: null, average: null },
    },
  };
}

function cacheKey(query: NodeCountTrendQuery): string {
  return JSON.stringify(query);
}

function buildSeriesSummary(data: (number | null)[]) {
  return {
    latest: latestNonNullValue(data),
    average: averageNonNull(data),
  };
}

export async function getNodeCountTrendData(
  query: NodeCountTrendQuery = { days: 7 }
): Promise<NodeCountTrendResponse> {
  const capped = capTrendQuery(query);
  const availableClusters = await listRegisteredClusterNames();
  const selectedCluster =
    query.cluster && availableClusters.includes(query.cluster)
      ? query.cluster
      : availableClusters[0] ?? '';

  const key = cacheKey({ ...capped, cluster: selectedCluster });

  if (trendCache && trendCache.key === key && Date.now() - trendCache.at < CACHE_TTL_MS) {
    return trendCache.data;
  }

  if (!availableClusters.length || !selectedCluster) {
    return emptyResponse('', availableClusters);
  }

  const { rangeStart, rangeEnd, days } = resolveDashboardRangeBounds(capped);
  const startDate = formatInTimeZone(rangeStart, IST_TIMEZONE, 'yyyy-MM-dd');
  const endDate = formatInTimeZone(rangeEnd, IST_TIMEZONE, 'yyyy-MM-dd');
  const calendarDates = listDatesInclusive(startDate, endDate);
  const captureStartAt = await getNodeSampleCaptureStartAt();
  const sampleWindowStart = maxDate([rangeStart, captureStartAt ?? rangeStart]);

  const [nodeRows, podRows] = await Promise.all([
    prisma.clusterNodeHourlySample.findMany({
      where: {
        clusterName: selectedCluster,
        sampledAt: { gte: sampleWindowStart, lte: rangeEnd },
      },
      orderBy: { sampledAt: 'asc' },
      select: { nodeCount: true, sampledAt: true },
    }),
    prisma.clusterPodHourlySample.findMany({
      where: {
        clusterName: selectedCluster,
        sampledAt: { gte: sampleWindowStart, lte: rangeEnd },
      },
      orderBy: { sampledAt: 'asc' },
      select: { podCount: true, sampledAt: true },
    }),
  ]);

  const nodeSamples: HourlySample[] = nodeRows.map((row) => ({
    count: row.nodeCount,
    sampledAt: row.sampledAt,
  }));
  const podSamples: HourlySample[] = podRows.map((row) => ({
    count: row.podCount,
    sampledAt: row.sampledAt,
  }));

  const series: Record<NodePodSeriesId, (number | null)[]> = {
    nodes: calendarDates.map((date) => latestCountForDay(nodeSamples, date)),
    pods: calendarDates.map((date) => latestCountForDay(podSamples, date)),
  };

  const hasSamples =
    nodeSamples.length > 0 ||
    podSamples.length > 0 ||
    series.nodes.some((v) => v != null) ||
    series.pods.some((v) => v != null);

  const periodLabel =
    capped.from && capped.to
      ? `${capped.from} → ${capped.to}`
      : `Last ${days} days`;

  const data: NodeCountTrendResponse = {
    labels: calendarDates.map((date) => dayChartLabel(date, calendarDates.length)),
    dates: calendarDates,
    days: calendarDates.length,
    periodLabel,
    cluster: selectedCluster,
    availableClusters,
    hasSamples,
    series,
    summary: {
      nodes: buildSeriesSummary(series.nodes),
      pods: buildSeriesSummary(series.pods),
    },
  };

  trendCache = { key, at: Date.now(), data };
  return data;
}

export function invalidateNodeCountTrendCache(): void {
  trendCache = null;
}
