import prisma from './prisma';
import { addHours } from 'date-fns';
import type { InstantRun, Schedule } from '@prisma/client';
import {
  applyManualSyncDenyForScheduleRepair,
  buildSyncBlockHoldSet,
  clearManualSyncDenyForScheduleRepair,
  scheduleShouldBeSyncBlockedNow,
} from './scheduler-actions';
import { isNonEksSchedule } from './workload-utils';
import {
  isScheduleInStoppedWindow,
  resolveLiveStartupAt,
} from './scheduler-utils';
import argocdClient, {
  appMatchesK8sCluster,
  getArgoListErrors,
  type ArgoCDAppSummary,
} from './argocd-client';
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

  // Reuse the shared Argo app list cache (3 min TTL) — do not bust cache here; reconcile
  // runs every 15 min and cold lists were slowing every page/API that shares the cache.

  const [schedules, instantRuns, allApps, instances] = await Promise.all([
    // Load BOTH directions:
    //  - enabled EKS schedules (running ones may carry orphaned deny windows to remove),
    //  - any schedule still showing stop-evidence (must stay blocked or be cleaned up).
    // The clear path is a cheap no-op when an app has nothing blocked, so scanning running
    // schedules is safe; it is the only way to auto-remove windows that startup left behind.
    prisma.schedule.findMany({
      where: {
        platformType: { not: 'non_eks' },
        OR: [
          { enabled: true },
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

  // If an Argo CD instance failed to list its apps, every schedule on that instance
  // will report "no linked Argo CD app found". Surface the real cause up front.
  const listErrors = getArgoListErrors();
  if (listErrors.length) {
    for (const message of listErrors) {
      result.errors.push(`Argo CD instance unreachable - ${message}`);
      console.warn(`[Argo reconcile] instance listing failed - ${message}`);
    }
  }

  const instanceMap = new Map(instances.map((i) => [i.id, i]));
  const candidates = schedules.filter(
    (schedule) =>
      !isNonEksSchedule(schedule) &&
      (schedule.enabled || scheduleNeedsSyncWindowReconcile(schedule))
  );
  result.schedulesScanned = candidates.length;

  console.log(
    `[Argo reconcile] starting: ${candidates.length} schedule(s), ${instantRuns.length} instant run(s)`
  );

  const syncBlockHoldKeys = await buildSyncBlockHoldSet(candidates, allApps, instanceMap, now);
  if (syncBlockHoldKeys.size > 0) {
    console.log(
      `[Argo reconcile] ${syncBlockHoldKeys.size} app(s) must stay sync-blocked across stopped schedule(s)`
    );
  }

  report({
    schedulesTotal: candidates.length,
    schedulesDone: 0,
    instantRunsTotal: instantRuns.length,
    instantRunsDone: 0,
    phase: 'schedules',
  });

  let schedulesDone = 0;
  const scheduleOutcomes: { apps: string[]; errors: string[] }[] = [];
  const clearedScheduleIds: string[] = [];

  await runWithConcurrency(candidates, 4, async (schedule) => {
    const shouldBeStopped = scheduleShouldBeSyncBlockedNow(schedule, now);

    if (schedule.liveActive && isScheduleInStoppedWindow(schedule, now)) {
      const startupAt = resolveLiveStartupAt(schedule, now);
      if (
        startupAt &&
        (!schedule.liveStartupAt || schedule.liveStartupAt.getTime() !== startupAt.getTime())
      ) {
        await prisma.schedule
          .update({ where: { id: schedule.id }, data: { liveStartupAt: startupAt } })
          .catch((err) =>
            console.warn(
              `[Argo reconcile] failed to refresh liveStartupAt for "${schedule.name}":`,
              err instanceof Error ? err.message : err
            )
          );
      }
    }

    // BIDIRECTIONAL reconcile:
    //  - in stop window (or manual stop)  → ensure deny window present + sync paused.
    //  - outside stop window (should run) → REMOVE deny window + restore sync for apps this
    //    schedule owns, but never apps another stopped schedule still needs (syncBlockHoldKeys).
    const outcome = shouldBeStopped
      ? await applyManualSyncDenyForScheduleRepair(schedule, allApps, instanceMap, now)
      : await clearManualSyncDenyForScheduleRepair(schedule, allApps, instanceMap, {
          holdKeys: syncBlockHoldKeys,
        });

    schedulesDone++;
    report({
      schedulesTotal: candidates.length,
      schedulesDone,
      instantRunsTotal: instantRuns.length,
      instantRunsDone: 0,
      phase: 'schedules',
    });

    if (!shouldBeStopped) {
      // Running schedule: drop the stop-evidence so it stops being a reconcile candidate
      // once its windows are cleared. liveActive is left to the scheduler tick's
      // shouldReconcileToStarted/startup path.
      if (schedule.pausedArgoApps.length > 0) {
        clearedScheduleIds.push(schedule.id);
      }
      scheduleOutcomes.push({
        apps: [],
        errors: outcome.errors.map((error) => `${schedule.name}: unblock: ${error}`),
      });
      return;
    }

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

  if (clearedScheduleIds.length > 0) {
    await prisma.schedule
      .updateMany({
        where: { id: { in: clearedScheduleIds } },
        data: { pausedArgoApps: [] },
      })
      .catch((err) =>
        console.error(
          '[Argo reconcile] failed to clear pausedArgoApps for unblocked schedules:',
          err instanceof Error ? err.message : err
        )
      );
  }

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
