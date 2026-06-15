import cron from 'node-cron';
import { syncDueGitRepositories, resetStaleSyncStatuses } from '../git-sync-service';
import { syncArgoCDAppSources } from '../argocd-app-sources';
import { linkGitChangesToResourceAudit } from '../git-resource-audit-join';
import { pruneResourceAuditDataByRetention } from '../resource-audit-retention';

const GIT_SYNC_GLOBAL_KEY = '__secureNexusGitSyncStarted__';

let gitSyncRunning = false;

async function runGitSyncCycle(): Promise<void> {
  if (gitSyncRunning) return;
  gitSyncRunning = true;
  try {
    await resetStaleSyncStatuses();
    await syncDueGitRepositories();
    await linkGitChangesToResourceAudit();
    await pruneResourceAuditDataByRetention();
  } catch (err) {
    console.error('[git-sync] cycle failed:', err);
  } finally {
    gitSyncRunning = false;
  }
}

async function bootstrapGitIntegration(): Promise<void> {
  try {
    await resetStaleSyncStatuses();
    await syncArgoCDAppSources();
  } catch (err) {
    console.error('[git-sync] bootstrap failed:', err);
  }
}

export function initGitSyncJob(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[GIT_SYNC_GLOBAL_KEY]) return;
  g[GIT_SYNC_GLOBAL_KEY] = true;

  cron.schedule('* * * * *', () => {
    void runGitSyncCycle();
  });

  cron.schedule('0 */6 * * *', () => {
    void syncArgoCDAppSources();
  });

  void bootstrapGitIntegration();
}
