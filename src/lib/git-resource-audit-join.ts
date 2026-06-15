import prisma from './prisma';
import { processNewCommitsForRepo, changedFilesForCommit, processCommitsForRepo, listCommitsSince } from './git-resource-diff';
import { persistResourceChanges, estimateCostDelta, parseReplicaCountValue } from './resource-audit-diff';
import type { ResourceChangeInput } from './resource-audit-types';
import { REPLICAS_CONTAINER_MARKER } from './resource-audit-types';
import { findAppSourcesForGitFile } from './git-app-source-match';
import {
  appBelongsToAnyHelmEnv,
  helmEnvsFromChangedFiles,
  inferAppFromHelmValuesPath,
} from './helm-values-path';
import { resolveAuditClusterName } from './resource-audit-cluster';
import { fetchLivePodCount } from './resource-audit-kubectl';
import { getClusterResourceRates } from './resource-audit-rates';
import { recomputeResourceAuditCostEstimates } from './resource-audit-maintenance';
import type { ClusterResourceRates } from './instance-pricing';

function isEmptyResourceValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return !v || v === 'none' || v === '(none)' || v === '—';
}

function normalizeStoredValue(value: string): string {
  return isEmptyResourceValue(value) ? '—' : value;
}

function replicaCountFromChange(change: {
  resourceType: string;
  newValue: string;
  oldValue: string;
}): number {
  if (change.resourceType === 'REPLICAS') {
    return parseReplicaCountValue(change.newValue) ?? parseReplicaCountValue(change.oldValue) ?? 1;
  }
  return 1;
}

function buildReplicaCountMap(
  rows: Array<{ commitSha: string; filePath: string; resourceType: string; newValue: string; oldValue: string }>
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.resourceType !== 'REPLICAS') continue;
    const count =
      parseReplicaCountValue(row.newValue) ?? parseReplicaCountValue(row.oldValue);
    if (count) map.set(`${row.commitSha}::${row.filePath}`, count);
  }
  return map;
}

async function loadReplicaCountMapForCommits(
  gitRepositoryId: string,
  commitShas: string[]
): Promise<Map<string, number>> {
  if (!commitShas.length) return new Map();
  const rows = await prisma.gitResourceChange.findMany({
    where: {
      gitRepositoryId,
      commitSha: { in: commitShas },
      resourceType: 'REPLICAS',
    },
    select: { commitSha: true, filePath: true, resourceType: true, newValue: true, oldValue: true },
  });
  return buildReplicaCountMap(rows);
}

function resolveReplicaCountForCost(input: {
  change: { commitSha: string; filePath: string; resourceType: string; newValue: string; oldValue: string };
  replicaMap: Map<string, number>;
  livePodCount: number | null;
}): number {
  if (input.change.resourceType === 'REPLICAS') {
    return replicaCountFromChange(input.change);
  }
  const fromGit = input.replicaMap.get(`${input.change.commitSha}::${input.change.filePath}`);
  if (fromGit) return fromGit;
  if (input.livePodCount != null && input.livePodCount > 0) return input.livePodCount;
  return 1;
}

function estimateChangeCost(
  change: {
    resourceType: string;
    oldValue: string;
    newValue: string;
  },
  replicaCount: number,
  rates: ClusterResourceRates
): number | null {
  const oldVal = isEmptyResourceValue(change.oldValue) ? '0' : change.oldValue;
  const newVal = isEmptyResourceValue(change.newValue) ? '0' : change.newValue;
  return estimateCostDelta(
    change.resourceType as ResourceChangeInput['resourceType'],
    oldVal,
    newVal,
    replicaCount,
    rates
  );
}

export async function linkGitChangesToResourceAudit(gitRepositoryId?: string): Promise<number> {
  const changes = await prisma.gitResourceChange.findMany({
    where: {
      auditLinked: false,
      ...(gitRepositoryId ? { gitRepositoryId } : {}),
    },
    include: {
      gitRepository: true,
    },
    orderBy: { committedAt: 'asc' },
    take: 5000,
  });

  if (!changes.length) return 0;

  const ratesCache = new Map<string, ClusterResourceRates>();
  const replicaMaps = new Map<string, Map<string, number>>();

  const toPersist: ResourceChangeInput[] = [];
  const linkedIds: string[] = [];

  for (const change of changes) {
    if (change.resourceType === 'FILE_TOUCH') {
      linkedIds.push(change.id);
      continue;
    }
    if (isEmptyResourceValue(change.oldValue) && isEmptyResourceValue(change.newValue)) {
      linkedIds.push(change.id);
      continue;
    }
    if (isEmptyResourceValue(change.oldValue) && !isEmptyResourceValue(change.newValue)) {
      linkedIds.push(change.id);
      continue;
    }

    const inferred = inferAppFromHelmValuesPath(change.filePath);
    if (!inferred) continue;

    const envFromFile = inferred.env;
    const namespace = inferred.namespace;
    const cluster = await resolveAuditClusterName({
      filePath: change.filePath,
      branch: change.branchName,
    });

    const oldValue = normalizeStoredValue(change.oldValue);
    const newValue = normalizeStoredValue(change.newValue);
    const valuesFilePath = inferred.filePath;

    const exists = await prisma.resourceChangeAudit.findFirst({
      where: {
        revisionSha: change.commitSha,
        cluster,
        namespace,
        resourceType: change.resourceType,
        containerName: change.containerName,
        oldValue,
        newValue,
      },
    });
    if (exists) {
      if (!linkedIds.includes(change.id)) linkedIds.push(change.id);
      continue;
    }

    const rates = await getClusterResourceRates(cluster, ratesCache);

    let replicaMap = replicaMaps.get(change.gitRepositoryId);
    if (!replicaMap) {
      replicaMap = await loadReplicaCountMapForCommits(
        change.gitRepositoryId,
        Array.from(
          new Set(
            changes
              .filter((c) => c.gitRepositoryId === change.gitRepositoryId)
              .map((c) => c.commitSha)
          )
        )
      );
      replicaMaps.set(change.gitRepositoryId, replicaMap);
    }

    let podCount: number | null = null;
    if (change.resourceType === 'REPLICAS' && change.containerName === REPLICAS_CONTAINER_MARKER) {
      podCount = replicaCountFromChange(change);
    } else {
      podCount = await fetchLivePodCount(
        cluster,
        namespace,
        inferred.argocdApp,
        inferred.legacyDeploymentName
      );
    }

    const replicaCount = resolveReplicaCountForCost({
      change,
      replicaMap,
      livePodCount: podCount,
    });

    toPersist.push({
      argocdApp: inferred.argocdApp,
      cluster,
      environment: envFromFile.toUpperCase(),
      namespace,
      workload: valuesFilePath,
      containerName: change.containerName,
      resourceType: change.resourceType as ResourceChangeInput['resourceType'],
      oldValue,
      newValue,
      revisionSha: change.commitSha,
      branchName: change.branchName,
      podCount,
      authorName: change.authorName ?? 'unknown',
      authorEmail: change.authorEmail ?? null,
      commitMessage: change.commitMessage ?? null,
      syncedAt: change.committedAt,
      estimatedCostImpactPerDay: estimateChangeCost(change, replicaCount, rates),
    });
    if (!linkedIds.includes(change.id)) linkedIds.push(change.id);
  }

  if (toPersist.length) {
    await persistResourceChanges(toPersist);
  }

  if (linkedIds.length) {
    await prisma.gitResourceChange.updateMany({
      where: { id: { in: linkedIds } },
      data: { auditLinked: true },
    });
  }

  return toPersist.length;
}

/** Skip GIT_SYNC when git analysis shows the commit did not touch this app's values files. */
export async function shouldRecordGitSyncForApp(
  argocdApp: string,
  revisionSha: string
): Promise<boolean> {
  const source = await prisma.argoCDAppSource.findUnique({ where: { argocdApp } });
  if (!source?.gitRepositoryId) return true;

  const shaPrefix = revisionSha.slice(0, 7);
  const gitChanges = await prisma.gitResourceChange.findMany({
    where: {
      gitRepositoryId: source.gitRepositoryId,
      OR: [{ commitSha: revisionSha }, { commitSha: { startsWith: shaPrefix } }],
    },
    select: { filePath: true },
    distinct: ['filePath'],
  });

  if (!gitChanges.length) return true;

  const envs = helmEnvsFromChangedFiles(gitChanges.map((row) => row.filePath));
  if (!envs.size) return true;

  return appBelongsToAnyHelmEnv(
    {
      namespace: source.namespace,
      helmValueFiles: source.helmValueFiles,
      argocdApp: source.argocdApp,
    },
    envs
  );
}

/** Delete GIT_SYNC rows for apps outside the env folders changed in a commit. */
export async function scrubGitSyncByCommitFiles(input: {
  commitSha: string;
  changedFiles: string[];
}): Promise<number> {
  const envs = helmEnvsFromChangedFiles(input.changedFiles);
  if (!envs.size) return 0;

  const shaPrefix = input.commitSha.slice(0, 7);
  const gitSyncRows = await prisma.resourceChangeAudit.findMany({
    where: {
      resourceType: 'GIT_SYNC',
      OR: [{ revisionSha: input.commitSha }, { revisionSha: { startsWith: shaPrefix } }],
    },
    select: { id: true, argocdApp: true },
  });

  if (!gitSyncRows.length) return 0;

  const appSources = await prisma.argoCDAppSource.findMany();
  const sourceByApp = new Map(appSources.map((row) => [row.argocdApp, row]));
  const toDelete = gitSyncRows
    .filter((row) => {
      const source = sourceByApp.get(row.argocdApp);
      if (!source) return true;
      return !appBelongsToAnyHelmEnv(
        {
          namespace: source.namespace,
          helmValueFiles: source.helmValueFiles,
          argocdApp: source.argocdApp,
        },
        envs
      );
    })
    .map((row) => row.id);

  if (!toDelete.length) return 0;
  const result = await prisma.resourceChangeAudit.deleteMany({
    where: { id: { in: toDelete } },
  });
  return result.count;
}

/** Remove GIT_SYNC rows for apps that did not own files changed in analyzed commits. */
export async function cleanupGitSyncForAnalyzedCommits(
  commitShas: string[],
  gitRepositoryId?: string
): Promise<number> {
  if (!commitShas.length) return 0;

  const appSources = await prisma.argoCDAppSource.findMany();
  let deleted = 0;

  for (const sha of commitShas) {
    const shaPrefix = sha.slice(0, 7);
    const changes = await prisma.gitResourceChange.findMany({
      where: {
        ...(gitRepositoryId ? { gitRepositoryId } : {}),
        OR: [{ commitSha: sha }, { commitSha: { startsWith: shaPrefix } }],
      },
      select: { filePath: true, gitRepositoryId: true },
      distinct: ['filePath', 'gitRepositoryId'],
    });

    const affectedApps = new Set<string>();
    for (const change of changes) {
      const matches = findAppSourcesForGitFile(
        change.filePath,
        change.gitRepositoryId,
        appSources
      );
      for (const match of matches) {
        affectedApps.add(match.argocdApp);
      }
      const inferred = inferAppFromHelmValuesPath(change.filePath);
      if (inferred) affectedApps.add(inferred.argocdApp);
    }

    const gitSyncRows = await prisma.resourceChangeAudit.findMany({
      where: {
        resourceType: 'GIT_SYNC',
        OR: [{ revisionSha: sha }, { revisionSha: { startsWith: shaPrefix } }],
      },
      select: { id: true, argocdApp: true },
    });

    const toDelete = gitSyncRows
      .filter((row) => {
        if (!changes.length) return true;
        return !affectedApps.has(row.argocdApp);
      })
      .map((row) => row.id);

    if (toDelete.length) {
      const result = await prisma.resourceChangeAudit.deleteMany({
        where: { id: { in: toDelete } },
      });
      deleted += result.count;
    }

    // Apps with resource changes from git should not also show GIT_SYNC.
    if (affectedApps.size) {
      const result = await prisma.resourceChangeAudit.deleteMany({
        where: {
          resourceType: 'GIT_SYNC',
          OR: [{ revisionSha: sha }, { revisionSha: { startsWith: shaPrefix } }],
          argocdApp: { in: Array.from(affectedApps) },
        },
      });
      deleted += result.count;
    }
  }

  return deleted;
}

export async function runGitPullResourceAnalysis(input: {
  repoId: string;
  clonePath: string;
  branch: string;
  previousSha: string | null;
  headSha: string;
  bootstrap?: boolean;
}): Promise<{ changesStored: number; auditRowsLinked: number; gitSyncRemoved: number }> {
  const { stored, commitShas } = await processNewCommitsForRepo({
    repoId: input.repoId,
    repoPath: input.clonePath,
    branch: input.branch,
    previousSha: input.previousSha,
    currentSha: input.headSha,
    bootstrap: input.bootstrap,
  });

  if (commitShas.length) {
    await prisma.resourceChangeAudit.deleteMany({
      where: {
        resourceType: { not: 'GIT_SYNC' },
        OR: commitShas.flatMap((sha) => [
          { revisionSha: sha },
          { revisionSha: { startsWith: sha.slice(0, 7) } },
        ]),
      },
    });
    await prisma.gitResourceChange.updateMany({
      where: { gitRepositoryId: input.repoId, commitSha: { in: commitShas } },
      data: { auditLinked: false },
    });
  }

  const auditRowsLinked = await linkGitChangesToResourceAudit(input.repoId);

  let gitSyncRemoved = 0;
  for (const sha of commitShas) {
    const files = await changedFilesForCommit(input.clonePath, sha);
    gitSyncRemoved += await scrubGitSyncByCommitFiles({ commitSha: sha, changedFiles: files });
  }
  gitSyncRemoved += await cleanupGitSyncForAnalyzedCommits(
    commitShas,
    input.repoId
  );

  return { changesStored: stored, auditRowsLinked, gitSyncRemoved };
}

export async function joinGitChangesWithArgoSync(
  argocdApp: string,
  revisionSha: string
): Promise<number> {
  const source = await prisma.argoCDAppSource.findUnique({ where: { argocdApp } });
  if (!source?.gitRepositoryId) return 0;

  const changes = await prisma.gitResourceChange.findMany({
    where: {
      gitRepositoryId: source.gitRepositoryId,
      commitSha: { startsWith: revisionSha.slice(0, 7) },
      auditLinked: false,
    },
  });

  if (!changes.length) {
    const fullMatch = await prisma.gitResourceChange.findMany({
      where: {
        gitRepositoryId: source.gitRepositoryId,
        commitSha: revisionSha,
        auditLinked: false,
      },
    });
    if (!fullMatch.length) return linkGitChangesToResourceAudit();
    return linkGitChangesToResourceAudit(source.gitRepositoryId);
  }

  return linkGitChangesToResourceAudit(source.gitRepositoryId);
}

/** Remove git-sourced audit rows and re-link from gitResourceChange with cost. */
export async function refreshGitResourceAuditRows(): Promise<{
  deleted: number;
  linked: number;
  gitSyncRemoved: number;
}> {
  const gitShas = await prisma.gitResourceChange.findMany({
    select: { commitSha: true },
    distinct: ['commitSha'],
  });
  const shaList = gitShas.map((row) => row.commitSha);

  const deleted =
    shaList.length > 0
      ? await prisma.resourceChangeAudit.deleteMany({
          where: {
            resourceType: { not: 'GIT_SYNC' },
            revisionSha: { in: shaList },
          },
        })
      : { count: 0 };

  await prisma.gitResourceChange.updateMany({
    data: { auditLinked: false },
  });

  const linked = await linkGitChangesToResourceAudit();
  const gitSyncRemoved = await cleanupGitSyncForAnalyzedCommits(shaList);
  await recomputeResourceAuditCostEstimates();

  return { deleted: deleted.count, linked, gitSyncRemoved };
}

/** Re-process recent helm-charts commits (path-inferred apps, scrub unrelated GIT_SYNC). */
export async function reanalyzeRecentHelmCommits(input: {
  repoId: string;
  clonePath: string;
  branch: string | null;
  headSha: string;
  limit?: number;
}): Promise<{ changesStored: number; auditRowsLinked: number; gitSyncRemoved: number }> {
  const commits = await listCommitsSince(
    input.clonePath,
    input.branch,
    null,
    input.headSha,
    { bootstrap: true }
  );
  const limited = commits.slice(-(input.limit ?? 50));
  const commitShas = limited.map((c) => c.sha);

  if (commitShas.length) {
    await prisma.resourceChangeAudit.deleteMany({
      where: {
        resourceType: { not: 'GIT_SYNC' },
        OR: commitShas.flatMap((sha) => [
          { revisionSha: sha },
          { revisionSha: { startsWith: sha.slice(0, 7) } },
        ]),
      },
    });
    await prisma.gitResourceChange.updateMany({
      where: { gitRepositoryId: input.repoId, commitSha: { in: commitShas } },
      data: { auditLinked: false },
    });
  }

  const { stored } = await processCommitsForRepo({
    repoId: input.repoId,
    repoPath: input.clonePath,
    branch: input.branch,
    commits: limited,
  });

  const auditRowsLinked = await linkGitChangesToResourceAudit(input.repoId);

  let gitSyncRemoved = 0;
  for (const sha of commitShas) {
    const files = await changedFilesForCommit(input.clonePath, sha);
    gitSyncRemoved += await scrubGitSyncByCommitFiles({ commitSha: sha, changedFiles: files });
  }
  gitSyncRemoved += await cleanupGitSyncForAnalyzedCommits(commitShas, input.repoId);

  return { changesStored: stored, auditRowsLinked, gitSyncRemoved };
}
