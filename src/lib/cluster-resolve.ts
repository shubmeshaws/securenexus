import prisma from './prisma';
import type { ArgoCDInstanceConfig } from './argocd-instances';
import { instanceMatchesCluster } from './argocd-instances';

type RegisteredCluster = {
  name: string;
  contextName: string | null;
  serverUrl: string | null;
};

let clusterCache: { at: number; rows: RegisteredCluster[] } | null = null;
const CACHE_TTL_MS = 60_000;

async function getRegisteredClusters(): Promise<RegisteredCluster[]> {
  if (!clusterCache || Date.now() - clusterCache.at >= CACHE_TTL_MS) {
    const rows = await prisma.cluster.findMany({
      where: { status: 'connected' },
      select: { name: true, contextName: true, serverUrl: true },
      orderBy: { createdAt: 'asc' },
    });
    clusterCache = { at: Date.now(), rows };
  }
  return clusterCache.rows;
}

function inferClusterFromInstanceLabel(
  instanceName: string,
  clusters: RegisteredCluster[]
): string | null {
  const label = instanceName.toLowerCase();
  if (label.includes('dr')) {
    return (
      clusters.find((c) => c.name.toLowerCase().includes('dr-eks'))?.name ??
      clusters.find((c) => c.name.toLowerCase().includes('/dr'))?.name ??
      clusters.find((c) => c.name.toLowerCase().includes('dr'))?.name ??
      null
    );
  }
  if (label.includes('dev')) {
    return (
      clusters.find((c) => c.name.toLowerCase().includes('dev-eks'))?.name ??
      clusters.find((c) => c.name.toLowerCase().includes('/dev'))?.name ??
      clusters.find((c) => c.name.toLowerCase().includes('dev'))?.name ??
      null
    );
  }
  return null;
}

function matchDestinationToCluster(
  destination: string,
  clusters: RegisteredCluster[]
): string | null {
  const dest = destination.trim().toLowerCase();
  if (!dest || dest === 'in-cluster' || dest.includes('kubernetes.default.svc')) {
    return null;
  }

  for (const cluster of clusters) {
    const name = cluster.name.toLowerCase();
    const context = (cluster.contextName ?? '').toLowerCase();
    const server = (cluster.serverUrl ?? '').toLowerCase();
    if (dest === name || dest === context || dest === server) return cluster.name;
    if (name.includes(dest) || dest.includes(name)) return cluster.name;
  }
  return null;
}

export async function resolveRegisteredClusterForArgoCD(params: {
  instance: Pick<ArgoCDInstanceConfig, 'id' | 'name' | 'clusterNames'>;
  argocdDestination?: string | null;
}): Promise<string> {
  const clusters = await getRegisteredClusters();
  if (!clusters.length) {
    return params.argocdDestination?.trim() || 'in-cluster';
  }

  const configured = params.instance.clusterNames
    .map((name) => name.trim())
    .filter(Boolean);

  if (configured.length === 1) {
    const exact = clusters.find((c) => c.name === configured[0]);
    return exact?.name ?? configured[0];
  }

  if (configured.length > 1) {
    for (const name of configured) {
      const row = clusters.find((c) => c.name === name);
      if (row) return row.name;
    }
    return configured[0];
  }

  const fromDestination = params.argocdDestination
    ? matchDestinationToCluster(params.argocdDestination, clusters)
    : null;
  if (fromDestination) return fromDestination;

  const fromInstance = inferClusterFromInstanceLabel(params.instance.name, clusters);
  if (fromInstance) return fromInstance;

  if (clusters.length === 1) return clusters[0].name;

  return params.argocdDestination?.trim() || clusters[0].name;
}

export async function buildArgoAppClusterMap(): Promise<Map<string, string>> {
  const { getEnabledArgoCDClients } = await import('./argocd-client');
  const clients = await getEnabledArgoCDClients();
  const map = new Map<string, string>();

  for (const { instance, client } of clients) {
    const cluster = await resolveRegisteredClusterForArgoCD({ instance });
    let apps;
    try {
      apps = await client.listApplications();
    } catch {
      continue;
    }
    for (const app of apps) {
      const resolved = await resolveRegisteredClusterForArgoCD({
        instance,
        argocdDestination: app.cluster,
      });
      map.set(app.name, resolved || cluster);
    }
  }

  return map;
}

export async function reconcileResourceAuditClusterNames(): Promise<number> {
  const appClusters = await buildArgoAppClusterMap();
  if (!appClusters.size) return 0;

  let updated = 0;
  for (const [argocdApp, cluster] of Array.from(appClusters.entries())) {
    const result = await prisma.resourceChangeAudit.updateMany({
      where: { argocdApp, NOT: { cluster } },
      data: { cluster },
    });
    updated += result.count;
  }
  return updated;
}

export function invalidateClusterResolveCache() {
  clusterCache = null;
}

export async function dedupeGitSyncAudits(): Promise<number> {
  const rows = await prisma.resourceChangeAudit.findMany({
    where: { resourceType: 'GIT_SYNC' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, argocdApp: true, revisionSha: true },
  });

  const seen = new Set<string>();
  const toDelete: string[] = [];
  for (const row of rows) {
    const key = `${row.argocdApp}::${row.revisionSha}`;
    if (seen.has(key)) toDelete.push(row.id);
    else seen.add(key);
  }

  if (!toDelete.length) return 0;
  const deleted = await prisma.resourceChangeAudit.deleteMany({
    where: { id: { in: toDelete } },
  });
  return deleted.count;
}

/** Test whether a registered cluster matches an ArgoCD instance binding. */
export function registeredClusterMatchesInstance(
  clusterName: string,
  instance: Pick<ArgoCDInstanceConfig, 'clusterNames'>
): boolean {
  return instanceMatchesCluster(
    { clusterNames: instance.clusterNames } as ArgoCDInstanceConfig,
    clusterName
  );
}
