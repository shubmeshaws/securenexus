import prisma from './prisma';
import type { StoppedTimeLog } from './stopped-time';

const STOP_TIME_ACTIONS = [
  'schedule-shutdown',
  'schedule-startup',
  'infra-shutdown',
  'infra-startup',
  'scale-down',
  'scale-up',
] as const;

const STOP_TIME_LOG_LIMIT = 10_000;

/** Fetch stop/start activity logs since `since`, oldest-first for interval building. */
export async function fetchStoppedActivityLogs(since: Date): Promise<StoppedTimeLog[]> {
  const rows = await prisma.activityLog.findMany({
    where: {
      action: { in: [...STOP_TIME_ACTIONS] },
      status: 'success',
      timestamp: { gte: since },
    },
    orderBy: { timestamp: 'desc' },
    take: STOP_TIME_LOG_LIMIT,
    select: {
      action: true,
      cluster: true,
      namespace: true,
      appName: true,
      status: true,
      details: true,
      timestamp: true,
    },
  });

  return rows.reverse();
}
