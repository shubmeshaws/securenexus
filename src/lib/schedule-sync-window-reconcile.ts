import prisma from './prisma';
import { addHours } from 'date-fns';
import type { InstantRun } from '@prisma/client';
import { applyManualSyncDenyForScheduleRepair } from './scheduler-actions';
import { isNonEksSchedule } from './workload-utils';
import argocdClient, { appMatchesK8sCluster, type ArgoCDAppSummary } from './argocd-client';
import { listEnabledArgoCDInstances } from './argocd-instances';
import { runWithConcurrency } from './concurrency';

export interface SyncWindowReconcileResult {
  schedulesScanned: number;
  schedulesProcessed: number;
  scheduleAppsUpdated: number;
  instantRunsProcessed: number;
  instantAppsUpdated: number;
  errors: string[];
}

export type SyncWindowReconcileProgress = {
  schedulesTotal: number;
  schedulesDone: number;
  instantRunsTotal: number;
  instantRunsDone: number;
  phase: 'schedules' | 'instant-runs' | 'done';
};

type ArgoAppRef = { name: string; instanceId: string };

function scheduleNeedsSyncWindowReconcile(schedule: {
  liveActive: boolean;
  liveStopSource: string | null;
  pausedArgoApps: string[];
}): boolean {
  if (schedule.liveActive) return true;
  if (schedule.liveStopSource === 'manual') return true;
  if (schedule.pausedArgoApps.length > 0) return true;
  return false;
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
export async function reconcileStoppedScheduleSyncWindows(
  onProgress?: (progress: SyncWindowReconcileProgress) => void
): Promise<SyncWindowReconcileResult> {
  const now = new Date();
  const result: SyncWindowReconcileResult = {
    schedulesScanned: 0,
    schedulesProcessed: 0,
    scheduleAppsUpdated: 0,
    instantRunsProcessed: 0,
    instantAppsUpdated: 0,
    errors: [],
  };

  const report = (progress: SyncWindowReconcileProgress) => onProgress?.(progress);

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
    argocdClient.listApplications(),
    listEnabledArgoCDInstances(),
  ]);

  const instanceMap = new Map(instances.map((i) => [i.id, i]));
  const candidates = schedules.filter(
    (schedule) => !isNonEksSchedule(schedule) && scheduleNeedsSyncWindowReconcile(schedule)
  );
  result.schedulesScanned = candidates.length;

  console.log(
    `[Argo reconcile] starting: ${candidates.length} schedule(s), ${instantRuns.length} instant run(s)`
  );

  report({
    schedulesTotal: candidates.length,
    schedulesDone: 0,
    instantRunsTotal: instantRuns.length,
    instantRunsDone: 0,
    phase: 'schedules',
  });

  let schedulesDone = 0;
  const scheduleOutcomes: { apps: string[]; errors: string[] }[] = [];

  await runWithConcurrency(candidates, 4, async (schedule) => {
    const outcome = await applyManualSyncDenyForScheduleRepair(
      schedule,
      allApps,
      instanceMap,
      now
    );

    schedulesDone++;
    report({
      schedulesTotal: candidates.length,
      schedulesDone,
      instantRunsTotal: instantRuns.length,
      instantRunsDone: 0,
      phase: 'schedules',
    });

    if (!outcome.apps.length && !outcome.errors.length) {
      scheduleOutcomes.push({
        apps: [],
        errors: [`${schedule.name}: no linked Argo CD app found`],
      });
      return;
    }

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

  report({
    schedulesTotal: candidates.length,
    schedulesDone: candidates.length,
    instantRunsTotal: instantRuns.length,
    instantRunsDone: 0,
    phase: 'instant-runs',
  });

  let instantRunsDone = 0;
  const instantOutcomes: { processed: boolean; apps: number; errors: string[] }[] = [];

  await runWithConcurrency(instantRuns, 4, async (run) => {
    const targets = resolveInstantRunApps(run, allApps);
    if (!targets.length) {
      instantOutcomes.push({
        processed: false,
        apps: 0,
        errors: [`instant:${run.appName}: no linked Argo CD app found`],
      });
      instantRunsDone++;
      report({
        schedulesTotal: candidates.length,
        schedulesDone: candidates.length,
        instantRunsTotal: instantRuns.length,
        instantRunsDone,
        phase: 'instant-runs',
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
        errors.push(`instant:${run.appName}: ${app.name}: ${message}`);
      }
    }

    instantOutcomes.push({
      processed: apps.length > 0,
      apps: apps.length,
      errors,
    });

    instantRunsDone++;
    report({
      schedulesTotal: candidates.length,
      schedulesDone: candidates.length,
      instantRunsTotal: instantRuns.length,
      instantRunsDone,
      phase: 'instant-runs',
    });
  });

  for (const outcome of instantOutcomes) {
    if (outcome.processed) {
      result.instantRunsProcessed++;
      result.instantAppsUpdated += outcome.apps;
    }
    result.errors.push(...outcome.errors);
  }

  report({
    schedulesTotal: candidates.length,
    schedulesDone: candidates.length,
    instantRunsTotal: instantRuns.length,
    instantRunsDone: instantRuns.length,
    phase: 'done',
  });

  console.log(
    `[Argo reconcile] done: scanned ${result.schedulesScanned}, updated ${result.schedulesProcessed} schedule(s) / ` +
      `${result.scheduleAppsUpdated} app(s), ${result.instantRunsProcessed} instant run(s), ` +
      `${result.errors.length} error(s)`
  );

  return result;
}
