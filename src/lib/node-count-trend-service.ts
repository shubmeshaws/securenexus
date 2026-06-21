import { addDays, format, max as maxDate, parseISO } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { resolveDashboardRangeBounds } from './dashboard-date-range';
import {
  type NodeCountTrendQuery,
  type NodeCountTrendResponse,
  type NodePodTrendSeries,
} from './node-count-trend-data';
import { listRegisteredClusterNames, sampleRegisteredClusters } from './node-count-sampler';
import { sampleRegisteredClusterPods } from './pod-count-sampler';
import {
  getNodeSampleCaptureStartAt,
  getNodeSampleCaptureStartConfig,
  getNodeSampleCaptureStartHour,
  getNodeSampleEffectiveStartDate,
  getNodeSampleRetentionDays,
} from './node-sample-retention';
import { formatTime12h, IST_TIMEZONE } from './utils';
import prisma from './prisma';

const CACHE_TTL_MS = 30_000;
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

function clampDateToRange(date: string, startDate: string, endDate: string): string {
  if (date < startDate) return startDate;
  if (date > endDate) return endDate;
  return date;
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

function allowedHoursForDate(
  calendarDate: string,
  captureStartDate: string | null,
  captureStartHour: number | null
): number[] {
  if (!captureStartDate || calendarDate !== captureStartDate) {
    return Array.from({ length: 24 }, (_, hour) => hour);
  }
  const startHour = captureStartHour ?? 0;
  return Array.from({ length: 24 - startHour }, (_, index) => startHour + index);
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

function emptyResponse(
  cluster: string,
  availableClusters: string[],
  calendarDate = ''
): NodeCountTrendResponse {
  return {
    labels: [],
    bucketKeys: [],
    days: 0,
    interval: '1h',
    isTodayLive: false,
    hasSamples: false,
    cluster,
    availableClusters,
    calendarDate,
    previousDate: null,
    nextDate: null,
    retentionDays: 0,
    totalDaysInRange: 0,
    captureStartDate: null,
    captureStartHour: null,
    series: [],
  };
}

function cacheKey(query: NodeCountTrendQuery): string {
  return JSON.stringify(query);
}

async function resolveSelectedDate(
  clusterName: string,
  requestedDate: string | undefined,
  startDate: string,
  endDate: string,
  captureStartAt: Date | null
): Promise<string> {
  if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return clampDateToRange(requestedDate, startDate, endDate);
  }

  const { end: rangeEnd } = istDayBounds(endDate);
  const latest = await prisma.clusterNodeHourlySample.findFirst({
    where: {
      clusterName,
      sampledAt: {
        gte: captureStartAt ?? undefined,
        lte: rangeEnd,
      },
    },
    orderBy: { sampledAt: 'desc' },
    select: { sampledAt: true },
  });

  if (latest?.sampledAt) {
    const { date } = istDateAndHour(latest.sampledAt);
    return clampDateToRange(date, startDate, endDate);
  }
  return clampDateToRange(todayCalendarDate(), startDate, endDate);
}

export async function getNodeCountTrendData(
  query: NodeCountTrendQuery = { days: 14 }
): Promise<NodeCountTrendResponse> {
  const availableClusters = await listRegisteredClusterNames();
  const selectedCluster =
    query.cluster && availableClusters.includes(query.cluster)
      ? query.cluster
      : availableClusters[0] ?? '';

  const key = cacheKey({ ...query, cluster: selectedCluster });

  if (trendCache && trendCache.key === key && Date.now() - trendCache.at < CACHE_TTL_MS) {
    return trendCache.data;
  }

  if (!availableClusters.length || !selectedCluster) {
    return emptyResponse('', availableClusters);
  }

  try {
    await Promise.all([sampleRegisteredClusters(), sampleRegisteredClusterPods()]);
  } catch (err) {
    console.error('[NodeCountTrend] Live sample failed (serving stored samples):', err);
  }

  const now = new Date();
  const todayDate = todayCalendarDate();

  const [retentionDays, captureStartAt, captureConfig, captureStartHour] = await Promise.all([
    getNodeSampleRetentionDays(),
    getNodeSampleCaptureStartAt(),
    getNodeSampleCaptureStartConfig(),
    getNodeSampleCaptureStartHour(),
  ]);

  const captureStartDate = captureConfig.startDate || null;
  const { rangeStart, rangeEnd } = resolveDashboardRangeBounds(query);
  const rangeStartDate = formatInTimeZone(rangeStart, IST_TIMEZONE, 'yyyy-MM-dd');
  const rangeEndDate = formatInTimeZone(rangeEnd, IST_TIMEZONE, 'yyyy-MM-dd');
  const startDate = await getNodeSampleEffectiveStartDate(rangeStartDate, now);
  const endDate = rangeEndDate;

  if (startDate > endDate) {
    return emptyResponse(selectedCluster, availableClusters);
  }

  const calendarDate = await resolveSelectedDate(
    selectedCluster,
    query.date,
    startDate,
    endDate,
    captureStartAt
  );
  const datesInRange = listDatesInclusive(startDate, endDate);
  const dateIndex = datesInRange.indexOf(calendarDate);
  const previousDate = dateIndex > 0 ? datesInRange[dateIndex - 1] : null;
  const nextDate = dateIndex >= 0 && dateIndex < datesInRange.length - 1 ? datesInRange[dateIndex + 1] : null;

  const allowedHours = allowedHoursForDate(calendarDate, captureStartDate, captureStartHour);
  const { start: dayStart, end: dayEnd } = istDayBounds(calendarDate);
  const sampleWindowStart = maxDate([dayStart, captureStartAt ?? dayStart]);

  const [nodeRows, podRows] = await Promise.all([
    prisma.clusterNodeHourlySample.findMany({
      where: {
        clusterName: selectedCluster,
        sampledAt: { gte: sampleWindowStart, lte: dayEnd },
      },
      orderBy: { sampledAt: 'asc' },
      select: { nodeCount: true, sampledAt: true },
    }),
    prisma.clusterPodHourlySample.findMany({
      where: {
        clusterName: selectedCluster,
        sampledAt: { gte: sampleWindowStart, lte: dayEnd },
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

  const nodeByHour = bucketCountsByIstHour(nodeSamples, calendarDate, allowedHours);
  const podByHour = bucketCountsByIstHour(podSamples, calendarDate, allowedHours);

  const labels = allowedHours.map((hour) => hourChartLabel(hour));
  const bucketKeys = allowedHours.map(
    (hour) => `${calendarDate} ${String(hour).padStart(2, '0')}:00`
  );

  const series: NodePodTrendSeries[] = [
    {
      id: 'nodes',
      label: 'Nodes',
      data: allowedHours.map((hour) => (nodeByHour.has(hour) ? nodeByHour.get(hour)! : null)),
    },
    {
      id: 'pods',
      label: 'Pods',
      data: allowedHours.map((hour) => (podByHour.has(hour) ? podByHour.get(hour)! : null)),
    },
  ];

  const data: NodeCountTrendResponse = {
    labels,
    bucketKeys,
    days: 1,
    interval: '1h',
    isTodayLive: calendarDate === todayDate,
    hasSamples: nodeSamples.length > 0 || podSamples.length > 0,
    cluster: selectedCluster,
    availableClusters,
    calendarDate,
    previousDate,
    nextDate,
    retentionDays,
    totalDaysInRange: datesInRange.length,
    captureStartDate,
    captureStartHour,
    series,
  };

  trendCache = { key, at: Date.now(), data };
  return data;
}

export function invalidateNodeCountTrendCache(): void {
  trendCache = null;
}
