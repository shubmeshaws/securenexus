import prisma from './prisma';
import argocdClient from './argocd-client';
import { getWorkloadDesiredReplicas } from './k8s-client';
import {
  collectScheduleArgoApps,
  getScheduleTargets,
  loadScheduleArgoCatalog,
  type ScheduleArgoApp,
  type WorkloadTarget,
} from './scheduler-actions';
import { isNamespaceSchedule, isNonEksSchedule, workloadKey } from './workload-utils';
import { isScheduleInStoppedWindow } from './scheduler-utils';
import { runWithConcurrency } from './concurrency';
import type { Schedule } from '@prisma/client';

/** Recent stop/start transitions stay visible briefly even after the window ends. */
const RECENT_TRANSITION_WINDOW_MS = 15 * 60 * 1000;
/** Recompute (live K8s/Argo calls) at most once per this interval; polls reuse the cache. */
const CACHE_TTL_MS = 60_000;
const SCHEDULE_SCAN_CONCURRENCY = 4;

export type ActivityStatus = 'completed' | 'in-progress';

export interface SyncOffServiceEntry {
  scheduleId: string;
  scheduleName: string;
  cluster: string;
  namespace: string;
  appName: string;
}

/** Per schedule (cluster + namespace) sync-off breakdown for the dashboard lists. */
export interface SyncOffNamespaceGroup {
  cluster: string;
  namespace: string;
  scheduleId: string;
  scheduleName: string;
  completed: string[];
  pending: string[];
  /** Sync still enabled during downtime — should have manual sync off. */
  syncOnDuringDowntime: string[];
  /** Sync enabled outside stop window — expected / healthy. */
  syncOnExpected: string[];
  completedCount: number;
  pendingCount: number;
  syncOnDuringDowntimeCount: number;
  syncOnExpectedCount: number;
  total: number;
  percent: number;
  /** Schedule is inside its stop window (or manual stop). */
  inStopWindow: boolean;
  /** Sync off still active outside the stop window — likely needs cleanup. */
  lingeringSyncOff: boolean;
}

export interface ScheduleActivityRow {
  id: string;
  name: string;
  cluster: string;
  namespace: string;
  scope: 'namespace' | 'workload';
  stoppedSince: string | null;
  ageMs: number;
  status: ActivityStatus;
  stop: { done: number; total: number; pending: string[] };
  syncOff: {
    done: number;
    total: number;
    pending: string[];
    applied: string[];
    resolved: boolean;
  };
  error?: string;
}

export interface ScheduleActivityTracker {
  generatedAt: string;
  activeWindowMinutes: number;
  rows: ScheduleActivityRow[];
  /** Flat lists (legacy / export). */
  syncOffServices: SyncOffServiceEntry[];
  syncOffPendingServices: SyncOffServiceEntry[];
  /** Grouped cluster → namespace view for the dashboard sync-off lists. */
  syncOffGroups: SyncOffNamespaceGroup[];
  totals: {
    schedules: number;
    completed: number;
    inProgress: number;
    stopDone: number;
    stopTotal: number;
    syncDone: number;
    syncTotal: number;
    syncPercent: number;
    lingeringSchedules: number;
    syncOnDuringDowntime: number;
    syncOnExpected: number;
    percent: number;
  };
}

let cache: { at: number; data: ScheduleActivityTracker } | null = null;
let inFlight: Promise<ScheduleActivityTracker> | null = null;

function stoppedSince(schedule: Schedule): Date | null {
  return schedule.lastRun ?? null;
}

function isInStopContext(schedule: Schedule, now: Date): boolean {
  if (schedule.liveStopSource === 'manual-start') return false;
  if (schedule.liveStopSource === 'manual') return true;
  return isScheduleInStoppedWindow(schedule, now);
}

/**
 * Include a schedule when:
 *  - it is in its stop window (show full pending + completed picture), OR
 *  - manual sync off is still active outside the window (the stuck-window case), OR
 *  - pausedArgoApps still recorded in DB.
 */
function shouldIncludeSchedule(
  row: ScheduleActivityRow,
  schedule: Schedule,
  now: Date
): boolean {
  if (isInStopContext(schedule, now)) return true;
  if (row.syncOff.applied.length > 0) return true;
  if (schedule.pausedArgoApps.length > 0) return true;
  return false;
}

type ScheduleArgoCatalog = Awaited<ReturnType<typeof loadScheduleArgoCatalog>>;

async function resolveAppsForTracker(
  schedule: Schedule,
  catalog: ScheduleArgoCatalog,
  targets: WorkloadTarget[]
): Promise<ScheduleArgoApp[]> {
  // Match the schedule's workload scope — not every Argo app in a shared namespace
  // (grafana/jenkins/etc. live in the same namespace but are not scheduled workloads).
  return collectScheduleArgoApps(schedule, catalog, targets);
}

async function computeStopProgress(
  schedule: Schedule,
  targets: WorkloadTarget[]
): Promise<{ done: number; total: number; pending: string[] }> {
  const pending: string[] = [];
  await runWithConcurrency(targets, 8, async (target) => {
    const replicas = await getWorkloadDesiredReplicas(
      schedule.cluster,
      schedule.namespace,
      target.kind,
      target.name
    ).catch(() => null);
    // null = couldn't read; treat as not-yet-confirmed-stopped so it shows as pending.
    if (replicas == null || replicas > 0) {
      pending.push(workloadKey(target.kind, target.name));
    }
  });
  return { done: targets.length - pending.length, total: targets.length, pending };
}

async function computeSyncOffProgress(
  schedule: Schedule,
  apps: ScheduleArgoApp[]
): Promise<{
  done: number;
  total: number;
  pending: string[];
  applied: string[];
  resolved: boolean;
}> {
  if (!apps.length) {
    return { done: 0, total: 0, pending: [], applied: [], resolved: false };
  }

  const byInstance = new Map<string, ScheduleArgoApp[]>();
  for (const app of apps) {
    const group = byInstance.get(app.instanceId) ?? [];
    group.push(app);
    byInstance.set(app.instanceId, group);
  }

  const denied = new Set<string>();
  await runWithConcurrency(Array.from(byInstance.entries()), 3, async ([instanceId, group]) => {
    const result = await argocdClient
      .getScheduleDeniedAppNames(
        group.map((app) => ({ name: app.name, namespace: schedule.namespace })),
        instanceId
      )
      .catch(() => new Set<string>());
    result.forEach((name) => denied.add(name));
  });

  const applied = apps.filter((app) => denied.has(app.name)).map((app) => app.name);
  const pending = apps.filter((app) => !denied.has(app.name)).map((app) => app.name);
  return {
    done: applied.length,
    total: apps.length,
    pending,
    applied,
    resolved: true,
  };
}

async function computeScheduleRow(
  schedule: Schedule,
  catalog: ScheduleArgoCatalog,
  now: Date
): Promise<ScheduleActivityRow> {
  const since = stoppedSince(schedule);
  const ageMs = since ? now.getTime() - since.getTime() : 0;
  const base: ScheduleActivityRow = {
    id: schedule.id,
    name: schedule.name,
    cluster: schedule.cluster,
    namespace: schedule.namespace,
    scope: isNamespaceSchedule(schedule) ? 'namespace' : 'workload',
    stoppedSince: since ? since.toISOString() : null,
    ageMs,
    status: 'in-progress',
    stop: { done: 0, total: 0, pending: [] },
    syncOff: { done: 0, total: 0, pending: [], applied: [], resolved: false },
  };

  try {
    const targets = await getScheduleTargets(schedule);
    const apps = await resolveAppsForTracker(schedule, catalog, targets);
    const [stop, syncOff] = await Promise.all([
      computeStopProgress(schedule, targets),
      computeSyncOffProgress(schedule, apps),
    ]);

    const stopComplete = stop.total === 0 || stop.done === stop.total;
    const syncComplete = !syncOff.resolved || syncOff.done === syncOff.total;

    return {
      ...base,
      stop,
      syncOff,
      status: stopComplete && syncComplete ? 'completed' : 'in-progress',
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : 'Failed to read schedule state',
    };
  }
}

async function computeTracker(now = new Date()): Promise<ScheduleActivityTracker> {
  const [schedules, catalog] = await Promise.all([
    prisma.schedule.findMany({
      where: {
        enabled: true,
        platformType: { not: 'non_eks' },
      },
    }),
    loadScheduleArgoCatalog(),
  ]);

  const rows: ScheduleActivityRow[] = [];
  const eksSchedules = schedules.filter((s) => !isNonEksSchedule(s));

  await runWithConcurrency(eksSchedules, SCHEDULE_SCAN_CONCURRENCY, async (schedule) => {
    const row = await computeScheduleRow(schedule, catalog, now);
    if (shouldIncludeSchedule(row, schedule, now)) {
      rows.push(row);
    }
  });

  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'in-progress' ? -1 : 1;
    return b.ageMs - a.ageMs;
  });

  const syncOffServices: SyncOffServiceEntry[] = [];
  const syncOffPendingServices: SyncOffServiceEntry[] = [];
  for (const row of rows) {
    for (const appName of row.syncOff.applied) {
      syncOffServices.push({
        scheduleId: row.id,
        scheduleName: row.name,
        cluster: row.cluster,
        namespace: row.namespace,
        appName,
      });
    }
    for (const appName of row.syncOff.pending) {
      syncOffPendingServices.push({
        scheduleId: row.id,
        scheduleName: row.name,
        cluster: row.cluster,
        namespace: row.namespace,
        appName,
      });
    }
  }

  syncOffServices.sort((a, b) =>
    a.namespace.localeCompare(b.namespace) || a.appName.localeCompare(b.appName)
  );
  syncOffPendingServices.sort((a, b) =>
    a.namespace.localeCompare(b.namespace) || a.appName.localeCompare(b.appName)
  );

  const syncOffGroups: SyncOffNamespaceGroup[] = rows
    .filter((row) => row.syncOff.resolved || row.syncOff.total > 0)
    .map((row) => {
      const schedule = eksSchedules.find((s) => s.id === row.id)!;
      const inStopWindow = isInStopContext(schedule, now);
      const syncOnDuringDowntime = inStopWindow ? row.syncOff.pending : [];
      const syncOnExpected = !inStopWindow ? row.syncOff.pending : [];
      return {
        cluster: row.cluster,
        namespace: row.namespace,
        scheduleId: row.id,
        scheduleName: row.name,
        completed: row.syncOff.applied,
        pending: row.syncOff.pending,
        syncOnDuringDowntime,
        syncOnExpected,
        completedCount: row.syncOff.done,
        pendingCount: row.syncOff.pending.length,
        syncOnDuringDowntimeCount: syncOnDuringDowntime.length,
        syncOnExpectedCount: syncOnExpected.length,
        total: row.syncOff.total,
        percent:
          row.syncOff.total === 0
            ? 100
            : Math.round((row.syncOff.done / row.syncOff.total) * 100),
        inStopWindow,
        lingeringSyncOff: !inStopWindow && row.syncOff.applied.length > 0,
      };
    })
    .sort(
      (a, b) =>
        a.cluster.localeCompare(b.cluster) ||
        a.namespace.localeCompare(b.namespace) ||
        a.scheduleName.localeCompare(b.scheduleName)
    );

  const totals = rows.reduce(
    (acc, row) => {
      acc.schedules += 1;
      acc.completed += row.status === 'completed' ? 1 : 0;
      acc.inProgress += row.status === 'in-progress' ? 1 : 0;
      acc.stopDone += row.stop.done;
      acc.stopTotal += row.stop.total;
      acc.syncDone += row.syncOff.done;
      acc.syncTotal += row.syncOff.total;
      return acc;
    },
    {
      schedules: 0,
      completed: 0,
      inProgress: 0,
      stopDone: 0,
      stopTotal: 0,
      syncDone: 0,
      syncTotal: 0,
      syncPercent: 0,
      lingeringSchedules: 0,
      syncOnDuringDowntime: 0,
      syncOnExpected: 0,
      percent: 0,
    }
  );

  totals.lingeringSchedules = syncOffGroups.filter((g) => g.lingeringSyncOff).length;
  totals.syncOnDuringDowntime = syncOffGroups.reduce(
    (n, g) => n + g.syncOnDuringDowntimeCount,
    0
  );
  totals.syncOnExpected = syncOffGroups.reduce((n, g) => n + g.syncOnExpectedCount, 0);

  totals.syncPercent =
    totals.syncTotal === 0 ? 100 : Math.round((totals.syncDone / totals.syncTotal) * 100);
  const totalUnits = totals.stopTotal + totals.syncTotal;
  const doneUnits = totals.stopDone + totals.syncDone;
  totals.percent = totalUnits === 0 ? 100 : Math.round((doneUnits / totalUnits) * 100);

  return {
    generatedAt: now.toISOString(),
    activeWindowMinutes: RECENT_TRANSITION_WINDOW_MS / 60_000,
    rows,
    syncOffServices,
    syncOffPendingServices,
    syncOffGroups,
    totals,
  };
}

/** Cached tracker — recomputes (live K8s/Argo) at most once per CACHE_TTL_MS. */
export async function getScheduleActivityTracker(
  force = false
): Promise<ScheduleActivityTracker> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inFlight) return inFlight;

  inFlight = computeTracker()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
