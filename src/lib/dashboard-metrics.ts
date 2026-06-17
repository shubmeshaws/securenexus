import prisma from './prisma';
import { subDays } from 'date-fns';
import { lookupEc2InstanceTypes } from './aws-credential-store';
import {
  type DashboardDateQuery,
  resolveDashboardRangeBounds,
} from './dashboard-date-range';
import { fetchStoppedActivityLogs } from './stopped-activity-logs';
import {
  computeEksNamespaceStoppedStats,
  computeStandaloneStoppedStats,
  type NamespaceStoppedStat,
  type StandaloneStoppedStat,
} from './stopped-time';
import type { Schedule } from '@prisma/client';

export type { NamespaceStoppedStat, StandaloneStoppedStat };

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

export interface DashboardInsightsResult {
  namespaceStopped: NamespaceStoppedStat[];
  standaloneStopped: StandaloneStoppedStat[];
  totals: {
    eksStoppedMs: number;
    standaloneStoppedMs: number;
  };
}

const INSIGHTS_CACHE_TTL_MS = 30_000;
let insightsCache: { key: string; at: number; data: DashboardInsightsResult } | null = null;

export function invalidateDashboardInsightsCache() {
  insightsCache = null;
}

export async function getDashboardInsights(
  schedules: Schedule[],
  query: DashboardDateQuery = { days: 14 }
): Promise<DashboardInsightsResult> {
  const key = JSON.stringify(query);
  if (insightsCache && insightsCache.key === key && Date.now() - insightsCache.at < INSIGHTS_CACHE_TTL_MS) {
    return insightsCache.data;
  }

  const now = new Date();
  const { rangeStart, rangeEnd } = resolveDashboardRangeBounds(query);
  const lookbackStart = subDays(rangeStart, 120);
  const logs = await fetchStoppedActivityLogs(lookbackStart);
  const instanceMeta = await buildEc2InstanceMeta(schedules);
  const range = { start: rangeStart, end: rangeEnd };

  const namespaceStopped = computeEksNamespaceStoppedStats(logs, now, range);
  const standaloneStopped = computeStandaloneStoppedStats(logs, now, instanceMeta, range);

  const data: DashboardInsightsResult = {
    namespaceStopped,
    standaloneStopped,
    totals: {
      eksStoppedMs: namespaceStopped.reduce((sum, row) => sum + row.stoppedMs, 0),
      standaloneStoppedMs: standaloneStopped.reduce((sum, row) => sum + row.stoppedMs, 0),
    },
  };

  insightsCache = { key, at: Date.now(), data };
  return data;
}
