import { parseClusterDisplay } from '@/lib/utils';
import type { ActivityAction } from '@/lib/activity';
import { formatAlertTarget, formatAlertTriggeredBy } from '@/lib/alert-display';

export interface TeamsAlertPayload {
  title: string;
  message: string;
  action: ActivityAction;
  cluster: string;
  namespace: string;
  appName: string;
  triggeredBy: string;
  status: 'success' | 'failed';
  userName?: string;
  startTime?: string;
}

const ACTION_META: Record<
  string,
  { emoji: string; label: string; accentColor: string; containerStyle: string }
> = {
  'schedule-run': { emoji: '⚡', label: 'Schedule Executed', accentColor: 'Accent', containerStyle: 'accent' },
  'schedule-shutdown': { emoji: '🌙', label: 'Scheduled Shutdown', accentColor: 'Attention', containerStyle: 'attention' },
  'schedule-startup': { emoji: '☀️', label: 'Scheduled Startup', accentColor: 'Good', containerStyle: 'good' },
  'scale-down': { emoji: '⏬', label: 'Scale Down', accentColor: 'Attention', containerStyle: 'attention' },
  'scale-up': { emoji: '⏫', label: 'Scale Up', accentColor: 'Good', containerStyle: 'good' },
  'sync-off': { emoji: '🔕', label: 'Sync Disabled', accentColor: 'Warning', containerStyle: 'warning' },
  'sync-on': { emoji: '🔔', label: 'Sync Enabled', accentColor: 'Good', containerStyle: 'good' },
  'infra-shutdown': { emoji: '🛑', label: 'Infrastructure Stopped', accentColor: 'Attention', containerStyle: 'attention' },
  'infra-startup': { emoji: '🚀', label: 'Infrastructure Started', accentColor: 'Good', containerStyle: 'good' },
  'alert-broadcast': { emoji: '📢', label: 'Team Announcement', accentColor: 'Accent', containerStyle: 'accent' },
};

function statusColor(status: 'success' | 'failed'): string {
  return status === 'success' ? 'Good' : 'Attention';
}

function statusEmoji(status: 'success' | 'failed'): string {
  return status === 'success' ? '✅' : '❌';
}

export function buildTeamsAdaptiveCard(payload: TeamsAlertPayload) {
  const meta = ACTION_META[payload.action] ?? {
    emoji: '🔔',
    label: payload.title,
    accentColor: 'Accent',
    containerStyle: 'emphasis',
  };
  const { clusterName } = parseClusterDisplay(payload.cluster);
  const statusLabel = payload.status === 'success' ? 'Success' : 'Failed';
  const target = formatAlertTarget(payload.appName);
  const actor = formatAlertTriggeredBy(payload.triggeredBy, {
    userName: payload.userName,
    action: payload.action,
  });

  const facts: { title: string; value: string }[] = [
    { title: 'Status', value: statusLabel },
    { title: 'Cluster', value: clusterName },
    { title: 'Namespace', value: payload.namespace },
    { title: 'Target', value: target },
    { title: 'Triggered by', value: actor },
  ];

  if (payload.startTime) {
    facts.splice(1, 0, { title: 'Start Time', value: payload.startTime });
  }

  return {
    type: 'message' as const,
    style: 'emphasis' as const,
    summary: `${meta.label} — ${payload.message}`,
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          body: [
            {
              type: 'Container',
              style: meta.containerStyle,
              bleed: true,
              items: [
                {
                  type: 'ColumnSet',
                  columns: [
                    {
                      type: 'Column',
                      width: 'auto',
                      items: [
                        {
                          type: 'TextBlock',
                          text: meta.emoji,
                          size: 'ExtraLarge',
                          horizontalAlignment: 'Center',
                        },
                      ],
                      verticalContentAlignment: 'Center',
                    },
                    {
                      type: 'Column',
                      width: 'stretch',
                      items: [
                        {
                          type: 'TextBlock',
                          text: meta.label,
                          weight: 'Bolder',
                          size: 'Large',
                          color: meta.accentColor,
                          wrap: true,
                        },
                        {
                          type: 'TextBlock',
                          text: 'SecureNexus Alert',
                          isSubtle: true,
                          spacing: 'None',
                          size: 'Small',
                        },
                      ],
                      verticalContentAlignment: 'Center',
                    },
                    {
                      type: 'Column',
                      width: 'auto',
                      items: [
                        {
                          type: 'TextBlock',
                          text: statusEmoji(payload.status),
                          size: 'Large',
                          horizontalAlignment: 'Right',
                        },
                      ],
                      verticalContentAlignment: 'Center',
                    },
                  ],
                },
              ],
            },
            {
              type: 'TextBlock',
              text: payload.message,
              wrap: true,
              size: 'Medium',
              spacing: 'Medium',
            },
            {
              type: 'FactSet',
              spacing: 'Medium',
              facts,
            },
            {
              type: 'TextBlock',
              text: `${statusEmoji(payload.status)} ${statusLabel}`,
              color: statusColor(payload.status),
              weight: 'Bolder',
              spacing: 'Medium',
            },
          ],
        },
      },
    ],
  };
}

export async function sendTeamsWebhook(
  webhookUrl: string,
  payload: TeamsAlertPayload
): Promise<{ ok: boolean; message: string }> {
  const body = buildTeamsAdaptiveCard(payload);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, message: `Teams webhook failed (${res.status}): ${text.slice(0, 200)}` };
    }
    return { ok: true, message: 'Teams notification sent' };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Teams webhook request failed',
    };
  }
}
