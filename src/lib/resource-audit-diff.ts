import prisma from './prisma';
import type { InstanceArgoCDClient } from './argocd-client';
import { extractSnapshotsFromManifests } from './resource-audit-manifests';
import {
  parseArgoCDAuthor,
  GIT_SYNC_CONTAINER_MARKER,
  GIT_SYNC_WORKLOAD_MARKER,
  type ResourceAuditType,
  type ResourceChangeInput,
  type ResourceFieldSnapshot,
} from './resource-audit-types';
import { parseCpuToCores, parseMemoryToGiB } from './resource-quantity';
import type { ClusterResourceRates } from './instance-pricing';

function snapshotMap(rows: ResourceFieldSnapshot[]): Map<string, ResourceFieldSnapshot> {
  const map = new Map<string, ResourceFieldSnapshot>();
  for (const row of rows) {
    map.set(
      `${row.namespace}::${row.workload}::${row.containerName}::${row.resourceType}`,
      row
    );
  }
  return map;
}

export function estimateCostDelta(
  resourceType: ResourceAuditType,
  oldValue: string,
  newValue: string,
  replicaCount: number,
  rates: ClusterResourceRates
): number | null {
  const replicas = Math.max(1, replicaCount);
  if (resourceType === 'CPU_REQUEST' || resourceType === 'CPU_LIMIT') {
    const delta = parseCpuToCores(newValue) - parseCpuToCores(oldValue);
    return delta * replicas * rates.cpuHourlyPerCore * 24;
  }
  if (resourceType === 'MEMORY_REQUEST' || resourceType === 'MEMORY_LIMIT') {
    const delta = parseMemoryToGiB(newValue) - parseMemoryToGiB(oldValue);
    return delta * replicas * rates.memHourlyPerGb * 24;
  }
  return null;
}

function replicaCountForWorkload(
  snaps: ResourceFieldSnapshot[],
  namespace: string,
  workload: string
): number {
  const replicaSnap = snaps.find(
    (s) =>
      s.workload === workload &&
      s.namespace === namespace &&
      s.resourceType === 'REPLICAS'
  );
  return parseInt(replicaSnap?.value ?? '1', 10) || 1;
}

function totalPodCount(snaps: ResourceFieldSnapshot[]): number {
  return snaps
    .filter((s) => s.resourceType === 'REPLICAS')
    .reduce((sum, s) => sum + (parseInt(s.value, 10) || 0), 0);
}

/** True when ArgoCD history shows the app coming online (first deploy or 0 → N pods). */
export function isAppFirstDeploy(
  historyIndex: number,
  previousSnaps: ResourceFieldSnapshot[],
  currentSnaps: ResourceFieldSnapshot[]
): boolean {
  if (historyIndex === 0) return true;
  const prevPods = totalPodCount(previousSnaps);
  const currPods = totalPodCount(currentSnaps);
  return prevPods === 0 && currPods > 0;
}

/** Daily cost to run all workloads at their git-declared CPU/memory requests × replicas. */
export function estimateRunningCostFromSnapshots(
  snaps: ResourceFieldSnapshot[],
  rates: ClusterResourceRates
): number {
  const workloads = new Map<
    string,
    { replicas: number; cpuCores: number; memGiB: number }
  >();

  for (const snap of snaps) {
    const key = `${snap.namespace}::${snap.workload}`;
    const entry = workloads.get(key) ?? { replicas: 1, cpuCores: 0, memGiB: 0 };

    if (snap.resourceType === 'REPLICAS') {
      entry.replicas = Math.max(0, parseInt(snap.value, 10) || 0);
    } else if (snap.resourceType === 'CPU_REQUEST') {
      entry.cpuCores += parseCpuToCores(snap.value);
    } else if (snap.resourceType === 'MEMORY_REQUEST') {
      entry.memGiB += parseMemoryToGiB(snap.value);
    }
    workloads.set(key, entry);
  }

  let total = 0;
  for (const w of Array.from(workloads.values())) {
    if (w.replicas <= 0) continue;
    const perPodDaily =
      (w.cpuCores * rates.cpuHourlyPerCore + w.memGiB * rates.memHourlyPerGb) * 24;
    total += w.replicas * perPodDaily;
  }
  return total;
}

async function gitSyncExists(argocdApp: string, revisionSha: string): Promise<boolean> {
  const row = await prisma.resourceChangeAudit.findFirst({
    where: { argocdApp, revisionSha, resourceType: 'GIT_SYNC' },
    select: { id: true },
  });
  return Boolean(row);
}

export interface GitSyncRecordParams {
  client: InstanceArgoCDClient;
  appName: string;
  cluster: string;
  environment: string;
  namespace: string;
  revisionSha: string;
  prevRevisionSha: string | null;
  branchName: string | null;
  syncedAt: Date;
  appNamespace: string;
  rates: ClusterResourceRates;
  revisionCache?: Map<string, ResourceFieldSnapshot[]>;
}

export interface AppUpRecordParams extends GitSyncRecordParams {
  historyIndex: number;
  previousSnaps: ResourceFieldSnapshot[];
  currentSnaps: ResourceFieldSnapshot[];
}

/** Record every git sync in history; running cost only on first deploy / scale-from-zero. */
export async function recordHistorySyncEvent(
  params: AppUpRecordParams
): Promise<ResourceChangeInput | null> {
  if (!params.revisionSha || (await gitSyncExists(params.appName, params.revisionSha))) {
    return null;
  }

  const isAppUp = isAppFirstDeploy(
    params.historyIndex,
    params.previousSnaps,
    params.currentSnaps
  );

  const cache = params.revisionCache ?? new Map<string, ResourceFieldSnapshot[]>();
  let snaps = cache.get(params.revisionSha);
  if (!snaps) {
    const manifests = await params.client.getManifestsAtRevision(
      params.appName,
      params.revisionSha,
      params.appNamespace
    );
    snaps = extractSnapshotsFromManifests(params.appName, manifests);
    cache.set(params.revisionSha, snaps);
  }

  const metadata = await params.client.getRevisionMetadata(
    params.appName,
    params.revisionSha
  );
  const author = parseArgoCDAuthor(metadata?.author ?? 'Unknown');
  const pods = totalPodCount(snaps);
  const runningCost = isAppUp
    ? estimateRunningCostFromSnapshots(snaps, params.rates)
    : 0;

  return {
    argocdApp: params.appName,
    cluster: params.cluster,
    environment: params.environment,
    namespace: params.namespace,
    workload: GIT_SYNC_WORKLOAD_MARKER,
    containerName: GIT_SYNC_CONTAINER_MARKER,
    resourceType: 'GIT_SYNC',
    oldValue: '—',
    newValue: '—',
    revisionSha: params.revisionSha,
    branchName: params.branchName,
    podCount: pods > 0 ? pods : null,
    authorName: author.authorName,
    authorEmail: author.authorEmail,
    commitMessage: metadata?.message ?? null,
    syncedAt: params.syncedAt,
    estimatedCostImpactPerDay: isAppUp && runningCost > 0 ? runningCost : null,
  };
}

/** @deprecated Use recordHistorySyncEvent */
export async function recordAppUpIfNeeded(
  params: AppUpRecordParams
): Promise<ResourceChangeInput | null> {
  return recordHistorySyncEvent(params);
}

export async function persistGitSyncEvent(
  event: ResourceChangeInput | null
): Promise<number> {
  if (!event) return 0;
  await prisma.resourceChangeAudit.create({
    data: {
      ...event,
      estimatedCostImpactPerDay:
        event.estimatedCostImpactPerDay != null
          ? event.estimatedCostImpactPerDay
          : undefined,
    },
  });
  return 1;
}

async function auditExists(
  argocdApp: string,
  revisionSha: string,
  snap: ResourceFieldSnapshot
): Promise<boolean> {
  const row = await prisma.resourceChangeAudit.findFirst({
    where: {
      argocdApp,
      revisionSha,
      namespace: snap.namespace,
      workload: snap.workload,
      containerName: snap.containerName,
      resourceType: snap.resourceType,
    },
    select: { id: true },
  });
  return Boolean(row);
}

export async function fetchManifestSnapshotsForRevision(
  client: InstanceArgoCDClient,
  appName: string,
  revision: string,
  appNamespace: string,
  destinationNamespace: string,
  cache: Map<string, ResourceFieldSnapshot[]>
): Promise<ResourceFieldSnapshot[]> {
  return fetchManifestSnapshots(
    client,
    appName,
    revision,
    appNamespace,
    destinationNamespace,
    cache
  );
}

async function fetchManifestSnapshots(
  client: InstanceArgoCDClient,
  appName: string,
  revision: string,
  appNamespace: string,
  _destinationNamespace: string,
  cache: Map<string, ResourceFieldSnapshot[]>
): Promise<ResourceFieldSnapshot[]> {
  const cached = cache.get(revision);
  if (cached) return cached;
  const manifests = await client.getManifestsAtRevision(appName, revision, appNamespace);
  // Compare all rendered workloads — destination namespace filter hid prior revision values.
  const snaps = extractSnapshotsFromManifests(appName, manifests);
  cache.set(revision, snaps);
  return snaps;
}

export interface ManifestRevisionDiffParams {
  client: InstanceArgoCDClient;
  appName: string;
  cluster: string;
  environment: string;
  destinationNamespace: string;
  prevRevision: string;
  newRevision: string;
  /** Older revisions to try when the immediate previous revision has no workloads. */
  priorRevisions?: string[];
  branchName: string | null;
  syncedAt: Date;
  appNamespace: string;
  rates: ClusterResourceRates;
  revisionCache?: Map<string, ResourceFieldSnapshot[]>;
}

export async function recordManifestRevisionDiff(
  params: ManifestRevisionDiffParams
): Promise<ResourceChangeInput[]> {
  const cache = params.revisionCache ?? new Map<string, ResourceFieldSnapshot[]>();
  let previousSnaps = await fetchManifestSnapshots(
    params.client,
    params.appName,
    params.prevRevision,
    params.appNamespace,
    params.destinationNamespace,
    cache
  );
  if (previousSnaps.length === 0 && params.priorRevisions?.length) {
    for (const revision of params.priorRevisions) {
      previousSnaps = await fetchManifestSnapshots(
        params.client,
        params.appName,
        revision,
        params.appNamespace,
        params.destinationNamespace,
        cache
      );
      if (previousSnaps.length > 0) break;
    }
  }

  const currentSnaps = await fetchManifestSnapshots(
      params.client,
      params.appName,
      params.newRevision,
    params.appNamespace,
    params.destinationNamespace,
    cache
  );

  const prevMap = snapshotMap(previousSnaps);
  const baselineRows = await prisma.resourceSnapshot.findMany({
    where: { argocdApp: params.appName },
  });
  for (const row of baselineRows) {
    const key = `${row.namespace}::${row.workload}::${row.containerName}::${row.resourceType}`;
    if (!prevMap.has(key)) {
      prevMap.set(key, {
        argocdApp: row.argocdApp,
        namespace: row.namespace,
        workload: row.workload,
        containerName: row.containerName,
        resourceType: row.resourceType as ResourceFieldSnapshot['resourceType'],
        value: row.value,
      });
    }
  }

  const metadata = await params.client.getRevisionMetadata(params.appName, params.newRevision);
  const author = parseArgoCDAuthor(metadata?.author ?? 'Unknown');
  const changes: ResourceChangeInput[] = [];

  for (const snap of currentSnaps) {
    const key = `${snap.namespace}::${snap.workload}::${snap.containerName}::${snap.resourceType}`;
    const prev = prevMap.get(key);
    if (prev && prev.value === snap.value) continue;
    if (await auditExists(params.appName, params.newRevision, snap)) continue;

    const podCount = replicaCountForWorkload(
      currentSnaps,
      snap.namespace,
      snap.workload
    );
    const replicaCount =
      snap.resourceType === 'REPLICAS'
        ? parseInt(snap.value, 10) || podCount
        : podCount;

    if (!prev) continue;

    const oldValue = prev.value;
    const newValue = snap.value;

    changes.push({
      argocdApp: params.appName,
      cluster: params.cluster,
      environment: params.environment,
      namespace: snap.namespace,
      workload: snap.workload,
      containerName: snap.containerName,
      resourceType: snap.resourceType,
      oldValue,
      newValue,
      revisionSha: params.newRevision,
      branchName: params.branchName,
      podCount: snap.resourceType === 'REPLICAS' ? parseInt(snap.value, 10) || podCount : podCount,
      authorName: author.authorName,
      authorEmail: author.authorEmail,
      commitMessage: metadata?.message ?? null,
      syncedAt: params.syncedAt,
      estimatedCostImpactPerDay: estimateCostDelta(
        snap.resourceType,
        prev.value,
        snap.value,
        replicaCount,
        params.rates
      ),
    });
  }

  return changes;
}

export async function persistResourceChanges(changes: ResourceChangeInput[]): Promise<number> {
  let recorded = 0;
  for (const change of changes) {
    await prisma.resourceChangeAudit.create({
      data: {
        ...change,
        estimatedCostImpactPerDay:
          change.estimatedCostImpactPerDay != null
            ? change.estimatedCostImpactPerDay
            : undefined,
      },
    });
    recorded += 1;
  }
  return recorded;
}

export async function syncManifestSnapshotsToBaseline(
  argocdApp: string,
  snaps: ResourceFieldSnapshot[]
): Promise<void> {
  for (const snap of snaps) {
    await prisma.resourceSnapshot.upsert({
      where: {
        argocdApp_namespace_workload_containerName_resourceType: {
          argocdApp: snap.argocdApp,
          namespace: snap.namespace,
          workload: snap.workload,
          containerName: snap.containerName,
          resourceType: snap.resourceType,
        },
      },
      create: snap,
      update: { value: snap.value, capturedAt: new Date() },
    });
  }
}
