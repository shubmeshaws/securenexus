import prisma from './prisma';
import { assertSecurityModuleEnabled } from './security-service';
import type { SecurityToolCategory } from './security-tools';

export interface SecurityAutomationView {
  id: string;
  name: string;
  enabled: boolean;
  scheduleTime: string;
  scheduleDays: number[];
  timezone: string;
  resourceIds: string[];
  scanCategories: SecurityToolCategory[];
  toolIds: string[];
  s3Enabled: boolean;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Prefix: string | null;
  s3AccessKeyId: string | null;
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
  scheduleTime: string;
  scheduleDays: unknown;
  timezone: string;
  resourceIds: unknown;
  scanCategories: unknown;
  toolIds: unknown;
  s3Enabled: boolean;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Prefix: string | null;
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
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    scheduleTime: row.scheduleTime,
    scheduleDays: parseNumberArray(row.scheduleDays),
    timezone: row.timezone,
    resourceIds: parseStringArray(row.resourceIds),
    scanCategories: parseStringArray(row.scanCategories) as SecurityToolCategory[],
    toolIds: parseStringArray(row.toolIds),
    s3Enabled: row.s3Enabled,
    s3Bucket: row.s3Bucket,
    s3Region: row.s3Region,
    s3Prefix: row.s3Prefix,
    s3AccessKeyId: row.s3AccessKeyId,
    s3SecretConfigured: Boolean(row.s3SecretAccessKey),
    teamsEnabled: row.teamsEnabled,
    teamsWebhookUrl: row.teamsWebhookUrl,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSecurityAutomations(): Promise<SecurityAutomationView[]> {
  await assertSecurityModuleEnabled();
  const rows = await prisma.securityAutomation.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toAutomationView);
}

export async function createSecurityAutomation(input: {
  name: string;
  enabled?: boolean;
  scheduleTime: string;
  scheduleDays: number[];
  timezone?: string;
  resourceIds: string[];
  scanCategories: SecurityToolCategory[];
  toolIds: string[];
  s3Enabled?: boolean;
  s3Bucket?: string;
  s3Region?: string;
  s3Prefix?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  teamsEnabled?: boolean;
  teamsWebhookUrl?: string;
  createdBy?: string;
}): Promise<SecurityAutomationView> {
  await assertSecurityModuleEnabled();

  const row = await prisma.securityAutomation.create({
    data: {
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      scheduleTime: input.scheduleTime,
      scheduleDays: input.scheduleDays,
      timezone: input.timezone?.trim() || 'UTC',
      resourceIds: input.resourceIds,
      scanCategories: input.scanCategories,
      toolIds: input.toolIds,
      s3Enabled: input.s3Enabled ?? false,
      s3Bucket: input.s3Bucket?.trim() || null,
      s3Region: input.s3Region?.trim() || null,
      s3Prefix: input.s3Prefix?.trim() || null,
      s3AccessKeyId: input.s3AccessKeyId?.trim() || null,
      s3SecretAccessKey: input.s3SecretAccessKey?.trim() || null,
      teamsEnabled: input.teamsEnabled ?? false,
      teamsWebhookUrl: input.teamsWebhookUrl?.trim() || null,
      createdBy: input.createdBy ?? null,
    },
  });

  return toAutomationView(row);
}

export async function updateSecurityAutomation(
  id: string,
  input: {
    name?: string;
    enabled?: boolean;
    scheduleTime?: string;
    scheduleDays?: number[];
    timezone?: string;
    resourceIds?: string[];
    scanCategories?: SecurityToolCategory[];
    toolIds?: string[];
    s3Enabled?: boolean;
    s3Bucket?: string | null;
    s3Region?: string | null;
    s3Prefix?: string | null;
    s3AccessKeyId?: string | null;
    s3SecretAccessKey?: string | null;
    teamsEnabled?: boolean;
    teamsWebhookUrl?: string | null;
  }
): Promise<SecurityAutomationView> {
  await assertSecurityModuleEnabled();

  const existing = await prisma.securityAutomation.findUnique({ where: { id } });
  if (!existing) throw new Error('Automation not found');

  const secret =
    input.s3SecretAccessKey === undefined
      ? undefined
      : input.s3SecretAccessKey?.trim() || null;

  const row = await prisma.securityAutomation.update({
    where: { id },
    data: {
      name: input.name?.trim(),
      enabled: input.enabled,
      scheduleTime: input.scheduleTime,
      scheduleDays: input.scheduleDays,
      timezone: input.timezone?.trim(),
      resourceIds: input.resourceIds,
      scanCategories: input.scanCategories,
      toolIds: input.toolIds,
      s3Enabled: input.s3Enabled,
      s3Bucket: input.s3Bucket === undefined ? undefined : input.s3Bucket?.trim() || null,
      s3Region: input.s3Region === undefined ? undefined : input.s3Region?.trim() || null,
      s3Prefix: input.s3Prefix === undefined ? undefined : input.s3Prefix?.trim() || null,
      s3AccessKeyId:
        input.s3AccessKeyId === undefined ? undefined : input.s3AccessKeyId?.trim() || null,
      s3SecretAccessKey: secret,
      teamsEnabled: input.teamsEnabled,
      teamsWebhookUrl:
        input.teamsWebhookUrl === undefined ? undefined : input.teamsWebhookUrl?.trim() || null,
    },
  });

  return toAutomationView(row);
}

export async function deleteSecurityAutomation(id: string): Promise<void> {
  await assertSecurityModuleEnabled();
  await prisma.securityAutomation.delete({ where: { id } });
}
