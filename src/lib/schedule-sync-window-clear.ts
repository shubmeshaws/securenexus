import prisma from './prisma';
import argocdClient, {
  getArgoListErrors,
  getEnabledArgoCDClients,
  invalidateArgoAppsCache,
  type ArgoCDAppSummary,
} from './argocd-client';
import { runWithConcurrency } from './concurrency';

export interface SyncWindowClearResult {
  instancesProcessed: number;
  projectsScanned: number;
  projectsUpdated: number;
  windowsRemoved: number;
  syncPoliciesRestored: number;
  errors: string[];
}

/** Collect apps linked to stopped schedules / active instant runs that should use automated sync. */
async function linkedAppsForAutomatedRestore(): Promise<{ name: string; instanceId: string }[]> {
  const schedules = await prisma.schedule.findMany({
    where: {
      syncPolicy: 'automated',
      OR: [{ liveActive: true }, { pausedArgoApps: { isEmpty: false } }],
    },
    select: { pausedArgoApps: true },
  });

  const instantRuns = await prisma.instantRun.findMany({
    where: { active: true, pausedArgoApps: { isEmpty: false } },
    select: { pausedArgoApps: true, appName: true },
  });

  const appNames = new Set<string>();
  for (const schedule of schedules) {
    for (const name of schedule.pausedArgoApps) appNames.add(name);
  }
  for (const run of instantRuns) {
    for (const name of run.pausedArgoApps) appNames.add(name);
    appNames.add(run.appName);
  }

  if (!appNames.size) return [];

  invalidateArgoAppsCache();
  const allApps = await argocdClient.listApplications();
  const byName = new Map(allApps.map((app) => [app.name, app]));

  return Array.from(appNames)
    .map((name) => byName.get(name))
    .filter((app): app is ArgoCDAppSummary => Boolean(app))
    .filter((app) => app.syncPolicy === 'none')
    .map((app) => ({ name: app.name, instanceId: app.instanceId }));
}

function appsOnInstancesWithManualSync(
  allApps: ArgoCDAppSummary[],
  instanceIds: Set<string>
): { name: string; instanceId: string }[] {
  return allApps
    .filter((app) => instanceIds.has(app.instanceId) && app.syncPolicy === 'none')
    .map((app) => ({ name: app.name, instanceId: app.instanceId }));
}

/** Remove all SecureNexus deny sync windows and restore automated sync where appropriate. */
export async function clearSecureNexusSyncWindows(): Promise<SyncWindowClearResult> {
  invalidateArgoAppsCache();

  const result: SyncWindowClearResult = {
    instancesProcessed: 0,
    projectsScanned: 0,
    projectsUpdated: 0,
    windowsRemoved: 0,
    syncPoliciesRestored: 0,
    errors: [],
  };

  const instancesWithRemovals = new Set<string>();
  const clients = await getEnabledArgoCDClients();

  for (const { instance, client } of clients) {
    try {
      const purge = await client.purgeSecureNexusSyncWindows();
      result.instancesProcessed++;
      result.projectsScanned += purge.projectsScanned;
      result.projectsUpdated += purge.projectsUpdated;
      result.windowsRemoved += purge.windowsRemoved;
      if (purge.windowsRemoved > 0) {
        instancesWithRemovals.add(instance.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${instance.name}: ${message}`);
    }
  }

  for (const listError of getArgoListErrors()) {
    result.errors.push(listError);
  }

  invalidateArgoAppsCache();
  const allApps = await argocdClient.listApplications();

  const restoreTargets = new Map<string, { name: string; instanceId: string }>();
  for (const app of await linkedAppsForAutomatedRestore()) {
    restoreTargets.set(`${app.instanceId}:${app.name}`, app);
  }
  for (const app of appsOnInstancesWithManualSync(allApps, instancesWithRemovals)) {
    restoreTargets.set(`${app.instanceId}:${app.name}`, app);
  }

  await runWithConcurrency(Array.from(restoreTargets.values()), 8, async (app) => {
    try {
      await argocdClient.updateSyncPolicy(app.name, 'automated', app.instanceId);
      result.syncPoliciesRestored++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`restore sync ${app.name}: ${message}`);
    }
  });

  return result;
}
