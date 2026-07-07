import prisma from './prisma';
import { assertSecurityModuleEnabled } from './security-service';
import type { SecurityToolCategory } from './security-tools';
import {
  formatAutomationScheduleSummary,
  normalizeScheduleFrequency,
  validateAutomationSchedule,
  type AutomationScheduleFrequency,
} from './security-automation-schedule';

export interface SecurityAutomationView {
  id: string;
  name: string;
  enabled: boolean;
  scheduleFrequency: AutomationScheduleFrequency;
  scheduleTime: string;
  scheduleDays: number[];
  scheduleDayOfMonth: number | null;
  scheduleMonth: number | null;
  scheduleStartDate: string | null;
  timezone: string;
  scheduleSummary: string;
  resourceIds: string[];
  scanCategories: SecurityToolCategory[];
  toolIds: string[];
  s3Enabled: boolean;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Prefix: string | null;
  awsCredentialId: string | null;
  s3SecretConfigured: boolean;
  teamsEnabled: boolean;
  teamsWebhookUrl: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === 'number');
}

function toAutomationView(row: {
  id: string;
  name: string;
  enabled: boolean;
  scheduleFrequency?: string | null;
  scheduleTime: string;
  scheduleDays: unknown;
  scheduleDayOfMonth?: number | null;
  scheduleMonth?: number | null;
  scheduleStartDate?: string | null;
  timezone: string;
  resourceIds: unknown;
  scanCategories: unknown;
  toolIds: unknown;
  s3Enabled: boolean;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Prefix: string | null;
  awsCredentialId?: string | null;
  s3AccessKeyId: string | null;
  s3SecretAccessKey: string | null;
  teamsEnabled: boolean;
  teamsWebhookUrl: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SecurityAutomationView {
  const scheduleFrequency = normalizeScheduleFrequency(row.scheduleFrequency);
  const scheduleDays = parseNumberArray(row.scheduleDays);
  const scheduleDayOfMonth = row.scheduleDayOfMonth ?? null;
  const scheduleMonth = row.scheduleMonth ?? null;
  const scheduleStartDate = row.scheduleStartDate ?? null;

  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    scheduleFrequency,
    scheduleTime: row.scheduleTime,
    scheduleDays,
    scheduleDayOfMonth,
    scheduleMonth,
    scheduleStartDate,
    timezone: row.timezone,
    scheduleSummary: formatAutomationScheduleSummary({
      scheduleFrequency,
      scheduleTime: row.scheduleTime,
      scheduleDays,
      scheduleDayOfMonth,
      scheduleMonth,
      scheduleStartDate,
      timezone: row.timezone,
    }),
    resourceIds: parseStringArray(row.resourceIds),
    scanCategories: parseStringArray(row.scanCategories) as SecurityToolCategory[],
    toolIds: parseStringArray(row.toolIds),
    s3Enabled: row.s3Enabled,
    s3Bucket: row.s3Bucket,
    s3Region: row.s3Region,
    s3Prefix: row.s3Prefix,
    awsCredentialId: row.awsCredentialId ?? null,
    s3SecretConfigured: Boolean(row.awsCredentialId || row.s3SecretAccessKey),
    teamsEnabled: row.teamsEnabled,
    teamsWebhookUrl: row.teamsWebhookUrl,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type AutomationWriteInput = {
  name: string;
  enabled?: boolean;
  scheduleFrequency: AutomationScheduleFrequency;
  scheduleTime: string;
  scheduleDays: number[];
  scheduleDayOfMonth?: number | null;
  scheduleMonth?: number | null;
  scheduleStartDate?: string | null;
  timezone?: string;
  resourceIds: string[];
  scanCategories: SecurityToolCategory[];
  toolIds: string[];
  s3Enabled?: boolean;
  s3Bucket?: string;
  s3Region?: string;
  s3Prefix?: string;
  awsCredentialId?: string | null;
  teamsEnabled?: boolean;
  teamsWebhookUrl?: string;
  createdBy?: string;
};

function assertValidAutomationInput(input: AutomationWriteInput): void {
  const scheduleError = validateAutomationSchedule({
    scheduleFrequency: input.scheduleFrequency,
    scheduleTime: input.scheduleTime,
    scheduleDays: input.scheduleDays,
    scheduleDayOfMonth: input.scheduleDayOfMonth ?? null,
    scheduleMonth: input.scheduleMonth ?? null,
    scheduleStartDate: input.scheduleStartDate ?? null,
    timezone: input.timezone?.trim() || 'UTC',
  });
  if (scheduleError) throw new Error(scheduleError);

  if (!input.name.trim()) throw new Error('Automation name is required.');
  if (!input.resourceIds.length) throw new Error('Select at least one repository or URL target.');
  if (!input.scanCategories.length) throw new Error('Select at least one scan type.');
  if (!input.toolIds.length) throw new Error('Select at least one tool.');

  if (input.s3Enabled && !input.s3Bucket?.trim()) {
    throw new Error('S3 bucket name is required when S3 upload is enabled.');
  }
  if (input.s3Enabled && !input.awsCredentialId?.trim()) {
    throw new Error('Select an AWS credential from Admin → Settings for S3 upload.');
  }
}

function buildAutomationData(input: AutomationWriteInput) {
  return {
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    scheduleFrequency: input.scheduleFrequency,
    scheduleTime: input.scheduleTime,
    scheduleDays: input.scheduleDays,
    scheduleDayOfMonth: input.scheduleDayOfMonth ?? null,
    scheduleMonth: input.scheduleMonth ?? null,
    scheduleStartDate: input.scheduleStartDate?.trim() || null,
    timezone: input.timezone?.trim() || 'UTC',
    resourceIds: input.resourceIds,
    scanCategories: input.scanCategories,
    toolIds: input.toolIds,
    s3Enabled: input.s3Enabled ?? false,
    s3Bucket: input.s3Bucket?.trim() || null,
    s3Region: input.s3Region?.trim() || null,
    s3Prefix: input.s3Prefix?.trim() || null,
    awsCredentialId: input.awsCredentialId?.trim() || null,
    s3AccessKeyId: null,
    s3SecretAccessKey: null,
    teamsEnabled: input.teamsEnabled ?? false,
    teamsWebhookUrl: input.teamsWebhookUrl?.trim() || null,
    createdBy: input.createdBy ?? null,
  };
}

export async function listSecurityAutomations(): Promise<SecurityAutomationView[]> {
  await assertSecurityModuleEnabled();
  const rows = await prisma.securityAutomation.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toAutomationView);
}

export async function createSecurityAutomation(
  input: AutomationWriteInput
): Promise<SecurityAutomationView> {
  await assertSecurityModuleEnabled();
  assertValidAutomationInput(input);

  const row = await prisma.securityAutomation.create({
    data: buildAutomationData(input),
  });

  return toAutomationView(row);
}

export async function updateSecurityAutomation(
  id: string,
  input: Partial<AutomationWriteInput> & { enabled?: boolean }
): Promise<SecurityAutomationView> {
  await assertSecurityModuleEnabled();

  const existing = await prisma.securityAutomation.findUnique({ where: { id } });
  if (!existing) throw new Error('Automation not found');

  const merged: AutomationWriteInput = {
    name: input.name ?? existing.name,
    enabled: input.enabled ?? existing.enabled,
    scheduleFrequency: input.scheduleFrequency ?? normalizeScheduleFrequency(existing.scheduleFrequency),
    scheduleTime: input.scheduleTime ?? existing.scheduleTime,
    scheduleDays: input.scheduleDays ?? parseNumberArray(existing.scheduleDays),
    scheduleDayOfMonth:
      input.scheduleDayOfMonth !== undefined
        ? input.scheduleDayOfMonth
        : existing.scheduleDayOfMonth,
    scheduleMonth: input.scheduleMonth !== undefined ? input.scheduleMonth : existing.scheduleMonth,
    scheduleStartDate:
      input.scheduleStartDate !== undefined
        ? input.scheduleStartDate
        : existing.scheduleStartDate,
    timezone: input.timezone ?? existing.timezone,
    resourceIds: input.resourceIds ?? parseStringArray(existing.resourceIds),
    scanCategories:
      input.scanCategories ??
      (parseStringArray(existing.scanCategories) as SecurityToolCategory[]),
    toolIds: input.toolIds ?? parseStringArray(existing.toolIds),
    s3Enabled: input.s3Enabled ?? existing.s3Enabled,
    s3Bucket: input.s3Bucket === undefined ? existing.s3Bucket ?? undefined : input.s3Bucket ?? undefined,
    s3Region: input.s3Region === undefined ? existing.s3Region ?? undefined : input.s3Region ?? undefined,
    s3Prefix: input.s3Prefix === undefined ? existing.s3Prefix ?? undefined : input.s3Prefix ?? undefined,
    awsCredentialId:
      input.awsCredentialId === undefined
        ? existing.awsCredentialId
        : input.awsCredentialId,
    teamsEnabled: input.teamsEnabled ?? existing.teamsEnabled,
    teamsWebhookUrl:
      input.teamsWebhookUrl === undefined
        ? existing.teamsWebhookUrl ?? undefined
        : input.teamsWebhookUrl ?? undefined,
  };

  assertValidAutomationInput(merged);

  const row = await prisma.securityAutomation.update({
    where: { id },
    data: {
      name: merged.name.trim(),
      enabled: merged.enabled,
      scheduleFrequency: merged.scheduleFrequency,
      scheduleTime: merged.scheduleTime,
      scheduleDays: merged.scheduleDays,
      scheduleDayOfMonth: merged.scheduleDayOfMonth ?? null,
      scheduleMonth: merged.scheduleMonth ?? null,
      scheduleStartDate: merged.scheduleStartDate?.trim() || null,
      timezone: merged.timezone?.trim() || 'UTC',
      resourceIds: merged.resourceIds,
      scanCategories: merged.scanCategories,
      toolIds: merged.toolIds,
      s3Enabled: merged.s3Enabled ?? false,
      s3Bucket: merged.s3Bucket?.trim() || null,
      s3Region: merged.s3Region?.trim() || null,
      s3Prefix: merged.s3Prefix?.trim() || null,
      awsCredentialId: merged.awsCredentialId?.trim() || null,
      s3AccessKeyId: null,
      s3SecretAccessKey: null,
      teamsEnabled: merged.teamsEnabled ?? false,
      teamsWebhookUrl: merged.teamsWebhookUrl?.trim() || null,
    },
  });

  return toAutomationView(row);
}

export async function deleteSecurityAutomation(id: string): Promise<void> {
  await assertSecurityModuleEnabled();
  await prisma.securityAutomation.delete({ where: { id } });
}
