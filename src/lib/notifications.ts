import type { ActivityLog } from '@prisma/client';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  type: NotificationType;
  timestamp: string;
  read: boolean;
}

function parseBroadcastDetails(details: string | null | undefined): {
  title?: string;
  notifType?: NotificationType;
} {
  if (!details) return {};
  try {
    return JSON.parse(details) as { title?: string; notifType?: NotificationType };
  } catch {
    return {};
  }
}

export function broadcastLogsToNotifications(logs: ActivityLog[]): AppNotification[] {
  return logs.map((log) => {
    const broadcast = parseBroadcastDetails(log.details);
    const type: NotificationType =
      broadcast.notifType ?? (log.status === 'failed' ? 'error' : 'success');

    return {
      id: log.id,
      title: broadcast.title ?? 'Announcement',
      message: log.message ?? '',
      type,
      timestamp: log.timestamp.toISOString(),
      read: false,
    };
  });
}
