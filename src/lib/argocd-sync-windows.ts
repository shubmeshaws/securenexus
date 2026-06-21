import { addMinutes, differenceInMinutes } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';

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

/** Cron (minute hour dom month dow) for when the deny window starts — in the schedule timezone. */
export function cronScheduleForInstant(when: Date, timeZone: string): string {
  const minute = formatInTimeZone(when, timeZone, 'm');
  const hour = formatInTimeZone(when, timeZone, 'H');
  return `${minute} ${hour} * * *`;
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

export function buildScheduleDenySyncWindow(input: {
  appName: string;
  blockFrom: Date;
  blockUntil: Date;
  timeZone: string;
}): ArgoSyncWindowSpec {
  return {
    kind: 'deny',
    schedule: cronScheduleForInstant(input.blockFrom, input.timeZone),
    duration: denyWindowDuration(input.blockFrom, input.blockUntil),
    // Argo CD: manualSync=true *allows* manual sync during a deny window (UI: "Enable manual sync").
    manualSync: false,
    applications: [input.appName],
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
  if (window.kind !== 'deny') return false;
  if (!window.applications?.length || !window.applications.includes(appName)) return false;
  if (window.namespaces?.length || window.clusters?.length) return false;
  return true;
}

export function mergeScheduleDenySyncWindow(
  existing: ArgoSyncWindowSpec[],
  next: ArgoSyncWindowSpec
): ArgoSyncWindowSpec[] {
  const appName = next.applications?.[0];
  if (!appName) return [...existing, next];
  const filtered = existing.filter((row) => !isManagedScheduleDenyWindow(row, appName));
  return [...filtered, next];
}

export function removeScheduleDenySyncWindows(
  existing: ArgoSyncWindowSpec[],
  appName: string
): { windows: ArgoSyncWindowSpec[]; removed: number } {
  const windows = existing.filter((row) => !isManagedScheduleDenyWindow(row, appName));
  return { windows, removed: existing.length - windows.length };
}

/** Fallback when startup time cannot be resolved — keep deny window until next day. */
export function defaultBlockUntil(from: Date): Date {
  return addMinutes(from, 24 * 60);
}
