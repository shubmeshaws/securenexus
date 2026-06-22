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

export function buildScheduleDenySyncWindow(input: {
  appName: string;
  blockUntil: Date;
  timeZone: string;
  /** When the deny window is written to Argo CD — defaults to now. */
  windowStart?: Date;
}): ArgoSyncWindowSpec {
  const windowStart = floorToScheduleMinute(input.windowStart ?? new Date(), input.timeZone);
  return {
    kind: 'deny',
    schedule: cronScheduleForInstant(windowStart, input.timeZone),
    duration: denyWindowDuration(windowStart, input.blockUntil),
    // manualSync=false blocks manual Sync in Argo CD during an active deny window.
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
  if (window.description === SECURENEXUS_SYNC_WINDOW_DESCRIPTION) {
    return !window.applications?.length || window.applications.includes(appName);
  }
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
