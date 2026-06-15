import prisma from './prisma';
import { valuesFilePathFromRow } from './helm-values-path';
import {
  estimateCostDelta,
  estimateRunningCostFromSnapshots,
  isBillableResourceType,
  parseReplicaCountValue,
} from './resource-audit-diff';
import type { ResourceFieldSnapshot, ResourceAuditType } from './resource-audit-types';
import { clusterResourceRates, type ClusterResourceRates } from './instance-pricing';
import { listClusterInstanceTypes } from './k8s-client';
import { getClusterResourceRates } from './resource-audit-rates';

async function getClusterRates(
  cluster: string,
  cache: Map<string, ClusterResourceRates>
): Promise<ClusterResourceRates> {
  const cached = cache.get(cluster);
  if (cached) return cached;
  try {
    const instances = await listClusterInstanceTypes(cluster);
    const rates = clusterResourceRates(
      instances.map((row) => ({
        instanceType: row.instanceType,
        capacityType: row.capacityType,
        count: row.count,
      }))
    );
    cache.set(cluster, rates);
    return rates;
  } catch {
    const fallback = {
      cpuHourlyPerCore: Number(process.env.COST_CPU_PER_VCORE_HOUR) || 0.0464,
      memHourlyPerGb: Number(process.env.COST_MEM_PER_GB_HOUR) || 0.0058,
    };
    cache.set(cluster, fallback);
    return fallback;
  }
}

/** Remove routine-sync app-up rows; keep only the earliest per application. */
export async function purgeSpuriousAppUpRows(): Promise<number> {
  const gitSyncs = await prisma.resourceChangeAudit.findMany({
    where: { resourceType: 'GIT_SYNC' },
    orderBy: { syncedAt: 'asc' },
    select: { id: true, argocdApp: true },
  });

  const keepFirst = new Set<string>();
  let deleted = 0;
  for (const row of gitSyncs) {
    if (!keepFirst.has(row.argocdApp)) {
      keepFirst.add(row.argocdApp);
      continue;
    }
    await prisma.resourceChangeAudit.delete({ where: { id: row.id } });
    deleted += 1;
  }
  return deleted;
}

/** Drop legacy duplicate audit rows when a git values-path row exists for the same change. */
export async function scrubDuplicateLegacyAuditRows(): Promise<number> {
  const rows = await prisma.resourceChangeAudit.findMany({
    where: { resourceType: { not: 'GIT_SYNC' } },
    select: {
      id: true,
      revisionSha: true,
      cluster: true,
      namespace: true,
      workload: true,
      containerName: true,
      resourceType: true,
      oldValue: true,
      newValue: true,
    },
    orderBy: { syncedAt: 'desc' },
  });

  const canonical = new Set<string>();
  for (const row of rows) {
    if (valuesFilePathFromRow(row)) {
      canonical.add(
        `${row.revisionSha}::${row.cluster}::${row.namespace}::${row.containerName}::${row.resourceType}::${row.oldValue}::${row.newValue}`
      );
    }
  }

  let deleted = 0;
  for (const row of rows) {
    if (valuesFilePathFromRow(row)) continue;
    const key = `${row.revisionSha}::${row.cluster}::${row.namespace}::${row.containerName}::${row.resourceType}::${row.oldValue}::${row.newValue}`;
    if (canonical.has(key)) {
      await prisma.resourceChangeAudit.delete({ where: { id: row.id } });
      deleted += 1;
    }
  }

  return deleted;
}

/** Clear app-up rows so backfill can recreate with first-deploy detection. */
export async function resetAppUpRowsForRebackfill(): Promise<number> {
  const deleted = await prisma.resourceChangeAudit.deleteMany({
    where: { resourceType: 'GIT_SYNC' },
  });
  return deleted.count;
}

/** True when legacy logic created multiple app-up rows per application. */
export async function needsAppUpV2Migration(): Promise<boolean> {
  const grouped = await prisma.resourceChangeAudit.groupBy({
    by: ['argocdApp'],
    where: { resourceType: 'GIT_SYNC' },
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } },
  });
  return grouped.length > 0;
}

/** Remove app-up rows when the same revision also has resource field changes. */
export async function dedupeAppUpWithResourceChanges(): Promise<number> {
  const gitSyncs = await prisma.resourceChangeAudit.findMany({
    where: { resourceType: 'GIT_SYNC' },
    select: { id: true, argocdApp: true, revisionSha: true },
  });

  let deleted = 0;
  for (const row of gitSyncs) {
    const hasResourceChange = await prisma.resourceChangeAudit.findFirst({
      where: {
        argocdApp: row.argocdApp,
        revisionSha: row.revisionSha,
        resourceType: { not: 'GIT_SYNC' },
      },
      select: { id: true },
    });
    if (hasResourceChange) {
      await prisma.resourceChangeAudit.delete({ where: { id: row.id } });
      deleted += 1;
    }
  }
  return deleted;
}

/** Wipe audit rows when catalog is full but history was never backfilled. */
export async function needsFullHistoryBackfill(): Promise<boolean> {
  const [auditCount, catalogCount] = await Promise.all([
    prisma.resourceChangeAudit.count(),
    prisma.resourceAppCatalog.count(),
  ]);
  return catalogCount > 50 && auditCount < 200;
}

export async function resetResourceAuditForFullBackfill(): Promise<number> {
  const deleted = await prisma.resourceChangeAudit.deleteMany({});
  return deleted.count;
}

/** Delete resource rows recorded with missing prior values so backfill can recreate them. */
export async function resetInvalidResourceDiffRows(): Promise<number> {
  const deleted = await prisma.resourceChangeAudit.deleteMany({
    where: {
      resourceType: { not: 'GIT_SYNC' },
      oldValue: 'none',
    },
  });
  return deleted.count;
}

/** Recompute running cost and clean old/new for existing app-up rows. */
export async function recomputeAppUpRunningCosts(): Promise<number> {
  const ratesCache = new Map<string, ClusterResourceRates>();
  const gitSyncs = await prisma.resourceChangeAudit.findMany({
    where: {
      resourceType: 'GIT_SYNC',
      estimatedCostImpactPerDay: { not: null },
    },
    select: { id: true, argocdApp: true, cluster: true, namespace: true },
  });

  let updated = 0;
  for (const row of gitSyncs) {
    const snapshots = await prisma.resourceSnapshot.findMany({
      where: { argocdApp: row.argocdApp, namespace: row.namespace },
    });

    const snaps: ResourceFieldSnapshot[] = snapshots.map((s) => ({
      argocdApp: s.argocdApp,
      namespace: s.namespace,
      workload: s.workload,
      containerName: s.containerName,
      resourceType: s.resourceType as ResourceFieldSnapshot['resourceType'],
      value: s.value,
    }));

    const rates = await getClusterRates(row.cluster, ratesCache);
    const runningCost = estimateRunningCostFromSnapshots(snaps, rates);
    const podCount = snaps
      .filter((s) => s.resourceType === 'REPLICAS')
      .reduce((sum, s) => sum + (parseInt(s.value, 10) || 0), 0);

    await prisma.resourceChangeAudit.update({
      where: { id: row.id },
      data: {
        oldValue: '—',
        newValue: '—',
        podCount: podCount > 0 ? podCount : undefined,
        estimatedCostImpactPerDay: runningCost > 0 ? runningCost : null,
      },
    });
    updated += 1;
  }
  return updated;
}

async function resolveReplicaCountForAuditRow(row: {
  revisionSha: string;
  workload: string;
  podCount: number | null;
  resourceType: string;
  oldValue: string;
  newValue: string;
}): Promise<number> {
  if (row.resourceType === 'REPLICAS') {
    return parseReplicaCountValue(row.newValue) ?? parseReplicaCountValue(row.oldValue) ?? 1;
  }

  const filePath = valuesFilePathFromRow(row);
  if (filePath) {
    const replicaRow = await prisma.gitResourceChange.findFirst({
      where: {
        commitSha: row.revisionSha,
        filePath,
        resourceType: 'REPLICAS',
      },
      select: { newValue: true, oldValue: true },
      orderBy: { pulledAt: 'desc' },
    });
    if (replicaRow) {
      const fromGit =
        parseReplicaCountValue(replicaRow.newValue) ??
        parseReplicaCountValue(replicaRow.oldValue);
      if (fromGit) return fromGit;
    }
  }

  if (row.podCount != null && row.podCount > 0) return row.podCount;
  return 1;
}

/** Recompute stored cost using request-only billing and helm replica counts. */
export async function recomputeResourceAuditCostEstimates(): Promise<number> {
  const rows = await prisma.resourceChangeAudit.findMany({
    where: { resourceType: { not: 'GIT_SYNC' } },
    select: {
      id: true,
      cluster: true,
      resourceType: true,
      oldValue: true,
      newValue: true,
      revisionSha: true,
      workload: true,
      podCount: true,
      estimatedCostImpactPerDay: true,
    },
  });

  const ratesCache = new Map<string, ClusterResourceRates>();
  let updated = 0;

  for (const row of rows) {
    const resourceType = row.resourceType as ResourceAuditType;
    const rates = await getClusterResourceRates(row.cluster, ratesCache);
    let nextCost: number | null = null;

    if (isBillableResourceType(resourceType)) {
      const replicas = await resolveReplicaCountForAuditRow(row);
      nextCost = estimateCostDelta(
        resourceType,
        row.oldValue,
        row.newValue,
        replicas,
        rates
      );
    }

    const prev =
      row.estimatedCostImpactPerDay != null ? Number(row.estimatedCostImpactPerDay) : null;
    const changed =
      (prev == null && nextCost != null) ||
      (prev != null && nextCost == null) ||
      (prev != null && nextCost != null && Math.abs(prev - nextCost) > 0.0001);

    if (!changed) continue;

    await prisma.resourceChangeAudit.update({
      where: { id: row.id },
      data: { estimatedCostImpactPerDay: nextCost },
    });
    updated += 1;
  }

  return updated;
}
