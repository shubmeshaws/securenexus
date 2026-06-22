import { addDays, format, max as maxDate, parseISO } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  type NodeCountTrendQuery,
  type NodeCountTrendResponse,
  type MetricDayComparison,
  type DayTrendSeries,
  latestNonNullValue,
} from './node-count-trend-data';
import { listRegisteredClusterNames } from './node-count-sampler';
import { getNodeSampleCaptureStartAt } from './node-sample-retention';
import { formatTime12h, IST_TIMEZONE } from './utils';
import prisma from './prisma';

const CACHE_TTL_MS = 60_000;
const COMPARISON_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

let trendCache: { key: string; at: number; data: NodeCountTrendResponse } | null = null;

interface HourlySample {
  count: number;
  sampledAt: Date;
}

function istDayBounds(calendarDate: string): { start: Date; end: Date } {
  return {
    start: fromZonedTime(`${calendarDate}T00:00:00`, IST_TIMEZONE),
    end: fromZonedTime(`${calendarDate}T23:59:59.999`, IST_TIMEZONE),
  };
}

function istDateAndHour(sampledAt: Date): { date: string; hour: number } {
  return {
    date: formatInTimeZone(sampledAt, IST_TIMEZONE, 'yyyy-MM-dd'),
    hour: Number.parseInt(formatInTimeZone(sampledAt, IST_TIMEZONE, 'H'), 10),
  };
}

function todayCalendarDate(now: Date = new Date()): string {
  return formatInTimeZone(now, IST_TIMEZONE, 'yyyy-MM-dd');
}

function yesterdayCalendarDate(now: Date = new Date()): string {
  const today = todayCalendarDate(now);
  return format(addDays(parseISO(today), -1), 'yyyy-MM-dd');
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

function hourChartLabel(hour: number): string {
  return formatTime12h(`${String(hour).padStart(2, '0')}:00`);
}

function emptyResponse(cluster: string, availableClusters: string[]): NodeCountTrendResponse {
  return {
    labels: [],
    cluster,
    availableClusters,
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
}

function cacheKey(query: NodeCountTrendQuery): string {
  return JSON.stringify(query);
}

async function fetchHourlySamplesForDate(
  clusterName: string,
  calendarDate: string,
  captureStartAt: Date | null
): Promise<{ nodeSamples: HourlySample[]; podSamples: HourlySample[] }> {
  const { start: dayStart, end: dayEnd } = istDayBounds(calendarDate);
  const sampleWindowStart = maxDate([dayStart, captureStartAt ?? dayStart]);

  const [nodeRows, podRows] = await Promise.all([
    prisma.clusterNodeHourlySample.findMany({
      where: {
        clusterName,
        sampledAt: { gte: sampleWindowStart, lte: dayEnd },
      },
      orderBy: { sampledAt: 'asc' },
      select: { nodeCount: true, sampledAt: true },
    }),
    prisma.clusterPodHourlySample.findMany({
      where: {
        clusterName,
        sampledAt: { gte: sampleWindowStart, lte: dayEnd },
      },
      orderBy: { sampledAt: 'asc' },
      select: { podCount: true, sampledAt: true },
    }),
  ]);

  return {
    nodeSamples: nodeRows.map((row) => ({
      count: row.nodeCount,
      sampledAt: row.sampledAt,
    })),
    podSamples: podRows.map((row) => ({
      count: row.podCount,
      sampledAt: row.sampledAt,
    })),
  };
}

function buildDaySeries(
  calendarDate: string,
  byHour: Map<number, number>
): DayTrendSeries {
  const data = COMPARISON_HOURS.map((hour) => (byHour.has(hour) ? byHour.get(hour)! : null));
  return {
    date: calendarDate,
    data,
    latest: latestNonNullValue(data),
  };
}

function buildMetricComparison(
  calendarDates: { today: string; yesterday: string },
  nodeSamplesByDate: Map<string, HourlySample[]>,
  podSamplesByDate: Map<string, HourlySample[]>
): NodeCountTrendResponse['comparison'] {
  const buildForMetric = (samplesByDate: Map<string, HourlySample[]>): MetricDayComparison => {
    const todaySamples = samplesByDate.get(calendarDates.today) ?? [];
    const yesterdaySamples = samplesByDate.get(calendarDates.yesterday) ?? [];
    const todayByHour = bucketCountsByIstHour(todaySamples, calendarDates.today, COMPARISON_HOURS);
    const yesterdayByHour = bucketCountsByIstHour(
      yesterdaySamples,
      calendarDates.yesterday,
      COMPARISON_HOURS
    );

    return {
      today: buildDaySeries(calendarDates.today, todayByHour),
      yesterday: buildDaySeries(calendarDates.yesterday, yesterdayByHour),
    };
  };

  return {
    nodes: buildForMetric(nodeSamplesByDate),
    pods: buildForMetric(podSamplesByDate),
  };
}

export async function getNodeCountTrendData(
  query: NodeCountTrendQuery = { days: 14 }
): Promise<NodeCountTrendResponse> {
  const availableClusters = await listRegisteredClusterNames();
  const selectedCluster =
    query.cluster && availableClusters.includes(query.cluster)
      ? query.cluster
      : availableClusters[0] ?? '';

  const key = cacheKey({ cluster: selectedCluster });

  if (trendCache && trendCache.key === key && Date.now() - trendCache.at < CACHE_TTL_MS) {
    return trendCache.data;
  }

  if (!availableClusters.length || !selectedCluster) {
    return emptyResponse('', availableClusters);
  }

  const todayDate = todayCalendarDate();
  const yesterdayDate = yesterdayCalendarDate();
  const captureStartAt = await getNodeSampleCaptureStartAt();

  const [todaySamples, yesterdaySamples] = await Promise.all([
    fetchHourlySamplesForDate(selectedCluster, todayDate, captureStartAt),
    fetchHourlySamplesForDate(selectedCluster, yesterdayDate, captureStartAt),
  ]);

  const nodeSamplesByDate = new Map<string, HourlySample[]>([
    [todayDate, todaySamples.nodeSamples],
    [yesterdayDate, yesterdaySamples.nodeSamples],
  ]);
  const podSamplesByDate = new Map<string, HourlySample[]>([
    [todayDate, todaySamples.podSamples],
    [yesterdayDate, yesterdaySamples.podSamples],
  ]);

  const comparison = buildMetricComparison(
    { today: todayDate, yesterday: yesterdayDate },
    nodeSamplesByDate,
    podSamplesByDate
  );

  const hasSamples =
    todaySamples.nodeSamples.length > 0 ||
    todaySamples.podSamples.length > 0 ||
    yesterdaySamples.nodeSamples.length > 0 ||
    yesterdaySamples.podSamples.length > 0;

  const data: NodeCountTrendResponse = {
    labels: COMPARISON_HOURS.map((hour) => hourChartLabel(hour)),
    cluster: selectedCluster,
    availableClusters,
    hasSamples,
    comparison,
  };

  trendCache = { key, at: Date.now(), data };
  return data;
}

export function invalidateNodeCountTrendCache(): void {
  trendCache = null;
}
