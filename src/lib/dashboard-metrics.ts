import prisma from './prisma';
import { listClusters, listClusterInstanceTypes } from './k8s-client';
import { isNamespaceSchedule } from './workload-utils';
import type { Schedule } from '@prisma/client';
import {
  buildStoppedIntervals,
  getCalendarDayBounds,
  getCalendarMonthBounds,
  msToHours,
  sumStoppedMsInRange,
  sumStoppedMsTotal,
  COST_CALENDAR_TZ,
} from './cost-calendar';
import {
  clusterResourceRates,
  resourceRatesFromInstance,
  type CapacityType,
} from './instance-pricing';
import { sumUsd } from './utils';

export interface NamespaceStoppedStat {
  cluster: string;
  namespace: string;
  stoppedHours: number;
  stoppedMs: number;
}

export interface InstanceTypeStat {
  cluster: string;
  instanceType: string;
  capacityType: CapacityType;
  count: number;
  vCpu: number;
  memoryGiB: number;
  hourlyPrice: number;
  cpuRatePerCore: number;
  memRatePerGb: number;
}

export interface NamespaceCostSavings {
  cluster: string;
  namespace: string;
  stoppedHours: number;
  stoppedHoursToday: number;
  stoppedHoursMonth: number;
  cpuCores: number;
  memoryGb: number;
  cpuSavedTotal: number;
  memorySavedTotal: number;
  cpuSavedPerDay: number;
  memorySavedPerDay: number;
  cpuSavedPerMonth: number;
  memorySavedPerMonth: number;
}

function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

async function fetchStoppedLogs() {
  return prisma.activityLog.findMany({
    where: {
      action: { in: ['schedule-shutdown', 'schedule-startup'] },
      status: 'success',
    },
    orderBy: { timestamp: 'asc' },
    take: 5000,
  });
}

function namespaceStoppedStatsFromLogs(
  logs: Awaited<ReturnType<typeof fetchStoppedLogs>>,
  now: Date
): NamespaceStoppedStat[] {
  const intervals = buildStoppedIntervals(logs, now);
  const totals = sumStoppedMsTotal(intervals, now);

  return Array.from(totals.entries())
    .map(([key, stoppedMs]) => {
      const sep = key.indexOf('::');
      return {
        cluster: key.slice(0, sep),
        namespace: key.slice(sep + 2),
        stoppedMs,
        stoppedHours: msToHours(stoppedMs),
      };
    })
    .filter((row) => row.stoppedMs > 0)
    .sort((a, b) => b.stoppedMs - a.stoppedMs);
}

export async function computeNamespaceStoppedStats(now = new Date()): Promise<NamespaceStoppedStat[]> {
  const logs = await fetchStoppedLogs();
  return namespaceStoppedStatsFromLogs(logs, now);
}

export async function estimateNamespaceResources(
  schedules: Schedule[]
): Promise<Map<string, { cpuCores: number; memoryGb: number }>> {
  const result = new Map<string, { cpuCores: number; memoryGb: number }>();
  const byKey = new Map<string, Schedule[]>();

  for (const schedule of schedules) {
    const key = `${schedule.cluster}::${schedule.namespace}`;
    const list = byKey.get(key) ?? [];
    list.push(schedule);
    byKey.set(key, list);
  }

  const { getDeploymentResources, listWorkloads, getDeployment } = await import('./k8s-client');

  await Promise.all(
    Array.from(byKey.entries()).map(async ([key, nsSchedules]) => {
      const sep = key.indexOf('::');
      const cluster = key.slice(0, sep);
      const namespace = key.slice(sep + 2);
      const totals = { cpuCores: 0, memoryGb: 0 };

      try {
        const namespaceSchedules = nsSchedules.filter(isNamespaceSchedule);
        const workloadSchedules = nsSchedules.filter(
          (s) => !isNamespaceSchedule(s) && s.workloadKind === 'Deployment'
        );

        if (namespaceSchedules.length) {
          const workloads = await listWorkloads(cluster, namespace);
          for (const schedule of namespaceSchedules) {
            const savedMap = parseSavedReplicas(schedule.savedWorkloadReplicas);
            const excluded = new Set(schedule.excludedWorkloads ?? []);
            await Promise.all(
              workloads
                .filter((w) => w.kind === 'Deployment')
                .filter((w) => !excluded.has(`${w.kind}::${w.name}`))
                .map(async (w) => {
                  const wk = `${w.kind}::${w.name}`;
                  const res = await getDeploymentResources(cluster, namespace, w.name);
                  const replicas =
                    savedMap[wk] ??
                    (await getDeployment(cluster, namespace, w.name))?.desiredReplicas ??
                    1;
                  totals.cpuCores += res.cpuCores * replicas;
                  totals.memoryGb += res.memoryGb * replicas;
                })
            );
          }
        }

        await Promise.all(
          workloadSchedules.map(async (schedule) => {
            const res = await getDeploymentResources(cluster, namespace, schedule.appName);
            const replicas = schedule.savedReplicas ?? schedule.targetReplicas ?? 1;
            totals.cpuCores += res.cpuCores * replicas;
            totals.memoryGb += res.memoryGb * replicas;
          })
        );
      } catch {
        // skip unreachable cluster/namespace
      }

      if (totals.cpuCores > 0 || totals.memoryGb > 0) {
        result.set(key, totals);
      }
    })
  );

  return result;
}

function parseSavedReplicas(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && v >= 0) out[k] = v;
  }
  return out;
}

export interface DashboardInsightsResult {
  namespaceStopped: NamespaceStoppedStat[];
  instanceTypes: InstanceTypeStat[];
  costSavings: NamespaceCostSavings[];
  costCalendarTz: string;
  totals: {
    stoppedHours: number;
    stoppedHoursToday: number;
    stoppedHoursMonth: number;
    cpuSavedTotal: number;
    memorySavedTotal: number;
    cpuSavedPerDay: number;
    memorySavedPerDay: number;
    cpuSavedPerMonth: number;
    memorySavedPerMonth: number;
  };
}

const INSIGHTS_CACHE_TTL_MS = 90_000;
let insightsCache: { at: number; data: DashboardInsightsResult } | null = null;

async function fetchClusterNodeMetrics(): Promise<{
  instanceTypes: InstanceTypeStat[];
  clusterRates: Map<string, ReturnType<typeof clusterResourceRates>>;
}> {
  const clusters = await listClusters().catch(() => []);
  const instanceTypes: InstanceTypeStat[] = [];
  const clusterRates = new Map<string, ReturnType<typeof clusterResourceRates>>();

  await Promise.all(
    clusters.map(async (cluster) => {
      const types = await listClusterInstanceTypes(cluster.name).catch(() => []);
      clusterRates.set(
        cluster.name,
        clusterResourceRates(
          types.map((t) => ({
            instanceType: t.instanceType,
            capacityType: t.capacityType,
            count: t.count,
          }))
        )
      );

      for (const t of types) {
        const { spec, cpuHourlyPerCore, memHourlyPerGb, hourlyPrice } = resourceRatesFromInstance(
          t.instanceType,
          t.capacityType
        );
        instanceTypes.push({
          cluster: cluster.name,
          instanceType: t.instanceType,
          capacityType: t.capacityType,
          count: t.count,
          vCpu: spec.vCpu,
          memoryGiB: spec.memoryGiB,
          hourlyPrice: roundUsd(hourlyPrice),
          cpuRatePerCore: roundUsd(cpuHourlyPerCore),
          memRatePerGb: roundUsd(memHourlyPerGb),
        });
      }
    })
  );

  return {
    instanceTypes: instanceTypes.sort((a, b) => b.count - a.count),
    clusterRates,
  };
}

export function buildCostSavings(
  stoppedStats: NamespaceStoppedStat[],
  resources: Map<string, { cpuCores: number; memoryGb: number }>,
  stoppedMsToday: Map<string, number>,
  stoppedMsMonth: Map<string, number>,
  clusterRates: Map<string, ReturnType<typeof clusterResourceRates>>
): NamespaceCostSavings[] {
  const keys = new Set([
    ...stoppedStats.map((s) => `${s.cluster}::${s.namespace}`),
    ...Array.from(stoppedMsToday.keys()),
    ...Array.from(stoppedMsMonth.keys()),
  ]);

  return Array.from(keys)
    .map((key) => {
      const sep = key.indexOf('::');
      const cluster = key.slice(0, sep);
      const namespace = key.slice(sep + 2);
      const stat = stoppedStats.find((s) => s.cluster === cluster && s.namespace === namespace);
      const { cpuCores, memoryGb } = resources.get(key) ?? { cpuCores: 0, memoryGb: 0 };
      const rates = clusterRates.get(cluster) ?? {
        cpuHourlyPerCore: Number(process.env.COST_CPU_PER_VCORE_HOUR) || 0.0464,
        memHourlyPerGb: Number(process.env.COST_MEM_PER_GB_HOUR) || 0.0058,
      };

      const msToday = stoppedMsToday.get(key) ?? 0;
      const msMonth = stoppedMsMonth.get(key) ?? 0;
      const msTotal = stat?.stoppedMs ?? 0;

      const hoursToday = msToHours(msToday);
      const hoursMonth = msToHours(msMonth);
      const hoursTotal = msToHours(msTotal);

      const cpuSavedPerDay = cpuCores * hoursToday * rates.cpuHourlyPerCore;
      const memorySavedPerDay = memoryGb * hoursToday * rates.memHourlyPerGb;
      const cpuSavedPerMonth = cpuCores * hoursMonth * rates.cpuHourlyPerCore;
      const memorySavedPerMonth = memoryGb * hoursMonth * rates.memHourlyPerGb;
      const cpuSavedTotal = cpuCores * hoursTotal * rates.cpuHourlyPerCore;
      const memorySavedTotal = memoryGb * hoursTotal * rates.memHourlyPerGb;

      return {
        cluster,
        namespace,
        stoppedHours: hoursTotal,
        stoppedHoursToday: hoursToday,
        stoppedHoursMonth: hoursMonth,
        cpuCores: Math.round(cpuCores * 100) / 100,
        memoryGb: Math.round(memoryGb * 100) / 100,
        cpuSavedTotal: cpuSavedTotal,
        memorySavedTotal: memorySavedTotal,
        cpuSavedPerDay: cpuSavedPerDay,
        memorySavedPerDay: memorySavedPerDay,
        cpuSavedPerMonth: cpuSavedPerMonth,
        memorySavedPerMonth: memorySavedPerMonth,
      };
    })
    .filter(
      (row) =>
        row.stoppedHours > 0 ||
        row.stoppedHoursToday > 0 ||
        row.stoppedHoursMonth > 0 ||
        row.cpuSavedPerDay > 0 ||
        row.cpuSavedPerMonth > 0
    )
    .sort((a, b) => b.cpuSavedPerMonth + b.memorySavedPerMonth - (a.cpuSavedPerMonth + a.memorySavedPerMonth));
}

export async function getClusterInstanceTypes(): Promise<InstanceTypeStat[]> {
  const { instanceTypes } = await fetchClusterNodeMetrics();
  return instanceTypes;
}

export async function getDashboardInsights(schedules: Schedule[]): Promise<DashboardInsightsResult> {
  if (insightsCache && Date.now() - insightsCache.at < INSIGHTS_CACHE_TTL_MS) {
    return insightsCache.data;
  }

  const now = new Date();
  const dayBounds = getCalendarDayBounds(now);
  const monthBounds = getCalendarMonthBounds(now);

  const logs = await fetchStoppedLogs();
  const intervals = buildStoppedIntervals(logs, now);
  const stoppedMsToday = sumStoppedMsInRange(intervals, dayBounds.start, dayBounds.end, now);
  const stoppedMsMonth = sumStoppedMsInRange(intervals, monthBounds.start, monthBounds.end, now);

  const [stoppedStats, nodeMetrics, resourceMap] = await Promise.all([
    Promise.resolve(namespaceStoppedStatsFromLogs(logs, now)),
    fetchClusterNodeMetrics(),
    estimateNamespaceResources(schedules),
  ]);

  const costSavings = buildCostSavings(
    stoppedStats,
    resourceMap,
    stoppedMsToday,
    stoppedMsMonth,
    nodeMetrics.clusterRates
  );

  const data = {
    namespaceStopped: stoppedStats,
    instanceTypes: nodeMetrics.instanceTypes,
    costSavings,
    costCalendarTz: COST_CALENDAR_TZ,
    totals: {
      stoppedHours: msToHours(stoppedStats.reduce((s, r) => s + r.stoppedMs, 0)),
      stoppedHoursToday: msToHours(Array.from(stoppedMsToday.values()).reduce((s, v) => s + v, 0)),
      stoppedHoursMonth: msToHours(Array.from(stoppedMsMonth.values()).reduce((s, v) => s + v, 0)),
      cpuSavedTotal: sumUsd(costSavings.map((r) => r.cpuSavedTotal)),
      memorySavedTotal: sumUsd(costSavings.map((r) => r.memorySavedTotal)),
      cpuSavedPerDay: sumUsd(costSavings.map((r) => r.cpuSavedPerDay)),
      memorySavedPerDay: sumUsd(costSavings.map((r) => r.memorySavedPerDay)),
      cpuSavedPerMonth: sumUsd(costSavings.map((r) => r.cpuSavedPerMonth)),
      memorySavedPerMonth: sumUsd(costSavings.map((r) => r.memorySavedPerMonth)),
    },
  };

  insightsCache = { at: Date.now(), data };
  return data;
}
