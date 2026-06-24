import argocdClient, { appMatchesK8sCluster } from './argocd-client';
import { instanceMatchesCluster, listEnabledArgoCDInstances } from './argocd-instances';
import type { ArgoCDAppSummary } from './argocd-client';
import { AUTOMATIC_CRON_TRIGGER } from './alert-display';
import {
  deleteStatefulSet,
  getArgoAppNamesForNamespace,
  getClusterReadyNodeCount,
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
  NAMESPACE_SCOPE_MARKER,
  workloadKey,
} from './workload-utils';
import { Prisma, type Schedule } from '@prisma/client';
import { startEc2Instance, stopEc2Instance } from './aws-credential-store';
import { runWithConcurrency, withRetry } from './concurrency';
import { resolveArgoOpConcurrency, resolveWorkloadOpConcurrency } from './schedule-execution-pool';

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
  return { ...schedule, appName: target.name, workloadKind: target.kind };
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
        add(await resolveArgoAppForWorkload(schedule, target, ctx));
      });
      console.log(
        `[Argo resolve] namespace=${schedule.namespace} workload-scoped apps: ${
          Array.from(byName.keys()).join(', ') || '(none)'
        }`
      );
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
  } else if (schedule.workloadKind === 'ScaledObject') {
    add(await resolveArgoAppForScaledObject(schedule, ctx));
  } else {
    add(await resolveArgoApp(schedule, ctx));
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

async function resolveScheduleArgoAppsFromCatalog(
  schedule: Schedule,
  allApps: ArgoCDAppSummary[],
  instanceMap: Map<string, Awaited<ReturnType<typeof listEnabledArgoCDInstances>>[number]>
): Promise<ScheduleArgoApp[]> {
  if (schedule.pausedArgoApps.length > 0) {
    const fromStored = await resolveArgoAppsForResume(schedule, schedule.pausedArgoApps);
    if (fromStored.length) return fromStored;
  }

  const catalog: ArgoCatalog = {
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

  return collectScheduleArgoApps(schedule, catalog);
}

/** Repair path: catalog + pausedArgoApps first; K8s tracking only when catalog finds nothing. */
export async function applyManualSyncDenyForScheduleRepair(
  schedule: Schedule,
  allApps: ArgoCDAppSummary[],
  instanceMap: Map<string, Awaited<ReturnType<typeof listEnabledArgoCDInstances>>[number]>,
  now = new Date()
): Promise<{ apps: string[]; errors: string[] }> {
  if (isNonEksSchedule(schedule)) return { apps: [], errors: [] };

  let targets = await resolveScheduleArgoAppsFromCatalog(schedule, allApps, instanceMap);
  if (!targets.length) {
    targets = await collectScheduleArgoApps(schedule);
  }
  return applyManualSyncDenyForApps(schedule, targets, now);
}

export async function applyManualSyncDenyForApps(
  schedule: Schedule,
  targets: ScheduleArgoApp[],
  now = new Date()
): Promise<{ apps: string[]; errors: string[] }> {
  if (isNonEksSchedule(schedule) || !targets.length) return { apps: [], errors: [] };

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
  const targets = await collectScheduleArgoApps(schedule, catalog, workloadTargets);
  console.log(
    `[Argo pause] ${schedule.namespace} resolved apps: ${
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

  await runWithConcurrency(apps, resolveArgoOpConcurrency(), async (app) => {
    try {
      const removed = await argocdClient.removeScheduleManualSyncDenyWindows(
        app.name,
        app.instanceId
      );
      if (removed > 0) {
        unblocked.push(app.name);
        console.log(
          `[Argo resume] removed ${removed} manual-sync deny window(s) for ${app.name}`
        );
      }
    } catch (err) {
      console.error(
        `[Argo resume] failed to remove manual-sync deny window for ${app.name}:`,
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
  await runWithConcurrency(apps, resolveArgoOpConcurrency(), async (app) => {
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
  const credentialId = schedule.awsCredentialId;
  const instanceId = schedule.ec2InstanceId;
  const region = schedule.ec2Region;
  if (!credentialId || !instanceId || !region) {
    throw new Error('EC2 schedule is missing AWS account or instance');
  }

  const liveUpdate = buildLiveScheduleUpdate(schedule, triggeredBy, options);

  try {
    await stopEc2Instance(credentialId, instanceId, region);

    if (Object.keys(liveUpdate).length > 0) {
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: liveUpdate,
      });
    }

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
    await logActivity({
      action: 'schedule-shutdown',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: schedule.appName,
      triggeredBy,
      status: 'failed',
      message: err instanceof Error ? err.message : 'EC2 shutdown failed',
      details: JSON.stringify({ platformType: 'non_eks', instanceId, region }),
      ...resolveScheduleTeamsAlert(schedule, triggeredBy),
    });
    throw err;
  }
}

async function executeEc2Startup(schedule: Schedule, triggeredBy: string): Promise<void> {
  const credentialId = schedule.awsCredentialId;
  const instanceId = schedule.ec2InstanceId;
  const region = schedule.ec2Region;
  if (!credentialId || !instanceId || !region) {
    throw new Error('EC2 schedule is missing AWS account or instance');
  }

  try {
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

    await logActivity({
      action: 'schedule-startup',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: schedule.appName,
      triggeredBy,
      status: 'success',
      message: `EC2 instance ${schedule.appName} (${instanceId}) start requested in ${region}`,
      details: JSON.stringify({ platformType: 'non_eks', instanceId, region }),
      ...resolveScheduleTeamsAlert(schedule, triggeredBy),
    });
  } catch (err) {
    await logActivity({
      action: 'schedule-startup',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: schedule.appName,
      triggeredBy,
      status: 'failed',
      message: err instanceof Error ? err.message : 'EC2 startup failed',
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

  const isNamespace = isNamespaceSchedule(schedule);
  const activityAppName = isNamespace ? NAMESPACE_SCOPE_MARKER : schedule.appName;
  let targets: WorkloadTarget[] = [];

  try {
    targets = await getScheduleTargets(schedule);

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
    } else {
      argoNote = ` · ArgoCD sync pause failed: ${
        pauseOutcome.err instanceof Error ? pauseOutcome.err.message : 'unknown'
      }`;
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
          if (target.kind === 'ScaledObject') {
            await retryWorkloadOp(`stop ${key}`, () =>
              stopScaledObjectWorkload(
                schedule.cluster,
                schedule.namespace,
                target.name,
                managedByArgo
              )
            );
            return;
          }
          await retryWorkloadOp(`stop ${key}`, () =>
            scaleWorkload(schedule.cluster, schedule.namespace, target.kind, target.name, 0)
          );
        } catch (err) {
          shutdownFailures.push(`${key}: ${err instanceof Error ? err.message : 'stop failed'}`);
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
          console.log(
            `[STS shutdown] ${schedule.namespace}/${schedule.appName} deleted; reappeared=${reappeared}`
          );
        } else {
          console.log(
            `[STS shutdown] ${schedule.namespace}/${schedule.appName} no Argo app found; scaling to 0`
          );
          await retryWorkloadOp(`stop StatefulSet/${schedule.appName}`, () =>
            scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, 0)
          );
        }
      } else if (kind === 'ScaledObject') {
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
          console.log(
            `[ScaledObject shutdown] ${schedule.namespace}/${schedule.appName} deleted; reappeared=${reappeared}`
          );
        }
      } else {
        await retryWorkloadOp(`stop ${kind}/${schedule.appName}`, () =>
          scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, 0)
        );
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
    await logActivity({
      action: 'schedule-shutdown',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: activityAppName,
      triggeredBy,
      status: 'failed',
      message: err instanceof Error ? err.message : 'Shutdown failed',
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

  const isNamespace = isNamespaceSchedule(schedule);
  const activityAppName = isNamespace ? NAMESPACE_SCOPE_MARKER : schedule.appName;
  let targets: WorkloadTarget[] = [];

  try {
    const [resolvedTargets, fresh] = await Promise.all([
      getScheduleTargets(schedule),
      prisma.schedule.findUnique({ where: { id: schedule.id } }),
    ]);
    targets = resolvedTargets;
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
            const mode = await retryWorkloadOp(`start ${key}`, () =>
              startScaledObjectWorkload(
                schedule.cluster,
                schedule.namespace,
                target.name,
                hadArgoPause
              )
            );
            if (mode === 'argocd') return;
          } catch (err) {
            startupFailures.push(`${key}: ${err instanceof Error ? err.message : 'start failed'}`);
          }
          return;
        }
        const replicas = resolveStartupReplicas(schedule, savedMap[key]);
        try {
          await retryWorkloadOp(`start ${key}`, () =>
            scaleWorkload(schedule.cluster, schedule.namespace, target.kind, target.name, replicas)
          );
        } catch (err) {
          startupFailures.push(`${key}: ${err instanceof Error ? err.message : 'scale failed'}`);
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
          await retryWorkloadOp(`start StatefulSet/${schedule.appName}`, () =>
            scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, replicas)
          );
        } else {
          statefulSetRecreatedViaArgo = true;
        }
      } else if (kind === 'ScaledObject') {
        const mode = await retryWorkloadOp(`start ScaledObject/${schedule.appName}`, () =>
          startScaledObjectWorkload(
            schedule.cluster,
            schedule.namespace,
            schedule.appName,
            hadArgoPause
          )
        );
        scaledObjectRecreatedViaArgo = mode === 'argocd';
      } else {
        await retryWorkloadOp(`start ${kind}/${schedule.appName}`, () =>
          scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, replicas)
        );
      }
    }

    const storedPausedApps = fresh?.pausedArgoApps ?? [];

    let argoNote = '';
    try {
      const catalog = await catalogPromise;
      let storedNames = storedPausedApps.length
        ? [...storedPausedApps]
        : (await collectScheduleArgoApps(schedule, catalog)).map((a) => a.name);

      if (includesScaledObject && (scaledObjectRecreatedViaArgo || hadArgoPause)) {
        storedNames = (await collectScheduleArgoApps(schedule, catalog)).map((a) => a.name);
      }

      const toResume = await resolveArgoAppsForResume(schedule, storedNames, catalog);
      if (toResume.length) {
        argoNote = await resumeStoredArgoApps(schedule, toResume, {
          forceSync: includesScaledObject && (scaledObjectRecreatedViaArgo || hadArgoPause),
        });
      } else if (storedNames.length) {
        console.warn(
          `[Argo resume] could not resolve Argo instance for apps: ${storedNames.join(', ')}`
        );
      } else if (includesScaledObject && scaledObjectRecreatedViaArgo) {
        console.warn(
          `[Argo resume] ScaledObject ${schedule.appName} needs Argo CD sync but no linked app was resolved`
        );
      }
    } catch (err) {
      argoNote = ` · ArgoCD sync restore failed: ${err instanceof Error ? err.message : 'unknown'}`;
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
    await logActivity({
      action: 'schedule-startup',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: activityAppName,
      triggeredBy,
      status: 'failed',
      message: err instanceof Error ? err.message : 'Startup failed',
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

export async function runScheduleNow(
  scheduleId: string,
  mode: 'shutdown' | 'startup',
  triggeredBy: string
): Promise<void> {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new Error('Schedule not found');

  if (mode === 'shutdown') {
    await executeShutdown(schedule, triggeredBy, { markLive: true });
  } else {
    await executeStartup(schedule, triggeredBy);
  }

  const now = new Date();
  const nextRun = computeNextRun(schedule, now);
  // A manual start during the schedule's stopped window is a deliberate "run it now"
  // override — tag it 'manual-start' so the stopped-state self-heal leaves it running
  // (instead of immediately re-stopping it). It clears at the next scheduled event.
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
