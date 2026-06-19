import { subDays, format } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { getSetting, SETTING_KEYS } from './settings';
import { IST_TIMEZONE } from './utils';
import prisma from './prisma';

export const DEFAULT_NODE_SAMPLE_RETENTION_DAYS = 90;
export const DEFAULT_NODE_SAMPLE_DATA_START_DATE = '';
export const DEFAULT_NODE_SAMPLE_DATA_START_TIME = '00:00';
const MIN_DAYS = 7;
const MAX_DAYS = 3650;

export async function getNodeSampleRetentionDays(): Promise<number> {
  const raw = await getSetting(SETTING_KEYS.NODE_SAMPLE_RETENTION_DAYS);
  const parsed = parseInt(raw ?? String(DEFAULT_NODE_SAMPLE_RETENTION_DAYS), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_NODE_SAMPLE_RETENTION_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, parsed));
}

function parseStartTime(raw: string | null | undefined): string {
  const value = raw?.trim() ?? DEFAULT_NODE_SAMPLE_DATA_START_TIME;
  return /^\d{2}:\d{2}$/.test(value) ? value : DEFAULT_NODE_SAMPLE_DATA_START_TIME;
}

function parseStartDate(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** Earliest moment node count capture is allowed (IST date + time), or null if unset. */
export async function getNodeSampleCaptureStartAt(): Promise<Date | null> {
  const [dateRaw, timeRaw] = await Promise.all([
    getSetting(SETTING_KEYS.NODE_SAMPLE_DATA_START_DATE),
    getSetting(SETTING_KEYS.NODE_SAMPLE_DATA_START_TIME),
  ]);
  const date = parseStartDate(dateRaw);
  if (!date) return null;
  const time = parseStartTime(timeRaw);
  return fromZonedTime(`${date}T${time}:00`, IST_TIMEZONE);
}

export async function getNodeSampleCaptureStartConfig(): Promise<{
  startDate: string;
  startTime: string;
}> {
  const [dateRaw, timeRaw] = await Promise.all([
    getSetting(SETTING_KEYS.NODE_SAMPLE_DATA_START_DATE),
    getSetting(SETTING_KEYS.NODE_SAMPLE_DATA_START_TIME),
  ]);
  return {
    startDate: parseStartDate(dateRaw) ?? '',
    startTime: parseStartTime(timeRaw),
  };
}

export async function getNodeSampleEffectiveStartDate(
  rangeStartDate: string,
  now: Date = new Date()
): Promise<string> {
  const retentionDays = await getNodeSampleRetentionDays();
  const retentionStart = format(subDays(now, retentionDays), 'yyyy-MM-dd');
  let startDate = rangeStartDate > retentionStart ? rangeStartDate : retentionStart;
  const captureStart = await getNodeSampleCaptureStartAt();
  if (captureStart) {
    const captureDate = formatInTimeZone(captureStart, IST_TIMEZONE, 'yyyy-MM-dd');
    if (captureDate > startDate) startDate = captureDate;
  }
  return startDate;
}

export async function getNodeSampleCaptureStartHour(): Promise<number | null> {
  const captureStart = await getNodeSampleCaptureStartAt();
  if (!captureStart) return null;
  return Number.parseInt(formatInTimeZone(captureStart, IST_TIMEZONE, 'H'), 10);
}

export function getNodeSampleRetentionCutoff(now: Date, retentionDays: number): Date {
  return subDays(now, retentionDays);
}

export async function pruneNodeSamplesByRetention(now: Date = new Date()): Promise<number> {
  const retentionDays = await getNodeSampleRetentionDays();
  const retentionCutoff = getNodeSampleRetentionCutoff(now, retentionDays);
  const captureStart = await getNodeSampleCaptureStartAt();
  const effectiveCutoff =
    captureStart && captureStart > retentionCutoff ? captureStart : retentionCutoff;

  const [nodeResult, podResult] = await Promise.all([
    prisma.clusterNodeHourlySample.deleteMany({
      where: { sampledAt: { lt: effectiveCutoff } },
    }),
    prisma.clusterPodHourlySample.deleteMany({
      where: { sampledAt: { lt: effectiveCutoff } },
    }),
  ]);
  return nodeResult.count + podResult.count;
}

export async function pruneNodeSamplesBeforeCaptureStart(): Promise<number> {
  const captureStart = await getNodeSampleCaptureStartAt();
  if (!captureStart) return 0;
  const [nodeResult, podResult] = await Promise.all([
    prisma.clusterNodeHourlySample.deleteMany({
      where: { sampledAt: { lt: captureStart } },
    }),
    prisma.clusterPodHourlySample.deleteMany({
      where: { sampledAt: { lt: captureStart } },
    }),
  ]);
  return nodeResult.count + podResult.count;
}
