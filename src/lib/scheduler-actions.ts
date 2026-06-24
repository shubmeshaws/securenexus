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
  listWorkloads,
  reconcileScaledObjectsAfterArgoSync,
  scaleWorkload,
  statefulSetExists,
  type WorkloadKind,
} from './k8s-client';
import { logActivity } from './activity';
import { buildShutdownActivityDetails } from './shutdown-node-count';
import prisma from './prisma';
import { computeCurrentLiveStartupAt, computeNextRun, computeNextStartupAt, formatScheduleStartupLabel } from './scheduler-utils';
import { defaultBlockUntil } from './argocd-sync-windows';
import {
  isNamespaceSchedule,
  isNonEksSchedule,
  NAMESPACE_SCOPE_MARKER,
  workloadKey,
} from './workload-utils';
import { Prisma, type Schedule } from '@prisma/client';
import { startEc2Instance, stopEc2Instance } from './aws-credential-store';
import { runWithConcurrency } from './concurrency';
import { resolveArgoOpConcurrency, resolveWorkloadOpConcurrency } from './schedule-execution-pool';

/** Delay after pausing Argo before deleting a StatefulSet (ms). Override: STS_SHUTDOWN_SETTLE_MS */
const STS_SHUTDOWN_SETTLE_MS = (() => {
  const fromEnv = Number(process.env.STS_SHUTDOWN_SETTLE_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 1000;
})();

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

  const nsApps = catalog.filtered(schedule).filter(
    (app) => app.destinationNamespace === schedule.namespace
  );
  if (nsApps.length) return { name: nsApps[0].name, instanceId: nsApps[0].instanceId };
  return null;
}

async function collectScheduleArgoApps(
  schedule: Schedule,
  catalog?: ArgoCatalog
): Promise<ScheduleArgoApp[]> {
  const ctx = catalog ?? (await loadArgoCatalog());
  const byName = new Map<string, ScheduleArgoApp>();
  const add = (app: ScheduleArgoApp | null) => {
    if (app) byName.set(app.name, app);
  };
  const addNamespaceMatches = () => {
    ctx
      .filtered(schedule)
      .filter((app) => app.destinationNamespace === schedule.namespace)
      .forEach((a) => add({ name: a.name, instanceId: a.instanceId }));
  };

  if (isNamespaceSchedule(schedule)) {
    const trackingNames = await getArgoAppNamesForNamespace(schedule.cluster, schedule.namespace);
    console.log(
      `[Argo resolve] namespace=${schedule.namespace} tracking apps: ${
        trackingNames.join(', ') || '(none)'
      }`
    );
    await runWithConcurrency(trackingNames, resolveArgoOpConcurrency(), async (name) => {
      add(findArgoAppInCatalog(ctx, schedule, name));
    });
    addNamespaceMatches();
    if (!byName.size) {
      (await resolveCatalogAppsInNamespace(schedule, ctx)).forEach((app) => add(app));
    }
  } else if (schedule.workloadKind === 'StatefulSet') {
    add(await resolveArgoAppForStatefulSet(schedule, ctx));
  } else {
    // Workload-scoped schedules (Deployment, ScaledObject, CronJob, ScaledJob, …) must
    // resolve only the Argo app for THIS workload — never every app in the namespace.
    add(await resolveArgoApp(schedule, ctx));
  }

  // Namespace-wide catalog fallback only for namespace schedules. Workload schedules with
  // no linked Argo app should not block sync for unrelated apps in the same namespace.
  if (!byName.size && isNamespaceSchedule(schedule)) {
    (await resolveCatalogAppsInNamespace(schedule, ctx)).forEach((app) => add(app));
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

  const scoped = filterAppsForSchedule(schedule, allApps, instanceMap);

  if (isNamespaceSchedule(schedule)) {
    return scoped
      .filter((app) => app.destinationNamespace === schedule.namespace)
      .map((app) => ({ name: app.name, instanceId: app.instanceId }));
  }

  const exact = scoped.find((app) => app.name === schedule.appName);
  if (exact) return [{ name: exact.name, instanceId: exact.instanceId }];

  const fuzzy = scoped.find(
    (app) =>
      app.destinationNamespace === schedule.namespace &&
      (app.name === schedule.appName ||
        app.name.includes(schedule.appName) ||
        schedule.appName.includes(app.name))
  );
  return fuzzy ? [{ name: fuzzy.name, instanceId: fuzzy.instanceId }] : [];
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

/** Pause automated sync and block manual sync for every Argo app on this schedule. */
async function pauseArgoForSchedule(
  schedule: Schedule,
  now = new Date()
): Promise<{ note: string; apps: string[] }> {
  const catalog = await loadArgoCatalog();
  const targets = await collectScheduleArgoApps(schedule, catalog);
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

  // Namespace-wide deny windows affect every app in the namespace — only for namespace schedules.
  const namespaceBlocked = isNamespaceSchedule(schedule)
    ? await blockNamespaceManualSync(
        schedule,
        {
          blockUntil,
          timeZone,
          targets,
        },
        catalog
      )
    : [];

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

interface WorkloadTarget {
  name: string;
  kind: WorkloadKind;
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
    const target = await getScaledObjectScaleTarget(
      schedule.cluster,
      schedule.namespace,
      schedule.appName
    );
    console.log(
      `[Argo resolve] scaledobject ${schedule.namespace}/${schedule.appName} scaleTarget=${
        target ? `${target.kind}/${target.name}` : '(none)'
      }`
    );
    if (target?.kind === 'Deployment') {
      const trackingApp = await getDeploymentArgoAppName(
        schedule.cluster,
        schedule.namespace,
        target.name
      );
      if (trackingApp) {
        const byTracking = findArgoAppInCatalog(ctx, schedule, trackingApp);
        if (byTracking) return byTracking;
      }
    } else if (target?.kind === 'StatefulSet') {
      const trackingApp = await getStatefulSetArgoAppName(
        schedule.cluster,
        schedule.namespace,
        target.name
      );
      if (trackingApp) {
        const byTracking = findArgoAppInCatalog(ctx, schedule, trackingApp);
        if (byTracking) return byTracking;
      }
    }
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

    const relaxedMatch = resolveArgoAppFromPool(schedule, ctx.relaxed(schedule));
    if (relaxedMatch) return relaxedMatch;

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
  apps: ScheduleArgoApp[]
): Promise<string> {
  const unblocked: string[] = [];

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

  if (schedule.syncPolicy !== 'automated') {
    return notes.length ? ` · ${notes.join(' · ')}` : '';
  }

  const resumed: string[] = [];
  await runWithConcurrency(apps, resolveArgoOpConcurrency(), async (app) => {
    try {
      await argocdClient.updateSyncPolicy(app.name, 'automated', app.instanceId);
      resumed.push(app.name);
      try {
        await argocdClient.triggerSync(app.name, app.instanceId);
      } catch {
        // best-effort
      }
    } catch (err) {
      console.error(
        `[Argo resume] failed to resume Argo app ${app.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  });
  if (resumed.length) notes.push(`ArgoCD sync restored (${resumed.join(', ')})`);
  return notes.length ? ` · ${notes.join(' · ')}` : '';
}

async function getScheduleTargets(schedule: Schedule): Promise<WorkloadTarget[]> {
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
    const [resolvedTargets, nodeCount, fresh, pauseOutcome] = await Promise.all([
      getScheduleTargets(schedule),
      getClusterReadyNodeCount(schedule.cluster),
      prisma.schedule.findUnique({ where: { id: schedule.id } }),
      pauseArgoForSchedule(schedule)
        .then((result) => ({ ok: true as const, result }))
        .catch((err: unknown) => ({ ok: false as const, err })),
    ]);
    targets = resolvedTargets;
    const priorWorkloadSaves = parseSavedWorkloadReplicas(fresh?.savedWorkloadReplicas);
    const alertSchedule = fresh ?? schedule;

    const liveUpdate = buildLiveScheduleUpdate(schedule, triggeredBy, options);

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

    if (isNamespace) {
      const replicasMap: Record<string, number> = {};

      await runWithConcurrency(targets, resolveWorkloadOpConcurrency(), async (target) => {
        const key = workloadKey(target.kind, target.name);
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
        await scaleWorkload(
          schedule.cluster,
          schedule.namespace,
          target.kind,
          target.name,
          0
        );
      });

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
          await deleteStatefulSet(schedule.cluster, schedule.namespace, schedule.appName);
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
          await scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, 0);
        }
      } else {
        await scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, 0);
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
    const message = isNamespace
      ? `Scaled ${targets.length} workload(s) to 0 in ${schedule.namespace}${argoNote}`
      : isCronJobSchedule
        ? `Suspended CronJob ${schedule.appName} and removed active jobs${argoNote}`
        : isScaledJobSchedule
          ? `Paused ScaledJob ${schedule.appName} and removed active jobs${argoNote}`
          : isScaledObjectSchedule
            ? `Paused ScaledObject ${schedule.appName}${argoNote}`
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
    const startupFailures: string[] = [];
    const catalogPromise = loadArgoCatalog();

    if (isNamespace) {
      const savedMap = parseSavedWorkloadReplicas(fresh?.savedWorkloadReplicas);

      await runWithConcurrency(targets, resolveWorkloadOpConcurrency(), async (target) => {
        const key = workloadKey(target.kind, target.name);
        const replicas = resolveStartupReplicas(schedule, savedMap[key]);
        try {
          await scaleWorkload(
            schedule.cluster,
            schedule.namespace,
            target.kind,
            target.name,
            replicas
          );
        } catch (err) {
          // Don't let one bad workload abort the whole startup — the schedule would stay
          // marked "Scheduled stop" even though the rest are running. Collect and report.
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
          await scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, replicas);
        } else {
          statefulSetRecreatedViaArgo = true;
        }
      } else {
        await scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, replicas);
      }
    }

    const storedPausedApps = fresh?.pausedArgoApps ?? [];

    let argoNote = '';
    try {
      const catalog = await catalogPromise;
      const storedNames = storedPausedApps.length
        ? storedPausedApps
        : (await collectScheduleArgoApps(schedule, catalog)).map((a) => a.name);
      const toResume = await resolveArgoAppsForResume(schedule, storedNames, catalog);
      if (toResume.length) {
        argoNote = await resumeStoredArgoApps(schedule, toResume);
      } else if (storedNames.length) {
        console.warn(
          `[Argo resume] could not resolve Argo instance for apps: ${storedNames.join(', ')}`
        );
      }
    } catch (err) {
      argoNote = ` · ArgoCD sync restore failed: ${err instanceof Error ? err.message : 'unknown'}`;
    }

    const scaledObjectNames = isNamespace
      ? targets.filter((target) => target.kind === 'ScaledObject').map((target) => target.name)
      : schedule.workloadKind === 'ScaledObject'
        ? [schedule.appName]
        : [];
    if (scaledObjectNames.length) {
      try {
        await reconcileScaledObjectsAfterArgoSync(
          schedule.cluster,
          schedule.namespace,
          scaledObjectNames
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'ScaledObject resume failed';
        if (isNamespace) {
          for (const name of scaledObjectNames) {
            startupFailures.push(`ScaledObject::${name}: ${message}`);
          }
        } else {
          throw new Error(message);
        }
      }
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
            ? `Resumed ScaledObject ${schedule.appName}${argoNote}`
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
            liveStopSource: null,
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
