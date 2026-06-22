import prisma from './prisma';
import { addHours } from 'date-fns';
import type { InstantRun, Schedule } from '@prisma/client';
import { applyManualSyncDenyForApps } from './scheduler-actions';
import { isNamespaceSchedule, isNonEksSchedule } from './workload-utils';
import argocdClient, { appMatchesK8sCluster, type ArgoCDAppSummary } from './argocd-client';
import { instanceMatchesCluster, listEnabledArgoCDInstances, type ArgoCDInstanceConfig } from './argocd-instances';
import { runWithConcurrency } from './concurrency';

export interface SyncWindowReconcileResult {
  schedulesScanned: number;
  schedulesProcessed: number;
  scheduleAppsUpdated: number;
  instantRunsProcessed: number;
  instantAppsUpdated: number;
  errors: string[];
}

type ArgoAppRef = { name: string; instanceId: string };

function scheduleNeedsSyncWindowReconcile(schedule: Schedule): boolean {
  if (isNonEksSchedule(schedule)) return false;
  if (schedule.liveActive) return true;
  if (schedule.liveStopSource === 'manual') return true;
  if (schedule.pausedArgoApps.length > 0) return true;
  return false;
}

async function loadArgoAppCatalog(): Promise<ArgoCDAppSummary[]> {
  return argocdClient.listApplications();
}

function resolveAppsForReconcile(
  schedule: Schedule,
  allApps: ArgoCDAppSummary[],
  instanceMap: Map<string, ArgoCDInstanceConfig>
): ArgoAppRef[] {
  const scoped = allApps.filter((app) => {
    if (schedule.argocdInstanceId && app.instanceId !== schedule.argocdInstanceId) {
      return false;
    }
    const instance = instanceMap.get(app.instanceId);
    if (instance && !instanceMatchesCluster(instance, schedule.cluster)) return false;
    return appMatchesK8sCluster(app, schedule.cluster);
  });

  if (schedule.pausedArgoApps.length > 0) {
    const fromPaused = schedule.pausedArgoApps
      .map((name) => scoped.find((app) => app.name === name) ?? allApps.find((app) => app.name === name))
      .filter((app): app is ArgoCDAppSummary => Boolean(app))
      .map((app) => ({ name: app.name, instanceId: app.instanceId }));
    if (fromPaused.length) return fromPaused;
  }

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

function resolveInstantRunApps(run: InstantRun, allApps: ArgoCDAppSummary[]): ArgoAppRef[] {
  const clusterApps = allApps.filter((app) => appMatchesK8sCluster(app, run.cluster));

  if (run.pausedArgoApps.length > 0) {
    return run.pausedArgoApps
      .map((name) => clusterApps.find((app) => app.name === name))
      .filter((app): app is ArgoCDAppSummary => Boolean(app))
      .map((app) => ({ name: app.name, instanceId: app.instanceId }));
  }

  const match = clusterApps.find(
    (app) => app.name === run.appName && app.destinationNamespace === run.namespace
  );
  return match ? [{ name: match.name, instanceId: match.instanceId }] : [];
}

/** Backfill Argo CD manual-sync deny windows for schedules/runs already in a stopped state. */
export async function reconcileStoppedScheduleSyncWindows(): Promise<SyncWindowReconcileResult> {
  const now = new Date();
  const result: SyncWindowReconcileResult = {
    schedulesScanned: 0,
    schedulesProcessed: 0,
    scheduleAppsUpdated: 0,
    instantRunsProcessed: 0,
    instantAppsUpdated: 0,
    errors: [],
  };

  const [schedules, instantRuns, allApps, instances] = await Promise.all([
    prisma.schedule.findMany({
      where: {
        platformType: { not: 'non_eks' },
        OR: [
          { liveActive: true },
          { liveStopSource: 'manual' },
          { pausedArgoApps: { isEmpty: false } },
        ],
      },
    }),
    prisma.instantRun.findMany({ where: { active: true } }),
    loadArgoAppCatalog(),
    listEnabledArgoCDInstances(),
  ]);

  const instanceMap = new Map(instances.map((i) => [i.id, i]));
  const candidates = schedules.filter(scheduleNeedsSyncWindowReconcile);
  result.schedulesScanned = candidates.length;

  console.log(
    `[Argo reconcile] starting: ${candidates.length} schedule(s), ${instantRuns.length} instant run(s)`
  );

  const scheduleOutcomes: { apps: string[]; errors: string[] }[] = [];

  await runWithConcurrency(candidates, 4, async (schedule) => {
    const targets = resolveAppsForReconcile(schedule, allApps, instanceMap);
    if (!targets.length) {
      scheduleOutcomes.push({
        apps: [],
        errors: [`${schedule.name}: no linked Argo CD app found`],
      });
      return;
    }

    const outcome = await applyManualSyncDenyForApps(schedule, targets, now);
    scheduleOutcomes.push({
      apps: outcome.apps,
      errors: outcome.errors.map((error) => `${schedule.name}: ${error}`),
    });
  });

  for (const outcome of scheduleOutcomes) {
    if (outcome.apps.length) {
      result.schedulesProcessed++;
      result.scheduleAppsUpdated += outcome.apps.length;
    }
    result.errors.push(...outcome.errors);
  }

  const instantOutcomes: { apps: string[]; errors: string[] }[] = [];

  await runWithConcurrency(instantRuns, 4, async (run) => {
    const targets = resolveInstantRunApps(run, allApps);
    if (!targets.length) {
      instantOutcomes.push({
        apps: [],
        errors: [`instant:${run.appName}: no linked Argo CD app found`],
      });
      return;
    }

    const blockUntil = addHours(now, 24);
    const apps: string[] = [];
    const errors: string[] = [];

    for (const app of targets) {
      try {
        await argocdClient.addScheduleManualSyncDenyWindow(
          {
            appName: app.name,
            blockFrom: now,
            blockUntil,
            timeZone: 'UTC',
          },
          app.instanceId
        );
        apps.push(app.name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${app.name}: ${message}`);
      }
    }

    instantOutcomes.push({
      apps,
      errors: errors.map((error) => `instant:${run.appName}: ${error}`),
    });
  });

  for (const outcome of instantOutcomes) {
    if (outcome.apps.length) {
      result.instantRunsProcessed++;
      result.instantAppsUpdated += outcome.apps.length;
    }
    result.errors.push(...outcome.errors);
  }

  console.log(
    `[Argo reconcile] done: scanned ${result.schedulesScanned}, updated ${result.schedulesProcessed} schedule(s) / ` +
      `${result.scheduleAppsUpdated} app(s), ${result.instantRunsProcessed} instant run(s), ` +
      `${result.errors.length} error(s)`
  );

  return result;
}
