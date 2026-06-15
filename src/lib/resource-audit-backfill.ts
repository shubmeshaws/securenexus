import prisma from './prisma';
import type { InstanceArgoCDClient } from './argocd-client';
import { getEnabledArgoCDClients } from './argocd-client';
import type { ResourceFieldSnapshot } from './resource-audit-types';
import { clusterResourceRates, type ClusterResourceRates } from './instance-pricing';
import { listClusterInstanceTypes } from './k8s-client';
import { inferScheduleEnvironment } from './utils';
import {
  persistGitSyncEvent,
  persistResourceChanges,
  recordHistorySyncEvent,
  recordManifestRevisionDiff,
  syncManifestSnapshotsToBaseline,
  fetchManifestSnapshotsForRevision,
} from './resource-audit-diff';
import { extractSnapshotsFromManifests } from './resource-audit-manifests';
import { resolveRegisteredClusterForArgoCD } from './cluster-resolve';
import { upsertResourceAppCatalogEntry } from './resource-app-catalog';
import type { ArgoCDInstanceConfig } from './argocd-instances';

export const RESOURCE_AUDIT_DEFAULT_DAYS = 30;

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

async function backfillApp(
  client: InstanceArgoCDClient,
  instance: Pick<ArgoCDInstanceConfig, 'id' | 'name' | 'clusterNames'>,
  appName: string,
  argocdDestination: string,
  destinationNamespace: string,
  ratesCache: Map<string, ClusterResourceRates>
): Promise<number> {
  const cutoff = new Date(Date.now() - RESOURCE_AUDIT_DEFAULT_DAYS * 24 * 60 * 60 * 1000);
  const cluster = await resolveRegisteredClusterForArgoCD({
    instance,
    argocdDestination,
  });
  const environment = inferScheduleEnvironment(destinationNamespace, cluster);
  const rates = await getClusterRates(cluster, ratesCache);
  await upsertResourceAppCatalogEntry(appName, cluster, destinationNamespace);
  const history = await client.getApplicationHistory(appName);
  const appNamespace = history[0]?.appNamespace ?? 'argocd';
  const revisionCache = new Map<string, ResourceFieldSnapshot[]>();
  let recorded = 0;

  const allSorted = [...history].sort((a, b) => a.deployedAt.getTime() - b.deployedAt.getTime());
  const inWindow = allSorted.filter((h) => h.deployedAt >= cutoff);

  for (const entry of inWindow) {
    const historyIndex = allSorted.findIndex((h) => h.revision === entry.revision);
    const prevEntry = historyIndex > 0 ? allSorted[historyIndex - 1] : null;

    let resourceChanges = 0;
    let currentSnaps = revisionCache.get(entry.revision);
    if (!currentSnaps) {
      currentSnaps = await fetchManifestSnapshotsForRevision(
        client,
        appName,
        entry.revision,
        appNamespace,
        destinationNamespace,
        revisionCache
      );
    }

    let previousSnaps: ResourceFieldSnapshot[] = [];
    if (prevEntry) {
      previousSnaps =
        revisionCache.get(prevEntry.revision) ??
        (await fetchManifestSnapshotsForRevision(
          client,
          appName,
          prevEntry.revision,
          appNamespace,
          destinationNamespace,
          revisionCache
        ));
    }

    if (prevEntry && prevEntry.revision !== entry.revision) {
      const priorRevisions = allSorted
        .slice(0, historyIndex - 1)
        .reverse()
        .map((h) => h.revision);

      const changes = await recordManifestRevisionDiff({
        client,
        appName,
        cluster,
        environment,
        destinationNamespace,
        prevRevision: prevEntry.revision,
        newRevision: entry.revision,
        priorRevisions,
        branchName: entry.branchName,
        syncedAt: entry.deployedAt,
        appNamespace,
        rates,
        revisionCache,
      });
      resourceChanges = await persistResourceChanges(changes);
      recorded += resourceChanges;
    }

    if (resourceChanges === 0) {
      recorded += await persistGitSyncEvent(
        await recordHistorySyncEvent({
          client,
          appName,
          cluster,
          environment,
          namespace: destinationNamespace,
          revisionSha: entry.revision,
          prevRevisionSha: prevEntry?.revision ?? null,
          branchName: entry.branchName,
          syncedAt: entry.deployedAt,
          appNamespace,
          rates,
          revisionCache,
          historyIndex,
          previousSnaps,
          currentSnaps,
        })
      );
    }

    await syncManifestSnapshotsToBaseline(appName, currentSnaps);
  }

  const detail = await client.getApplication(appName);
  const revisionSha = detail.revision?.trim();
  const syncedAt = detail.lastSyncedAt ? new Date(detail.lastSyncedAt) : null;
  const coveredByHistory = revisionSha
    ? inWindow.some((entry) => entry.revision === revisionSha)
    : false;

  if (revisionSha && syncedAt && syncedAt >= cutoff && !coveredByHistory) {
    const appState = await prisma.resourceAppRevision.findUnique({
      where: { argocdApp: appName },
    });

    let resourceChanges = 0;
    if (appState?.lastRevisionSha && appState.lastRevisionSha !== revisionSha) {
      const changes = await recordManifestRevisionDiff({
        client,
        appName,
        cluster,
        environment,
        destinationNamespace,
        prevRevision: appState.lastRevisionSha,
        newRevision: revisionSha,
        branchName: detail.branchName,
        syncedAt,
        appNamespace,
        rates,
        revisionCache,
      });
      resourceChanges = await persistResourceChanges(changes);
      recorded += resourceChanges;
    }

    if (resourceChanges === 0) {
      const manifests = await client.getManifestsAtRevision(
        appName,
        revisionSha,
        appNamespace
      );
      const currentSnaps = extractSnapshotsFromManifests(
        appName,
        manifests,
        destinationNamespace
      );
      let previousSnaps: ResourceFieldSnapshot[] = [];
      if (appState?.lastRevisionSha) {
        try {
          const prevManifests = await client.getManifestsAtRevision(
            appName,
            appState.lastRevisionSha,
            appNamespace
          );
          previousSnaps = extractSnapshotsFromManifests(
            appName,
            prevManifests,
            destinationNamespace
          );
        } catch {
          // Best-effort for scale-from-zero detection.
        }
      }

      recorded += await persistGitSyncEvent(
        await recordHistorySyncEvent({
          client,
          appName,
          cluster,
          environment,
          namespace: destinationNamespace,
          revisionSha,
          prevRevisionSha: appState?.lastRevisionSha ?? null,
          branchName: detail.branchName,
          syncedAt,
          appNamespace,
          rates,
          revisionCache,
          historyIndex: appState ? 1 : 0,
          previousSnaps,
          currentSnaps,
        })
      );
    }
  }

  const latest =
    allSorted[allSorted.length - 1] ??
    (revisionSha && syncedAt
      ? {
          revision: revisionSha,
          branchName: detail.branchName,
          deployedAt: syncedAt,
        }
      : null);

  if (latest) {
    try {
      const manifests = await client.getManifestsAtRevision(
        appName,
        latest.revision,
        appNamespace
      );
      const snaps = extractSnapshotsFromManifests(appName, manifests, destinationNamespace);
      await syncManifestSnapshotsToBaseline(appName, snaps);
    } catch {
      // Baseline sync is best-effort.
    }

    await prisma.resourceAppRevision.upsert({
      where: { argocdApp: appName },
      create: {
        argocdApp: appName,
        cluster,
        namespace: destinationNamespace,
        lastRevisionSha: latest.revision,
        branchName: latest.branchName,
        lastSyncedAt: latest.deployedAt,
      },
      update: {
        cluster,
        namespace: destinationNamespace,
        lastRevisionSha: latest.revision,
        branchName: latest.branchName,
        lastSyncedAt: latest.deployedAt,
      },
    });
  }

  return recorded;
}

export async function backfillResourceAuditLast7Days(): Promise<{
  appsProcessed: number;
  changesRecorded: number;
  errors: string[];
}> {
  const result = { appsProcessed: 0, changesRecorded: 0, errors: [] as string[] };
  const clients = await getEnabledArgoCDClients();
  if (!clients.length) return result;

  const ratesCache = new Map<string, ClusterResourceRates>();

  for (const { instance, client } of clients) {
    let apps;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        apps = await client.listApplications();
        break;
      } catch (err) {
        if (attempt === 3) {
          result.errors.push(
            `${instance.name}: ${err instanceof Error ? err.message : 'list failed'}`
          );
        } else {
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
    }
    if (!apps) continue;

    for (const app of apps) {
      result.appsProcessed += 1;
      try {
        const count = await backfillApp(
          client,
          instance,
          app.name,
          app.cluster,
          app.destinationNamespace,
          ratesCache
        );
        result.changesRecorded += count;
      } catch (err) {
        result.errors.push(
          `${app.name}: ${err instanceof Error ? err.message : 'backfill failed'}`
        );
      }
    }
  }

  return result;
}
