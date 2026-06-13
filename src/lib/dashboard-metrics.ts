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
    take: 10000,
  });
}

export async function computeNamespaceStoppedStats(now = new Date()): Promise<NamespaceStoppedStat[]> {
  const logs = await fetchStoppedLogs();
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

export async function estimateNamespaceResources(
  schedules: Schedule[]
): Promise<Map<string, { cpuCores: number; memoryGb: number }>> {
  const result = new Map<string, { cpuCores: number; memoryGb: number }>();
  const { getDeploymentResources, listWorkloads, getDeployment } = await import('./k8s-client');

  for (const schedule of schedules) {
    const key = `${schedule.cluster}::${schedule.namespace}`;
    const existing = result.get(key) ?? { cpuCores: 0, memoryGb: 0 };

    try {
      if (isNamespaceSchedule(schedule)) {
        const savedMap = parseSavedReplicas(schedule.savedWorkloadReplicas);
        const workloads = await listWorkloads(schedule.cluster, schedule.namespace);
        const excluded = new Set(schedule.excludedWorkloads ?? []);
        for (const w of workloads) {
          if (w.kind === 'DaemonSet') continue;
          const wk = `${w.kind}::${w.name}`;
          if (excluded.has(wk)) continue;
          if (w.kind === 'Deployment') {
            const res = await getDeploymentResources(schedule.cluster, schedule.namespace, w.name);
            const replicas = savedMap[wk] ?? (await getDeployment(schedule.cluster, schedule.namespace, w.name))?.desiredReplicas ?? 1;
            existing.cpuCores += res.cpuCores * replicas;
            existing.memoryGb += res.memoryGb * replicas;
          }
        }
      } else if (schedule.workloadKind === 'Deployment') {
        const res = await getDeploymentResources(
          schedule.cluster,
          schedule.namespace,
          schedule.appName
        );
        const replicas = schedule.savedReplicas ?? schedule.targetReplicas ?? 1;
        existing.cpuCores += res.cpuCores * replicas;
        existing.memoryGb += res.memoryGb * replicas;
      }
    } catch {
      // skip unreachable workloads
    }

    result.set(key, existing);
  }

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

async function buildClusterRateMap(): Promise<Map<string, ReturnType<typeof clusterResourceRates>>> {
  const clusters = await listClusters().catch(() => []);
  const map = new Map<string, ReturnType<typeof clusterResourceRates>>();

  await Promise.all(
    clusters.map(async (cluster) => {
      const types = await listClusterInstanceTypes(cluster.name).catch(() => []);
      map.set(
        cluster.name,
        clusterResourceRates(
          types.map((t) => ({
            instanceType: t.instanceType,
            capacityType: t.capacityType,
            count: t.count,
          }))
        )
      );
    })
  );

  return map;
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
  const clusters = await listClusters().catch(() => []);
  const rows: InstanceTypeStat[] = [];

  await Promise.all(
    clusters.map(async (cluster) => {
      const types = await listClusterInstanceTypes(cluster.name).catch(() => []);
      for (const t of types) {
        const { spec, cpuHourlyPerCore, memHourlyPerGb, hourlyPrice } = resourceRatesFromInstance(
          t.instanceType,
          t.capacityType
        );
        rows.push({
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

  return rows.sort((a, b) => b.count - a.count);
}

export async function getDashboardInsights(schedules: Schedule[]) {
  const now = new Date();
  const dayBounds = getCalendarDayBounds(now);
  const monthBounds = getCalendarMonthBounds(now);

  const logs = await fetchStoppedLogs();
  const intervals = buildStoppedIntervals(logs, now);
  const stoppedMsToday = sumStoppedMsInRange(intervals, dayBounds.start, dayBounds.end, now);
  const stoppedMsMonth = sumStoppedMsInRange(intervals, monthBounds.start, monthBounds.end, now);

  const [stoppedStats, instanceTypes, resourceMap, clusterRates] = await Promise.all([
    computeNamespaceStoppedStats(now),
    getClusterInstanceTypes(),
    estimateNamespaceResources(schedules),
    buildClusterRateMap(),
  ]);

  const costSavings = buildCostSavings(
    stoppedStats,
    resourceMap,
    stoppedMsToday,
    stoppedMsMonth,
    clusterRates
  );

  return {
    namespaceStopped: stoppedStats,
    instanceTypes,
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
}
