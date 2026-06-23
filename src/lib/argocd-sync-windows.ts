import { addMinutes, differenceInMinutes } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/** Identifies sync windows created by SecureNexus schedule shutdown. */
export const SECURENEXUS_SYNC_WINDOW_DESCRIPTION = 'securenexus-schedule-manual-sync-deny';

export interface ArgoSyncWindowSpec {
  kind: 'allow' | 'deny';
  schedule: string;
  duration: string;
  manualSync?: boolean;
  applications?: string[];
  namespaces?: string[];
  clusters?: string[];
  timeZone?: string;
  description?: string;
}

const MIN_DENY_DURATION_HOURS = 1;
const MAX_DENY_DURATION_HOURS = 168;
const STARTUP_BUFFER_MINUTES = 30;

/** Floor a UTC instant to the start of its minute in the given timezone. */
export function floorToScheduleMinute(when: Date, timeZone: string): Date {
  const stamp = formatInTimeZone(when, timeZone, "yyyy-MM-dd'T'HH:mm:00");
  return fromZonedTime(stamp, timeZone);
}

/**
 * Cron for an immediate deny window in the schedule timezone.
 * Uses a minute range through :59 so delayed project writes on slower hosts (e.g. EC2)
 * still land inside an active window for this shutdown cycle.
 */
export function cronScheduleForInstant(when: Date, timeZone: string): string {
  const minute = Number(formatInTimeZone(when, timeZone, 'm'));
  const hour = Number(formatInTimeZone(when, timeZone, 'H'));
  return `${minute}-59 ${hour} * * *`;
}

/** Argo CD duration string (e.g. "10h") covering stop until startup (+ buffer). */
export function denyWindowDuration(from: Date, until: Date): string {
  const minutes = Math.max(
    differenceInMinutes(until, from) + STARTUP_BUFFER_MINUTES,
    MIN_DENY_DURATION_HOURS * 60
  );
  const hours = Math.min(Math.ceil(minutes / 60), MAX_DENY_DURATION_HOURS);
  return `${hours}h`;
}

export function buildNamespaceDenySyncWindow(input: {
  namespace: string;
  blockUntil: Date;
  timeZone: string;
  windowStart?: Date;
}): ArgoSyncWindowSpec {
  const windowStart = floorToScheduleMinute(input.windowStart ?? new Date(), input.timeZone);
  return {
    kind: 'deny',
    schedule: cronScheduleForInstant(windowStart, input.timeZone),
    duration: denyWindowDuration(windowStart, input.blockUntil),
    manualSync: false,
    namespaces: [input.namespace],
    timeZone: input.timeZone || 'UTC',
    description: SECURENEXUS_SYNC_WINDOW_DESCRIPTION,
  };
}

export function isManagedNamespaceDenyWindow(
  window: ArgoSyncWindowSpec,
  namespace: string
): boolean {
  if (window.description === SECURENEXUS_SYNC_WINDOW_DESCRIPTION) {
    return Boolean(window.namespaces?.includes(namespace));
  }
  if (window.kind !== 'deny') return false;
  if (!window.namespaces?.includes(namespace)) return false;
  if (window.applications?.length || window.clusters?.length) return false;
  return true;
}

function isSecureNexusManagedNamespaceDenyRow(window: ArgoSyncWindowSpec): boolean {
  if (window.kind !== 'deny') return false;
  if (!window.namespaces?.length || window.applications?.length || window.clusters?.length) {
    return false;
  }
  return window.description === SECURENEXUS_SYNC_WINDOW_DESCRIPTION;
}

export function mergeNamespaceDenySyncWindow(
  existing: ArgoSyncWindowSpec[],
  next: ArgoSyncWindowSpec
): ArgoSyncWindowSpec[] {
  const namespace = next.namespaces?.[0];
  if (!namespace) return [...existing, next];

  const nonManaged = existing.filter((row) => !isSecureNexusManagedNamespaceDenyRow(row));
  const managedNamespaces = new Set<string>([namespace]);
  let managedDuration = next.duration;

  for (const row of existing) {
    if (!isSecureNexusManagedNamespaceDenyRow(row)) continue;
    for (const ns of row.namespaces ?? []) managedNamespaces.add(ns);
    managedDuration = longerDuration(managedDuration, row.duration);
  }

  const merged: ArgoSyncWindowSpec = {
    kind: 'deny',
    schedule: next.schedule,
    duration: managedDuration,
    manualSync: false,
    namespaces: Array.from(managedNamespaces),
    timeZone: next.timeZone || 'UTC',
    description: SECURENEXUS_SYNC_WINDOW_DESCRIPTION,
  };

  return [...nonManaged, merged];
}

export function removeScheduleNamespaceDenyWindow(
  existing: ArgoSyncWindowSpec[],
  namespace: string
): { windows: ArgoSyncWindowSpec[]; removed: number } {
  let removed = 0;
  const windows = existing.flatMap((row) => {
    if (!isManagedNamespaceDenyWindow(row, namespace)) return [row];
    removed++;
    const namespaces = (row.namespaces ?? []).filter((ns) => ns !== namespace);
    if (!namespaces.length) return [];
    return [{ ...row, namespaces }];
  });
  return { windows, removed };
}

export function buildScheduleDenySyncWindow(input: {
  appNames: string[];
  blockUntil: Date;
  timeZone: string;
  /** When the deny window is written to Argo CD — defaults to now. */
  windowStart?: Date;
}): ArgoSyncWindowSpec {
  const appNames = Array.from(new Set(input.appNames.filter(Boolean)));
  const windowStart = floorToScheduleMinute(input.windowStart ?? new Date(), input.timeZone);
  return {
    kind: 'deny',
    schedule: cronScheduleForInstant(windowStart, input.timeZone),
    duration: denyWindowDuration(windowStart, input.blockUntil),
    // manualSync=false blocks both manual and automated sync during an active deny window.
    manualSync: false,
    applications: appNames,
    timeZone: input.timeZone || 'UTC',
    description: SECURENEXUS_SYNC_WINDOW_DESCRIPTION,
  };
}

/**
 * Deny windows SecureNexus creates for schedule stop: single-app scope, no ns/cluster filter.
 * Used for merge/remove because Argo CD may omit `description` on older versions.
 */
export function isManagedScheduleDenyWindow(
  window: ArgoSyncWindowSpec,
  appName: string
): boolean {
  if (window.description === SECURENEXUS_SYNC_WINDOW_DESCRIPTION) {
    return !window.applications?.length || window.applications.includes(appName);
  }
  if (window.kind !== 'deny') return false;
  if (!window.applications?.length || !window.applications.includes(appName)) return false;
  if (window.namespaces?.length || window.clusters?.length) return false;
  return true;
}

function isSecureNexusManagedDenyRow(window: ArgoSyncWindowSpec): boolean {
  if (window.kind !== 'deny') return false;
  if (window.namespaces?.length || window.clusters?.length) return false;
  if (window.description === SECURENEXUS_SYNC_WINDOW_DESCRIPTION) return true;
  if (window.manualSync === true) return false;
  return Boolean(window.applications?.length);
}

function parseDurationHours(duration: string): number {
  const match = /^(\d+)h$/.exec(duration.trim());
  return match ? Number(match[1]) : 0;
}

function longerDuration(a: string, b: string): string {
  return parseDurationHours(a) >= parseDurationHours(b) ? a : b;
}

/**
 * Merge SecureNexus deny windows into a single project-level row (Argo allows one
 * schedule+duration key per project). Always refreshes schedule/duration to `next`.
 */
export function mergeScheduleDenySyncWindow(
  existing: ArgoSyncWindowSpec[],
  next: ArgoSyncWindowSpec
): ArgoSyncWindowSpec[] {
  const nextApps = next.applications?.length ? next.applications : [];
  if (!nextApps.length) return [...existing, next];

  const nonManaged: ArgoSyncWindowSpec[] = [];
  const managedApps = new Set<string>();
  let managedDuration = next.duration;

  for (const row of existing) {
    if (isSecureNexusManagedDenyRow(row)) {
      for (const name of row.applications ?? []) managedApps.add(name);
      managedDuration = longerDuration(managedDuration, row.duration);
      continue;
    }

    const remainingApps = (row.applications ?? []).filter((name) => !nextApps.includes(name));
    if (row.kind === 'deny' && remainingApps.length !== (row.applications?.length ?? 0)) {
      if (remainingApps.length) nonManaged.push({ ...row, applications: remainingApps });
      for (const name of row.applications ?? []) {
        if (nextApps.includes(name)) managedApps.add(name);
      }
      continue;
    }

    nonManaged.push(row);
  }

  for (const name of nextApps) managedApps.add(name);

  const merged: ArgoSyncWindowSpec = {
    kind: 'deny',
    schedule: next.schedule,
    duration: managedDuration,
    manualSync: false,
    applications: Array.from(managedApps),
    timeZone: next.timeZone || 'UTC',
    description: SECURENEXUS_SYNC_WINDOW_DESCRIPTION,
  };

  return [...nonManaged, merged];
}

export function denyWindowCoversApp(
  windows: ArgoSyncWindowSpec[],
  appName: string,
  schedule: string,
  duration: string
): boolean {
  return windows.some(
    (row) =>
      row.kind === 'deny' &&
      row.manualSync === false &&
      row.schedule === schedule &&
      row.duration === duration &&
      !row.namespaces?.length &&
      !row.clusters?.length &&
      row.applications?.includes(appName)
  );
}

export function removeScheduleDenySyncWindows(
  existing: ArgoSyncWindowSpec[],
  appName: string
): { windows: ArgoSyncWindowSpec[]; removed: number } {
  let removed = 0;
  const windows = existing.flatMap((row) => {
    if (!isManagedScheduleDenyWindow(row, appName)) return [row];
    removed++;
    const apps = (row.applications ?? []).filter((name) => name !== appName);
    if (!apps.length) return [];
    return [{ ...row, applications: apps }];
  });
  return { windows, removed };
}

/** Fallback when startup time cannot be resolved — keep deny window until next day. */
export function defaultBlockUntil(from: Date): Date {
  return addMinutes(from, 24 * 60);
}
