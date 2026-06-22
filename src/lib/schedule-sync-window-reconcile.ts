import prisma from './prisma';
import { addHours } from 'date-fns';
import type { InstantRun, Schedule } from '@prisma/client';
import { applyManualSyncDenyForSchedule } from './scheduler-actions';
import { isNonEksSchedule } from './workload-utils';
import argocdClient, { appMatchesK8sCluster } from './argocd-client';

export interface SyncWindowReconcileResult {
  schedulesProcessed: number;
  scheduleAppsUpdated: number;
  instantRunsProcessed: number;
  instantAppsUpdated: number;
  errors: string[];
}

function scheduleNeedsSyncWindowReconcile(schedule: Schedule): boolean {
  if (isNonEksSchedule(schedule)) return false;
  if (schedule.liveActive) return true;
  if (schedule.liveStopSource === 'manual') return true;
  if (schedule.pausedArgoApps.length > 0) return true;
  return false;
}

async function resolveInstantRunArgoApps(
  run: InstantRun
): Promise<{ name: string; instanceId: string }[]> {
  const clusterApps = (await argocdClient.listApplications()).filter((app) =>
    appMatchesK8sCluster(app, run.cluster)
  );

  if (run.pausedArgoApps.length > 0) {
    return run.pausedArgoApps
      .map((name) => clusterApps.find((app) => app.name === name))
      .filter((app): app is NonNullable<typeof app> => Boolean(app))
      .map((app) => ({ name: app.name, instanceId: app.instanceId }));
  }

  const match = clusterApps.find(
    (app) => app.name === run.appName && app.destinationNamespace === run.namespace
  );
  return match ? [{ name: match.name, instanceId: match.instanceId }] : [];
}

async function applyManualSyncDenyForInstantRun(
  run: InstantRun,
  now = new Date()
): Promise<{ apps: string[]; errors: string[] }> {
  const targets = await resolveInstantRunArgoApps(run);
  if (!targets.length) return { apps: [], errors: [] };

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

  return { apps, errors };
}

/** Backfill Argo CD manual-sync deny windows for schedules/runs already in a stopped state. */
export async function reconcileStoppedScheduleSyncWindows(): Promise<SyncWindowReconcileResult> {
  const now = new Date();
  const result: SyncWindowReconcileResult = {
    schedulesProcessed: 0,
    scheduleAppsUpdated: 0,
    instantRunsProcessed: 0,
    instantAppsUpdated: 0,
    errors: [],
  };

  const schedules = await prisma.schedule.findMany({
    where: {
      platformType: { not: 'non_eks' },
      OR: [
        { liveActive: true },
        { liveStopSource: 'manual' },
        { pausedArgoApps: { isEmpty: false } },
      ],
    },
  });

  for (const schedule of schedules) {
    if (!scheduleNeedsSyncWindowReconcile(schedule)) continue;

    const { apps, errors } = await applyManualSyncDenyForSchedule(schedule, now);
    if (apps.length) {
      result.schedulesProcessed++;
      result.scheduleAppsUpdated += apps.length;
    }
    for (const error of errors) {
      result.errors.push(`${schedule.name}: ${error}`);
    }
  }

  const instantRuns = await prisma.instantRun.findMany({ where: { active: true } });
  for (const run of instantRuns) {
    const { apps, errors } = await applyManualSyncDenyForInstantRun(run, now);
    if (apps.length) {
      result.instantRunsProcessed++;
      result.instantAppsUpdated += apps.length;
    }
    for (const error of errors) {
      result.errors.push(`instant:${run.appName}: ${error}`);
    }
  }

  if (
    result.schedulesProcessed ||
    result.instantRunsProcessed ||
    result.errors.length
  ) {
    console.log(
      `[Argo reconcile] sync windows: ${result.schedulesProcessed} schedule(s), ` +
        `${result.scheduleAppsUpdated} app(s), ${result.instantRunsProcessed} instant run(s), ` +
        `${result.errors.length} error(s)`
    );
  }

  return result;
}
