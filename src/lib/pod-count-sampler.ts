import prisma from './prisma';
import { getClusterRunningPodCount } from './k8s-client';
import { getCalendarDateAndHour, listRegisteredClusterNames } from './node-count-sampler';

export async function upsertHourlyPodSample(
  clusterName: string,
  podCount: number,
  now: Date = new Date()
): Promise<void> {
  const { date, hour, minuteSlot } = getCalendarDateAndHour(now);
  await prisma.clusterPodHourlySample.upsert({
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
      podCount,
      sampledAt: now,
    },
    update: {
      podCount,
      sampledAt: now,
    },
  });
}

export async function sampleClusterPodCount(clusterName: string): Promise<number | null> {
  return getClusterRunningPodCount(clusterName);
}

/** Sample running pod count for every cluster registered under Clusters. */
export async function sampleRegisteredClusterPods(now: Date = new Date()): Promise<void> {
  const clusters = await prisma.cluster.findMany({
    orderBy: { name: 'asc' },
    select: { name: true },
  });

  await Promise.all(
    clusters.map(async ({ name }) => {
      const podCount = await sampleClusterPodCount(name);
      if (podCount == null) return;
      await upsertHourlyPodSample(name, podCount, now);
    })
  );
}

export { listRegisteredClusterNames };
