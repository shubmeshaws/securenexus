import prisma from './prisma';
import type { Prisma } from '@prisma/client';
import type { ResourceAuditType } from './resource-audit-types';
import { RESOURCE_AUDIT_TYPES } from './resource-audit-types';
import { groupResourceAuditRows, sumGroupedRowsCostImpact, type ResourceAuditRowBase } from './resource-audit-grouping';
import { isResourceIncrease } from './resource-audit-display';
import {
  expandClusterFilterValues,
  getRegisteredClusterNames,
} from './resource-audit-cluster';
import {
  clampAuditFromDate,
  getResourceAuditDataWindow,
  type ResourceAuditDataWindow,
} from './resource-audit-retention';
import {
  getCatalogAppsForClusterNamespace,
  getSnapshotAppsForNamespace,
} from './resource-app-catalog';

export const RESOURCE_AUDIT_DEFAULT_DAYS = 30;

export interface ResourceAuditFilters {
  cluster?: string;
  namespace?: string;
  argocdApp?: string;
  environment?: string;
  author?: string;
  fromDate?: Date;
  toDate?: Date;
  resourceTypes?: ResourceAuditType[];
  page?: number;
  pageSize?: number;
}

/** Match audit rows by ArgoCD destination namespace OR apps deployed into the selected namespace. */
async function resolveNamespaceScope(
  filters: Pick<ResourceAuditFilters, 'cluster' | 'namespace'>
): Promise<Prisma.ResourceChangeAuditWhereInput | null> {
  if (!filters.namespace) return null;

  const or: Prisma.ResourceChangeAuditWhereInput[] = [
    { namespace: filters.namespace },
  ];

  let clusterFilter: Prisma.ResourceChangeAuditWhereInput['cluster'] | undefined;
  if (filters.cluster) {
    const clusterValues = await expandClusterFilterValues(filters.cluster);
    clusterFilter =
      clusterValues.length === 1 ? clusterValues[0] : { in: clusterValues };
  }

  const [catalogApps, snapApps] = await Promise.all([
    filters.cluster
      ? getCatalogAppsForClusterNamespace(filters.cluster, filters.namespace)
      : Promise.resolve([]),
    getSnapshotAppsForNamespace(filters.namespace),
  ]);

  const appNames = Array.from(new Set([...catalogApps, ...snapApps]));
  if (appNames.length) {
    or.push({
      argocdApp: { in: appNames },
      ...(clusterFilter ? { cluster: clusterFilter } : {}),
    });
  }

  return { OR: or };
}

function serializeAuditRow(
  row: Awaited<
    ReturnType<typeof prisma.resourceChangeAudit.findMany>
  >[number]
): ResourceAuditRowBase {
  return {
    id: row.id,
    argocdApp: row.argocdApp,
    cluster: row.cluster,
    environment: row.environment,
    namespace: row.namespace,
    workload: row.workload,
    containerName: row.containerName,
    resourceType: row.resourceType as ResourceAuditType,
    oldValue: row.oldValue,
    newValue: row.newValue,
    revisionSha: row.revisionSha,
    branchName: row.branchName,
    podCount: row.podCount,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    commitMessage: row.commitMessage,
    syncedAt: row.syncedAt.toISOString(),
    estimatedCostImpactPerDay:
      row.estimatedCostImpactPerDay != null ? Number(row.estimatedCostImpactPerDay) : null,
  };
}

async function fetchGroupedResourceAuditRows(
  filters: ResourceAuditFilters
): Promise<ResourceAuditRowBase[]> {
  const where = await buildResourceAuditWhere(filters);
  const rawRows = await prisma.resourceChangeAudit.findMany({
    where,
    orderBy: { syncedAt: 'desc' },
    take: 10_000,
  });
  return groupResourceAuditRows(rawRows.map(serializeAuditRow));
}

function authorIdentityKey(row: Pick<ResourceAuditRowBase, 'authorName' | 'authorEmail'>): string {
  return row.authorEmail?.trim().toLowerCase() || row.authorName.trim();
}

function computeTopContributorFromGroupedRows(rows: ResourceAuditRowBase[]) {
  type AuthorStats = {
    authorName: string;
    authorEmail: string | null;
    commitShas: Set<string>;
    resourceIncreases: number;
    resourceChanges: number;
    totalCostImpact: number;
    podsAdded: number;
    podsRemoved: number;
  };

  const byAuthor = new Map<string, AuthorStats>();

  for (const row of rows) {
    if (row.resourceType === 'GIT_SYNC') continue;

    const key = authorIdentityKey(row);
    let stats = byAuthor.get(key);
    if (!stats) {
      stats = {
        authorName: row.authorName,
        authorEmail: row.authorEmail,
        commitShas: new Set<string>(),
        resourceIncreases: 0,
        resourceChanges: 0,
        totalCostImpact: 0,
        podsAdded: 0,
        podsRemoved: 0,
      };
      byAuthor.set(key, stats);
    }

    if (row.revisionSha?.trim()) {
      stats.commitShas.add(row.revisionSha.trim());
    }

    stats.resourceChanges += 1;
    if (row.estimatedCostImpactPerDay != null) {
      stats.totalCostImpact += Number(row.estimatedCostImpactPerDay);
    }

    const changes = row.changes?.length
      ? row.changes
      : [
          {
            resourceType: row.resourceType,
            oldValue: row.oldValue,
            newValue: row.newValue,
            estimatedCostImpactPerDay: row.estimatedCostImpactPerDay,
          },
        ];

    for (const change of changes) {
      if (isResourceIncrease(change.resourceType, change.oldValue, change.newValue)) {
        stats.resourceIncreases += 1;
      }
      if (change.resourceType === 'REPLICAS') {
        const oldR = parseInt(change.oldValue, 10) || 0;
        const newR = parseInt(change.newValue, 10) || 0;
        const delta = newR - oldR;
        if (delta > 0) stats.podsAdded += delta;
        else if (delta < 0) stats.podsRemoved += Math.abs(delta);
      }
    }
  }

  const ranked = Array.from(byAuthor.values()).sort((a, b) => {
    const commitsA = a.commitShas.size;
    const commitsB = b.commitShas.size;
    if (commitsB !== commitsA) return commitsB - commitsA;
    if (b.resourceIncreases !== a.resourceIncreases) {
      return b.resourceIncreases - a.resourceIncreases;
    }
    return b.resourceChanges - a.resourceChanges;
  });

  return ranked[0] ?? null;
}

export async function buildResourceAuditWhere(
  filters: ResourceAuditFilters
): Promise<Prisma.ResourceChangeAuditWhereInput> {
  const where: Prisma.ResourceChangeAuditWhereInput = {
    resourceType: { not: 'GIT_SYNC' },
  };

  const { dataAvailableFrom } = await getResourceAuditDataWindow();
  const effectiveFrom = clampAuditFromDate(filters.fromDate, dataAvailableFrom);

  where.syncedAt = { gte: effectiveFrom };
  if (filters.toDate) {
    where.syncedAt.lte = filters.toDate;
  }

  if (filters.cluster) {
    const clusterValues = await expandClusterFilterValues(filters.cluster);
    where.cluster = clusterValues.length === 1 ? clusterValues[0] : { in: clusterValues };
  }
  if (filters.argocdApp) where.argocdApp = filters.argocdApp;
  if (filters.environment) where.environment = filters.environment;
  if (filters.author) where.authorName = filters.author;
  if (filters.resourceTypes !== undefined) {
    if (filters.resourceTypes.length === 0) {
      where.resourceType = { in: [] };
    } else {
      where.resourceType = { in: filters.resourceTypes };
    }
  }

  const namespaceScope = await resolveNamespaceScope(filters);
  if (namespaceScope) {
    const existingAnd = Array.isArray(where.AND)
      ? where.AND
      : where.AND
        ? [where.AND]
        : [];
    where.AND = [...existingAnd, namespaceScope];
  }

  return where;
}

export function defaultAuditFromDate(): Date {
  return new Date(Date.now() - RESOURCE_AUDIT_DEFAULT_DAYS * 24 * 60 * 60 * 1000);
}

export function withDefaultDateRange(filters: ResourceAuditFilters): ResourceAuditFilters {
  return {
    ...filters,
    fromDate: filters.fromDate ?? defaultAuditFromDate(),
    toDate: filters.toDate ?? new Date(),
  };
}

export async function queryResourceAudit(filters: ResourceAuditFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, filters.pageSize ?? 10));

  const grouped = await fetchGroupedResourceAuditRows(filters);
  const total = grouped.length;
  const rows = grouped.slice((page - 1) * pageSize, page * pageSize);

  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    totalCostImpact: sumGroupedRowsCostImpact(grouped),
  };
}

export async function getResourceAuditSummary(filters: ResourceAuditFilters = {}) {
  const [grouped, dataWindow] = await Promise.all([
    fetchGroupedResourceAuditRows(filters),
    getResourceAuditDataWindow(),
  ]);

  const top = computeTopContributorFromGroupedRows(grouped);

  let podsAddedTotal = 0;
  let podsRemovedTotal = 0;
  for (const row of grouped) {
    const changes = row.changes?.length
      ? row.changes
      : [{ resourceType: row.resourceType, oldValue: row.oldValue, newValue: row.newValue }];
    for (const change of changes) {
      if (change.resourceType !== 'REPLICAS') continue;
      const oldR = parseInt(change.oldValue, 10) || 0;
      const newR = parseInt(change.newValue, 10) || 0;
      const delta = newR - oldR;
      if (delta > 0) podsAddedTotal += delta;
      else if (delta < 0) podsRemovedTotal += Math.abs(delta);
    }
  }

  const totalChanges = grouped.length;

  return {
    totalCostImpact: sumGroupedRowsCostImpact(grouped),
    totalChanges,
    gitSyncCount: 0,
    resourceChangeCount: totalChanges,
    podsAddedTotal,
    podsRemovedTotal,
    dataWindow: serializeResourceAuditDataWindow(dataWindow),
    topContributor: top
      ? {
          authorName: top.authorName,
          authorEmail: top.authorEmail,
          commits: top.commitShas.size,
          resourceIncreases: top.resourceIncreases,
          totalCostImpact: top.totalCostImpact,
          gitSyncs: 0,
          resourceChanges: top.resourceChanges,
          podsAdded: top.podsAdded,
          podsRemoved: top.podsRemoved,
        }
      : null,
  };
}

export async function getResourceAuditFilterOptions(filters: ResourceAuditFilters = {}) {
  const { dataAvailableFrom } = await getResourceAuditDataWindow();
  const effectiveFrom = clampAuditFromDate(filters.fromDate, dataAvailableFrom);

  const optionWhere: Prisma.ResourceChangeAuditWhereInput = {
    resourceType: { not: 'GIT_SYNC' },
    syncedAt: filters.toDate
      ? { gte: effectiveFrom, lte: filters.toDate }
      : { gte: effectiveFrom },
  };
  if (filters.resourceTypes?.length) {
    optionWhere.resourceType = { in: filters.resourceTypes };
  }

  const [clusters, namespaces, applications, authors, registeredNames] = await Promise.all([
    prisma.resourceChangeAudit.findMany({
      where: optionWhere,
      distinct: ['cluster'],
      select: { cluster: true },
      orderBy: { cluster: 'asc' },
    }),
    prisma.resourceChangeAudit.findMany({
      where: optionWhere,
      distinct: ['namespace'],
      select: { namespace: true },
      orderBy: { namespace: 'asc' },
    }),
    prisma.resourceChangeAudit.findMany({
      where: optionWhere,
      distinct: ['argocdApp'],
      select: { argocdApp: true },
      orderBy: { argocdApp: 'asc' },
    }),
    prisma.resourceChangeAudit.findMany({
      where: optionWhere,
      distinct: ['authorName'],
      select: { authorName: true, authorEmail: true },
      orderBy: { authorName: 'asc' },
      take: 200,
    }),
    getRegisteredClusterNames(),
  ]);

  const clusterSet = new Set<string>([
    ...registeredNames,
    ...clusters.map((r) => r.cluster).filter(Boolean),
  ]);

  return {
    clusters: Array.from(clusterSet).sort(),
    namespaces: namespaces.map((r) => r.namespace).filter(Boolean).sort(),
    applications: applications.map((r) => r.argocdApp).filter(Boolean).sort(),
    authors: authors
      .filter((r) => r.authorName)
      .map((r) => ({
        name: r.authorName,
        email: r.authorEmail,
      })),
    resourceTypes: [...RESOURCE_AUDIT_TYPES],
    dataWindow: serializeResourceAuditDataWindow(await getResourceAuditDataWindow()),
  };
}

export function serializeResourceAuditDataWindow(window: ResourceAuditDataWindow) {
  return {
    dataAvailableFrom: window.dataAvailableFromIso,
    dataAvailableFromLabel: window.dataAvailableFromLabel,
    retentionLabel: window.retentionLabel,
    dataStartDate: window.dataStartDate,
    retentionAmount: window.retentionAmount,
    retentionUnit: window.retentionUnit,
  };
}

export async function exportResourceAuditRows(filters: ResourceAuditFilters) {
  const where = await buildResourceAuditWhere(filters);
  return prisma.resourceChangeAudit.findMany({
    where,
    orderBy: { syncedAt: 'desc' },
    take: 10_000,
  });
}
