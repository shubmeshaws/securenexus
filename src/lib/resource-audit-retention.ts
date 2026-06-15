import { subMonths, subWeeks, subYears } from 'date-fns';
import prisma from './prisma';
import { getSetting, SETTING_KEYS } from './settings';
import { formatDateInputIST, parseDateInputStartIST } from './utils';

export const RESOURCE_AUDIT_RETENTION_UNITS = ['weeks', 'months', 'years'] as const;
export type ResourceAuditRetentionUnit = (typeof RESOURCE_AUDIT_RETENTION_UNITS)[number];

export const DEFAULT_RESOURCE_AUDIT_DATA_START = '2026-06-01';
export const DEFAULT_RESOURCE_AUDIT_RETENTION_AMOUNT = 3;
export const DEFAULT_RESOURCE_AUDIT_RETENTION_UNIT: ResourceAuditRetentionUnit = 'months';

export interface ResourceAuditRetentionConfig {
  amount: number;
  unit: ResourceAuditRetentionUnit;
  dataStartDate: string;
}

export interface ResourceAuditDataWindow {
  dataAvailableFrom: Date;
  dataAvailableFromIso: string;
  dataAvailableFromLabel: string;
  retentionCutoff: Date;
  retentionLabel: string;
  dataStartDate: string;
  retentionAmount: number;
  retentionUnit: ResourceAuditRetentionUnit;
}

function parseRetentionUnit(raw: string | null | undefined): ResourceAuditRetentionUnit {
  const unit = raw?.trim().toLowerCase();
  if (unit === 'weeks' || unit === 'months' || unit === 'years') return unit;
  return DEFAULT_RESOURCE_AUDIT_RETENTION_UNIT;
}

function parseRetentionAmount(raw: string | null | undefined, unit: ResourceAuditRetentionUnit): number {
  const n = parseInt(raw?.trim() ?? '', 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_RESOURCE_AUDIT_RETENTION_AMOUNT;
  }
  const max = unit === 'weeks' ? 52 : unit === 'months' ? 36 : 10;
  return Math.min(max, n);
}

function parseDataStartDate(raw: string | null | undefined): string {
  const value = raw?.trim();
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return DEFAULT_RESOURCE_AUDIT_DATA_START;
}

export function retentionLabel(amount: number, unit: ResourceAuditRetentionUnit): string {
  const noun = amount === 1 ? unit.slice(0, -1) : unit;
  return `${amount} ${noun}`;
}

export function computeRetentionCutoff(
  config: Pick<ResourceAuditRetentionConfig, 'amount' | 'unit'>,
  now: Date = new Date()
): Date {
  if (config.unit === 'weeks') return subWeeks(now, config.amount);
  if (config.unit === 'years') return subYears(now, config.amount);
  return subMonths(now, config.amount);
}

export async function getResourceAuditRetentionConfig(): Promise<ResourceAuditRetentionConfig> {
  const [amountRaw, unitRaw, startRaw] = await Promise.all([
    getSetting(SETTING_KEYS.RESOURCE_AUDIT_RETENTION_AMOUNT),
    getSetting(SETTING_KEYS.RESOURCE_AUDIT_RETENTION_UNIT),
    getSetting(SETTING_KEYS.RESOURCE_AUDIT_DATA_START_DATE),
  ]);

  const unit = parseRetentionUnit(unitRaw);
  return {
    amount: parseRetentionAmount(amountRaw, unit),
    unit,
    dataStartDate: parseDataStartDate(startRaw),
  };
}

export async function getResourceAuditDataWindow(
  now: Date = new Date()
): Promise<ResourceAuditDataWindow> {
  const config = await getResourceAuditRetentionConfig();
  const dataStart = parseDateInputStartIST(config.dataStartDate);
  const retentionCutoff = computeRetentionCutoff(config, now);
  const dataAvailableFrom =
    retentionCutoff.getTime() > dataStart.getTime() ? retentionCutoff : dataStart;

  return {
    dataAvailableFrom,
    dataAvailableFromIso: dataAvailableFrom.toISOString(),
    dataAvailableFromLabel: formatDateInputIST(dataAvailableFrom),
    retentionCutoff,
    retentionLabel: retentionLabel(config.amount, config.unit),
    dataStartDate: config.dataStartDate,
    retentionAmount: config.amount,
    retentionUnit: config.unit,
  };
}

/** Delete resource audit + git rows older than the effective retention window. */
export async function pruneResourceAuditDataByRetention(): Promise<{
  auditDeleted: number;
  gitDeleted: number;
}> {
  const { dataAvailableFrom } = await getResourceAuditDataWindow();

  const [auditDeleted, gitDeleted] = await Promise.all([
    prisma.resourceChangeAudit.deleteMany({
      where: { syncedAt: { lt: dataAvailableFrom } },
    }),
    prisma.gitResourceChange.deleteMany({
      where: { committedAt: { lt: dataAvailableFrom } },
    }),
  ]);

  return {
    auditDeleted: auditDeleted.count,
    gitDeleted: gitDeleted.count,
  };
}

export function clampAuditFromDate(
  requestedFrom: Date | undefined,
  dataAvailableFrom: Date
): Date {
  if (!requestedFrom) return dataAvailableFrom;
  return requestedFrom.getTime() > dataAvailableFrom.getTime() ? requestedFrom : dataAvailableFrom;
}
