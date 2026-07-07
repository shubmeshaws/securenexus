import prisma from './prisma';
import type { AuthenticatedRequest } from './auth';
import { dispatchAlerts } from './alert-dispatcher';
import { invalidateDashboardInsightsCache } from './dashboard-metrics';
import { getSetting, SETTING_KEYS } from './settings';

export type ActivityAction =
  | 'sync-off'
  | 'sync-on'
  | 'scale-down'
  | 'scale-up'
  | 'schedule-run'
  | 'schedule-shutdown'
  | 'schedule-startup'
  | 'instant-start'
  | 'instant-stop'
  | 'infra-shutdown'
  | 'infra-startup'
  | 'resource-change'
  | 'alert-broadcast'
  | 'security-scan';

export interface LogActivityParams {
  action: ActivityAction;
  cluster: string;
  namespace: string;
  appName: string;
  triggeredBy: string;
  status: 'success' | 'failed';
  message?: string;
  details?: string;
  /** Next scheduled startup (shown on shutdown/stopped alerts). */
  startTime?: string;
  /** When false, skip Teams webhook for this activity (schedule-level opt-out). */
  teamsAlertEnabled?: boolean;
  userId?: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  ipAddress?: string;
}

let cachedPublicIp: { ip: string; at: number } | null = null;

/** Public egress IP via AWS checkip (cached 5 min). */
export async function fetchPublicIp(): Promise<string | null> {
  try {
    if (cachedPublicIp && Date.now() - cachedPublicIp.at < 300_000) {
      return cachedPublicIp.ip;
    }
    const res = await fetch('https://checkip.amazonaws.com/', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const ip = (await res.text()).trim();
    if (ip) cachedPublicIp = { ip, at: Date.now() };
    return ip || null;
  } catch {
    return null;
  }
}

function clientIpFromRequest(req: AuthenticatedRequest): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() ?? null;
  }
  const socketIp = req.socket?.remoteAddress;
  return socketIp?.replace(/^::ffff:/, '') ?? null;
}

async function resolveUserFields(
  userId: string | undefined,
  triggeredBy: string
): Promise<{ userName: string; userEmail?: string; userRole?: string }> {
  if (!userId) {
    return { userName: triggeredBy };
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { userName: triggeredBy };
  return {
    userName: user.displayName,
    userEmail: user.email,
    userRole: user.role,
  };
}

export async function logActivity(params: LogActivityParams) {
  const ipAddress =
    params.ipAddress ?? (await fetchPublicIp()) ?? undefined;

  const userFields =
    params.userName != null
      ? {
          userName: params.userName,
          userEmail: params.userEmail,
          userRole: params.userRole,
        }
      : await resolveUserFields(params.userId, params.triggeredBy);

  const log = await prisma.activityLog.create({
    data: {
      action: params.action,
      cluster: params.cluster,
      namespace: params.namespace,
      appName: params.appName,
      triggeredBy: params.triggeredBy,
      status: params.status,
      message: params.message,
      details: params.details,
      userId: params.userId,
      userName: userFields.userName,
      userEmail: userFields.userEmail,
      userRole: userFields.userRole,
      ipAddress,
    },
  });

  void dispatchAlerts({ ...params, ...userFields, logId: log.id });

  if (
    params.status === 'success' &&
    (params.action === 'schedule-shutdown' ||
      params.action === 'schedule-startup' ||
      params.action === 'infra-shutdown' ||
      params.action === 'infra-startup' ||
      params.action === 'scale-down' ||
      params.action === 'scale-up')
  ) {
    invalidateDashboardInsightsCache();
  }

  return log;
}

export async function logActivityFromRequest(
  req: AuthenticatedRequest,
  params: Omit<LogActivityParams, 'userId' | 'ipAddress' | 'userName' | 'userEmail' | 'userRole'>
) {
  const user = req.user;
  const userFields = user
    ? await resolveUserFields(user.id, user.email)
    : { userName: params.triggeredBy };

  return logActivity({
    ...params,
    userId: user?.id,
    userName: userFields.userName,
    userEmail: userFields.userEmail ?? user?.email,
    userRole: userFields.userRole ?? user?.role,
    ipAddress: (await fetchPublicIp()) ?? clientIpFromRequest(req) ?? undefined,
  });
}

export async function getActivityLogRetentionDays(): Promise<number> {
  const raw = await getSetting(SETTING_KEYS.ACTIVITY_LOG_RETENTION_DAYS);
  const days = parseInt(raw ?? '90', 10);
  return Math.min(3650, Math.max(1, Number.isFinite(days) ? days : 90));
}

export const MAX_BROADCAST_NOTIFICATIONS = 5;

export async function getBroadcastNotifications() {
  const logs = await prisma.activityLog.findMany({
    where: { action: 'alert-broadcast' },
    orderBy: { timestamp: 'desc' },
    take: MAX_BROADCAST_NOTIFICATIONS,
  });
  return logs;
}

export async function pruneBroadcastNotifications() {
  const keep = await prisma.activityLog.findMany({
    where: { action: 'alert-broadcast' },
    orderBy: { timestamp: 'desc' },
    take: MAX_BROADCAST_NOTIFICATIONS,
    select: { id: true },
  });
  const keepIds = keep.map((l) => l.id);
  if (keepIds.length === 0) return;
  await prisma.activityLog.deleteMany({
    where: {
      action: 'alert-broadcast',
      id: { notIn: keepIds },
    },
  });
}

export async function pruneActivityLogsByRetention() {
  const retentionDays = await getActivityLogRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  await prisma.activityLog.deleteMany({
    where: {
      timestamp: { lt: cutoff },
      action: { not: 'alert-broadcast' },
    },
  });
}

export async function getActivityLogs(
  limit = 100,
  options?: { from?: Date; to?: Date }
) {
  const retentionDays = await getActivityLogRetentionDays();
  const retentionCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const from = options?.from
    ? new Date(Math.max(options.from.getTime(), retentionCutoff.getTime()))
    : retentionCutoff;
  const to = options?.to ?? new Date();

  const logs = await prisma.activityLog.findMany({
    where: {
      timestamp: { gte: from, lte: to },
      action: { not: 'alert-broadcast' },
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });

  const missingUserIds = Array.from(
    new Set(
      logs
        .filter((l) => l.userId && !l.userName)
        .map((l) => l.userId as string)
    )
  );

  const missingEmails = Array.from(
    new Set(
      logs
        .filter((l) => !l.userName && l.triggeredBy.includes('@'))
        .map((l) => l.triggeredBy)
    )
  );

  const users =
    missingUserIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: missingUserIds } } })
      : [];
  const usersByEmail =
    missingEmails.length > 0
      ? await prisma.user.findMany({ where: { email: { in: missingEmails } } })
      : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  const emailMap = new Map(usersByEmail.map((u) => [u.email, u]));

  return logs.map((log) => {
    const user = log.userId ? userMap.get(log.userId) : emailMap.get(log.triggeredBy);
    return {
      ...log,
      userName: log.userName ?? user?.displayName ?? (log.triggeredBy === 'scheduler' ? 'System Scheduler' : log.triggeredBy),
      userEmail: log.userEmail ?? user?.email ?? null,
      userRole: log.userRole ?? user?.role ?? null,
    };
  });
}
