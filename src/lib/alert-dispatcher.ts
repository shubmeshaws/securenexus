import type { ActivityAction, LogActivityParams } from '@/lib/activity';
import {
  getAlertConfigFull,
  getTeamsWebhookUrl,
  shouldAlertForEvent,
} from '@/lib/alert-settings';
import { sendTeamsWebhook } from '@/lib/teams-webhook';
import { sendEmailAlert } from '@/lib/email-alerts';
import prisma from '@/lib/prisma';

const EXTERNAL_ALERT_DEDUP_MS = 90_000;

const ACTION_TITLES: Record<string, string> = {
  'sync-off': 'Sync disabled',
  'sync-on': 'Sync enabled',
  'scale-down': 'Deployment scaled down',
  'scale-up': 'Deployment scaled up',
  'schedule-run': 'Schedule executed',
  'schedule-shutdown': 'Scheduled shutdown',
  'schedule-startup': 'Scheduled startup',
  'infra-shutdown': 'Infrastructure stopped',
  'infra-startup': 'Infrastructure started',
  'resource-change': 'Resource increase detected',
};

export interface AlertDispatchInput extends LogActivityParams {
  logId?: string;
}

function buildPayload(input: AlertDispatchInput) {
  return {
    title: ACTION_TITLES[input.action] ?? input.action,
    message:
      input.message ??
      `${input.appName} on ${input.cluster}/${input.namespace} — ${input.triggeredBy}`,
    action: input.action,
    cluster: input.cluster,
    namespace: input.namespace,
    appName: input.appName,
    triggeredBy: input.triggeredBy,
    status: input.status,
    userName: input.userName,
    startTime: input.startTime,
  };
}

async function isDuplicateExternalAlert(input: AlertDispatchInput): Promise<boolean> {
  const since = new Date(Date.now() - EXTERNAL_ALERT_DEDUP_MS);
  const duplicate = await prisma.activityLog.findFirst({
    where: {
      ...(input.logId ? { id: { not: input.logId } } : {}),
      action: input.action,
      cluster: input.cluster,
      namespace: input.namespace,
      appName: input.appName,
      status: input.status,
      timestamp: { gte: since },
    },
    select: { id: true },
  });
  return Boolean(duplicate);
}

export async function dispatchAlerts(input: AlertDispatchInput): Promise<void> {
  try {
    if (input.action === 'alert-broadcast') return;

    const config = await getAlertConfigFull();
    if (!shouldAlertForEvent(config, input.action)) return;

    if (await isDuplicateExternalAlert(input)) return;

    const payload = buildPayload(input);
    const tasks: Promise<unknown>[] = [];

    if (config.teamsEnabled && input.teamsAlertEnabled !== false) {
      const webhookUrl = await getTeamsWebhookUrl();
      if (webhookUrl) {
        tasks.push(sendTeamsWebhook(webhookUrl, payload));
      }
    }

    if (config.emailEnabled) {
      tasks.push(sendEmailAlert(config, payload));
    }

    await Promise.allSettled(tasks);
  } catch {
    // Never block activity logging on alert failures
  }
}

export async function sendTestAlert(
  channel: 'in-app' | 'email' | 'teams',
  triggeredBy: string
): Promise<{ ok: boolean; message: string }> {
  const payload = {
    title: 'Test Alert',
    message: 'This is a test notification from SecureNexus Alerts.',
    action: 'schedule-run' as ActivityAction,
    cluster: 'test-cluster',
    namespace: 'default',
    appName: 'test-workload',
    triggeredBy,
    status: 'success' as const,
    userName: triggeredBy,
  };

  if (channel === 'teams') {
    const webhookUrl = await getTeamsWebhookUrl();
    if (!webhookUrl) return { ok: false, message: 'Teams webhook URL is not configured' };
    return sendTeamsWebhook(webhookUrl, payload);
  }

  if (channel === 'email') {
    const config = await getAlertConfigFull();
    const recipients = config.emailRecipients;
    if (!recipients.length) return { ok: false, message: 'Add at least one email recipient' };
    return sendEmailAlert(config, payload, recipients);
  }

  return { ok: true, message: 'In-app test uses activity log entry' };
}
