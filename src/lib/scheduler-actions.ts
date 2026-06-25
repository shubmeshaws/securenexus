import argocdClient, { appMatchesK8sCluster } from './argocd-client';
import { instanceMatchesCluster, listEnabledArgoCDInstances } from './argocd-instances';
import type { ArgoCDAppSummary } from './argocd-client';
import { AUTOMATIC_CRON_TRIGGER } from './alert-display';
import {
  deleteStatefulSet,
  getArgoAppNamesForNamespace,
  getClusterReadyNodeCount,
  getCronJobArgoAppName,
  getDeploymentArgoAppName,
  getScaledObjectScaleTarget,
  getStatefulSetArgoAppName,
  getWorkloadDesiredReplicas,
  guessScaledObjectScaleTargetName,
  listWorkloads,
  pauseScaledObjectByAnnotation,
  resumeScaledObjectByAnnotation,
  scaledObjectExists,
  shutdownScaledObject,
  scaleWorkload,
  statefulSetExists,
  type WorkloadKind,
} from './k8s-client';
import { logActivity } from './activity';
import { buildShutdownActivityDetails } from './shutdown-node-count';
import prisma from './prisma';
import {
  computeCurrentLiveStartupAt,
  computeNextRun,
  computeNextStartupAt,
  formatScheduleStartupLabel,
  isScheduleInStoppedWindow,
} from './scheduler-utils';
import { defaultBlockUntil } from './argocd-sync-windows';
import {
  isNamespaceSchedule,
  isNonEksSchedule,
  namespaceScheduleUsesFullNamespaceSyncBlock,
  NAMESPACE_SCOPE_MARKER,
  workloadKey,
} from './workload-utils';
import { Prisma, type Schedule } from '@prisma/client';
import { startEc2Instance, stopEc2Instance } from './aws-credential-store';
import { runWithConcurrency, withRetry } from './concurrency';
import { resolveArgoOpConcurrency, resolveWorkloadOpConcurrency } from './schedule-execution-pool';
import { createScheduleRunLogger } from './schedule-run-logger';

/** Delay after pausing Argo before deleting a StatefulSet (ms). Override: STS_SHUTDOWN_SETTLE_MS */
const STS_SHUTDOWN_SETTLE_MS = (() => {
  const fromEnv = Number(process.env.STS_SHUTDOWN_SETTLE_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 1000;
})();

/**
 * Attempts for a single workload stop/start op. With the default backoff
 * (5s · 2^n, capped 60s) 6 attempts keeps retrying for ~2.5 min so a transient
 * K8s/Argo failure during the midnight batch doesn't strand a workload.
 * Override: WORKLOAD_RETRY_ATTEMPTS
 */
const WORKLOAD_RETRY_ATTEMPTS = (() => {
  const fromEnv = Number(process.env.WORKLOAD_RETRY_ATTEMPTS);
  return Number.isFinite(fromEnv) && fromEnv >= 1 ? Math.min(Math.floor(fromEnv), 12) : 6;
})();

/** Retry a workload stop/start op across transient K8s/Argo failures for a few minutes. */
function retryWorkloadOp<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, {
    attempts: WORKLOAD_RETRY_ATTEMPTS,
    baseDelayMs: 5000,
    maxDelayMs: 60000,
    onRetry: (err, attempt, delayMs) =>
      console.warn(
        `[Scheduler retry] ${label} attempt ${attempt} failed (${
          err instanceof Error ? err.message : err
        }); retrying in ${delayMs}ms`
      ),
  });
}

function isAutomaticScheduleTrigger(triggeredBy: string): boolean {
  return (
    triggeredBy === AUTOMATIC_CRON_TRIGGER ||
    triggeredBy === 'scheduler' ||
    (!triggeredBy.includes('@') &&
      triggeredBy !== 'manual' &&
      triggeredBy !== 'bulk-action' &&
      triggeredBy !== 'infra-control' &&
      triggeredBy !== 'live-stop')
  );
}

function resolveScheduleTeamsAlert(schedule: Schedule, triggeredBy: string) {
  const automatic = isAutomaticScheduleTrigger(triggeredBy);
  return {
    teamsAlertEnabled: automatic
      ? schedule.teamsAlertEnabled
      : schedule.teamsManualAlertEnabled,
  };
}

/** Find an Argo app by exact/fuzzy name within a candidate pool. */
function resolveArgoAppFromPool(
  schedule: Schedule,
  pool: ArgoCDAppSummary[]
): { name: string; instanceId: string } | null {
  const exact = pool.find((app) => app.name === schedule.appName);
  if (exact) return { name: exact.name, instanceId: exact.instanceId };

  const byTarget = pool.find(
    (app) =>
      app.destinationNamespace === schedule.namespace &&
      (app.name === schedule.appName ||
        app.name.includes(schedule.appName) ||
        schedule.appName.includes(app.name))
  );
  return byTarget ? { name: byTarget.name, instanceId: byTarget.instanceId } : null;
}

/**
 * Resolve a single workload-scoped Argo app from the catalog only (no live K8s).
 * Never expands to the whole namespace — used by pause/reconcile for workload schedules.
 */
function resolveWorkloadArgoAppFromCatalogOnly(
  schedule: Schedule,
  catalog: ArgoCatalog
): ScheduleArgoApp | null {
  if (isNamespaceSchedule(schedule)) return null;

  const byName = findArgoAppInCatalog(catalog, schedule, schedule.appName);
  if (byName) return byName;

  const scopedMatch = resolveArgoAppFromPool(schedule, catalog.filtered(schedule));
  if (scopedMatch) return scopedMatch;

  return resolveArgoAppFromPool(schedule, relaxedAppsFromCatalog(catalog, schedule));
}

/** Catalog-only Argo app resolution for explicit workload targets (no live K8s). */
function resolveArgoAppsFromCatalogForTargets(
  schedule: Schedule,
  catalog: ArgoCatalog,
  workloadTargets: WorkloadTarget[]
): ScheduleArgoApp[] {
  const byName = new Map<string, ScheduleArgoApp>();
  for (const target of workloadTargets) {
    const match = resolveWorkloadArgoAppFromCatalogOnly(scheduleAsWorkload(schedule, target), catalog);
    if (match) byName.set(match.name, match);
  }
  return Array.from(byName.values());
}

/**
 * Resolve Argo apps to pause/unpause. Always follows the schedule's workload targets
 * (from getScheduleTargets) — never the whole Argo catalog for a namespace. A namespace
 * schedule that stops only pftest-mongodb must only sync-block pftest-mongodb, even when
 * excludedWorkloads is empty and other apps share the pftest namespace in Argo CD.
 */
async function resolveScheduleArgoAppsForOperations(
  schedule: Schedule,
  catalog: ArgoCatalog,
  workloadTargets?: WorkloadTarget[]
): Promise<ScheduleArgoApp[]> {
  if (isNamespaceSchedule(schedule)) {
    const targets = workloadTargets?.length
      ? workloadTargets
      : await getScheduleTargets(schedule);
    if (!targets.length) {
      return [];
    }
    const fromK8s = await collectScheduleArgoApps(schedule, catalog, targets);
    const fromCatalog = resolveArgoAppsFromCatalogForTargets(schedule, catalog, targets);
    const merged = new Map<string, ScheduleArgoApp>();
    for (const app of [...fromK8s, ...fromCatalog]) merged.set(app.name, app);
    return Array.from(merged.values());
  }

  let targets = await collectScheduleArgoApps(schedule, catalog, workloadTargets);
  if (!targets.length) {
    const fallback = resolveWorkloadArgoAppFromCatalogOnly(schedule, catalog);
    if (fallback) targets = [fallback];
  }
  return targets;
}

interface ScheduleArgoApp {
  name: string;
  instanceId: string;
}

export interface WorkloadTarget {
  name: string;
  kind: WorkloadKind;
}

export type { ScheduleArgoApp };

function scheduleAsWorkload(schedule: Schedule, target: WorkloadTarget): Schedule {
  // Treat as workload-scoped for Argo resolution — parent schedule may be namespace scope.
  return { ...schedule, scope: 'workload', appName: target.name, workloadKind: target.kind };
}

/**
 * In-memory Argo CD catalog for one schedule run. Loads all apps once so resolution,
 * pause, and resume avoid repeated listApplications() calls within the same execution.
 */
interface ArgoCatalog {
  filtered(schedule: Schedule): ArgoCDAppSummary[];
  relaxed(schedule: Schedule): ArgoCDAppSummary[];
  find(schedule: Schedule, appName: string): ScheduleArgoApp | null;
}

/** Shared Argo CD catalog loader for tracker / reconcile callers. */
export async function loadScheduleArgoCatalog(): Promise<ArgoCatalog> {
  return loadArgoCatalog();
}

/** Namespace-wide app list from the Argo catalog (no live K8s lookups). */
export async function resolveCatalogAppsInNamespaceForSchedule(
  schedule: Schedule,
  catalog: ArgoCatalog
): Promise<ScheduleArgoApp[]> {
  return resolveCatalogAppsInNamespace(schedule, catalog);
}

async function loadArgoCatalog(): Promise<ArgoCatalog> {
  const [allApps, instances] = await Promise.all([
    argocdClient.listApplications(),
    listEnabledArgoCDInstances(),
  ]);
  const instanceMap = new Map(instances.map((i) => [i.id, i]));

  return {
    filtered: (schedule) => filterAppsForSchedule(schedule, allApps, instanceMap),
    relaxed: (schedule) => {
      const inNamespace = allApps.filter((app) => app.destinationNamespace === schedule.namespace);
      if (schedule.argocdInstanceId) {
        const pinned = inNamespace.filter((app) => app.instanceId === schedule.argocdInstanceId);
        if (pinned.length) return pinned;
      }
      return inNamespace;
    },
    find: (schedule, appName) => {
      const scoped = filterAppsForSchedule(schedule, allApps, instanceMap);
      const scopedMatch = scoped.find((a) => a.name === appName);
      if (scopedMatch) return { name: scopedMatch.name, instanceId: scopedMatch.instanceId };
      const anyMatch = allApps.find((a) => a.name === appName);
      return anyMatch ? { name: anyMatch.name, instanceId: anyMatch.instanceId } : null;
    },
  };
}

function relaxedAppsFromCatalog(catalog: ArgoCatalog, schedule: Schedule): ArgoCDAppSummary[] {
  return catalog.relaxed(schedule);
}

async function resolveCatalogAppsInNamespace(
  schedule: Schedule,
  catalog: ArgoCatalog
): Promise<ScheduleArgoApp[]> {
  const relaxed = relaxedAppsFromCatalog(catalog, schedule);
  const strict = catalog.filtered(schedule);
  const pool = strict.length ? strict : relaxed;
  return pool.map((app) => ({ name: app.name, instanceId: app.instanceId }));
}

function findArgoAppInCatalog(
  catalog: ArgoCatalog,
  schedule: Schedule,
  appName: string
): ScheduleArgoApp | null {
  return catalog.find(schedule, appName);
}

/**
 * Catalog lookup without strict cluster-name filtering (EC2 cluster labels often differ).
 *
 * Prefers the schedule's pinned Argo CD instance, but never lets a missing/stale
 * `argocdInstanceId` (or an instance whose `clusterNames` list doesn't yet include a
 * newly added cluster) black-hole the deny window: it falls back to a namespace match
 * across every instance. Each app keeps its own `instanceId`, so the deny window is
 * still written to the correct Argo CD.
 */
async function appsForScheduleRelaxed(schedule: Schedule): Promise<ArgoCDAppSummary[]> {
  const catalog = await loadArgoCatalog();
  return relaxedAppsFromCatalog(catalog, schedule);
}

/** Find an Argo app by exact name, preferring the cluster/instance-scoped list. */
async function findArgoAppByName(
  schedule: Schedule,
  appName: string,
  catalog?: ArgoCatalog
): Promise<ScheduleArgoApp | null> {
  try {
    const ctx = catalog ?? (await loadArgoCatalog());
    return findArgoAppInCatalog(ctx, schedule, appName);
  } catch {
    return null;
  }
}

async function resolveArgoAppForStatefulSet(
  schedule: Schedule,
  catalog: ArgoCatalog
): Promise<ScheduleArgoApp | null> {
  const trackingApp = await getStatefulSetArgoAppName(
    schedule.cluster,
    schedule.namespace,
    schedule.appName
  );
  console.log(
    `[STS shutdown] ${schedule.namespace}/${schedule.appName} trackingApp=${trackingApp ?? '(none)'}`
  );
  if (trackingApp) {
    const byTracking = findArgoAppInCatalog(catalog, schedule, trackingApp);
    if (byTracking) return byTracking;
  }

  return null;
}

/** Resolve the Argo app for one namespace-schedule workload target. */
async function resolveArgoAppForWorkload(
  schedule: Schedule,
  target: WorkloadTarget,
  catalog: ArgoCatalog
): Promise<ScheduleArgoApp | null> {
  const workloadSchedule = scheduleAsWorkload(schedule, target);
  if (target.kind === 'StatefulSet') {
    return resolveArgoAppForStatefulSet(workloadSchedule, catalog);
  }
  if (target.kind === 'ScaledObject') {
    return resolveArgoAppForScaledObject(workloadSchedule, catalog);
  }
  return resolveArgoApp(workloadSchedule, catalog);
}

/** Resolve the single Argo app for a ScaledObject schedule — never fuzzy-match the whole namespace. */
async function resolveArgoAppForScaledObject(
  schedule: Schedule,
  catalog: ArgoCatalog
): Promise<ScheduleArgoApp | null> {
  const target = await getScaledObjectScaleTarget(
    schedule.cluster,
    schedule.namespace,
    schedule.appName
  );
  const scaleTargetName = target?.name ?? guessScaledObjectScaleTargetName(schedule.appName);
  const scaleTargetKind = target?.kind ?? 'Deployment';

  console.log(
    `[Argo resolve] scaledobject ${schedule.namespace}/${schedule.appName} scaleTarget=${
      target ? `${target.kind}/${target.name}` : `guess Deployment/${scaleTargetName}`
    }`
  );

  if (scaleTargetKind === 'Deployment') {
    const trackingApp = await getDeploymentArgoAppName(
      schedule.cluster,
      schedule.namespace,
      scaleTargetName
    );
    if (trackingApp) {
      return findArgoAppInCatalog(catalog, schedule, trackingApp);
    }
  } else {
    const trackingApp = await getStatefulSetArgoAppName(
      schedule.cluster,
      schedule.namespace,
      scaleTargetName
    );
    if (trackingApp) {
      return findArgoAppInCatalog(catalog, schedule, trackingApp);
    }
  }

  return null;
}

export async function collectScheduleArgoApps(
  schedule: Schedule,
  catalog?: ArgoCatalog,
  workloadTargets?: WorkloadTarget[]
): Promise<ScheduleArgoApp[]> {
  const ctx = catalog ?? (await loadArgoCatalog());
  const byName = new Map<string, ScheduleArgoApp>();
  const add = (app: ScheduleArgoApp | null) => {
    if (app) byName.set(app.name, app);
  };

  if (isNamespaceSchedule(schedule)) {
    if (workloadTargets?.length) {
      await runWithConcurrency(workloadTargets, resolveArgoOpConcurrency(), async (target) => {
        const resolved = await resolveArgoAppForWorkload(schedule, target, ctx);
        if (resolved) {
          add(resolved);
          return;
        }
        add(resolveWorkloadArgoAppFromCatalogOnly(scheduleAsWorkload(schedule, target), ctx));
      });
      if (workloadTargets.length > 1) {
        console.log(
          `[Argo resolve] namespace=${schedule.namespace} workload-scoped apps: ${
            Array.from(byName.keys()).join(', ') || '(none)'
          }`
        );
      }
      return Array.from(byName.values());
    }

    const trackingNames = await getArgoAppNamesForNamespace(schedule.cluster, schedule.namespace);
    console.log(
      `[Argo resolve] namespace=${schedule.namespace} tracking apps: ${
        trackingNames.join(', ') || '(none)'
      }`
    );
    await runWithConcurrency(trackingNames, resolveArgoOpConcurrency(), async (name) => {
      add(findArgoAppInCatalog(ctx, schedule, name));
    });
  } else if (schedule.workloadKind === 'StatefulSet') {
    add(await resolveArgoAppForStatefulSet(schedule, ctx));
    if (!byName.size) {
      add(resolveWorkloadArgoAppFromCatalogOnly(schedule, ctx));
    }
  } else if (schedule.workloadKind === 'ScaledObject') {
    add(await resolveArgoAppForScaledObject(schedule, ctx));
    if (!byName.size) {
      add(resolveWorkloadArgoAppFromCatalogOnly(schedule, ctx));
    }
  } else {
    add(await resolveArgoApp(schedule, ctx));
    if (!byName.size) {
      add(resolveWorkloadArgoAppFromCatalogOnly(schedule, ctx));
    }
  }

  return Array.from(byName.values());
}

async function blockNamespaceManualSync(
  schedule: Schedule,
  input: { blockUntil: Date; timeZone: string; targets: ScheduleArgoApp[] },
  catalog: ArgoCatalog
): Promise<string[]> {
  const blocked: string[] = [];
  const sampleByInstance = new Map<string, string>();

  for (const app of input.targets) {
    if (!sampleByInstance.has(app.instanceId)) {
      sampleByInstance.set(app.instanceId, app.name);
    }
  }

  for (const app of relaxedAppsFromCatalog(catalog, schedule)) {
    if (!sampleByInstance.has(app.instanceId)) {
      sampleByInstance.set(app.instanceId, app.name);
    }
  }

  await runWithConcurrency(
    Array.from(sampleByInstance.entries()),
    resolveArgoOpConcurrency(),
    async ([instanceId, sampleAppName]) => {
      try {
        await argocdClient.addScheduleNamespaceDenyWindow(
          {
            namespace: schedule.namespace,
            blockUntil: input.blockUntil,
            timeZone: input.timeZone,
            sampleAppName,
          },
          instanceId
        );
        blocked.push(`${schedule.namespace}@${sampleAppName}`);
      } catch (err) {
        console.error(
          `[Argo pause] failed namespace deny for ${schedule.namespace} via ${sampleAppName}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  );

  return blocked;
}

async function blockManualSyncForApps(
  apps: ScheduleArgoApp[],
  input: {
    blockUntil: Date;
    timeZone: string;
    now: Date;
    logPrefix: string;
  }
): Promise<{ blocked: string[]; errors: string[] }> {
  const blocked: string[] = [];
  const errors: string[] = [];
  const byInstance = new Map<string, ScheduleArgoApp[]>();

  for (const app of apps) {
    const group = byInstance.get(app.instanceId) ?? [];
    group.push(app);
    byInstance.set(app.instanceId, group);
  }

  await runWithConcurrency(
    Array.from(byInstance.entries()),
    resolveArgoOpConcurrency(),
    async ([instanceId, group]) => {
      try {
        await argocdClient.addScheduleManualSyncDenyWindows(
          {
            appNames: group.map((app) => app.name),
            blockUntil: input.blockUntil,
            timeZone: input.timeZone,
          },
          instanceId
        );
        for (const app of group) {
          blocked.push(app.name);
          console.log(
            `[${input.logPrefix}] manual sync deny window set for ${app.name} until ${input.blockUntil.toISOString()}`
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const app of group) {
          if (message.includes('already exists')) {
            blocked.push(app.name);
            console.log(
              `[${input.logPrefix}] manual sync deny window already active for ${app.name}`
            );
          } else {
            errors.push(`${app.name}: ${message}`);
            console.error(
              `[${input.logPrefix}] failed to block manual sync for ${app.name}: ${message}`
            );
          }
        }
      }
    }
  );

  return { blocked, errors };
}

function resolveManualSyncBlockUntilForShutdown(schedule: Schedule, now: Date): Date {
  return (
    computeCurrentLiveStartupAt(schedule, now) ??
    computeNextStartupAt(schedule, now) ??
    defaultBlockUntil(now)
  );
}

function resolveManualSyncBlockUntilForReconcile(schedule: Schedule, now: Date): Date {
  return schedule.liveStartupAt ?? resolveManualSyncBlockUntilForShutdown(schedule, now);
}

async function resolveScheduleArgoAppsForSyncDeny(schedule: Schedule): Promise<ScheduleArgoApp[]> {
  if (schedule.pausedArgoApps.length > 0) {
    const fromStored = await resolveArgoAppsForResume(schedule, schedule.pausedArgoApps);
    if (fromStored.length) return fromStored;
  }
  return collectScheduleArgoApps(schedule);
}

/** Apply manual-sync deny windows only — for stopped schedules missing windows after deploy/restart. */
export async function applyManualSyncDenyForSchedule(
  schedule: Schedule,
  now = new Date()
): Promise<{ apps: string[]; errors: string[] }> {
  if (isNonEksSchedule(schedule)) return { apps: [], errors: [] };

  const targets = await resolveScheduleArgoAppsForSyncDeny(schedule);
  return applyManualSyncDenyForApps(schedule, targets, now);
}

function buildCatalogForApps(
  allApps: ArgoCDAppSummary[],
  instanceMap: Map<string, Awaited<ReturnType<typeof listEnabledArgoCDInstances>>[number]>
): ArgoCatalog {
  return {
    filtered: (s) => filterAppsForSchedule(s, allApps, instanceMap),
    relaxed: (s) => {
      const inNamespace = allApps.filter((app) => app.destinationNamespace === s.namespace);
      if (s.argocdInstanceId) {
        const pinned = inNamespace.filter((app) => app.instanceId === s.argocdInstanceId);
        if (pinned.length) return pinned;
      }
      return inNamespace;
    },
    find: (s, appName) => {
      const scoped = filterAppsForSchedule(s, allApps, instanceMap);
      const scopedMatch = scoped.find((a) => a.name === appName);
      if (scopedMatch) return { name: scopedMatch.name, instanceId: scopedMatch.instanceId };
      const anyMatch = allApps.find((a) => a.name === appName);
      return anyMatch ? { name: anyMatch.name, instanceId: anyMatch.instanceId } : null;
    },
  };
}

/**
 * Resolve a schedule's Argo apps for the repair/reconcile path WITHOUT touching the live
 * cluster. A stopped schedule's workloads are scaled to 0 or deleted, so K8s
 * tracking-annotation lookups (getDeploymentArgoAppName, getArgoAppNamesForNamespace, …)
 * return nothing and the deny window silently never gets applied. The Argo CD catalog
 * (listApplications) always lists every app regardless of workload state, so we resolve
 * from it by namespace/instance instead. Order:
 *   1. Stored pausedArgoApps intersected with workload scope (drops stale namespace-wide lists).
 *   2. Namespace / workload schedules → Argo apps for getScheduleTargets() workloads only.
 *   3. Single-workload schedules → exact/fuzzy catalog match for that workload only.
 */
async function resolveScheduleArgoAppsFromCatalog(
  schedule: Schedule,
  allApps: ArgoCDAppSummary[],
  instanceMap: Map<string, Awaited<ReturnType<typeof listEnabledArgoCDInstances>>[number]>,
  workloadTargets?: WorkloadTarget[]
): Promise<ScheduleArgoApp[]> {
  const catalog = buildCatalogForApps(allApps, instanceMap);

  let scoped: ScheduleArgoApp[] = [];
  if (isNamespaceSchedule(schedule)) {
    const targets = workloadTargets ?? [];
    if (targets.length) {
      scoped = resolveArgoAppsFromCatalogForTargets(schedule, catalog, targets);
    }
  } else {
    const match = resolveWorkloadArgoAppFromCatalogOnly(schedule, catalog);
    if (match) scoped = [match];
  }

  if (schedule.pausedArgoApps.length > 0) {
    const fromStored = await resolveArgoAppsForResume(schedule, schedule.pausedArgoApps, catalog);
    if (scoped.length) {
      const scopedNames = new Set(scoped.map((a) => a.name));
      const filtered = fromStored.filter((a) => scopedNames.has(a.name));
      if (filtered.length) return filtered;
      return scoped;
    }
    if (fromStored.length) return fromStored;
  }

  return scoped;
}

/** Whether this schedule should keep Argo manual-sync deny windows active right now. */
export function scheduleShouldBeSyncBlockedNow(schedule: Schedule, now: Date): boolean {
  if (schedule.liveStopSource === 'manual') return true;
  if (schedule.liveStopSource === 'manual-start') return false;
  return isScheduleInStoppedWindow(schedule, now);
}

function syncBlockHoldKey(app: { name: string; instanceId: string }): string {
  return `${app.instanceId}:${app.name}`;
}

/**
 * Apps that must stay sync-blocked because at least one schedule is currently stopped.
 * Reconcile uses this so clearing windows for a running schedule never unblocks apps
 * another schedule (e.g. a manual stop) still needs blocked.
 */
export async function buildSyncBlockHoldSet(
  schedules: Schedule[],
  allApps: ArgoCDAppSummary[],
  instanceMap: Map<string, Awaited<ReturnType<typeof listEnabledArgoCDInstances>>[number]>,
  now: Date
): Promise<Set<string>> {
  const hold = new Set<string>();
  const stopped = schedules.filter(
    (s) => !isNonEksSchedule(s) && scheduleShouldBeSyncBlockedNow(s, now)
  );

  await runWithConcurrency(stopped, 4, async (schedule) => {
    const workloadTargets = isNamespaceSchedule(schedule)
      ? await getScheduleTargets(schedule).catch(() => [])
      : undefined;
    const catalog = buildCatalogForApps(allApps, instanceMap);
    const apps = await resolveScheduleArgoAppsForOperations(schedule, catalog, workloadTargets);
    for (const app of apps) hold.add(syncBlockHoldKey(app));
  });

  return hold;
}

/**
 * Repair/self-heal path: resolve from the Argo CD catalog only (no live K8s lookups), so
 * the deny window is applied even after the schedule's workloads have been deleted. K8s
 * tracking resolution is used only as a final fallback when the catalog yields nothing
 * (e.g. an app whose name and namespace both differ from the schedule).
 */
export async function applyManualSyncDenyForScheduleRepair(
  schedule: Schedule,
  allApps: ArgoCDAppSummary[],
  instanceMap: Map<string, Awaited<ReturnType<typeof listEnabledArgoCDInstances>>[number]>,
  now = new Date()
): Promise<{ apps: string[]; errors: string[] }> {
  if (isNonEksSchedule(schedule)) return { apps: [], errors: [] };

  const workloadTargets = isNamespaceSchedule(schedule)
    ? await getScheduleTargets(schedule)
    : undefined;

  const catalog = buildCatalogForApps(allApps, instanceMap);
  const targets = await resolveScheduleArgoAppsForOperations(schedule, catalog, workloadTargets);
  return applyManualSyncDenyForApps(schedule, targets, now);
}

/**
 * Inverse of applyManualSyncDenyForScheduleRepair: a schedule that is currently OUTSIDE its
 * stop window (should be running) but still has SecureNexus deny windows / paused sync must
 * be cleaned up. Resolves apps from the Argo catalog (K8s-free, namespace-wide) and removes
 * the deny windows + restores automated sync. This is the missing self-heal for "manual sync
 * window not removed automatically" — startup is no longer the only thing that can remove it.
 */
export async function clearManualSyncDenyForScheduleRepair(
  schedule: Schedule,
  allApps: ArgoCDAppSummary[],
  instanceMap: Map<string, Awaited<ReturnType<typeof listEnabledArgoCDInstances>>[number]>,
  options?: { holdKeys?: Set<string> }
): Promise<{ apps: string[]; errors: string[] }> {
  if (isNonEksSchedule(schedule)) return { apps: [], errors: [] };

  let apps = await resolveScheduleArgoAppsFromCatalog(
    schedule,
    allApps,
    instanceMap,
    isNamespaceSchedule(schedule) ? await getScheduleTargets(schedule).catch(() => []) : undefined
  );

  // Only remove windows this schedule owns — not apps another stopped schedule still needs.
  if (schedule.pausedArgoApps.length > 0) {
    const owned = new Set(schedule.pausedArgoApps);
    apps = apps.filter((app) => owned.has(app.name));
  }

  const holdKeys = options?.holdKeys;
  if (holdKeys?.size) {
    const before = apps.length;
    apps = apps.filter((app) => !holdKeys.has(syncBlockHoldKey(app)));
    const skipped = before - apps.length;
    if (skipped > 0) {
      console.log(
        `[Argo reconcile] skipping unblock for ${skipped} app(s) on "${schedule.name}" — still required by another stopped schedule`
      );
    }
  }

  if (!apps.length) return { apps: [], errors: [] };

  const cleared: string[] = [];
  const errors: string[] = [];

  const byInstance = new Map<string, ScheduleArgoApp[]>();
  for (const app of apps) {
    const group = byInstance.get(app.instanceId) ?? [];
    group.push(app);
    byInstance.set(app.instanceId, group);
  }

  await runWithConcurrency(Array.from(byInstance.entries()), 2, async ([instanceId, group]) => {
    const appNames = group.map((app) => app.name);
    try {
      const removed = await argocdClient.removeScheduleManualSyncDenyWindowsForApps(
        appNames,
        instanceId
      );
      if (removed > 0) cleared.push(...appNames);
    } catch (err) {
      for (const app of group) {
        errors.push(`${app.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  // Remove any legacy namespace-scoped deny window (one sample app per instance/project).
  if (isNamespaceSchedule(schedule) && namespaceScheduleUsesFullNamespaceSyncBlock(schedule)) {
    const sampleByInstance = new Map<string, ScheduleArgoApp>();
    for (const app of apps) {
      if (!sampleByInstance.has(app.instanceId)) sampleByInstance.set(app.instanceId, app);
    }
    await runWithConcurrency(
      Array.from(sampleByInstance.values()),
      resolveArgoOpConcurrency(),
      async (app) => {
        try {
          const removed = await argocdClient.removeScheduleNamespaceDenyWindow(
            schedule.namespace,
            app.name,
            app.instanceId
          );
          if (removed > 0 && !cleared.includes(app.name)) cleared.push(app.name);
        } catch (err) {
          errors.push(`${schedule.namespace}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    );
  }

  // ONLY restore automated sync for apps we actually unblocked, and only when the schedule is
  // configured for automated sync. Critical: a running schedule with nothing blocked makes no
  // Argo writes here, so this is safe to run every reconcile without triggering spurious syncs.
  if (cleared.length > 0 && schedule.syncPolicy === 'automated') {
    await runWithConcurrency(
      apps.filter((a) => cleared.includes(a.name)),
      resolveArgoOpConcurrency(),
      async (app) => {
        try {
          await argocdClient.updateSyncPolicy(app.name, 'automated', app.instanceId);
        } catch (err) {
          errors.push(`${app.name}: restore: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    );
  }

  return { apps: cleared, errors };
}

export async function applyManualSyncDenyForApps(
  schedule: Schedule,
  targets: ScheduleArgoApp[],
  now = new Date()
): Promise<{ apps: string[]; errors: string[] }> {
  if (isNonEksSchedule(schedule) || !targets.length) return { apps: [], errors: [] };

  // Pause automated sync as well as adding the deny window. The deny window blocks sync
  // only while it is *active*; if the original shutdown failed to resolve the app, auto
  // sync was never turned off, so ArgoCD kept re-syncing the workload back up (the
  // "Auto sync is enabled" + synced-during-downtime symptom). Re-asserting syncPolicy=none
  // here makes the self-heal restore the same state a real shutdown would. Idempotent.
  await runWithConcurrency(targets, resolveArgoOpConcurrency(), async (app) => {
    try {
      await argocdClient.updateSyncPolicy(app.name, 'none', app.instanceId);
    } catch (err) {
      console.error(
        `[Argo reconcile] failed to pause automated sync for ${app.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  });

  const { blocked, errors } = await blockManualSyncForApps(targets, {
    blockUntil: resolveManualSyncBlockUntilForReconcile(schedule, now),
    timeZone: schedule.timezone || 'UTC',
    now,
    logPrefix: 'Argo reconcile',
  });

  return { apps: blocked, errors };
}

/** Pause automated sync and block manual sync for Argo apps linked to this schedule only. */
async function pauseArgoForSchedule(
  schedule: Schedule,
  now = new Date(),
  workloadTargets?: WorkloadTarget[]
): Promise<{ note: string; apps: string[] }> {
  const catalog = await loadArgoCatalog();

  // Resolve the apps to block from the Argo CD catalog (listApplications), NOT from live
  // Kubernetes tracking annotations. A stopping schedule's workloads are about to be (or
  // already) scaled to 0 / deleted, so K8s-based resolution silently returns nothing and
  // the sync-off never lands — the root cause of "worked for some, not all". Argo CD
  // Application objects persist regardless of workload state, so the catalog is reliable.
  //
  // Sync-off always follows workload targets — never every Argo app in the namespace catalog.
  const targets = await resolveScheduleArgoAppsForOperations(schedule, catalog, workloadTargets);
  const targetCount = workloadTargets?.length ?? 0;
  console.log(
    `[Argo pause] ${schedule.namespace} syncScope=workload-targets (${targetCount} workload(s)) resolved apps: ${
      targets.map((t) => t.name).join(', ') || '(none)'
    }`
  );

  if (!targets.length) {
    console.warn(
      `[Argo pause] no Argo apps resolved for schedule "${schedule.name}" ` +
        `(cluster=${schedule.cluster}, namespace=${schedule.namespace}, app=${schedule.appName})`
    );
  }

  const paused: string[] = [];
  const pauseErrors: string[] = [];
  const blockUntil = resolveManualSyncBlockUntilForShutdown(schedule, now);
  const timeZone = schedule.timezone || 'UTC';

  await runWithConcurrency(targets, resolveArgoOpConcurrency(), async (app) => {
    try {
      await argocdClient.updateSyncPolicy(app.name, 'none', app.instanceId);
      paused.push(app.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pauseErrors.push(`${app.name}: ${message}`);
      console.error(`[Argo pause] failed to pause ${app.name}:`, message);
    }
  });

  const { blocked: manualBlocked, errors: manualErrors } = await blockManualSyncForApps(targets, {
    blockUntil,
    timeZone,
    now,
    logPrefix: 'Argo pause',
  });

  // Per-app deny windows only — namespace-wide deny blocks manual sync for every app in the
  // namespace/project and is not used (leftover windows are cleared on resume).
  const namespaceBlocked: string[] = [];

  const notes: string[] = [];
  if (paused.length) notes.push(`ArgoCD sync paused (${paused.join(', ')})`);
  if (manualBlocked.length) notes.push(`manual sync blocked (${manualBlocked.join(', ')})`);
  if (namespaceBlocked.length) {
    notes.push(`namespace sync blocked (${schedule.namespace})`);
  }
  if (!targets.length && !namespaceBlocked.length) {
    notes.push('no Argo CD apps linked — sync may not be blocked');
  }
  const blockingErrors = [...pauseErrors, ...manualErrors];
  if (blockingErrors.length && !manualBlocked.length && !namespaceBlocked.length) {
    notes.push(`Argo CD sync block failed: ${blockingErrors.join('; ')}`);
  }
  const note = notes.length ? ` · ${notes.join(' · ')}` : '';
  return { note, apps: Array.from(new Set([...paused, ...manualBlocked])) };
}

async function stopScaledObjectWorkload(
  cluster: string,
  namespace: string,
  name: string,
  managedByArgo: boolean
): Promise<'deleted' | 'paused'> {
  if (managedByArgo) {
    await shutdownScaledObject(cluster, namespace, name, {
      managedByArgo: true,
      settleBeforeDeleteMs: STS_SHUTDOWN_SETTLE_MS,
    });
    return 'deleted';
  }
  await pauseScaledObjectByAnnotation(cluster, namespace, name);
  return 'paused';
}

async function startScaledObjectWorkload(
  cluster: string,
  namespace: string,
  name: string,
  managedByArgo: boolean
): Promise<'argocd' | 'resumed'> {
  if (managedByArgo || !(await scaledObjectExists(cluster, namespace, name))) {
    return 'argocd';
  }
  await resumeScaledObjectByAnnotation(cluster, namespace, name);
  return 'resumed';
}

function scheduleIncludesScaledObject(
  schedule: Schedule,
  targets: WorkloadTarget[]
): boolean {
  if (!isNamespaceSchedule(schedule) && schedule.workloadKind === 'ScaledObject') return true;
  return targets.some((target) => target.kind === 'ScaledObject');
}

function filterAppsForSchedule(
  schedule: Schedule,
  apps: ArgoCDAppSummary[],
  instanceMap: Map<string, Awaited<ReturnType<typeof listEnabledArgoCDInstances>>[number]>
): ArgoCDAppSummary[] {
  return apps.filter((app) => {
    if (schedule.argocdInstanceId && app.instanceId !== schedule.argocdInstanceId) {
      return false;
    }
    const instance = instanceMap.get(app.instanceId);
    if (instance && !instanceMatchesCluster(instance, schedule.cluster)) return false;
    return appMatchesK8sCluster(app, schedule.cluster);
  });
}

async function appsForSchedule(schedule: Schedule): Promise<ArgoCDAppSummary[]> {
  const [apps, instances] = await Promise.all([
    argocdClient.listApplications(),
    listEnabledArgoCDInstances(),
  ]);
  const instanceMap = new Map(instances.map((i) => [i.id, i]));
  return filterAppsForSchedule(schedule, apps, instanceMap);
}

async function resolveArgoApp(
  schedule: Schedule,
  catalog?: ArgoCatalog
): Promise<ScheduleArgoApp | null> {
  if (isNamespaceSchedule(schedule)) return null;

  const ctx = catalog ?? (await loadArgoCatalog());

  if (schedule.workloadKind === 'ScaledObject') {
    return resolveArgoAppForScaledObject(schedule, ctx);
  }

  if (schedule.workloadKind === 'Deployment') {
    const trackingApp = await getDeploymentArgoAppName(
      schedule.cluster,
      schedule.namespace,
      schedule.appName
    );
    console.log(
      `[Argo resolve] deployment ${schedule.namespace}/${schedule.appName} trackingApp=${
        trackingApp ?? '(none)'
      }`
    );
    if (trackingApp) {
      const byTracking = findArgoAppInCatalog(ctx, schedule, trackingApp);
      if (byTracking) return byTracking;
    }
  }

  if (schedule.workloadKind === 'CronJob') {
    const trackingApp = await getCronJobArgoAppName(
      schedule.cluster,
      schedule.namespace,
      schedule.appName
    );
    if (trackingApp) {
      const byTracking = findArgoAppInCatalog(ctx, schedule, trackingApp);
      if (byTracking) return byTracking;
    }
  }

  try {
    const scoped = ctx.filtered(schedule);
    const match = resolveArgoAppFromPool(schedule, scoped);
    if (match) return match;

    return findArgoAppInCatalog(ctx, schedule, schedule.appName);
  } catch {
    return null;
  }
}

async function resolveArgoAppsForResume(
  schedule: Schedule,
  appNames: string[],
  catalog?: ArgoCatalog
): Promise<ScheduleArgoApp[]> {
  const ctx = catalog ?? (await loadArgoCatalog());
  const resolved: ScheduleArgoApp[] = [];

  await runWithConcurrency(appNames, resolveArgoOpConcurrency(), async (name) => {
    const match = findArgoAppInCatalog(ctx, schedule, name);
    if (match) {
      resolved.push(match);
      return;
    }
    if (schedule.argocdInstanceId) {
      resolved.push({ name, instanceId: schedule.argocdInstanceId });
    }
  });

  return resolved;
}

/** Resume automated sync and remove SecureNexus manual-sync deny windows. */
async function resumeStoredArgoApps(
  schedule: Schedule,
  apps: ScheduleArgoApp[],
  options?: { forceSync?: boolean }
): Promise<string> {
  const unblocked: string[] = [];
  const forceSync = options?.forceSync ?? schedule.workloadKind === 'ScaledObject';

  const byInstance = new Map<string, ScheduleArgoApp[]>();
  for (const app of apps) {
    const group = byInstance.get(app.instanceId) ?? [];
    group.push(app);
    byInstance.set(app.instanceId, group);
  }

  await runWithConcurrency(Array.from(byInstance.entries()), 2, async ([instanceId, group]) => {
    const appNames = group.map((app) => app.name);
    try {
      const removed = await argocdClient.removeScheduleManualSyncDenyWindowsForApps(
        appNames,
        instanceId
      );
      unblocked.push(...appNames);
      console.log(
        `[Argo resume] unblocked ${appNames.length} app(s) on instance ${instanceId} (${removed} deny row(s) removed)`
      );
    } catch (err) {
      console.error(
        `[Argo resume] failed to remove manual-sync deny windows for ${appNames.join(', ')}:`,
        err instanceof Error ? err.message : err
      );
    }
  });

  const sampleByInstance = new Map<string, ScheduleArgoApp>();
  if (isNamespaceSchedule(schedule)) {
    for (const app of apps) {
      if (!sampleByInstance.has(app.instanceId)) sampleByInstance.set(app.instanceId, app);
    }
    await runWithConcurrency(
      Array.from(sampleByInstance.values()),
      resolveArgoOpConcurrency(),
      async (app) => {
        try {
          const removed = await argocdClient.removeScheduleNamespaceDenyWindow(
            schedule.namespace,
            app.name,
            app.instanceId
          );
          if (removed > 0) {
            console.log(
              `[Argo resume] removed namespace deny window for ${schedule.namespace} in project via ${app.name}`
            );
          }
        } catch (err) {
          console.error(
            `[Argo resume] failed to remove namespace deny for ${schedule.namespace}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    );
  }

  const notes: string[] = [];
  if (unblocked.length) {
    notes.push(`manual sync unblocked (${unblocked.join(', ')})`);
  }

  if (schedule.syncPolicy !== 'automated' && !forceSync) {
    return notes.length ? ` · ${notes.join(' · ')}` : '';
  }

  const resumed: string[] = [];
  const unblockedSet = new Set(unblocked);
  const appsToSync = apps.filter((app) => unblockedSet.has(app.name));
  await runWithConcurrency(appsToSync, 2, async (app) => {
    try {
      if (schedule.syncPolicy === 'automated') {
        await argocdClient.updateSyncPolicy(app.name, 'automated', app.instanceId);
      }
      resumed.push(app.name);
      try {
        await argocdClient.triggerSync(app.name, app.instanceId);
      } catch (err) {
        console.error(
          `[Argo resume] sync trigger failed for ${app.name}:`,
          err instanceof Error ? err.message : err
        );
      }
    } catch (err) {
      console.error(
        `[Argo resume] failed to resume Argo app ${app.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  });
  if (resumed.length) {
    notes.push(
      forceSync && schedule.syncPolicy !== 'automated'
        ? `ArgoCD sync triggered (${resumed.join(', ')})`
        : `ArgoCD sync restored (${resumed.join(', ')})`
    );
  }
  return notes.length ? ` · ${notes.join(' · ')}` : '';
}

export async function getScheduleTargets(schedule: Schedule): Promise<WorkloadTarget[]> {
  if (!isNamespaceSchedule(schedule)) {
    return [
      {
        name: schedule.appName,
        kind: schedule.workloadKind as WorkloadKind,
      },
    ];
  }

  const excluded = new Set(schedule.excludedWorkloads ?? []);
  const workloads = await listWorkloads(schedule.cluster, schedule.namespace);

  return workloads.filter((w) => {
    if (w.kind === 'DaemonSet') return false;
    return !excluded.has(workloadKey(w.kind, w.name));
  });
}

function parseSavedWorkloadReplicas(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'number') out[key] = val;
  }
  return out;
}

/** Use saved count from shutdown; fall back when already at 0 or save was overwritten. */
function resolveStartupReplicas(schedule: Schedule, saved: number | null | undefined): number {
  if (saved != null && saved > 0) return saved;
  return schedule.targetReplicas;
}

function resolveShutdownReplicaSave(
  current: number,
  prior: number | null | undefined,
  fallback: number
): number {
  if (current > 0) return current;
  if (prior != null && prior > 0) return prior;
  return fallback;
}

async function executeEc2Shutdown(
  schedule: Schedule,
  triggeredBy: string,
  options?: ShutdownOptions
): Promise<void> {
  const runLog = createScheduleRunLogger('shutdown', schedule, triggeredBy);
  runLog.phase('begin', 'EC2 shutdown started', { options: options ?? null });

  const credentialId = schedule.awsCredentialId;
  const instanceId = schedule.ec2InstanceId;
  const region = schedule.ec2Region;
  if (!credentialId || !instanceId || !region) {
    const message = 'EC2 schedule is missing AWS account or instance';
    runLog.finish('failed', message);
    throw new Error(message);
  }

  const liveUpdate = buildLiveScheduleUpdate(schedule, triggeredBy, options);

  try {
    runLog.phase('ec2-stop', 'Stopping EC2 instance', { instanceId, region });
    await stopEc2Instance(credentialId, instanceId, region);

    if (Object.keys(liveUpdate).length > 0) {
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: liveUpdate,
      });
    }

    const message = `EC2 instance ${schedule.appName} (${instanceId}) stop requested in ${region}`;
    runLog.finish('success', message, { instanceId, region });

    await logActivity({
      action: 'schedule-shutdown',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: schedule.appName,
      triggeredBy,
      status: 'success',
      message: `EC2 instance ${schedule.appName} (${instanceId}) stop requested in ${region}`,
      details: JSON.stringify({ platformType: 'non_eks', instanceId, region }),
      startTime: formatScheduleStartupLabel(schedule),
      ...resolveScheduleTeamsAlert(schedule, triggeredBy),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'EC2 shutdown failed';
    runLog.finish('failed', message, { instanceId, region });
    await logActivity({
      action: 'schedule-shutdown',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: schedule.appName,
      triggeredBy,
      status: 'failed',
      message,
      details: JSON.stringify({ platformType: 'non_eks', instanceId, region }),
      ...resolveScheduleTeamsAlert(schedule, triggeredBy),
    });
    throw err;
  }
}

async function executeEc2Startup(schedule: Schedule, triggeredBy: string): Promise<void> {
  const runLog = createScheduleRunLogger('startup', schedule, triggeredBy);
  runLog.phase('begin', 'EC2 startup started');

  const credentialId = schedule.awsCredentialId;
  const instanceId = schedule.ec2InstanceId;
  const region = schedule.ec2Region;
  if (!credentialId || !instanceId || !region) {
    const message = 'EC2 schedule is missing AWS account or instance';
    runLog.finish('failed', message);
    throw new Error(message);
  }

  try {
    runLog.phase('ec2-start', 'Starting EC2 instance', { instanceId, region });
    await startEc2Instance(credentialId, instanceId, region);

    await prisma.schedule.update({
      where: { id: schedule.id },
      data: {
        liveActive: false,
        liveStartupAt: null,
        liveStopSource: null,
        liveStoppedBy: null,
      },
    });

    const message = `EC2 instance ${schedule.appName} (${instanceId}) start requested in ${region}`;
    runLog.finish('success', message, { instanceId, region });

    await logActivity({
      action: 'schedule-startup',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: schedule.appName,
      triggeredBy,
      status: 'success',
      message,
      details: JSON.stringify({ platformType: 'non_eks', instanceId, region }),
      ...resolveScheduleTeamsAlert(schedule, triggeredBy),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'EC2 startup failed';
    runLog.finish('failed', message, { instanceId, region });
    await logActivity({
      action: 'schedule-startup',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: schedule.appName,
      triggeredBy,
      status: 'failed',
      message,
      details: JSON.stringify({ platformType: 'non_eks', instanceId, region }),
      ...resolveScheduleTeamsAlert(schedule, triggeredBy),
    });
    throw err;
  }
}

export interface ShutdownOptions {
  markLive?: boolean;
  clearLive?: boolean;
}

function buildLiveScheduleUpdate(
  schedule: Schedule,
  triggeredBy: string,
  options?: ShutdownOptions
): Record<string, unknown> {
  if (options?.clearLive) {
    const scheduled = isAutomaticScheduleTrigger(triggeredBy);
    return {
      liveActive: false,
      liveStartupAt: null,
      ...(scheduled
        ? { liveStopSource: null, liveStoppedBy: null }
        : { liveStopSource: 'manual', liveStoppedBy: triggeredBy }),
    };
  }
  if (options?.markLive) {
    const scheduled = isAutomaticScheduleTrigger(triggeredBy);
    return {
      liveActive: true,
      liveStartupAt: computeCurrentLiveStartupAt(schedule, new Date()),
      liveStopSource: scheduled ? 'scheduled' : 'manual',
      liveStoppedBy: scheduled ? null : triggeredBy,
    };
  }
  return {};
}

export async function executeShutdown(
  schedule: Schedule,
  triggeredBy: string,
  options?: ShutdownOptions
): Promise<void> {
  if (isNonEksSchedule(schedule)) {
    return executeEc2Shutdown(schedule, triggeredBy, options);
  }

  const runLog = createScheduleRunLogger('shutdown', schedule, triggeredBy);
  runLog.phase('begin', 'Shutdown started', { options: options ?? null });

  const isNamespace = isNamespaceSchedule(schedule);
  const activityAppName = isNamespace ? NAMESPACE_SCOPE_MARKER : schedule.appName;
  let targets: WorkloadTarget[] = [];

  try {
    targets = await getScheduleTargets(schedule);
    runLog.phase('targets', 'Resolved workload targets', {
      count: targets.length,
      workloads: targets.map((t) => workloadKey(t.kind, t.name)),
      scope: isNamespace ? 'namespace' : 'workload',
      excludedWorkloads: schedule.excludedWorkloads?.length ?? 0,
    });

    const shutdownCatalog = await loadArgoCatalog();
    const argoAppsByTargetKey = new Map<string, ScheduleArgoApp[]>();
    for (const target of targets) {
      const key = workloadKey(target.kind, target.name);
      const apps = await collectScheduleArgoApps(schedule, shutdownCatalog, [target]);
      argoAppsByTargetKey.set(
        key,
        apps.length ? apps : resolveArgoAppsFromCatalogForTargets(schedule, shutdownCatalog, [target])
      );
    }

    const [nodeCount, fresh, pauseOutcome] = await Promise.all([
      getClusterReadyNodeCount(schedule.cluster),
      prisma.schedule.findUnique({ where: { id: schedule.id } }),
      pauseArgoForSchedule(schedule, new Date(), targets)
        .then((result) => ({ ok: true as const, result }))
        .catch((err: unknown) => ({ ok: false as const, err })),
    ]);
    const priorWorkloadSaves = parseSavedWorkloadReplicas(fresh?.savedWorkloadReplicas);
    const alertSchedule = fresh ?? schedule;

    const liveUpdate = buildLiveScheduleUpdate(schedule, triggeredBy, options);

    // Commit the live-state (liveActive / liveStopSource) BEFORE touching workloads.
    // Once targets are resolved and Argo is paused we are committed to stopping, so the
    // schedule must read as "stopped" even if a workload op later throws or partially
    // fails. Persisting after the scale loop (the old behavior) left schedules showing
    // "Enabled" whenever the loop threw — the exact "workloads stopped but status
    // Enabled" bug. The final update below still records savedReplicas/pausedArgoApps.
    if (Object.keys(liveUpdate).length > 0) {
      await prisma.schedule
        .update({ where: { id: schedule.id }, data: liveUpdate })
        .catch((err) =>
          console.error(
            `[Scheduler] failed to persist live-state early for "${schedule.name}":`,
            err instanceof Error ? err.message : err
          )
        );
    }

    let argoNote = '';
    let pausedArgoApps: string[] = [];
    if (pauseOutcome.ok) {
      argoNote = pauseOutcome.result.note;
      pausedArgoApps = pauseOutcome.result.apps;
      runLog.phase('argo-pause', 'Argo sync paused', {
        apps: pausedArgoApps,
        note: argoNote || null,
      });
    } else {
      const argoErr =
        pauseOutcome.err instanceof Error ? pauseOutcome.err.message : 'unknown';
      argoNote = ` · ArgoCD sync pause failed: ${argoErr}`;
      runLog.warn('argo-pause', 'Argo sync pause failed', { error: argoErr });
    }

    let statefulSetDeleted = false;
    let scaledObjectDeleted = false;
    const managedByArgo = pausedArgoApps.length > 0;
    const shutdownFailures: string[] = [];

    if (isNamespace) {
      const replicasMap: Record<string, number> = {};

      // Resilient per-workload shutdown: a single workload op failing (e.g. a K8s
      // read/scale/ScaledObject-delete timing out under the midnight batch load) must
      // NOT abort the whole namespace shutdown. Collect failures and only hard-fail
      // when every workload failed, so the schedule still transitions to stopped and
      // pausedArgoApps/liveUpdate are persisted (otherwise the schedule is left showing
      // "Enabled" while Argo is already half-paused, and startup can't resume it).
      await runWithConcurrency(targets, resolveWorkloadOpConcurrency(), async (target) => {
        const key = workloadKey(target.kind, target.name);
        try {
          const current = await getWorkloadDesiredReplicas(
            schedule.cluster,
            schedule.namespace,
            target.kind,
            target.name
          );
          replicasMap[key] = resolveShutdownReplicaSave(
            current,
            priorWorkloadSaves[key],
            schedule.targetReplicas
          );
          runLog.phase('workload-stop', `Stopping ${key}`, {
            currentReplicas: current,
            savedReplicas: replicasMap[key],
          });
          if (target.kind === 'ScaledObject') {
            await retryWorkloadOp(`stop ${key}`, () =>
              stopScaledObjectWorkload(
                schedule.cluster,
                schedule.namespace,
                target.name,
                (argoAppsByTargetKey.get(key) ?? []).some((a) => pausedArgoApps.includes(a.name))
              )
            );
            runLog.phase('workload-stop', `Stopped ${key}`, { method: 'scaledobject' });
            return;
          }
          if (target.kind === 'StatefulSet') {
            const targetManaged = (argoAppsByTargetKey.get(key) ?? []).some((a) =>
              pausedArgoApps.includes(a.name)
            );
            if (targetManaged) {
              runLog.phase('workload-stop', `Deleting Argo-managed StatefulSet ${key}`, {
                argoApps: (argoAppsByTargetKey.get(key) ?? []).map((a) => a.name),
              });
              await new Promise((r) => setTimeout(r, STS_SHUTDOWN_SETTLE_MS));
              await retryWorkloadOp(`stop ${key}`, () =>
                deleteStatefulSet(schedule.cluster, schedule.namespace, target.name)
              );
              await new Promise((r) => setTimeout(r, STS_SHUTDOWN_SETTLE_MS));
              const reappeared = await statefulSetExists(
                schedule.cluster,
                schedule.namespace,
                target.name
              ).catch(() => false);
              runLog.phase('workload-stop', `StatefulSet delete completed for ${key}`, {
                reappeared,
              });
              return;
            }
          }
          await retryWorkloadOp(`stop ${key}`, () =>
            scaleWorkload(schedule.cluster, schedule.namespace, target.kind, target.name, 0)
          );
          runLog.phase('workload-stop', `Stopped ${key}`, { method: 'scale-to-0' });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'stop failed';
          shutdownFailures.push(`${key}: ${errMsg}`);
          runLog.warn('workload-stop', `Failed to stop ${key}`, { error: errMsg });
        }
      });

      // Only treat as a hard failure when EVERY workload failed; a partial failure still
      // lets the schedule transition to stopped so the status reflects reality and the
      // resolved Argo apps stay paused/resumable.
      if (targets.length > 0 && shutdownFailures.length === targets.length) {
        throw new Error(
          `All ${targets.length} workload(s) failed to stop: ${shutdownFailures.join('; ')}`
        );
      }

      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          savedWorkloadReplicas: replicasMap,
          savedReplicas: null,
          pausedArgoApps,
          ...liveUpdate,
        },
      });
    } else {
      const kind = schedule.workloadKind as WorkloadKind;
      const currentReplicas = await getWorkloadDesiredReplicas(
        schedule.cluster,
        schedule.namespace,
        kind,
        schedule.appName
      );
      const replicasToSave = resolveShutdownReplicaSave(
        currentReplicas,
        fresh?.savedReplicas,
        schedule.targetReplicas
      );

      // StatefulSets managed by ArgoCD are deleted (PVCs preserved) so the
      // shutdown sticks. The owning Argo app was already resolved (via the live
      // resource's tracking metadata) and paused above, and is remembered so
      // startup can resume it. If no Argo app manages it, fall back to scale-to-0.
      if (kind === 'StatefulSet') {
        if (pausedArgoApps.length) {
          runLog.phase('workload-stop', 'Deleting Argo-managed StatefulSet', {
            managedByArgo: true,
            settleMs: STS_SHUTDOWN_SETTLE_MS,
          });
          // Let Argo register the paused policy before deleting so an in-flight
          // self-heal doesn't immediately recreate the StatefulSet.
          await new Promise((r) => setTimeout(r, STS_SHUTDOWN_SETTLE_MS));
          await retryWorkloadOp(`stop StatefulSet/${schedule.appName}`, () =>
            deleteStatefulSet(schedule.cluster, schedule.namespace, schedule.appName)
          );
          statefulSetDeleted = true;

          // Verify the delete stuck (Argo did not immediately recreate it).
          await new Promise((r) => setTimeout(r, STS_SHUTDOWN_SETTLE_MS));
          const reappeared = await statefulSetExists(
            schedule.cluster,
            schedule.namespace,
            schedule.appName
          ).catch(() => false);
          runLog.phase('workload-stop', 'StatefulSet delete completed', {
            reappeared,
          });
          console.log(
            `[STS shutdown] ${schedule.namespace}/${schedule.appName} deleted; reappeared=${reappeared}`
          );
        } else {
          runLog.warn('workload-stop', 'No Argo app — scaling StatefulSet to 0', {
            appName: schedule.appName,
          });
          console.log(
            `[STS shutdown] ${schedule.namespace}/${schedule.appName} no Argo app found; scaling to 0`
          );
          await retryWorkloadOp(`stop StatefulSet/${schedule.appName}`, () =>
            scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, 0)
          );
        }
      } else if (kind === 'ScaledObject') {
        runLog.phase('workload-stop', 'Stopping ScaledObject', {
          managedByArgo: pausedArgoApps.length > 0,
        });
        const mode = await retryWorkloadOp(`stop ScaledObject/${schedule.appName}`, () =>
          stopScaledObjectWorkload(
            schedule.cluster,
            schedule.namespace,
            schedule.appName,
            pausedArgoApps.length > 0
          )
        );
        scaledObjectDeleted = mode === 'deleted';
        if (mode === 'deleted') {
          await new Promise((r) => setTimeout(r, STS_SHUTDOWN_SETTLE_MS));
          const reappeared = await scaledObjectExists(
            schedule.cluster,
            schedule.namespace,
            schedule.appName
          ).catch(() => false);
          runLog.phase('workload-stop', 'ScaledObject deleted', { reappeared, mode });
          console.log(
            `[ScaledObject shutdown] ${schedule.namespace}/${schedule.appName} deleted; reappeared=${reappeared}`
          );
        } else {
          runLog.phase('workload-stop', 'ScaledObject paused', { mode });
        }
      } else {
        runLog.phase('workload-stop', `Scaling ${kind}/${schedule.appName} to 0`);
        await retryWorkloadOp(`stop ${kind}/${schedule.appName}`, () =>
          scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, 0)
        );
        runLog.phase('workload-stop', `Scaled ${kind}/${schedule.appName} to 0`);
      }

      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          savedReplicas: replicasToSave,
          savedWorkloadReplicas: Prisma.JsonNull,
          pausedArgoApps,
          ...liveUpdate,
        },
      });
    }

    const savedForMessage = isNamespace
      ? null
      : (await prisma.schedule.findUnique({ where: { id: schedule.id } }))?.savedReplicas;

    const isCronJobSchedule = !isNamespace && schedule.workloadKind === 'CronJob';
    const isScaledJobSchedule = !isNamespace && schedule.workloadKind === 'ScaledJob';
    const isScaledObjectSchedule = !isNamespace && schedule.workloadKind === 'ScaledObject';
    const shutdownFailuresNote = shutdownFailures.length
      ? ` · ${shutdownFailures.length} workload(s) failed to stop: ${shutdownFailures.join('; ')}`
      : '';
    const stoppedCount = targets.length - shutdownFailures.length;
    const message = isNamespace
      ? `Scaled ${stoppedCount}/${targets.length} workload(s) to 0 in ${schedule.namespace}${argoNote}${shutdownFailuresNote}`
      : isCronJobSchedule
        ? `Suspended CronJob ${schedule.appName} and removed active jobs${argoNote}`
        : isScaledJobSchedule
          ? `Paused ScaledJob ${schedule.appName} and removed active jobs${argoNote}`
          : isScaledObjectSchedule
            ? scaledObjectDeleted
              ? `Deleted ScaledObject ${schedule.appName} (ArgoCD will recreate on startup)${argoNote}`
              : `Paused ScaledObject ${schedule.appName} (no linked Argo CD app)${argoNote}`
            : statefulSetDeleted
              ? `Deleted StatefulSet ${schedule.appName} (PVCs preserved)${argoNote}`
              : `Scaled to 0 (saved ${savedForMessage ?? schedule.targetReplicas} replicas)${argoNote}`;

    const activityDetails = buildShutdownActivityDetails(
      isNamespace
        ? {
            scope: 'namespace',
            workloads: targets.map((t) => workloadKey(t.kind, t.name)),
            count: targets.length,
          }
        : undefined,
      nodeCount
    );

    runLog.finish('success', message, {
      pausedArgoApps,
      shutdownFailures,
      statefulSetDeleted,
      scaledObjectDeleted,
      stoppedCount,
      targetCount: targets.length,
    });

    await logActivity({
      action: 'schedule-shutdown',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: activityAppName,
      triggeredBy,
      status: 'success',
      message,
      details: activityDetails,
      startTime: formatScheduleStartupLabel(schedule),
      ...resolveScheduleTeamsAlert(alertSchedule, triggeredBy),
    });
  } catch (err) {
    const alertSchedule =
      (await prisma.schedule.findUnique({ where: { id: schedule.id } })) ?? schedule;
    const message = err instanceof Error ? err.message : 'Shutdown failed';
    runLog.finish('failed', message, {
      targetCount: targets.length,
      workloads: targets.map((t) => workloadKey(t.kind, t.name)),
    });
    await logActivity({
      action: 'schedule-shutdown',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: activityAppName,
      triggeredBy,
      status: 'failed',
      message,
      details: buildShutdownActivityDetails(
        isNamespace
          ? {
              scope: 'namespace',
              workloads: targets.map((t) => workloadKey(t.kind, t.name)),
              count: targets.length,
            }
          : undefined,
        null
      ),
      ...resolveScheduleTeamsAlert(alertSchedule, triggeredBy),
    });
    throw err;
  }
}

export async function executeStartup(schedule: Schedule, triggeredBy: string): Promise<void> {
  if (isNonEksSchedule(schedule)) {
    return executeEc2Startup(schedule, triggeredBy);
  }

  const runLog = createScheduleRunLogger('startup', schedule, triggeredBy);
  runLog.phase('begin', 'Startup started');

  const isNamespace = isNamespaceSchedule(schedule);
  const activityAppName = isNamespace ? NAMESPACE_SCOPE_MARKER : schedule.appName;
  let targets: WorkloadTarget[] = [];

  try {
    const [resolvedTargets, fresh] = await Promise.all([
      getScheduleTargets(schedule),
      prisma.schedule.findUnique({ where: { id: schedule.id } }),
    ]);
    targets = resolvedTargets;
    runLog.phase('targets', 'Resolved workload targets', {
      count: targets.length,
      workloads: targets.map((t) => workloadKey(t.kind, t.name)),
      pausedArgoApps: fresh?.pausedArgoApps ?? [],
    });
    const alertSchedule = fresh ?? schedule;

    let statefulSetRecreatedViaArgo = false;
    let scaledObjectRecreatedViaArgo = false;
    const startupFailures: string[] = [];
    const catalogPromise = loadArgoCatalog();
    const hadArgoPause = (fresh?.pausedArgoApps ?? []).length > 0;
    const includesScaledObject = scheduleIncludesScaledObject(schedule, targets);

    if (isNamespace) {
      const savedMap = parseSavedWorkloadReplicas(fresh?.savedWorkloadReplicas);

      await runWithConcurrency(targets, resolveWorkloadOpConcurrency(), async (target) => {
        const key = workloadKey(target.kind, target.name);
        if (target.kind === 'ScaledObject') {
          try {
            runLog.phase('workload-start', `Starting ${key}`, { method: 'scaledobject' });
            const mode = await retryWorkloadOp(`start ${key}`, () =>
              startScaledObjectWorkload(
                schedule.cluster,
                schedule.namespace,
                target.name,
                hadArgoPause
              )
            );
            runLog.phase('workload-start', `Started ${key}`, { mode });
            if (mode === 'argocd') return;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'start failed';
            startupFailures.push(`${key}: ${errMsg}`);
            runLog.warn('workload-start', `Failed to start ${key}`, { error: errMsg });
          }
          return;
        }
        const replicas = resolveStartupReplicas(schedule, savedMap[key]);
        try {
          runLog.phase('workload-start', `Scaling ${key} to ${replicas}`, { replicas });
          await retryWorkloadOp(`start ${key}`, () =>
            scaleWorkload(schedule.cluster, schedule.namespace, target.kind, target.name, replicas)
          );
          runLog.phase('workload-start', `Started ${key}`, { replicas });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'scale failed';
          startupFailures.push(`${key}: ${errMsg}`);
          runLog.warn('workload-start', `Failed to start ${key}`, { error: errMsg });
        }
      });

      // Only treat startup as a hard failure when EVERY workload failed; a partial failure
      // still lets the schedule transition to started so the status reflects reality.
      if (targets.length > 0 && startupFailures.length === targets.length) {
        throw new Error(
          `All ${targets.length} workload(s) failed to start: ${startupFailures.join('; ')}`
        );
      }
    } else {
      const kind = schedule.workloadKind as WorkloadKind;
      const replicas = resolveStartupReplicas(schedule, fresh?.savedReplicas);
      // A deleted (Argo-managed) StatefulSet no longer exists — skip scaling and let
      // the resumed Argo sync below recreate it bound to the existing PVCs. Only scale
      // when the STS is still present (the scale-to-0 fallback path).
      if (kind === 'StatefulSet') {
        if (await statefulSetExists(schedule.cluster, schedule.namespace, schedule.appName)) {
          runLog.phase('workload-start', `Scaling StatefulSet/${schedule.appName}`, { replicas });
          await retryWorkloadOp(`start StatefulSet/${schedule.appName}`, () =>
            scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, replicas)
          );
          runLog.phase('workload-start', `Scaled StatefulSet/${schedule.appName}`, { replicas });
        } else {
          statefulSetRecreatedViaArgo = true;
          runLog.phase('workload-start', 'StatefulSet missing — will recreate via Argo', {
            replicas,
          });
        }
      } else if (kind === 'ScaledObject') {
        runLog.phase('workload-start', `Starting ScaledObject/${schedule.appName}`);
        const mode = await retryWorkloadOp(`start ScaledObject/${schedule.appName}`, () =>
          startScaledObjectWorkload(
            schedule.cluster,
            schedule.namespace,
            schedule.appName,
            hadArgoPause
          )
        );
        scaledObjectRecreatedViaArgo = mode === 'argocd';
        runLog.phase('workload-start', `Started ScaledObject/${schedule.appName}`, { mode });
      } else {
        runLog.phase('workload-start', `Scaling ${kind}/${schedule.appName}`, { replicas });
        await retryWorkloadOp(`start ${kind}/${schedule.appName}`, () =>
          scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, replicas)
        );
        runLog.phase('workload-start', `Started ${kind}/${schedule.appName}`, { replicas });
      }
    }

    const storedPausedApps = fresh?.pausedArgoApps ?? [];

    let argoNote = '';
    try {
      const catalog = await catalogPromise;
      // Resolve the apps to UN-block from the Argo catalog (not live K8s), mirroring the
      // stop side. Namespace schedules cover the whole namespace, so even if the stored
      // pausedArgoApps list was lost (e.g. a restart), startup still removes the deny
      // window + re-enables sync for every app — otherwise the namespace would stay
      // sync-blocked after start.
      const resolveFromCatalog = async (): Promise<string[]> => {
        const apps = await resolveScheduleArgoAppsForOperations(schedule, catalog, targets);
        return apps.map((a) => a.name);
      };

      const scopedNames = await resolveFromCatalog();
      let storedNames = storedPausedApps.length
        ? filterPausedAppsToScheduleScope(storedPausedApps, scopedNames)
        : scopedNames;

      if (includesScaledObject && (scaledObjectRecreatedViaArgo || hadArgoPause)) {
        storedNames = scopedNames;
      }

      runLog.phase('argo-resume', 'Apps to resume (scoped)', {
        storedPausedCount: storedPausedApps.length,
        scopedCount: scopedNames.length,
        resumeCount: storedNames.length,
      });

      const toResume = await resolveArgoAppsForResume(schedule, storedNames, catalog);
      runLog.phase('argo-resume', 'Resolving Argo apps to resume', {
        storedNames,
        resolved: toResume.map((a) => a.name),
      });
      if (toResume.length) {
        argoNote = await resumeStoredArgoApps(schedule, toResume, {
          forceSync: includesScaledObject && (scaledObjectRecreatedViaArgo || hadArgoPause),
        });
        runLog.phase('argo-resume', 'Argo sync restored', { note: argoNote || null });
      } else if (storedNames.length) {
        runLog.warn('argo-resume', 'Could not resolve Argo instance for stored apps', {
          storedNames,
        });
        console.warn(
          `[Argo resume] could not resolve Argo instance for apps: ${storedNames.join(', ')}`
        );
      } else if (includesScaledObject && scaledObjectRecreatedViaArgo) {
        runLog.warn('argo-resume', 'ScaledObject needs Argo sync but no linked app resolved', {
          appName: schedule.appName,
        });
        console.warn(
          `[Argo resume] ScaledObject ${schedule.appName} needs Argo CD sync but no linked app was resolved`
        );
      }
    } catch (err) {
      const argoErr = err instanceof Error ? err.message : 'unknown';
      argoNote = ` · ArgoCD sync restore failed: ${argoErr}`;
      runLog.warn('argo-resume', 'Argo sync restore failed', { error: argoErr });
    }

    if (storedPausedApps.length) {
      await prisma.schedule
        .update({ where: { id: schedule.id }, data: { pausedArgoApps: [] } })
        .catch(() => undefined);
    }

    const restoredReplicas = isNamespace
      ? null
      : resolveStartupReplicas(schedule, fresh?.savedReplicas);

    const isCronJobSchedule = !isNamespace && schedule.workloadKind === 'CronJob';
    const isScaledJobSchedule = !isNamespace && schedule.workloadKind === 'ScaledJob';
    const isScaledObjectSchedule = !isNamespace && schedule.workloadKind === 'ScaledObject';
    const failuresNote = startupFailures.length
      ? ` · ${startupFailures.length} workload(s) failed to start: ${startupFailures.join('; ')}`
      : '';
    const restoredCount = targets.length - startupFailures.length;
    const message = isNamespace
      ? `Restored ${restoredCount}/${targets.length} workload(s) in ${schedule.namespace}${argoNote}${failuresNote}`
      : isCronJobSchedule
        ? `Resumed CronJob ${schedule.appName}${argoNote}`
        : isScaledJobSchedule
          ? `Resumed ScaledJob ${schedule.appName}${argoNote}`
          : isScaledObjectSchedule
            ? scaledObjectRecreatedViaArgo
              ? `Recreating ScaledObject ${schedule.appName} via ArgoCD${argoNote}`
              : `Resumed ScaledObject ${schedule.appName}${argoNote}`
            : statefulSetRecreatedViaArgo
              ? `Recreating StatefulSet ${schedule.appName} via ArgoCD (existing PVCs reused)${argoNote}`
              : `Scaled to ${restoredReplicas} replicas${argoNote}`;

    const startupDetails = isNamespace
      ? JSON.stringify({
          scope: 'namespace',
          workloads: targets.map((t) => workloadKey(t.kind, t.name)),
          count: targets.length,
        })
      : undefined;

    runLog.finish('success', message, {
      restoredCount,
      targetCount: targets.length,
      startupFailures,
      statefulSetRecreatedViaArgo,
      scaledObjectRecreatedViaArgo,
    });

    await logActivity({
      action: 'schedule-startup',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: activityAppName,
      triggeredBy,
      status: 'success',
      message,
      details: startupDetails,
      ...resolveScheduleTeamsAlert(alertSchedule, triggeredBy),
    });
  } catch (err) {
    const alertSchedule =
      (await prisma.schedule.findUnique({ where: { id: schedule.id } })) ?? schedule;
    const message = err instanceof Error ? err.message : 'Startup failed';
    runLog.finish('failed', message, {
      targetCount: targets.length,
      workloads: targets.map((t) => workloadKey(t.kind, t.name)),
    });
    await logActivity({
      action: 'schedule-startup',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: activityAppName,
      triggeredBy,
      status: 'failed',
      message,
      details: isNamespace
        ? JSON.stringify({
            scope: 'namespace',
            workloads: targets.map((t) => workloadKey(t.kind, t.name)),
            count: targets.length,
          })
        : undefined,
      ...resolveScheduleTeamsAlert(alertSchedule, triggeredBy),
    });
    throw err;
  }
}

/** Keep only paused apps that belong to this schedule's workload scope (not a stale namespace-wide list). */
function filterPausedAppsToScheduleScope(storedNames: string[], scopedNames: string[]): string[] {
  if (!storedNames.length) return scopedNames;
  if (!scopedNames.length) return storedNames;
  const scoped = new Set(scopedNames);
  const filtered = storedNames.filter((name) => scoped.has(name));
  return filtered.length > 0 ? filtered : scopedNames;
}

export async function runScheduleNow(
  scheduleId: string,
  mode: 'shutdown' | 'startup',
  triggeredBy: string
): Promise<void> {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new Error('Schedule not found');

  const now = new Date();

  if (mode === 'startup') {
    const manualStartInStoppedWindow = isScheduleInStoppedWindow(schedule, now);
    // Clear "Manual stop" immediately — do not wait for slow Argo resume on EC2.
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: {
        liveActive: false,
        liveStartupAt: null,
        liveStopSource: manualStartInStoppedWindow ? 'manual-start' : null,
        liveStoppedBy: null,
      },
    });
    await executeStartup(schedule, triggeredBy);
  } else {
    await executeShutdown(schedule, triggeredBy, { markLive: true });
  }

  const nextRun = computeNextRun(schedule, now);
  const manualStartInStoppedWindow =
    mode === 'startup' && isScheduleInStoppedWindow(schedule, now);
  await prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      lastRun: now,
      nextRun,
      ...(mode === 'shutdown'
        ? buildLiveScheduleUpdate(schedule, triggeredBy, { markLive: true })
        : {
            liveActive: false,
            liveStartupAt: null,
            liveStopSource: manualStartInStoppedWindow ? 'manual-start' : null,
            liveStoppedBy: null,
          }),
    },
  });
}

export async function stopLiveSchedule(scheduleId: string, triggeredBy: string): Promise<void> {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new Error('Schedule not found');

  await executeShutdown(schedule, triggeredBy, { clearLive: true });

  const nextRun = computeNextRun(schedule);
  await prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      lastRun: new Date(),
      nextRun,
    },
  });
}
