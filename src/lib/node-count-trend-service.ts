import { addDays, format, max as maxDate, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { resolveCostTrendBuckets } from './cost-savings-trend-data';
import {
  type DayTrendSeries,
  type NodeCountTrendQuery,
  type NodeCountTrendResponse,
  type NodePodSeriesId,
  MAX_NODE_COUNT_TREND_DAYS,
  latestNonNullValue,
} from './node-count-trend-data';
import {
  parseDashboardDateQuery,
  type DashboardDateQuery,
} from './dashboard-date-range';
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

function todayCalendarDate(now: Date = new Date()): string {
  return formatInTimeZone(now, IST_TIMEZONE, 'yyyy-MM-dd');
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

function groupSamplesByDate(samples: HourlySample[]): Map<string, HourlySample[]> {
  const grouped = new Map<string, HourlySample[]>();
  for (const sample of samples) {
    const { date } = istDateAndHour(sample.sampledAt);
    const list = grouped.get(date) ?? [];
    list.push(sample);
    grouped.set(date, list);
  }
  return grouped;
}

function buildDaySeries(
  calendarDate: string,
  label: string,
  samples: HourlySample[]
): DayTrendSeries {
  const byHour = bucketCountsByIstHour(samples, calendarDate, COMPARISON_HOURS);
  const data = COMPARISON_HOURS.map((hour) => (byHour.has(hour) ? byHour.get(hour)! : null));
  return {
    date: calendarDate,
    label,
    data,
    latest: latestNonNullValue(data),
  };
}

function daySeriesLabel(
  calendarDate: string,
  todayDate: string,
  dayCount: number
): string {
  const yesterdayDate = format(addDays(parseISO(todayDate), -1), 'yyyy-MM-dd');
  if (calendarDate === todayDate) return 'Today';
  if (calendarDate === yesterdayDate) return 'Yesterday';
  const day = parseISO(calendarDate);
  if (dayCount <= 7) return formatInTimeZone(day, IST_TIMEZONE, 'EEE');
  return formatInTimeZone(day, IST_TIMEZONE, 'd MMM');
}

function buildHourlyByDay(
  calendarDates: string[],
  samplesByDate: Map<string, HourlySample[]>,
  todayDate: string
): DayTrendSeries[] {
  return calendarDates.map((date) =>
    buildDaySeries(
      date,
      daySeriesLabel(date, todayDate, calendarDates.length),
      samplesByDate.get(date) ?? []
    )
  );
}

function emptyResponse(cluster: string, availableClusters: string[]): NodeCountTrendResponse {
  return {
    labels: [],
    days: 0,
    periodLabel: '',
    cluster,
    availableClusters,
    hasSamples: false,
    hourlyByDay: {
      nodes: [],
      pods: [],
    },
  };
}

function cacheKey(query: NodeCountTrendQuery): string {
  return JSON.stringify(query);
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

  const buckets = resolveCostTrendBuckets(capped, IST_TIMEZONE);
  if (!buckets.length) {
    return emptyResponse(selectedCluster, availableClusters);
  }

  const calendarDates = buckets.map((bucket) => bucket.date);
  const rangeStart = buckets[0].start;
  const rangeEnd = buckets[buckets.length - 1].end;
  const days = buckets.length;
  const captureStartAt = await getNodeSampleCaptureStartAt();
  const sampleWindowStart = maxDate([rangeStart, captureStartAt ?? rangeStart]);
  const todayDate = todayCalendarDate();

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

  const nodeSamplesByDate = groupSamplesByDate(nodeSamples);
  const podSamplesByDate = groupSamplesByDate(podSamples);

  const hourlyByDay: Record<NodePodSeriesId, DayTrendSeries[]> = {
    nodes: buildHourlyByDay(calendarDates, nodeSamplesByDate, todayDate),
    pods: buildHourlyByDay(calendarDates, podSamplesByDate, todayDate),
  };

  const hasSamples =
    nodeSamples.length > 0 ||
    podSamples.length > 0 ||
    hourlyByDay.nodes.some((day) => day.data.some((value) => value != null)) ||
    hourlyByDay.pods.some((day) => day.data.some((value) => value != null));

  const periodLabel =
    capped.from && capped.to ? `${capped.from} → ${capped.to}` : `Last ${days} days`;

  const data: NodeCountTrendResponse = {
    labels: COMPARISON_HOURS.map((hour) => hourChartLabel(hour)),
    days,
    periodLabel,
    cluster: selectedCluster,
    availableClusters,
    hasSamples,
    hourlyByDay,
  };

  trendCache = { key, at: Date.now(), data };
  return data;
}

export function invalidateNodeCountTrendCache(): void {
  trendCache = null;
}
