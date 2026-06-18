import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import prisma from './prisma';
import { COST_CALENDAR_TZ } from './cost-calendar';
import { getClusterReadyNodeCount } from './k8s-client';

export function getCalendarDateAndHour(
  now: Date,
  tz: string = COST_CALENDAR_TZ
): { date: string; hour: number } {
  const zoned = toZonedTime(now, tz);
  return {
    date: format(zoned, 'yyyy-MM-dd'),
    hour: zoned.getHours(),
  };
}

export async function upsertHourlyNodeSample(
  clusterName: string,
  nodeCount: number,
  now: Date = new Date()
): Promise<void> {
  const { date, hour } = getCalendarDateAndHour(now);
  await prisma.clusterNodeHourlySample.upsert({
    where: {
      clusterName_calendarDate_hour: {
        clusterName,
        calendarDate: date,
        hour,
      },
    },
    create: {
      clusterName,
      calendarDate: date,
      hour,
      nodeCount,
      sampledAt: now,
    },
    update: {
      nodeCount,
      sampledAt: now,
    },
  });
}

export async function sampleClusterNodeCount(clusterName: string): Promise<number | null> {
  return getClusterReadyNodeCount(clusterName);
}

/** Sample ready node count for every cluster registered under Clusters. */
export async function sampleRegisteredClusters(now: Date = new Date()): Promise<void> {
  const clusters = await prisma.cluster.findMany({
    orderBy: { name: 'asc' },
    select: { name: true },
  });

  await Promise.all(
    clusters.map(async ({ name }) => {
      const nodeCount = await sampleClusterNodeCount(name);
      if (nodeCount == null) return;
      await upsertHourlyNodeSample(name, nodeCount, now);
    })
  );
}

export async function listRegisteredClusterNames(): Promise<string[]> {
  const clusters = await prisma.cluster.findMany({
    orderBy: { name: 'asc' },
    select: { name: true },
  });
  return clusters.map((row) => row.name);
}
