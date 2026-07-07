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
  };
  jobId: string | null;
  scanStatus: 'completed' | 'failed';
  scanError: string | null;
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
        select: { name: true, repoUrl: true, targetUrl: true },
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

  const scheduleSummary = formatAutomationScheduleSummary(schedule);
  const failed = input.scanStatus !== 'completed';
  const findingsLabel = buildFindingsLabel(reports, failed);
  const appUrl = getAppUrl().replace(/\/$/, '');
  const reportUrls = reports.map(
    (report) => `${appUrl}/api/security/reports/${report.id}/download?format=html`
  );

  const messageParts = [
    `Type of reports: ${scanTypes.length ? scanTypes.join(', ') : '—'}`,
    `Repositories:\n${repoUrls.length ? repoUrls.join('\n') : '—'}`,
    `Findings: ${findingsLabel}`,
    `Scheduled: ${scheduleSummary}`,
  ];

  if (!failed && reportUrls.length > 0) {
    messageParts.push(`Report URLs:\n${reportUrls.join('\n')}`);
  }
  if (failed && input.scanError) {
    messageParts.push(`Error: ${input.scanError}`);
  }

  const result = await sendTeamsWebhook(webhookUrl, {
    title: input.automation.name,
    message: messageParts.join('\n\n'),
    action: 'security-scan',
    cluster: 'Security Automation',
    namespace: scanTypes.join(', ') || 'Security',
    appName: repoUrls[0] ?? input.automation.name,
    triggeredBy: 'Security Automation',
    status: failed ? 'failed' : 'success',
  });

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
}): Promise<{ ok: boolean; message: string }> {
  const webhookUrl = await resolveAutomationTeamsWebhookUrl(input.teamsWebhookUrl ?? null);
  if (!webhookUrl) {
    return { ok: false, message: 'Teams webhook URL is not configured' };
  }

  const error = await sendAutomationTeamsNotification({
    automation: {
      name: input.name || 'Security Scan Test',
      teamsEnabled: true,
      teamsWebhookUrl: webhookUrl,
      scanCategories: input.scanCategories ?? ['sast', 'sca'],
      scheduleFrequency: 'once',
      scheduleTime: '12:00',
      scheduleDays: [],
      scheduleDayOfMonth: null,
      scheduleMonth: null,
      scheduleStartDate: new Date().toISOString().slice(0, 10),
      timezone: 'UTC',
      resourceIds: input.resourceIds ?? [],
    },
    jobId: null,
    scanStatus: 'completed',
    scanError: null,
  });

  if (error) return { ok: false, message: error };
  return { ok: true, message: 'Test Teams notification sent' };
}
