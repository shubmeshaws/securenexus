import type { Schedule } from '@prisma/client';
import { createScheduleSchema } from '@/lib/validation';
import { formatZonedDatetimeInput } from '@/lib/schedule-recurrence';

export const SCHEDULE_CSV_HEADERS = [
  'name',
  'platform_type',
  'cluster',
  'namespace',
  'scope',
  'app_name',
  'workload_kind',
  'excluded_workloads',
  'aws_credential_id',
  'ec2_instance_id',
  'ec2_region',
  'recurrence',
  'timezone',
  'shutdown_time',
  'startup_time',
  'days_of_week',
  'weekend_shutdown_time',
  'weekend_startup_time',
  'weekend_days',
  'shutdown_day_of_week',
  'startup_day_of_week',
  'window_repeat_weekly',
  'overnight_days',
  'overnight_shutdown_time',
  'overnight_startup_time',
  'one_time_shutdown_at',
  'one_time_startup_at',
  'sync_policy',
  'argocd_instance_id',
  'target_replicas',
  'enabled',
  'teams_alert_enabled',
] as const;

type CsvHeader = (typeof SCHEDULE_CSV_HEADERS)[number];

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function joinIntList(values: number[]): string {
  return values.join(',');
}

function joinExcludedWorkloads(values: string[]): string {
  return values.join(';');
}

function formatOptionalDate(date: Date | null | undefined, timezone: string): string {
  if (!date) return '';
  return formatZonedDatetimeInput(date, timezone);
}

function formatBool(value: boolean): string {
  return value ? 'true' : 'false';
}

export function scheduleToCsvRow(schedule: Schedule): string[] {
  const tz = schedule.timezone || 'UTC';
  return [
    schedule.name,
    schedule.platformType,
    schedule.cluster,
    schedule.namespace,
    schedule.scope,
    schedule.appName,
    schedule.workloadKind,
    joinExcludedWorkloads(schedule.excludedWorkloads),
    schedule.awsCredentialId ?? '',
    schedule.ec2InstanceId ?? '',
    schedule.ec2Region ?? '',
    schedule.recurrence,
    schedule.timezone,
    schedule.shutdownTime,
    schedule.startupTime,
    joinIntList(schedule.daysOfWeek),
    schedule.weekendShutdownTime ?? '',
    schedule.weekendStartupTime ?? '',
    joinIntList(schedule.weekendDays),
    schedule.shutdownDayOfWeek != null ? String(schedule.shutdownDayOfWeek) : '',
    schedule.startupDayOfWeek != null ? String(schedule.startupDayOfWeek) : '',
    formatBool(schedule.windowRepeatWeekly),
    joinIntList(schedule.overnightDays),
    schedule.overnightShutdownTime ?? '',
    schedule.overnightStartupTime ?? '',
    formatOptionalDate(schedule.oneTimeShutdownAt, tz),
    formatOptionalDate(schedule.oneTimeStartupAt, tz),
    schedule.syncPolicy,
    schedule.argocdInstanceId ?? '',
    String(schedule.targetReplicas),
    formatBool(schedule.enabled),
    formatBool(schedule.teamsAlertEnabled),
  ];
}

export function schedulesToCsv(schedules: Schedule[]): string {
  const lines = [
    SCHEDULE_CSV_HEADERS.join(','),
    ...schedules.map((schedule) => scheduleToCsvRow(schedule).map((v) => csvEscape(String(v))).join(',')),
  ];
  return lines.join('\n');
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || (c === '\r' && next === '\n')) {
      row.push(field);
      field = '';
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      if (c === '\r') i++;
    } else if (c !== '\r') {
      field += c;
    }
  }

  row.push(field);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function parseIntList(value: string): number[] {
  if (!value.trim()) return [];
  return value
    .split(',')
    .map((part) => parseInt(part.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

function parseExcludedWorkloads(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseOptionalInt(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = parseInt(trimmed, 10);
  return Number.isNaN(n) ? undefined : n;
}

function parseBool(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'true' || v === 'yes' || v === '1') return true;
  if (v === 'false' || v === 'no' || v === '0') return false;
  return undefined;
}

function parseOptionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseNullableString(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function flattenZodError(error: { flatten: () => { formErrors: string[]; fieldErrors: Record<string, string[]> } }): string {
  const flat = error.flatten();
  const messages = [
    ...flat.formErrors,
    ...Object.entries(flat.fieldErrors).flatMap(([field, msgs]) => msgs.map((msg) => `${field}: ${msg}`)),
  ];
  return messages.join('; ') || 'Invalid schedule row';
}

export function csvRowToScheduleInput(cells: string[], headerIndex: Map<string, number>): Record<string, unknown> {
  const get = (header: CsvHeader): string => {
    const idx = headerIndex.get(header);
    if (idx == null) return '';
    return cells[idx] ?? '';
  };

  const recurrence = (parseOptionalString(get('recurrence')) ?? 'daily') as
    | 'daily'
    | 'onetime'
    | 'split'
    | 'window'
    | 'combined';

  const input: Record<string, unknown> = {
    name: get('name').trim(),
    platformType: parseOptionalString(get('platform_type')) ?? 'eks',
    cluster: get('cluster').trim(),
    namespace: get('namespace').trim(),
    scope: parseOptionalString(get('scope')) ?? 'workload',
    appName: parseOptionalString(get('app_name')),
    workloadKind: parseOptionalString(get('workload_kind')) ?? 'Deployment',
    excludedWorkloads: parseExcludedWorkloads(get('excluded_workloads')),
    awsCredentialId: parseNullableString(get('aws_credential_id')),
    ec2InstanceId: parseNullableString(get('ec2_instance_id')),
    ec2Region: parseNullableString(get('ec2_region')),
    recurrence,
    timezone: parseOptionalString(get('timezone')) ?? 'UTC',
    shutdownTime: parseOptionalString(get('shutdown_time')),
    startupTime: parseOptionalString(get('startup_time')),
    daysOfWeek: parseIntList(get('days_of_week')),
    weekendShutdownTime: parseOptionalString(get('weekend_shutdown_time')),
    weekendStartupTime: parseOptionalString(get('weekend_startup_time')),
    weekendDays: parseIntList(get('weekend_days')),
    shutdownDayOfWeek: parseOptionalInt(get('shutdown_day_of_week')),
    startupDayOfWeek: parseOptionalInt(get('startup_day_of_week')),
    windowRepeatWeekly: parseBool(get('window_repeat_weekly')),
    overnightDays: parseIntList(get('overnight_days')),
    overnightShutdownTime: parseOptionalString(get('overnight_shutdown_time')),
    overnightStartupTime: parseOptionalString(get('overnight_startup_time')),
    oneTimeShutdownAt: parseOptionalString(get('one_time_shutdown_at')),
    oneTimeStartupAt: parseOptionalString(get('one_time_startup_at')),
    syncPolicy: parseOptionalString(get('sync_policy')) ?? 'automated',
    argocdInstanceId: parseNullableString(get('argocd_instance_id')),
    targetReplicas: parseOptionalInt(get('target_replicas')) ?? 1,
    enabled: parseBool(get('enabled')) ?? true,
    teamsAlertEnabled: parseBool(get('teams_alert_enabled')) ?? true,
  };

  return input;
}

export type ScheduleCsvImportRowError = {
  row: number;
  name: string;
  error: string;
};

export type ScheduleCsvImportResult = {
  created: number;
  failed: number;
  errors: ScheduleCsvImportRowError[];
};

export function parseSchedulesCsv(csv: string): {
  rows: Record<string, unknown>[];
  headerIndex: Map<string, number>;
} {
  const table = parseCsv(csv.trim());
  if (table.length === 0) {
    return { rows: [], headerIndex: new Map() };
  }

  const [headerRow, ...dataRows] = table;
  const headerIndex = new Map<string, number>();
  headerRow.forEach((header, index) => {
    headerIndex.set(header.trim().toLowerCase(), index);
  });

  const rows = dataRows
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => csvRowToScheduleInput(cells, headerIndex));

  return { rows, headerIndex };
}

export function validateScheduleCsvRow(row: Record<string, unknown>) {
  return createScheduleSchema.safeParse(row);
}

export function formatImportValidationError(
  row: Record<string, unknown>,
  rowNumber: number,
  result: ReturnType<typeof validateScheduleCsvRow>
): ScheduleCsvImportRowError | null {
  if (result.success) return null;
  return {
    row: rowNumber,
    name: typeof row.name === 'string' ? row.name : '',
    error: flattenZodError(result.error),
  };
}
