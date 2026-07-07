import prisma from '@/lib/prisma';
import { getTeamsWebhookUrl } from '@/lib/alert-settings';
import {
  automationScheduleRowFromRecord,
  formatAutomationScheduleSummary,
} from '@/lib/security-automation-schedule';
import {
  buildS3ConsoleFolderUrl,
  groupS3ReportLinks,
} from '@/lib/security-automation-s3-upload';
import { SECURITY_TOOL_CATEGORIES } from '@/lib/security-tools';
import { sendTeamsWebhook } from '@/lib/teams-webhook';

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export interface SecurityScanTeamsInput {
  title: string;
  scanTypes: string[];
  repositories: string[];
  urls: string[];
  scheduleSummary: string;
  status: 'success' | 'failed';
  highCount: number;
  mediumCount: number;
  lowCount: number;
  reportLinks: Array<{ title: string; htmlUrl: string; csvUrl: string; pdfUrl: string }>;
  s3Bucket?: string | null;
  s3FolderUrl?: string | null;
  error?: string | null;
}

function sectionLabel(text: string): Record<string, unknown> {
  return {
    type: 'TextBlock',
    text,
    weight: 'Bolder',
    size: 'Small',
    color: 'Accent',
    spacing: 'Medium',
  };
}

function sectionValue(text: string): Record<string, unknown> {
  return {
    type: 'TextBlock',
    text: text || '—',
    wrap: true,
    spacing: 'Small',
    fontType: 'Monospace',
    size: 'Small',
  };
}

function findingColumn(label: string, count: number, style: string, color: string): Record<string, unknown> {
  return {
    type: 'Column',
    width: 'stretch',
    items: [
      {
        type: 'Container',
        style,
        items: [
          {
            type: 'TextBlock',
            text: String(count),
            size: 'ExtraLarge',
            weight: 'Bolder',
            color,
            horizontalAlignment: 'Center',
          },
          {
            type: 'TextBlock',
            text: label,
            size: 'Small',
            horizontalAlignment: 'Center',
            spacing: 'None',
            isSubtle: true,
          },
        ],
      },
    ],
  };
}

export function buildSecurityScanTeamsCard(input: SecurityScanTeamsInput) {
  const failed = input.status === 'failed';
  const statusLabel = failed ? 'Failed' : 'Success';
  const statusEmoji = failed ? '❌' : '✅';
  const scanTypeLine = input.scanTypes.length ? input.scanTypes.join(' · ') : '—';

  const body: Record<string, unknown>[] = [
    {
      type: 'Container',
      style: 'accent',
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
                  text: '🛡️',
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
                  text: 'Security Scan Report',
                  weight: 'Bolder',
                  size: 'Large',
                  color: 'Accent',
                  wrap: true,
                },
                {
                  type: 'TextBlock',
                  text: input.title,
                  weight: 'Bolder',
                  spacing: 'None',
                  wrap: true,
                },
                {
                  type: 'TextBlock',
                  text: 'SecureNexus Security Automation',
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
                  text: statusEmoji,
                  size: 'ExtraLarge',
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
      type: 'Container',
      style: 'emphasis',
      spacing: 'Medium',
      items: [
        {
          type: 'TextBlock',
          text: 'Scan coverage',
          weight: 'Bolder',
          size: 'Small',
          color: 'Accent',
        },
        {
          type: 'TextBlock',
          text: scanTypeLine,
          wrap: true,
          spacing: 'Small',
          weight: 'Bolder',
        },
      ],
    },
  ];

  if (input.repositories.length) {
    body.push(
      {
        type: 'Container',
        spacing: 'Medium',
        items: [sectionLabel('Repositories'), sectionValue(input.repositories.join('\n'))],
      }
    );
  }

  if (input.urls.length) {
    body.push(
      {
        type: 'Container',
        spacing: 'Medium',
        items: [sectionLabel('URL'), sectionValue(input.urls.join('\n'))],
      }
    );
  }

  if (!failed) {
    body.push({
      type: 'Container',
      spacing: 'Medium',
      items: [
        sectionLabel('Findings'),
        {
          type: 'ColumnSet',
          spacing: 'Small',
          columns: [
            findingColumn('High', input.highCount, 'attention', 'Attention'),
            findingColumn('Medium', input.mediumCount, 'warning', 'Warning'),
            findingColumn('Low', input.lowCount, 'default', 'Default'),
          ],
        },
      ],
    });
  } else {
    body.push({
      type: 'Container',
      style: 'attention',
      spacing: 'Medium',
      items: [
        {
          type: 'TextBlock',
          text: 'Scan did not complete',
          weight: 'Bolder',
          color: 'Attention',
        },
        ...(input.error
          ? [
              {
                type: 'TextBlock',
                text: input.error,
                wrap: true,
                spacing: 'Small',
              },
            ]
          : []),
      ],
    });
  }

  body.push({
    type: 'FactSet',
    spacing: 'Medium',
    facts: [
      { title: 'Status', value: statusLabel },
      { title: 'Scheduled', value: input.scheduleSummary },
      { title: 'Triggered by', value: 'Security Automation' },
    ],
  });

  if (!failed && input.reportLinks.length > 0) {
    const reportActions: Record<string, unknown>[] = [];

    for (const report of input.reportLinks) {
      reportActions.push({
        type: 'ActionSet',
        spacing: 'Small',
        actions: [
          {
            type: 'Action.OpenUrl',
            title: `${report.title} · HTML`,
            url: report.htmlUrl,
            style: 'positive',
          },
          {
            type: 'Action.OpenUrl',
            title: 'CSV',
            url: report.csvUrl,
          },
          {
            type: 'Action.OpenUrl',
            title: 'PDF',
            url: report.pdfUrl,
          },
        ],
      });
    }

    body.push(
      {
        type: 'Container',
        style: 'good',
        spacing: 'Medium',
        items: [
          sectionLabel('Report URLs (S3)'),
          ...(input.s3Bucket
            ? [
                {
                  type: 'TextBlock',
                  text: `Bucket: ${input.s3Bucket}`,
                  isSubtle: true,
                  spacing: 'Small',
                  size: 'Small',
                },
              ]
            : []),
          ...reportActions,
          ...(input.s3FolderUrl
            ? [
                {
                  type: 'ActionSet',
                  actions: [
                    {
                      type: 'Action.OpenUrl',
                      title: 'Open S3 folder in AWS Console',
                      url: input.s3FolderUrl,
                    },
                  ],
                },
              ]
            : []),
        ],
      }
    );
  }

  body.push({
    type: 'TextBlock',
    text: `${statusEmoji} ${statusLabel}`,
    color: failed ? 'Attention' : 'Good',
    weight: 'Bolder',
    spacing: 'Medium',
  });

  return {
    type: 'message' as const,
    style: 'emphasis' as const,
    summary: `Security Scan Report — ${input.title}`,
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          body,
        },
      },
    ],
  };
}

export async function resolveAutomationTeamsWebhookUrl(
  teamsWebhookUrl: string | null | undefined
): Promise<string | null> {
  const direct = teamsWebhookUrl?.trim();
  if (direct) return direct;
  return (await getTeamsWebhookUrl()) ?? process.env.ALERTS_TEAMS_WEBHOOK_URL ?? null;
}

export async function sendAutomationTeamsNotification(input: {
  automation: {
    name: string;
    teamsEnabled: boolean;
    teamsWebhookUrl: string | null;
    scanCategories: unknown;
    scheduleFrequency?: string | null;
    scheduleTime: string;
    scheduleDays: unknown;
    scheduleDayOfMonth?: number | null;
    scheduleMonth?: number | null;
    scheduleStartDate?: string | null;
    timezone: string;
    resourceIds: unknown;
    s3Enabled?: boolean;
    s3Bucket?: string | null;
    s3Region?: string | null;
  };
  jobId: string | null;
  scanStatus: 'completed' | 'failed';
  scanError: string | null;
  s3Keys?: string[];
}): Promise<string | null> {
  if (!input.automation.teamsEnabled) return null;

  const webhookUrl = await resolveAutomationTeamsWebhookUrl(input.automation.teamsWebhookUrl);
  if (!webhookUrl) {
    return 'Teams webhook URL is not configured for this automation';
  }

  const resourceIds = parseStringArray(input.automation.resourceIds);
  const resources = resourceIds.length
    ? await prisma.securityResource.findMany({
        where: { id: { in: resourceIds } },
        select: { name: true, repoUrl: true, targetUrl: true, type: true },
      })
    : [];

  const reports = input.jobId
    ? await prisma.securityReport.findMany({
        where: { scanJobId: input.jobId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          title: true,
          highCount: true,
          mediumCount: true,
          lowCount: true,
        },
      })
    : [];

  const scanCategories = parseStringArray(input.automation.scanCategories);
  const scanTypes = scanCategories.map(
    (id) => SECURITY_TOOL_CATEGORIES.find((row) => row.id === id)?.label ?? id.toUpperCase()
  );

  const repositories = resources
    .filter((row) => row.type === 'repository' || (row.repoUrl && row.type !== 'target_url'))
    .map((row) => row.repoUrl ?? row.name)
    .filter((url): url is string => Boolean(url));

  const urls = resources
    .filter((row) => row.type === 'target_url' || (!row.repoUrl && row.targetUrl))
    .map((row) => row.targetUrl ?? row.name)
    .filter((url): url is string => Boolean(url));

  const schedule = automationScheduleRowFromRecord({
    enabled: true,
    scheduleFrequency: input.automation.scheduleFrequency,
    scheduleTime: input.automation.scheduleTime,
    scheduleDays: input.automation.scheduleDays,
    scheduleDayOfMonth: input.automation.scheduleDayOfMonth ?? null,
    scheduleMonth: input.automation.scheduleMonth ?? null,
    scheduleStartDate: input.automation.scheduleStartDate ?? null,
    timezone: input.automation.timezone,
  });

  const scheduleSummary = formatAutomationScheduleSummary(schedule);
  const failed = input.scanStatus !== 'completed';

  const highCount = reports.reduce((sum, row) => sum + row.highCount, 0);
  const mediumCount = reports.reduce((sum, row) => sum + row.mediumCount, 0);
  const lowCount = reports.reduce((sum, row) => sum + row.lowCount, 0);

  const s3Bucket = input.automation.s3Bucket?.trim() || null;
  const s3Region = input.automation.s3Region;
  const s3Keys = input.s3Keys ?? [];
  const reportLinks =
    s3Bucket && s3Keys.length
      ? groupS3ReportLinks({ bucket: s3Bucket, region: s3Region, keys: s3Keys })
      : [];

  const s3FolderPrefix =
    s3Keys[0]?.split('/').slice(0, -1).join('/') ?? null;
  const s3FolderUrl =
    s3Bucket && s3FolderPrefix
      ? buildS3ConsoleFolderUrl(s3Bucket, s3Region, s3FolderPrefix)
      : null;

  const card = buildSecurityScanTeamsCard({
    title: input.automation.name,
    scanTypes,
    repositories,
    urls,
    scheduleSummary,
    status: failed ? 'failed' : 'success',
    highCount,
    mediumCount,
    lowCount,
    reportLinks,
    s3Bucket,
    s3FolderUrl,
    error: input.scanError,
  });

  const result = await sendTeamsWebhook(webhookUrl, card);

  if (!result.ok) {
    console.error(
      `[SecurityAutomation] Teams notification failed for "${input.automation.name}": ${result.message}`
    );
    return result.message;
  }

  console.log(`[SecurityAutomation] Teams notification sent for "${input.automation.name}"`);
  return null;
}

export async function sendAutomationTeamsTestNotification(input: {
  name?: string;
  teamsWebhookUrl?: string | null;
  scanCategories?: string[];
  resourceIds?: string[];
  s3Bucket?: string | null;
  s3Region?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  const webhookUrl = await resolveAutomationTeamsWebhookUrl(input.teamsWebhookUrl ?? null);
  if (!webhookUrl) {
    return { ok: false, message: 'Teams webhook URL is not configured' };
  }

  const resourceIds = input.resourceIds ?? [];
  const resources = resourceIds.length
    ? await prisma.securityResource.findMany({
        where: { id: { in: resourceIds } },
        select: { name: true, repoUrl: true, targetUrl: true, type: true },
      })
    : [];

  const repositories = resources
    .filter((row) => row.type === 'repository' || (row.repoUrl && row.type !== 'target_url'))
    .map((row) => row.repoUrl ?? row.name)
    .filter((url): url is string => Boolean(url));

  const urls = resources
    .filter((row) => row.type === 'target_url' || (!row.repoUrl && row.targetUrl))
    .map((row) => row.targetUrl ?? row.name)
    .filter((url): url is string => Boolean(url));

  const scanTypes = (input.scanCategories ?? ['sast', 'sca']).map(
    (id) => SECURITY_TOOL_CATEGORIES.find((row) => row.id === id)?.label ?? id.toUpperCase()
  );

  const bucket = input.s3Bucket?.trim() || 'my-security-reports';
  const region = input.s3Region?.trim() || 'us-east-1';
  const folder = 'security-reports/sample-automation/2026-07-07-16-52';
  const sampleLinks = [
    {
      title: 'SAST Report',
      htmlUrl: `https://${bucket}.s3.${region}.amazonaws.com/${folder}/sast-report.html`,
      csvUrl: `https://${bucket}.s3.${region}.amazonaws.com/${folder}/sast-report.csv`,
      pdfUrl: `https://${bucket}.s3.${region}.amazonaws.com/${folder}/sast-report.pdf`,
    },
  ];

  const card = buildSecurityScanTeamsCard({
    title: input.name || 'Security Scan Test',
    scanTypes,
    repositories: repositories.length ? repositories : ['https://bitbucket.org/org/sample-repo.git'],
    urls,
    scheduleSummary: 'Once on 2026-07-07 at 12:00 UTC',
    status: 'success',
    highCount: 2,
    mediumCount: 5,
    lowCount: 3,
    reportLinks: sampleLinks,
    s3Bucket: bucket,
    s3FolderUrl: buildS3ConsoleFolderUrl(bucket, region, folder),
  });

  const result = await sendTeamsWebhook(webhookUrl, card);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, message: 'Test Teams notification sent' };
}
