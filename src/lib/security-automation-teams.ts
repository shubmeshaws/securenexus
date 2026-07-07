import prisma from '@/lib/prisma';
import { getTeamsWebhookUrl } from '@/lib/alert-settings';
import { getAppUrl } from '@/lib/google-auth';
import {
  automationScheduleRowFromRecord,
  formatAutomationScheduleSummary,
} from '@/lib/security-automation-schedule';
import { SECURITY_TOOL_CATEGORIES } from '@/lib/security-tools';
import { sendTeamsWebhook } from '@/lib/teams-webhook';

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function buildFindingsLabel(
  reports: Array<{ highCount: number; mediumCount: number; lowCount: number }>,
  failed: boolean
): string {
  if (failed) return 'Scan did not complete';
  if (!reports.length) return 'No findings recorded';

  const high = reports.reduce((sum, row) => sum + row.highCount, 0);
  const medium = reports.reduce((sum, row) => sum + row.mediumCount, 0);
  const low = reports.reduce((sum, row) => sum + row.lowCount, 0);
  const total = high + medium + low;

  if (total === 0) return 'No vulnerabilities reported';
  return `${high} High · ${medium} Medium · ${low} Low`;
}

export function buildSecurityAutomationTeamsMessage(input: {
  title: string;
  scanTypes: string[];
  repoUrls: string[];
  status: 'success' | 'failed';
  findingsLabel: string;
  scheduleSummary: string;
  reportUrls: string[];
  errorMessage?: string | null;
}) {
  const facts: { title: string; value: string }[] = [
    {
      title: 'Type of Reports',
      value: input.scanTypes.length ? input.scanTypes.join(', ') : '—',
    },
    {
      title: 'Repository',
      value: input.repoUrls.length ? input.repoUrls.join('\n') : '—',
    },
    {
      title: 'Status',
      value: input.status === 'success' ? 'Success' : 'Failed',
    },
    {
      title: 'Findings',
      value: input.findingsLabel,
    },
    {
      title: 'Scheduled',
      value: input.scheduleSummary,
    },
  ];

  const body: Record<string, unknown>[] = [
    {
      type: 'TextBlock',
      text: input.title,
      weight: 'Bolder',
      size: 'Large',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: 'SecureNexus Security Automation',
      isSubtle: true,
      spacing: 'None',
      size: 'Small',
    },
    {
      type: 'FactSet',
      spacing: 'Medium',
      facts,
    },
  ];

  if (input.reportUrls.length > 0) {
    body.push({
      type: 'TextBlock',
      text: 'Report URL',
      weight: 'Bolder',
      spacing: 'Medium',
    });
    for (const url of input.reportUrls) {
      body.push({
        type: 'TextBlock',
        text: url,
        wrap: true,
        color: 'Accent',
        spacing: 'Small',
      });
    }
  }

  if (input.errorMessage) {
    body.push({
      type: 'TextBlock',
      text: input.errorMessage,
      color: 'Attention',
      wrap: true,
      spacing: 'Medium',
    });
  }

  return {
    type: 'message',
    summary: `${input.title} — ${input.status === 'success' ? 'Success' : 'Failed'}`,
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
  };
  jobId: string;
  scanStatus: 'completed' | 'failed';
  scanError: string | null;
}): Promise<string | null> {
  if (!input.automation.teamsEnabled) return null;

  let webhookUrl = input.automation.teamsWebhookUrl?.trim() || '';
  if (!webhookUrl) {
    webhookUrl = (await getTeamsWebhookUrl()) ?? '';
  }
  if (!webhookUrl) {
    return 'Teams webhook URL is not configured for this automation';
  }

  const resourceIds = parseStringArray(input.automation.resourceIds);
  const resources = resourceIds.length
    ? await prisma.securityResource.findMany({
        where: { id: { in: resourceIds } },
        select: { name: true, repoUrl: true, targetUrl: true },
      })
    : [];

  const reports = await prisma.securityReport.findMany({
    where: { scanJobId: input.jobId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      title: true,
      highCount: true,
      mediumCount: true,
      lowCount: true,
    },
  });

  const scanCategories = parseStringArray(input.automation.scanCategories);
  const scanTypes = scanCategories.map(
    (id) => SECURITY_TOOL_CATEGORIES.find((row) => row.id === id)?.label ?? id.toUpperCase()
  );

  const repoUrls = resources
    .map((row) => row.repoUrl ?? row.targetUrl ?? row.name)
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

  const appUrl = getAppUrl().replace(/\/$/, '');
  const reportUrls = reports.map(
    (report) => `${appUrl}/api/security/reports/${report.id}/download?format=html`
  );

  const failed = input.scanStatus !== 'completed';
  const payload = buildSecurityAutomationTeamsMessage({
    title: input.automation.name,
    scanTypes,
    repoUrls,
    status: failed ? 'failed' : 'success',
    findingsLabel: buildFindingsLabel(reports, failed),
    scheduleSummary: formatAutomationScheduleSummary(schedule),
    reportUrls: failed ? [] : reportUrls,
    errorMessage: failed ? input.scanError : null,
  });

  const result = await sendTeamsWebhook(webhookUrl, payload);
  if (!result.ok) {
    return result.message;
  }

  console.log(`[SecurityAutomation] Teams notification sent for "${input.automation.name}"`);
  return null;
}
