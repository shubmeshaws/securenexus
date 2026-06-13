import argocdClient, { appMatchesK8sCluster } from './argocd-client';
import { instanceMatchesCluster, listEnabledArgoCDInstances } from './argocd-instances';
import type { ArgoCDAppSummary } from './argocd-client';
import {
  getWorkloadDesiredReplicas,
  listWorkloads,
  scaleWorkload,
  type WorkloadKind,
} from './k8s-client';
import { logActivity } from './activity';
import prisma from './prisma';
import { computeCurrentLiveStartupAt, computeNextRun, formatScheduleStartupLabel } from './scheduler-utils';
import {
  isNamespaceSchedule,
  NAMESPACE_SCOPE_MARKER,
  workloadKey,
} from './workload-utils';
import { Prisma, type Schedule } from '@prisma/client';

interface WorkloadTarget {
  name: string;
  kind: WorkloadKind;
}

async function appsForSchedule(schedule: Schedule): Promise<ArgoCDAppSummary[]> {
  const [apps, instances] = await Promise.all([
    argocdClient.listApplications(),
    listEnabledArgoCDInstances(),
  ]);
  const instanceMap = new Map(instances.map((i) => [i.id, i]));
  return apps.filter((app) => {
    if (schedule.argocdInstanceId && app.instanceId !== schedule.argocdInstanceId) {
      return false;
    }
    const instance = instanceMap.get(app.instanceId);
    if (instance && !instanceMatchesCluster(instance, schedule.cluster)) return false;
    return appMatchesK8sCluster(app, schedule.cluster);
  });
}

async function resolveArgoApp(
  schedule: Schedule
): Promise<{ name: string; instanceId: string } | null> {
  if (isNamespaceSchedule(schedule)) return null;
  try {
    const scoped = await appsForSchedule(schedule);

    const exact = scoped.find((app) => app.name === schedule.appName);
    if (exact) return { name: exact.name, instanceId: exact.instanceId };

    const byTarget = scoped.find(
      (app) =>
        app.destinationNamespace === schedule.namespace &&
        (app.name === schedule.appName ||
          app.name.includes(schedule.appName) ||
          schedule.appName.includes(app.name))
    );
    return byTarget ? { name: byTarget.name, instanceId: byTarget.instanceId } : null;
  } catch {
    return null;
  }
}

async function pauseArgoSync(schedule: Schedule): Promise<string | null> {
  const argoApp = await resolveArgoApp(schedule);
  if (!argoApp) return null;
  await argocdClient.updateSyncPolicy(argoApp.name, 'none', argoApp.instanceId);
  return argoApp.name;
}

async function resumeArgoSync(schedule: Schedule): Promise<string | null> {
  if (schedule.syncPolicy !== 'automated') return null;
  const argoApp = await resolveArgoApp(schedule);
  if (!argoApp) return null;
  await argocdClient.updateSyncPolicy(argoApp.name, 'automated', argoApp.instanceId);
  try {
    await argocdClient.triggerSync(argoApp.name, argoApp.instanceId);
  } catch {
    // sync trigger is best-effort
  }
  return argoApp.name;
}

async function pauseArgoSyncForNamespace(schedule: Schedule): Promise<string[]> {
  const paused: string[] = [];
  try {
    const inNs = (await appsForSchedule(schedule)).filter(
      (app) => app.destinationNamespace === schedule.namespace
    );
    for (const app of inNs) {
      await argocdClient.updateSyncPolicy(app.name, 'none', app.instanceId);
      paused.push(app.name);
    }
  } catch {
    // best-effort
  }
  return paused;
}

async function resumeArgoSyncForNamespace(schedule: Schedule): Promise<string[]> {
  if (schedule.syncPolicy !== 'automated') return [];
  const resumed: string[] = [];
  try {
    const inNs = (await appsForSchedule(schedule)).filter(
      (app) => app.destinationNamespace === schedule.namespace
    );
    for (const app of inNs) {
      await argocdClient.updateSyncPolicy(app.name, 'automated', app.instanceId);
      resumed.push(app.name);
      try {
        await argocdClient.triggerSync(app.name, app.instanceId);
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
  return resumed;
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

export interface ShutdownOptions {
  markLive?: boolean;
  clearLive?: boolean;
}

export async function executeShutdown(
  schedule: Schedule,
  triggeredBy: string,
  options?: ShutdownOptions
): Promise<void> {
  const targets = await getScheduleTargets(schedule);
  const isNamespace = isNamespaceSchedule(schedule);
  const activityAppName = isNamespace ? NAMESPACE_SCOPE_MARKER : schedule.appName;

  try {
    const fresh = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    const priorWorkloadSaves = parseSavedWorkloadReplicas(fresh?.savedWorkloadReplicas);

    const liveUpdate = options?.clearLive
      ? { liveActive: false, liveStartupAt: null }
      : options?.markLive
        ? {
            liveActive: true,
            liveStartupAt: computeCurrentLiveStartupAt(schedule, new Date()),
          }
        : {};

    if (isNamespace) {
      const replicasMap: Record<string, number> = {};

      for (const target of targets) {
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
      }

      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          savedWorkloadReplicas: replicasMap,
          savedReplicas: null,
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

      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          savedReplicas: replicasToSave,
          savedWorkloadReplicas: Prisma.JsonNull,
          ...liveUpdate,
        },
      });

      await scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, 0);
    }

    let argoNote = '';
    try {
      if (isNamespace) {
        const paused = await pauseArgoSyncForNamespace(schedule);
        if (paused.length) argoNote = ` · ArgoCD sync paused (${paused.length} apps)`;
      } else {
        const argoApp = await pauseArgoSync(schedule);
        if (argoApp) argoNote = ` · ArgoCD sync paused (${argoApp})`;
      }
    } catch (err) {
      argoNote = ` · ArgoCD sync pause failed: ${err instanceof Error ? err.message : 'unknown'}`;
    }

    const savedForMessage = isNamespace
      ? null
      : (await prisma.schedule.findUnique({ where: { id: schedule.id } }))?.savedReplicas;

    const message = isNamespace
      ? `Scaled ${targets.length} workload(s) to 0 in ${schedule.namespace}${argoNote}`
      : `Scaled to 0 (saved ${savedForMessage ?? schedule.targetReplicas} replicas)${argoNote}`;

    const activityDetails = isNamespace
      ? JSON.stringify({
          scope: 'namespace',
          workloads: targets.map((t) => workloadKey(t.kind, t.name)),
          count: targets.length,
        })
      : undefined;

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
    });
  } catch (err) {
    await logActivity({
      action: 'schedule-shutdown',
      cluster: schedule.cluster,
      namespace: schedule.namespace,
      appName: activityAppName,
      triggeredBy,
      status: 'failed',
      message: err instanceof Error ? err.message : 'Shutdown failed',
      details: isNamespace
        ? JSON.stringify({
            scope: 'namespace',
            workloads: targets.map((t) => workloadKey(t.kind, t.name)),
            count: targets.length,
          })
        : undefined,
    });
    throw err;
  }
}

export async function executeStartup(schedule: Schedule, triggeredBy: string): Promise<void> {
  const targets = await getScheduleTargets(schedule);
  const isNamespace = isNamespaceSchedule(schedule);
  const activityAppName = isNamespace ? NAMESPACE_SCOPE_MARKER : schedule.appName;

  try {
    const fresh = await prisma.schedule.findUnique({ where: { id: schedule.id } });

    if (isNamespace) {
      const savedMap = parseSavedWorkloadReplicas(fresh?.savedWorkloadReplicas);

      for (const target of targets) {
        const key = workloadKey(target.kind, target.name);
        const replicas = resolveStartupReplicas(schedule, savedMap[key]);
        await scaleWorkload(
          schedule.cluster,
          schedule.namespace,
          target.kind,
          target.name,
          replicas
        );
      }
    } else {
      const kind = schedule.workloadKind as WorkloadKind;
      const replicas = resolveStartupReplicas(schedule, fresh?.savedReplicas);
      await scaleWorkload(schedule.cluster, schedule.namespace, kind, schedule.appName, replicas);
    }

    let argoNote = '';
    try {
      if (isNamespace) {
        const resumed = await resumeArgoSyncForNamespace(schedule);
        if (resumed.length) argoNote = ` · ArgoCD sync restored (${resumed.length} apps)`;
      } else {
        const argoApp = await resumeArgoSync(schedule);
        if (argoApp) argoNote = ` · ArgoCD sync restored (${argoApp})`;
      }
    } catch (err) {
      argoNote = ` · ArgoCD sync restore failed: ${err instanceof Error ? err.message : 'unknown'}`;
    }

    const restoredReplicas = isNamespace
      ? null
      : resolveStartupReplicas(schedule, fresh?.savedReplicas);

    const message = isNamespace
      ? `Restored ${targets.length} workload(s) in ${schedule.namespace}${argoNote}`
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
    });
  } catch (err) {
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
    await executeShutdown(schedule, triggeredBy);
  } else {
    await executeStartup(schedule, triggeredBy);
  }

  const nextRun = computeNextRun(schedule);
  await prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      lastRun: new Date(),
      nextRun,
      ...(mode === 'startup' ? { liveActive: false, liveStartupAt: null } : {}),
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
    data: { lastRun: new Date(), nextRun, liveActive: false, liveStartupAt: null },
  });
}
