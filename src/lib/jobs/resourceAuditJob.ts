import prisma from '../prisma';
import { getEnabledArgoCDClients } from '../argocd-client';
import type { ResourceFieldSnapshot } from '../resource-audit-types';
import { clusterResourceRates, type ClusterResourceRates } from '../instance-pricing';
import { listClusterInstanceTypes } from '../k8s-client';
import { inferScheduleEnvironment } from '../utils';
import { resolveRegisteredClusterForArgoCD } from '../cluster-resolve';
import { dispatchResourceChangeAlert } from '../resource-audit-alerts';
import { getAlertConfigFull } from '../alert-settings';
import {
  persistGitSyncEvent,
  persistResourceChanges,
  recordHistorySyncEvent,
  recordManifestRevisionDiff,
  syncManifestSnapshotsToBaseline,
} from '../resource-audit-diff';
import { extractSnapshotsFromManifests } from '../resource-audit-manifests';
import cron from 'node-cron';
import {
  backfillResourceAuditLast7Days,
  RESOURCE_AUDIT_DEFAULT_DAYS,
} from '../resource-audit-backfill';
import {
  dedupeAppUpWithResourceChanges,
  recomputeAppUpRunningCosts,
  recomputeResourceAuditCostEstimates,
  resetAppUpRowsForRebackfill,
  needsAppUpV2Migration,
  resetInvalidResourceDiffRows,
  needsFullHistoryBackfill,
  resetResourceAuditForFullBackfill,
} from '../resource-audit-maintenance';
import {
  dedupeGitSyncAudits,
  reconcileResourceAuditClusterNames,
} from '../cluster-resolve';
import { syncResourceAppCatalog, bootstrapCatalogFromSnapshots } from '../resource-app-catalog';
import { joinGitChangesWithArgoSync, shouldRecordGitSyncForApp, linkGitChangesToResourceAudit } from '../git-resource-audit-join';

const RESOURCE_AUDIT_GLOBAL_KEY = '__secureNexusResourceAuditStarted__';

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

export interface ResourceAuditJobResult {
  appsScanned: number;
  changesRecorded: number;
  baselinesCreated: number;
  alertsSent: number;
  errors: string[];
}

export async function runResourceAuditJob(): Promise<ResourceAuditJobResult> {
  const result: ResourceAuditJobResult = {
    appsScanned: 0,
    changesRecorded: 0,
    baselinesCreated: 0,
    alertsSent: 0,
    errors: [],
  };

  const clients = await getEnabledArgoCDClients();
  if (!clients.length) return result;

  const ratesCache = new Map<string, ClusterResourceRates>();
  const revisionCache = new Map<string, ResourceFieldSnapshot[]>();
  const alertConfig = await getAlertConfigFull();

  for (const { instance, client } of clients) {
    let apps;
    try {
      apps = await client.listApplications();
    } catch (err) {
      result.errors.push(
        `${instance.name}: ${err instanceof Error ? err.message : 'list apps failed'}`
      );
      continue;
    }

    for (const app of apps) {
      result.appsScanned += 1;
      try {
        const detail = await client.getApplication(app.name);
        const revisionSha = detail.revision?.trim();
        if (!revisionSha) continue;

        const syncedAt = detail.lastSyncedAt ? new Date(detail.lastSyncedAt) : new Date();
        const cluster = await resolveRegisteredClusterForArgoCD({
          instance,
          argocdDestination: app.cluster,
        });
        const environment = inferScheduleEnvironment(app.destinationNamespace, cluster);
        const rates = await getClusterRates(cluster, ratesCache);
        const appNamespace = app.namespace;

        const appState = await prisma.resourceAppRevision.findUnique({
          where: { argocdApp: app.name },
        });

        if (!appState) {
          const manifests = await client.getManifestsAtRevision(
            app.name,
            revisionSha,
            appNamespace
          );
          const snaps = extractSnapshotsFromManifests(app.name, manifests);
          await syncManifestSnapshotsToBaseline(app.name, snaps);
          result.baselinesCreated += snaps.length;

          if (await shouldRecordGitSyncForApp(app.name, revisionSha)) {
            result.changesRecorded += await persistGitSyncEvent(
              await recordHistorySyncEvent({
                client,
                appName: app.name,
                cluster,
                environment,
                namespace: app.destinationNamespace,
                revisionSha,
                prevRevisionSha: null,
                branchName: detail.branchName,
                syncedAt,
                appNamespace,
                rates,
                revisionCache,
                historyIndex: 0,
                previousSnaps: [],
                currentSnaps: snaps,
              })
            );
          }
          result.changesRecorded += await joinGitChangesWithArgoSync(app.name, revisionSha);

          await prisma.resourceAppRevision.create({
            data: {
              argocdApp: app.name,
              lastRevisionSha: revisionSha,
              branchName: detail.branchName,
              lastSyncedAt: syncedAt,
            },
          });
          continue;
        }

        if (appState.lastRevisionSha === revisionSha) continue;

        const changes = await recordManifestRevisionDiff({
          client,
          appName: app.name,
          cluster,
          environment,
          destinationNamespace: app.destinationNamespace,
          prevRevision: appState.lastRevisionSha,
          newRevision: revisionSha,
          branchName: detail.branchName ?? appState.branchName,
          syncedAt,
          appNamespace,
          rates,
          revisionCache,
        });

        const recorded = await persistResourceChanges(changes);
        result.changesRecorded += recorded;
        result.changesRecorded += await joinGitChangesWithArgoSync(app.name, revisionSha);

        const prevManifests = await client.getManifestsAtRevision(
          app.name,
          appState.lastRevisionSha,
          appNamespace
        );
        const previousSnaps = extractSnapshotsFromManifests(
          app.name,
          prevManifests,
          app.destinationNamespace
        );

        if (recorded === 0) {
          const manifests = await client.getManifestsAtRevision(
            app.name,
            revisionSha,
            appNamespace
          );
          const currentSnaps = extractSnapshotsFromManifests(
            app.name,
            manifests,
            app.destinationNamespace
          );

          if (await shouldRecordGitSyncForApp(app.name, revisionSha)) {
            result.changesRecorded += await persistGitSyncEvent(
              await recordHistorySyncEvent({
                client,
                appName: app.name,
                cluster,
                environment,
                namespace: app.destinationNamespace,
                revisionSha,
                prevRevisionSha: appState.lastRevisionSha,
                branchName: detail.branchName ?? appState.branchName,
                syncedAt,
                appNamespace,
                rates,
                revisionCache,
                historyIndex: 1,
                previousSnaps,
                currentSnaps,
              })
            );
          }
          result.changesRecorded += await joinGitChangesWithArgoSync(app.name, revisionSha);
        }

        const manifests = await client.getManifestsAtRevision(
          app.name,
          revisionSha,
          appNamespace
        );
        const snaps = extractSnapshotsFromManifests(app.name, manifests, app.destinationNamespace);
        await syncManifestSnapshotsToBaseline(app.name, snaps);

        await prisma.resourceAppRevision.update({
          where: { argocdApp: app.name },
          data: {
            lastRevisionSha: revisionSha,
            branchName: detail.branchName ?? appState.branchName,
            lastSyncedAt: syncedAt,
          },
        });

        if (changes.length === 0) continue;

        const increaseTotal = changes.reduce((sum, c) => {
          const impact = c.estimatedCostImpactPerDay ?? 0;
          return impact > 0 ? sum + impact : sum;
        }, 0);

        const threshold = alertConfig.resourceChangeThresholdUsd ?? 5;
        if (
          alertConfig.events.includes('resource-change') &&
          increaseTotal >= threshold
        ) {
          const sent = await dispatchResourceChangeAlert({
            argocdApp: app.name,
            cluster,
            namespace: app.destinationNamespace,
            authorName: changes[0]?.authorName ?? 'Unknown',
            authorEmail: changes[0]?.authorEmail ?? null,
            revisionSha,
            commitMessage: changes[0]?.commitMessage ?? null,
            changes,
            totalCostImpactPerDay: increaseTotal,
          });
          if (sent) result.alertsSent += 1;
        }
      } catch (err) {
        result.errors.push(
          `${app.name}: ${err instanceof Error ? err.message : 'audit failed'}`
        );
      }
    }
  }

  return result;
}

/** Remove rows with invalid resource diffs (e.g. removed-resource noise). */
export async function purgeInvalidResourceAuditRows(): Promise<number> {
  const deleted = await prisma.resourceChangeAudit.deleteMany({
    where: {
      resourceType: { not: 'GIT_SYNC' },
      newValue: '—',
    },
  });
  return deleted.count;
}

/** Remove scheduler-driven rows that lack git revision metadata. */
export async function purgeUnknownRevisionAudits(): Promise<number> {
  const deleted = await prisma.resourceChangeAudit.deleteMany({
    where: { revisionSha: 'unknown' },
  });
  return deleted.count;
}

let auditJob: ReturnType<typeof cron.schedule> | null = null;

export function initResourceAuditJob() {
  const g = globalThis as typeof globalThis & { [RESOURCE_AUDIT_GLOBAL_KEY]?: boolean };
  if (g[RESOURCE_AUDIT_GLOBAL_KEY] || auditJob) return;

  g[RESOURCE_AUDIT_GLOBAL_KEY] = true;
  console.log('[ResourceAudit] Initializing audit runner (every 10 minutes)...');

  void (async () => {
    try {
      const purged = await purgeUnknownRevisionAudits();
      if (purged > 0) {
        console.log(`[ResourceAudit] Purged ${purged} non-git revision rows`);
      }

      const invalid = await purgeInvalidResourceAuditRows();
      if (invalid > 0) {
        console.log(`[ResourceAudit] Purged ${invalid} invalid resource diff rows`);
      }

      const catalog = await syncResourceAppCatalog();
      console.log(
        `[ResourceAudit] App catalog: ${catalog.appsSynced} apps synced` +
          (catalog.errors.length ? ` (${catalog.errors.length} errors)` : '')
      );
      if (catalog.errors.length) {
        console.warn('[ResourceAudit] Catalog errors:', catalog.errors.slice(0, 2).join('; '));
      }

      if (catalog.appsSynced < 20) {
        const bootstrapped = await bootstrapCatalogFromSnapshots();
        if (bootstrapped > 0) {
          console.log(`[ResourceAudit] Bootstrapped ${bootstrapped} apps into catalog from snapshots`);
        }
      }

      const deduped = await dedupeGitSyncAudits();
      if (deduped > 0) {
        console.log(`[ResourceAudit] Removed ${deduped} duplicate git sync rows`);
      }

      if (await needsAppUpV2Migration()) {
        const reset = await resetAppUpRowsForRebackfill();
        if (reset > 0) {
          console.log(`[ResourceAudit] Reset ${reset} app-up rows for v2 backfill`);
        }
      }

      const invalidDiffs = await resetInvalidResourceDiffRows();
      if (invalidDiffs > 0) {
        console.log(`[ResourceAudit] Reset ${invalidDiffs} resource rows with missing prior values`);
      }

      if (await needsFullHistoryBackfill()) {
        const wiped = await resetResourceAuditForFullBackfill();
        console.log(
          `[ResourceAudit] Cleared ${wiped} audit rows for full ${RESOURCE_AUDIT_DEFAULT_DAYS}d history backfill`
        );
      }

      const backfill = await backfillResourceAuditLast7Days();
      console.log(
        `[ResourceAudit] Backfill (${RESOURCE_AUDIT_DEFAULT_DAYS}d): ${backfill.changesRecorded} changes from ${backfill.appsProcessed} apps`
      );
      if (backfill.errors.length) {
        console.warn('[ResourceAudit] Backfill errors:', backfill.errors.slice(0, 3).join('; '));
      }

      const appUpDeduped = await dedupeAppUpWithResourceChanges();
      if (appUpDeduped > 0) {
        console.log(`[ResourceAudit] Removed ${appUpDeduped} app-up rows superseded by resource changes`);
      }

      const appUpFixed = await recomputeAppUpRunningCosts();
      if (appUpFixed > 0) {
        console.log(`[ResourceAudit] Recomputed running cost on ${appUpFixed} app-up rows`);
      }

      const clusterFixed = await reconcileResourceAuditClusterNames();
      if (clusterFixed > 0) {
        console.log(`[ResourceAudit] Updated cluster name on ${clusterFixed} rows`);
      }

      const costsFixed = await recomputeResourceAuditCostEstimates();
      if (costsFixed > 0) {
        console.log(`[ResourceAudit] Recomputed cost on ${costsFixed} rows`);
      }

      const summary = await runResourceAuditJob();
      console.log(
        `[ResourceAudit] Startup scan: ${summary.appsScanned} apps, ${summary.changesRecorded} new changes`
      );

      const unlinkedGit = await prisma.gitResourceChange.count({
        where: { auditLinked: false, resourceType: { not: 'FILE_TOUCH' } },
      });
      if (unlinkedGit > 0) {
        const linked = await linkGitChangesToResourceAudit();
        console.log(
          `[ResourceAudit] Linked ${linked} resource change row(s) from ${unlinkedGit} pending git commit(s)`
        );
      }
    } catch (err) {
      console.error('[ResourceAudit] Startup scan failed:', err);
    }
  })();

  auditJob = cron.schedule('*/10 * * * *', async () => {
    try {
      const summary = await runResourceAuditJob();
      if (summary.changesRecorded > 0 || summary.errors.length > 0) {
        console.log(
          `[ResourceAudit] Scanned ${summary.appsScanned} apps, ${summary.changesRecorded} changes, ${summary.alertsSent} alerts`
        );
      }
      if (summary.errors.length) {
        console.warn('[ResourceAudit] Errors:', summary.errors.slice(0, 5).join('; '));
      }
    } catch (err) {
      console.error('[ResourceAudit] Job error:', err);
    }
  });
}

export function ensureResourceAuditRunning() {
  initResourceAuditJob();
}
