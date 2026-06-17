import { subDays } from 'date-fns';
import prisma from './prisma';
import { lookupEc2InstanceTypes } from './aws-credential-store';
import {
  resolveCostTrendBuckets,
  previousPeriodBuckets,
  type CostSavingsClusterSeries,
  type CostSavingsTrendResponse,
  type CostTrendQuery,
  type DayBucket,
} from './cost-savings-trend-data';
import { COST_CALENDAR_TZ } from './cost-calendar';
import { hourlyPriceForInstance, type ClusterResourceRates } from './instance-pricing';
import { getClusterResourceRates } from './resource-audit-rates';
import { fetchStoppedActivityLogs } from './stopped-activity-logs';
import {
  computeEc2StoppedIntervals,
  computeEksNamespaceStoppedIntervals,
  type StoppedTimeLog,
} from './stopped-time';
import { parseClusterDisplay } from './utils';
import type { Schedule } from '@prisma/client';

const DEFAULT_NS_CPU = Number(process.env.COST_NAMESPACE_DEFAULT_CPU) || 2;
const DEFAULT_NS_MEM_GIB = Number(process.env.COST_NAMESPACE_DEFAULT_MEM_GIB) || 4;

const INSIGHTS_CACHE_TTL_MS = 30_000;
let trendCache: { key: string; at: number; data: CostSavingsTrendResponse } | null = null;

function clipIntervalMs(
  intervalStart: Date,
  intervalEnd: Date,
  rangeStart: Date,
  rangeEnd: Date,
  now: Date
): number {
  const effectiveEnd = Math.min(intervalEnd.getTime(), rangeEnd.getTime(), now.getTime());
  const effectiveStart = Math.max(intervalStart.getTime(), rangeStart.getTime());
  return Math.max(0, effectiveEnd - effectiveStart);
}

function seriesKey(cluster: string, kind: 'eks' | 'ec2'): string {
  const base = parseClusterDisplay(cluster).clusterName || cluster.trim() || cluster;
  return kind === 'ec2' ? `${base} · EC2` : base;
}

async function buildEc2InstanceMeta(
  schedules: Schedule[]
): Promise<Map<string, { name: string; instanceType: string }>> {
  const map = new Map<string, { name: string; instanceType: string }>();
  const lookupQueries: Array<{ credentialId: string; instanceId: string; region: string }> = [];

  for (const schedule of schedules) {
    if (schedule.platformType !== 'non_eks' || !schedule.ec2InstanceId) continue;
    map.set(schedule.ec2InstanceId, {
      name: schedule.appName,
      instanceType: 'unknown',
    });
    if (schedule.awsCredentialId && schedule.ec2Region) {
      lookupQueries.push({
        credentialId: schedule.awsCredentialId,
        instanceId: schedule.ec2InstanceId,
        region: schedule.ec2Region,
      });
    }
  }

  const types = await lookupEc2InstanceTypes(lookupQueries);
  for (const [instanceId, meta] of Array.from(map.entries())) {
    const instanceType = types.get(instanceId);
    if (instanceType) {
      map.set(instanceId, { ...meta, instanceType });
    }
  }

  return map;
}

async function namespaceHourlyCost(
  cluster: string,
  ratesCache: Map<string, ClusterResourceRates>
): Promise<number> {
  const rates = await getClusterResourceRates(cluster, ratesCache);
  return rates.cpuHourlyPerCore * DEFAULT_NS_CPU + rates.memHourlyPerGb * DEFAULT_NS_MEM_GIB;
}

function ec2HourlyCost(instanceType: string): number {
  return hourlyPriceForInstance(instanceType, 'on-demand');
}

type SavingsAccumulator = Map<string, number[]>;

function ensureSeries(map: SavingsAccumulator, key: string, length: number): number[] {
  let row = map.get(key);
  if (!row) {
    row = Array.from({ length }, () => 0);
    map.set(key, row);
  }
  return row;
}

function accumulateSavings(
  map: SavingsAccumulator,
  buckets: DayBucket[],
  seriesId: string,
  intervalStart: Date,
  intervalEnd: Date,
  hourlyRate: number,
  now: Date
): void {
  if (hourlyRate <= 0) return;
  const row = ensureSeries(map, seriesId, buckets.length);
  for (let i = 0; i < buckets.length; i++) {
    const ms = clipIntervalMs(intervalStart, intervalEnd, buckets[i].start, buckets[i].end, now);
    if (ms <= 0) continue;
    row[i] += (ms / 3_600_000) * hourlyRate;
  }
}

async function computeDailySavingsByCluster(
  buckets: DayBucket[],
  logs: StoppedTimeLog[],
  instanceMeta: Map<string, { name: string; instanceType: string }>,
  now: Date
): Promise<SavingsAccumulator> {
  const savings: SavingsAccumulator = new Map();
  const ratesCache = new Map<string, ClusterResourceRates>();
  const namespaceRateCache = new Map<string, number>();

  const eksIntervals = computeEksNamespaceStoppedIntervals(logs, now);
  for (const row of eksIntervals) {
    let hourly = namespaceRateCache.get(row.cluster);
    if (hourly == null) {
      hourly = await namespaceHourlyCost(row.cluster, ratesCache);
      namespaceRateCache.set(row.cluster, hourly);
    }
    accumulateSavings(
      savings,
      buckets,
      seriesKey(row.cluster, 'eks'),
      row.start,
      row.end,
      hourly,
      now
    );
  }

  const ec2Intervals = computeEc2StoppedIntervals(logs, now, instanceMeta);
  for (const row of ec2Intervals) {
    accumulateSavings(
      savings,
      buckets,
      seriesKey(row.cluster, 'ec2'),
      row.start,
      row.end,
      ec2HourlyCost(row.instanceType),
      now
    );
  }

  return savings;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildResponse(
  buckets: DayBucket[],
  savings: SavingsAccumulator,
  previousTotal: number
): CostSavingsTrendResponse {
  const clusters: CostSavingsClusterSeries[] = Array.from(savings.entries())
    .map(([id, data]) => ({
      id,
      data: data.map(roundUsd),
      total: roundUsd(data.reduce((sum, value) => sum + value, 0)),
    }))
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total);

  const periodTotal = roundUsd(clusters.reduce((sum, row) => sum + row.total, 0));
  const todayTotal = roundUsd(
    clusters.reduce((sum, row) => sum + (row.data.at(-1) ?? 0), 0)
  );

  return {
    labels: buckets.map((b) => b.label),
    dates: buckets.map((b) => b.date),
    days: buckets.length,
    clusters,
    summary: {
      today: todayTotal,
      thisMonth: periodTotal,
      lastMonthDelta: roundUsd(periodTotal - previousTotal),
    },
  };
}

function cacheKey(query: CostTrendQuery): string {
  return JSON.stringify(query);
}

export async function getCostSavingsTrendData(
  query: CostTrendQuery = {}
): Promise<CostSavingsTrendResponse> {
  const key = cacheKey(query);
  if (trendCache && trendCache.key === key && Date.now() - trendCache.at < INSIGHTS_CACHE_TTL_MS) {
    return trendCache.data;
  }

  const now = new Date();
  const buckets = resolveCostTrendBuckets(query);
  if (!buckets.length) {
    return {
      labels: [],
      dates: [],
      days: 0,
      clusters: [],
      summary: { today: 0, thisMonth: 0, lastMonthDelta: 0 },
    };
  }

  const lookbackStart = subDays(buckets[0].start, 120);
  const [logs, schedules] = await Promise.all([
    fetchStoppedActivityLogs(lookbackStart),
    prisma.schedule.findMany({ where: { enabled: true } }),
  ]);
  const instanceMeta = await buildEc2InstanceMeta(schedules);

  const currentSavings = await computeDailySavingsByCluster(buckets, logs, instanceMeta, now);

  const prevBuckets = previousPeriodBuckets(buckets);
  const previousSavings = prevBuckets.length
    ? await computeDailySavingsByCluster(prevBuckets, logs, instanceMeta, now)
    : new Map<string, number[]>();
  const previousTotal = roundUsd(
    Array.from(previousSavings.values()).reduce(
      (sum, row) => sum + row.reduce((a, b) => a + b, 0),
      0
    )
  );

  const data = buildResponse(buckets, currentSavings, previousTotal);
  trendCache = { key, at: Date.now(), data };
  return data;
}

export function costSavingsEstimationNote(): string {
  return `EKS: ${DEFAULT_NS_CPU} vCPU + ${DEFAULT_NS_MEM_GIB} GiB namespace footprint × cluster rates. EC2: on-demand instance hourly. Timezone: ${COST_CALENDAR_TZ}.`;
}
