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
  'resource-change': { emoji: '📈', label: 'Resource Increase Detected', accentColor: 'Attention', containerStyle: 'attention' },
  'alert-broadcast': { emoji: '📢', label: 'Team Announcement', accentColor: 'Accent', containerStyle: 'accent' },
  'security-scan': { emoji: '🛡️', label: 'Security Scan Report', accentColor: 'Accent', containerStyle: 'accent' },
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

export interface ResourceChangeTeamsInput {
  argocdApp: string;
  cluster: string;
  namespace: string;
  authorName: string;
  authorEmail: string | null;
  revisionSha: string;
  commitMessage: string | null;
  changes: {
    workload: string;
    containerName: string;
    resourceType: string;
    oldValue: string;
    newValue: string;
    costImpact: number | null;
  }[];
  totalCostImpactPerDay: number;
}

export function buildResourceChangeTeamsCard(input: ResourceChangeTeamsInput) {
  const changeRows = input.changes
    .slice(0, 8)
    .map(
      (c) =>
        `• ${c.workload}${c.containerName !== '__replicas__' ? `/${c.containerName}` : ''} · ${c.resourceType}: ${c.oldValue} → ${c.newValue}`
    )
    .join('\n');

  const author = input.authorEmail
    ? `${input.authorName} <${input.authorEmail}>`
    : input.authorName;

  return {
    type: 'message' as const,
    style: 'emphasis' as const,
    summary: `Resource increase on ${input.argocdApp} (+$${input.totalCostImpactPerDay.toFixed(2)}/day)`,
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
              style: 'attention',
              items: [
                {
                  type: 'TextBlock',
                  text: '📈 Resource increase detected',
                  weight: 'Bolder',
                  size: 'Large',
                  color: 'Attention',
                },
                {
                  type: 'TextBlock',
                  text: 'SecureNexus Resource changes',
                  isSubtle: true,
                  spacing: 'None',
                  size: 'Small',
                },
              ],
            },
            {
              type: 'FactSet',
              spacing: 'Medium',
              facts: [
                { title: 'App', value: input.argocdApp },
                { title: 'Cluster', value: input.cluster },
                { title: 'Namespace', value: input.namespace },
                { title: 'Author', value: author },
                { title: 'Est. impact', value: `+$${input.totalCostImpactPerDay.toFixed(2)}/day` },
              ],
            },
            {
              type: 'TextBlock',
              text: 'Resource changes',
              weight: 'Bolder',
              spacing: 'Medium',
            },
            {
              type: 'TextBlock',
              text: changeRows || '—',
              wrap: true,
              fontType: 'Monospace',
              size: 'Small',
            },
            ...(input.commitMessage
              ? [
                  {
                    type: 'TextBlock',
                    text: `Commit: ${input.commitMessage.slice(0, 200)}`,
                    wrap: true,
                    spacing: 'Medium',
                    isSubtle: true,
                  },
                ]
              : []),
            {
              type: 'TextBlock',
              text: `Revision: ${input.revisionSha.slice(0, 12)}`,
              isSubtle: true,
              spacing: 'Small',
              size: 'Small',
            },
          ],
        },
      },
    ],
  };
}

function stripNulls<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function extractAdaptiveCard(payload: Record<string, unknown>): Record<string, unknown> | null {
  const attachments = payload.attachments;
  if (Array.isArray(attachments)) {
    const first = attachments[0] as { content?: unknown } | undefined;
    if (first?.content && typeof first.content === 'object') {
      return first.content as Record<string, unknown>;
    }
  }
  if (payload.type === 'AdaptiveCard') return payload;
  return null;
}

async function postTeamsWebhook(
  webhookUrl: string,
  body: unknown
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => '');
  const ok = res.ok || res.status === 202 || text.trim() === '1';
  return { ok, status: res.status, text };
}

export async function sendTeamsWebhook(
  webhookUrl: string,
  payload: TeamsAlertPayload | Record<string, unknown>
): Promise<{ ok: boolean; message: string }> {
  try {
    const primary =
      'action' in payload && payload.action
        ? buildTeamsAdaptiveCard(payload as TeamsAlertPayload)
        : (payload as Record<string, unknown>);

    const attempts: unknown[] = [stripNulls(primary as Record<string, unknown>)];

    const card = extractAdaptiveCard(primary as Record<string, unknown>);
    if (card) {
      attempts.push(
        stripNulls({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: card,
            },
          ],
        })
      );
      attempts.push(stripNulls(card));
    }

    let lastStatus = 0;
    let lastText = '';

    for (const body of attempts) {
      const result = await postTeamsWebhook(webhookUrl, body);
      if (result.ok) {
        return { ok: true, message: 'Teams notification sent' };
      }
      lastStatus = result.status;
      lastText = result.text;
    }

    return {
      ok: false,
      message: `Teams webhook failed (${lastStatus}): ${lastText.slice(0, 300) || 'empty response'}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Teams webhook request failed';
    return { ok: false, message };
  }
}
