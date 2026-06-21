import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import prisma from './prisma';
import { IST_TIMEZONE } from './utils';
import { getClusterReadyNodeCount } from './k8s-client';

export function getCalendarDateAndHour(
  now: Date,
  tz: string = IST_TIMEZONE
): { date: string; hour: number; minuteSlot: number } {
  const zoned = toZonedTime(now, tz);
  const minute = zoned.getMinutes();
  return {
    date: format(zoned, 'yyyy-MM-dd'),
    hour: zoned.getHours(),
    minuteSlot: Math.floor(minute / 15) * 15,
  };
}

export async function upsertHourlyNodeSample(
  clusterName: string,
  nodeCount: number,
  now: Date = new Date()
): Promise<void> {
  const { date, hour, minuteSlot } = getCalendarDateAndHour(now);
  await prisma.clusterNodeHourlySample.upsert({
    where: {
      clusterName_calendarDate_hour_minuteSlot: {
        clusterName,
        calendarDate: date,
        hour,
        minuteSlot,
      },
    },
    create: {
      clusterName,
      calendarDate: date,
      hour,
      minuteSlot,
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
