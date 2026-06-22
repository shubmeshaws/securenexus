import argocdClient, { appMatchesK8sCluster } from './argocd-client';
import { instanceMatchesCluster, listEnabledArgoCDInstances } from './argocd-instances';
import type { ArgoCDAppSummary } from './argocd-client';
import { AUTOMATIC_CRON_TRIGGER } from './alert-display';
import {
  deleteStatefulSet,
  getArgoAppNamesForNamespace,
  getClusterReadyNodeCount,
  getStatefulSetArgoAppName,
  getWorkloadDesiredReplicas,
  listWorkloads,
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
import { resolveWorkloadOpConcurrency } from './schedule-execution-pool';

function scheduleTeamsAlertFlag(schedule: Schedule) {
  return { teamsAlertEnabled: schedule.teamsAlertEnabled };
}

/** Find an Argo app by exact name, preferring the cluster/instance-scoped list. */
async function findArgoAppByName(
  schedule: Schedule,
  appName: string
): Promise<{ name: string; instanceId: string } | null> {
  try {
    const scoped = await appsForSchedule(schedule);
    const scopedMatch = scoped.find((a) => a.name === appName);
    if (scopedMatch) return { name: scopedMatch.name, instanceId: scopedMatch.instanceId };

    // Fallback: search every app (cluster filtering may be too strict).
    const all = await argocdClient.listApplications();
    const anyMatch = all.find((a) => a.name === appName);
    return anyMatch ? { name: anyMatch.name, instanceId: anyMatch.instanceId } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Argo app managing a StatefulSet: first from the live resource's
 * tracking metadata, then falling back to a namespace match.
 */
async function resolveArgoAppForStatefulSet(
  schedule: Schedule
): Promise<{ name: string; instanceId: string } | null> {
  const trackingApp = await getStatefulSetArgoAppName(
    schedule.cluster,
    schedule.namespace,
    schedule.appName
  );
  console.log(
    `[STS shutdown] ${schedule.namespace}/${schedule.appName} trackingApp=${trackingApp ?? '(none)'}`
  );
  if (trackingApp) {
    const byTracking = await findArgoAppByName(schedule, trackingApp);
    if (byTracking) return byTracking;
  }

  try {
    const nsApps = (await appsForSchedule(schedule)).filter(
      (app) => app.destinationNamespace === schedule.namespace
    );
    if (nsApps.length) return { name: nsApps[0].name, instanceId: nsApps[0].instanceId };
  } catch {
    // ignore
  }
  return null;
}

/**
 * Resolve every Argo app that needs pausing for a schedule. Uses the live
 * resources' Argo tracking metadata (reliable across namespaces/app names) with a
 * destination-namespace match as a fallback.
 */
async function collectScheduleArgoApps(
  schedule: Schedule
): Promise<{ name: string; instanceId: string }[]> {
  const byName = new Map<string, { name: string; instanceId: string }>();
  const add = (app: { name: string; instanceId: string } | null) => {
    if (app) byName.set(app.name, app);
  };
  const addNamespaceMatches = async () => {
    try {
      const nsApps = (await appsForSchedule(schedule)).filter(
        (app) => app.destinationNamespace === schedule.namespace
      );
      nsApps.forEach((a) => add({ name: a.name, instanceId: a.instanceId }));
    } catch {
      // best-effort
    }
  };

  if (isNamespaceSchedule(schedule)) {
    const trackingNames = await getArgoAppNamesForNamespace(schedule.cluster, schedule.namespace);
    console.log(
      `[Argo resolve] namespace=${schedule.namespace} tracking apps: ${
        trackingNames.join(', ') || '(none)'
      }`
    );
    for (const name of trackingNames) add(await findArgoAppByName(schedule, name));
    await addNamespaceMatches();
  } else if (schedule.workloadKind === 'StatefulSet') {
    add(await resolveArgoAppForStatefulSet(schedule));
  } else if (schedule.workloadKind === 'CronJob' || schedule.workloadKind === 'ScaledJob') {
    await addNamespaceMatches();
  } else {
    add(await resolveArgoApp(schedule));
  }

  return Array.from(byName.values());
}

interface ScheduleArgoApp {
  name: string;
  instanceId: string;
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

  for (const app of apps) {
    try {
      await argocdClient.addScheduleManualSyncDenyWindow(
        {
          appName: app.name,
          blockFrom: input.now,
          blockUntil: input.blockUntil,
          timeZone: input.timeZone,
        },
        app.instanceId
      );
      blocked.push(app.name);
      console.log(
        `[${input.logPrefix}] manual sync deny window set for ${app.name} until ${input.blockUntil.toISOString()}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${app.name}: ${message}`);
      console.error(`[${input.logPrefix}] failed to block manual sync for ${app.name}: ${message}`);
    }
  }

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
  const targets = await collectScheduleArgoApps(schedule);
  console.log(
    `[Argo pause] ${schedule.namespace} resolved apps: ${
      targets.map((t) => t.name).join(', ') || '(none)'
    }`
  );
  const paused: string[] = [];
  const blockUntil = resolveManualSyncBlockUntilForShutdown(schedule, now);
  const timeZone = schedule.timezone || 'UTC';

  for (const app of targets) {
    try {
      await argocdClient.updateSyncPolicy(app.name, 'none', app.instanceId);
      paused.push(app.name);
    } catch (err) {
      console.error(
        `[Argo pause] failed to pause ${app.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const { blocked: manualBlocked } = await blockManualSyncForApps(targets, {
    blockUntil,
    timeZone,
    now,
    logPrefix: 'Argo pause',
  });

  const notes: string[] = [];
  if (paused.length) notes.push(`ArgoCD sync paused (${paused.join(', ')})`);
  if (manualBlocked.length) notes.push(`manual sync blocked (${manualBlocked.join(', ')})`);
  const note = notes.length ? ` · ${notes.join(' · ')}` : '';
  return { note, apps: Array.from(new Set([...paused, ...manualBlocked])) };
}

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

async function resolveArgoAppsForResume(
  schedule: Schedule,
  appNames: string[]
): Promise<ScheduleArgoApp[]> {
  const resolved: ScheduleArgoApp[] = [];
  for (const name of appNames) {
    const match = await findArgoAppByName(schedule, name);
    if (match) {
      resolved.push(match);
      continue;
    }
    if (schedule.argocdInstanceId) {
      resolved.push({ name, instanceId: schedule.argocdInstanceId });
    }
  }
  return resolved;
}

/** Resume automated sync and remove SecureNexus manual-sync deny windows. */
async function resumeStoredArgoApps(
  schedule: Schedule,
  apps: ScheduleArgoApp[]
): Promise<string> {
  const unblocked: string[] = [];
  for (const app of apps) {
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
  }

  const notes: string[] = [];
  if (unblocked.length) {
    notes.push(`manual sync unblocked (${unblocked.join(', ')})`);
  }

  if (schedule.syncPolicy !== 'automated') {
    return notes.length ? ` · ${notes.join(' · ')}` : '';
  }

  const resumed: string[] = [];
  for (const app of apps) {
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
  }
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
      ...scheduleTeamsAlertFlag(schedule),
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
      ...scheduleTeamsAlertFlag(schedule),
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
      ...scheduleTeamsAlertFlag(schedule),
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
      ...scheduleTeamsAlertFlag(schedule),
    });
    throw err;
  }
}

export interface ShutdownOptions {
  markLive?: boolean;
  clearLive?: boolean;
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

  const targets = await getScheduleTargets(schedule);
  const isNamespace = isNamespaceSchedule(schedule);
  const activityAppName = isNamespace ? NAMESPACE_SCOPE_MARKER : schedule.appName;

  try {
    const nodeCount = await getClusterReadyNodeCount(schedule.cluster);
    const fresh = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    const priorWorkloadSaves = parseSavedWorkloadReplicas(fresh?.savedWorkloadReplicas);
    const alertSchedule = fresh ?? schedule;

    const liveUpdate = buildLiveScheduleUpdate(schedule, triggeredBy, options);

    let argoNote = '';
    let pausedArgoApps: string[] = [];
    try {
      const pauseResult = await pauseArgoForSchedule(schedule);
      argoNote = pauseResult.note;
      pausedArgoApps = pauseResult.apps;
    } catch (err) {
      argoNote = ` · ArgoCD sync pause failed: ${err instanceof Error ? err.message : 'unknown'}`;
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
          await new Promise((r) => setTimeout(r, 2000));
          await deleteStatefulSet(schedule.cluster, schedule.namespace, schedule.appName);
          statefulSetDeleted = true;

          // Verify the delete stuck (Argo did not immediately recreate it).
          await new Promise((r) => setTimeout(r, 2000));
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
    const message = isNamespace
      ? `Scaled ${targets.length} workload(s) to 0 in ${schedule.namespace}${argoNote}`
      : isCronJobSchedule
        ? `Suspended CronJob ${schedule.appName} and removed active jobs${argoNote}`
        : isScaledJobSchedule
          ? `Paused ScaledJob ${schedule.appName} and removed active jobs${argoNote}`
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
      ...scheduleTeamsAlertFlag(alertSchedule),
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
      ...scheduleTeamsAlertFlag(alertSchedule),
    });
    throw err;
  }
}

export async function executeStartup(schedule: Schedule, triggeredBy: string): Promise<void> {
  if (isNonEksSchedule(schedule)) {
    return executeEc2Startup(schedule, triggeredBy);
  }

  const targets = await getScheduleTargets(schedule);
  const isNamespace = isNamespaceSchedule(schedule);
  const activityAppName = isNamespace ? NAMESPACE_SCOPE_MARKER : schedule.appName;

  try {
    const fresh = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    const alertSchedule = fresh ?? schedule;

    let statefulSetRecreatedViaArgo = false;

    if (isNamespace) {
      const savedMap = parseSavedWorkloadReplicas(fresh?.savedWorkloadReplicas);

      await runWithConcurrency(targets, resolveWorkloadOpConcurrency(), async (target) => {
        const key = workloadKey(target.kind, target.name);
        const replicas = resolveStartupReplicas(schedule, savedMap[key]);
        await scaleWorkload(
          schedule.cluster,
          schedule.namespace,
          target.kind,
          target.name,
          replicas
        );
      });
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
      const storedNames = storedPausedApps.length
        ? storedPausedApps
        : (await collectScheduleArgoApps(schedule)).map((a) => a.name);
      const toResume = await resolveArgoAppsForResume(schedule, storedNames);
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
    const message = isNamespace
      ? `Restored ${targets.length} workload(s) in ${schedule.namespace}${argoNote}`
      : isCronJobSchedule
        ? `Resumed CronJob ${schedule.appName}${argoNote}`
        : isScaledJobSchedule
          ? `Resumed ScaledJob ${schedule.appName}${argoNote}`
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
      ...scheduleTeamsAlertFlag(alertSchedule),
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
      ...scheduleTeamsAlertFlag(alertSchedule),
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
