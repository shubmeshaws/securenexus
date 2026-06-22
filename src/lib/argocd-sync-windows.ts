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

/** Argo CD allows only one deny window per schedule+duration per project — merge app lists. */
function isCoalescableScheduleDenyWindow(
  existing: ArgoSyncWindowSpec,
  next: ArgoSyncWindowSpec
): boolean {
  if (existing.kind !== 'deny' || next.kind !== 'deny') return false;
  if (existing.schedule !== next.schedule || existing.duration !== next.duration) return false;
  if (existing.manualSync === true || next.manualSync === true) return false;
  if (existing.namespaces?.length || existing.clusters?.length) return false;
  if (next.namespaces?.length || next.clusters?.length) return false;
  return true;
}

function withoutManagedApp(
  existing: ArgoSyncWindowSpec[],
  appName: string
): ArgoSyncWindowSpec[] {
  return existing.flatMap((row) => {
    if (!isManagedScheduleDenyWindow(row, appName)) return [row];
    const apps = (row.applications ?? []).filter((name) => name !== appName);
    if (!apps.length) return [];
    return [{ ...row, applications: apps }];
  });
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
      (row.applications?.includes(appName) || isManagedScheduleDenyWindow(row, appName))
  );
}

export function mergeScheduleDenySyncWindow(
  existing: ArgoSyncWindowSpec[],
  next: ArgoSyncWindowSpec
): ArgoSyncWindowSpec[] {
  const appName = next.applications?.[0];
  if (!appName) return [...existing, next];

  const withoutApp = withoutManagedApp(existing, appName);
  const twinIdx = withoutApp.findIndex((row) => isCoalescableScheduleDenyWindow(row, next));
  if (twinIdx >= 0) {
    const twin = withoutApp[twinIdx];
    const applications = Array.from(new Set([...(twin.applications ?? []), appName]));
    const merged: ArgoSyncWindowSpec = {
      ...twin,
      applications,
      manualSync: false,
      description: SECURENEXUS_SYNC_WINDOW_DESCRIPTION,
    };
    return [...withoutApp.slice(0, twinIdx), merged, ...withoutApp.slice(twinIdx + 1)];
  }

  return [...withoutApp, next];
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
