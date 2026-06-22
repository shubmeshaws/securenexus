import { addHours } from 'date-fns';
import argocdClient, { appMatchesK8sCluster } from './argocd-client';
import { instanceMatchesCluster, listEnabledArgoCDInstances } from './argocd-instances';
import type { ArgoCDAppSummary } from './argocd-client';
import {
  getStatefulSetArgoAppName,
  getWorkloadDesiredReplicas,
  scaleWorkload,
  type WorkloadKind,
} from './k8s-client';
import { logActivity } from './activity';
import prisma from './prisma';
import type { InstantRun } from '@prisma/client';

interface ArgoAppRef {
  name: string;
  instanceId: string;
}

async function appsForCluster(cluster: string): Promise<ArgoCDAppSummary[]> {
  const [apps, instances] = await Promise.all([
    argocdClient.listApplications(),
    listEnabledArgoCDInstances(),
  ]);
  const instanceMap = new Map(instances.map((i) => [i.id, i]));
  return apps.filter((app) => {
    const instance = instanceMap.get(app.instanceId);
    if (instance && !instanceMatchesCluster(instance, cluster)) return false;
    return appMatchesK8sCluster(app, cluster);
  });
}

async function findArgoAppByName(cluster: string, appName: string): Promise<ArgoAppRef | null> {
  try {
    const scoped = await appsForCluster(cluster);
    const match = scoped.find((a) => a.name === appName);
    return match ? { name: match.name, instanceId: match.instanceId } : null;
  } catch {
    return null;
  }
}

async function resolveArgoAppForWorkload(
  cluster: string,
  namespace: string,
  appName: string,
  kind: WorkloadKind
): Promise<ArgoAppRef | null> {
  if (kind === 'StatefulSet') {
    const trackingApp = await getStatefulSetArgoAppName(cluster, namespace, appName);
    if (trackingApp) {
      const byTracking = await findArgoAppByName(cluster, trackingApp);
      if (byTracking) return byTracking;
    }
  }

  try {
    const scoped = await appsForCluster(cluster);
    const exact = scoped.find((a) => a.name === appName);
    if (exact) return { name: exact.name, instanceId: exact.instanceId };

    const byTarget = scoped.find(
      (a) =>
        a.destinationNamespace === namespace &&
        (a.name === appName || a.name.includes(appName) || appName.includes(a.name))
    );
    return byTarget ? { name: byTarget.name, instanceId: byTarget.instanceId } : null;
  } catch {
    return null;
  }
}

async function pauseArgoForWorkload(
  cluster: string,
  namespace: string,
  appName: string,
  kind: WorkloadKind,
  now = new Date()
): Promise<string[]> {
  const app = await resolveArgoAppForWorkload(cluster, namespace, appName, kind);
  if (!app) return [];

  const paused: string[] = [];
  const blockUntil = addHours(now, 24);

  try {
    await argocdClient.updateSyncPolicy(app.name, 'none', app.instanceId);
    paused.push(app.name);
  } catch (err) {
    console.error(
      `[InstantSchedule] Argo pause failed for ${app.name}:`,
      err instanceof Error ? err.message : err
    );
  }

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
    if (!paused.includes(app.name)) paused.push(app.name);
  } catch (err) {
    console.error(
      `[InstantSchedule] Argo manual-sync block failed for ${app.name}:`,
      err instanceof Error ? err.message : err
    );
  }

  return paused;
}

async function resumeArgoApps(appNames: string[], cluster: string): Promise<string> {
  const notes: string[] = [];
  const unblocked: string[] = [];
  const resumed: string[] = [];

  for (const name of appNames) {
    const app = await findArgoAppByName(cluster, name);
    if (!app) continue;

    try {
      const removed = await argocdClient.removeScheduleManualSyncDenyWindows(
        app.name,
        app.instanceId
      );
      if (removed > 0) unblocked.push(app.name);
    } catch (err) {
      console.error(
        `[InstantSchedule] Argo unblock failed for ${app.name}:`,
        err instanceof Error ? err.message : err
      );
    }

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
        `[InstantSchedule] Argo resume failed for ${app.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (unblocked.length) notes.push(`manual sync unblocked (${unblocked.join(', ')})`);
  if (resumed.length) notes.push(`ArgoCD sync restored (${resumed.join(', ')})`);
  return notes.length ? ` · ${notes.join(' · ')}` : '';
}

export interface InstantStartInput {
  cluster: string;
  namespace: string;
  appName: string;
  workloadKind: WorkloadKind;
  targetReplicas: number;
  startedBy: string;
}

export async function executeInstantStart(input: InstantStartInput): Promise<InstantRun> {
  const { cluster, namespace, appName, workloadKind, targetReplicas, startedBy } = input;

  if (workloadKind === 'DaemonSet') {
    throw new Error('DaemonSets cannot be started via Instant Schedule');
  }

  const existing = await prisma.instantRun.findFirst({
    where: { cluster, namespace, appName, workloadKind, active: true },
  });
  if (existing) {
    throw new Error(
      `An instant run is already active for ${namespace}/${appName}. Stop it first before starting again.`
    );
  }

  const replicasBefore = await getWorkloadDesiredReplicas(
    cluster,
    namespace,
    workloadKind,
    appName
  );

  let pausedArgoApps: string[] = [];
  let argoNote = '';
  try {
    pausedArgoApps = await pauseArgoForWorkload(cluster, namespace, appName, workloadKind);
    if (pausedArgoApps.length) {
      argoNote = ` · ArgoCD sync paused (${pausedArgoApps.join(', ')})`;
    }
  } catch (err) {
    argoNote = ` · ArgoCD sync pause failed: ${err instanceof Error ? err.message : 'unknown'}`;
  }

  await scaleWorkload(cluster, namespace, workloadKind, appName, targetReplicas);

  const run = await prisma.instantRun.create({
    data: {
      cluster,
      namespace,
      appName,
      workloadKind,
      replicasBefore,
      targetReplicas,
      pausedArgoApps,
      active: true,
      startedBy,
    },
  });

  await logActivity({
    action: 'instant-start',
    cluster,
    namespace,
    appName,
    triggeredBy: startedBy,
    status: 'success',
    message: `Instant start: scaled ${appName} (${workloadKind}) to ${targetReplicas} replicas (was ${replicasBefore})${argoNote}`,
  });

  return run;
}

export async function executeInstantStop(runId: string, stoppedBy: string): Promise<InstantRun> {
  const run = await prisma.instantRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error('Instant run not found');
  if (!run.active) throw new Error('Instant run is already stopped');

  const kind = run.workloadKind as WorkloadKind;
  const restoreReplicas = run.replicasBefore;

  let argoNote = '';
  try {
    argoNote = await resumeArgoApps(run.pausedArgoApps, run.cluster);
  } catch (err) {
    argoNote = ` · ArgoCD resume failed: ${err instanceof Error ? err.message : 'unknown'}`;
  }

  await scaleWorkload(run.cluster, run.namespace, kind, run.appName, restoreReplicas);

  const updated = await prisma.instantRun.update({
    where: { id: runId },
    data: {
      active: false,
      stoppedAt: new Date(),
      stoppedBy,
    },
  });

  await logActivity({
    action: 'instant-stop',
    cluster: run.cluster,
    namespace: run.namespace,
    appName: run.appName,
    triggeredBy: stoppedBy,
    status: 'success',
    message: `Instant stop: scaled ${run.appName} (${kind}) back to ${restoreReplicas} replicas${argoNote}`,
  });

  return updated;
}

export async function listActiveInstantRuns() {
  return prisma.instantRun.findMany({
    where: { active: true },
    orderBy: { startedAt: 'desc' },
  });
}
