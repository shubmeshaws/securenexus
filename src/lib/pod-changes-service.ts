import { addDays, format, max as maxDate, parseISO } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  parseDashboardDateQuery,
  resolveDashboardRangeBounds,
  type DashboardDateQuery,
} from './dashboard-date-range';
import { listRegisteredClusterNames } from './pod-count-sampler';
import {
  getNodeSampleCaptureStartAt,
  getNodeSampleCaptureStartConfig,
  getNodeSampleCaptureStartHour,
  getNodeSampleEffectiveStartDate,
  getNodeSampleRetentionDays,
} from './node-sample-retention';
import { formatTime12h, IST_TIMEZONE } from './utils';
import prisma from './prisma';

export type PodChangeDirection = 'all' | 'increase' | 'decrease';

export interface PodHourlyRow {
  hour: number;
  hourLabel: string;
  dateTimeLabel: string;
  podCount: number;
  previousCount: number | null;
  delta: number | null;
  sampledAt: string;
  hasSample: true;
}

export interface PodChangesQuery extends DashboardDateQuery {
  cluster?: string;
  date?: string;
  direction?: PodChangeDirection;
}

export interface PodChangesResponse {
  cluster: string;
  calendarDate: string;
  availableClusters: string[];
  rows: PodHourlyRow[];
  previousDate: string | null;
  nextDate: string | null;
  retentionDays: number;
  totalDaysInRange: number;
  captureStartDate: string | null;
  captureStartHour: number | null;
}

const CACHE_TTL_MS = 60_000;
let changesCache: { key: string; at: number; data: PodChangesResponse } | null = null;

function cacheKey(query: PodChangesQuery): string {
  return JSON.stringify(query);
}

function hourLabel(hour: number): string {
  return formatTime12h(`${String(hour).padStart(2, '0')}:00`);
}

function formatDateTimeLabel(calendarDate: string, hour: number): string {
  return `${format(parseISO(calendarDate), 'd MMM yyyy')}, ${hourLabel(hour)}`;
}

function todayCalendarDate(now: Date = new Date()): string {
  return formatInTimeZone(now, IST_TIMEZONE, 'yyyy-MM-dd');
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

function bucketSamplesByIstHour(
  samples: Array<{ podCount: number; sampledAt: Date }>,
  calendarDate: string,
  allowedHours: number[]
): Map<number, { podCount: number; sampledAt: Date }> {
  const allowed = new Set(allowedHours);
  const byHour = new Map<number, { podCount: number; sampledAt: Date }>();

  for (const sample of samples) {
    const { date, hour } = istDateAndHour(sample.sampledAt);
    if (date !== calendarDate || !allowed.has(hour)) continue;
    const existing = byHour.get(hour);
    if (!existing || sample.sampledAt > existing.sampledAt) {
      byHour.set(hour, sample);
    }
  }

  return byHour;
}

function buildSampleRows(
  calendarDate: string,
  byHour: Map<number, { podCount: number; sampledAt: Date }>,
  allowedHours: number[],
  previousBaseline: number | null
): PodHourlyRow[] {
  const rows: PodHourlyRow[] = [];
  let previous = previousBaseline;

  for (const hour of allowedHours) {
    const sample = byHour.get(hour);
    if (!sample) continue;

    const delta = previous != null ? sample.podCount - previous : null;

    rows.push({
      hour,
      hourLabel: hourLabel(hour),
      dateTimeLabel: formatDateTimeLabel(calendarDate, hour),
      podCount: sample.podCount,
      previousCount: previous,
      delta,
      sampledAt: sample.sampledAt.toISOString(),
      hasSample: true,
    });

    previous = sample.podCount;
  }

  return rows.reverse();
}

function applyDirectionFilter(
  rows: PodHourlyRow[],
  direction: PodChangeDirection
): PodHourlyRow[] {
  if (direction === 'all') return rows;
  return rows.filter((row) => {
    if (row.delta == null || row.delta === 0) return false;
    return direction === 'increase' ? row.delta > 0 : row.delta < 0;
  });
}

async function getPreviousBaseline(
  clusterName: string,
  calendarDate: string,
  firstAllowedHour: number,
  captureStartAt: Date | null
): Promise<number | null> {
  const { start: dayStart } = istDayBounds(calendarDate);
  const firstHourStart = fromZonedTime(
    `${calendarDate}T${String(firstAllowedHour).padStart(2, '0')}:00:00`,
    IST_TIMEZONE
  );
  const beforeCurrent = maxDate([dayStart, captureStartAt ?? dayStart, firstHourStart]);

  const sample = await prisma.clusterPodHourlySample.findFirst({
    where: {
      clusterName,
      sampledAt: {
        gte: captureStartAt ?? undefined,
        lt: beforeCurrent,
      },
    },
    orderBy: { sampledAt: 'desc' },
    select: { podCount: true },
  });
  return sample?.podCount ?? null;
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
  const latest = await prisma.clusterPodHourlySample.findFirst({
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

export async function getPodChanges(query: PodChangesQuery = { days: 14 }): Promise<PodChangesResponse> {
  const direction: PodChangeDirection =
    query.direction === 'increase' || query.direction === 'decrease' ? query.direction : 'all';
  const availableClusters = await listRegisteredClusterNames();
  const selectedCluster =
    query.cluster && availableClusters.includes(query.cluster)
      ? query.cluster
      : availableClusters[0] ?? '';

  const [retentionDays, captureStartAt, captureConfig, captureStartHourIst] = await Promise.all([
    getNodeSampleRetentionDays(),
    getNodeSampleCaptureStartAt(),
    getNodeSampleCaptureStartConfig(),
    getNodeSampleCaptureStartHour(),
  ]);

  const captureStartDate = captureConfig.startDate || null;
  const captureStartHour = captureStartHourIst;

  const now = new Date();
  const { rangeStart, rangeEnd } = resolveDashboardRangeBounds(query);
  const rangeStartDate = formatInTimeZone(rangeStart, IST_TIMEZONE, 'yyyy-MM-dd');
  const rangeEndDate = formatInTimeZone(rangeEnd, IST_TIMEZONE, 'yyyy-MM-dd');
  const startDate = await getNodeSampleEffectiveStartDate(rangeStartDate, now);
  const endDate = rangeEndDate;

  const key = cacheKey({
    ...query,
    cluster: selectedCluster,
    direction,
    date: query.date,
  });
  if (changesCache && changesCache.key === key && Date.now() - changesCache.at < CACHE_TTL_MS) {
    return changesCache.data;
  }

  const empty: PodChangesResponse = {
    cluster: selectedCluster,
    calendarDate: endDate,
    availableClusters,
    rows: [],
    previousDate: null,
    nextDate: null,
    retentionDays,
    totalDaysInRange: 0,
    captureStartDate,
    captureStartHour,
  };

  if (!selectedCluster || startDate > endDate) {
    return empty;
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
  const firstAllowedHour = allowedHours[0] ?? 0;
  const { start: dayStart, end: dayEnd } = istDayBounds(calendarDate);
  const sampleWindowStart = maxDate([dayStart, captureStartAt ?? dayStart]);

  const [daySamples, previousBaseline] = await Promise.all([
    prisma.clusterPodHourlySample.findMany({
      where: {
        clusterName: selectedCluster,
        sampledAt: { gte: sampleWindowStart, lte: dayEnd },
      },
      orderBy: { sampledAt: 'asc' },
      select: { podCount: true, sampledAt: true },
    }),
    getPreviousBaseline(selectedCluster, calendarDate, firstAllowedHour, captureStartAt),
  ]);

  const byHour = bucketSamplesByIstHour(daySamples, calendarDate, allowedHours);
  const rows = applyDirectionFilter(
    buildSampleRows(calendarDate, byHour, allowedHours, previousBaseline),
    direction
  );

  const data: PodChangesResponse = {
    cluster: selectedCluster,
    calendarDate,
    availableClusters,
    rows,
    previousDate,
    nextDate,
    retentionDays,
    totalDaysInRange: datesInRange.length,
    captureStartDate,
    captureStartHour,
  };
  changesCache = { key, at: Date.now(), data };
  return data;
}

export function invalidatePodChangesCache(): void {
  changesCache = null;
}

export function parsePodChangesQuery(query: {
  days?: string | string[];
  from?: string | string[];
  to?: string | string[];
  cluster?: string | string[];
  date?: string | string[];
  direction?: string | string[];
}): PodChangesQuery {
  const dateQuery = parseDashboardDateQuery(query);
  const cluster = typeof query.cluster === 'string' ? query.cluster : undefined;
  const date = typeof query.date === 'string' ? query.date : undefined;
  const directionRaw = typeof query.direction === 'string' ? query.direction : undefined;
  const direction: PodChangeDirection =
    directionRaw === 'increase' || directionRaw === 'decrease' ? directionRaw : 'all';
  return { ...dateQuery, cluster, date, direction };
}
