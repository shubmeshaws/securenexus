import prisma from './prisma';
import { getEnabledArgoCDClients } from './argocd-client';
import { clusterNameVariants } from './cluster-name-utils';
import { resolveRegisteredClusterForArgoCD } from './cluster-resolve';
import { listNamespaces } from './k8s-client';

export async function upsertResourceAppCatalogEntry(
  argocdApp: string,
  cluster: string,
  namespace: string
): Promise<void> {
  await prisma.resourceAppCatalog.upsert({
    where: { argocdApp },
    create: { argocdApp, cluster, namespace },
    update: { cluster, namespace },
  });
}

/** Sync all ArgoCD apps into the local catalog for filter dropdowns. */
export async function syncResourceAppCatalog(): Promise<{
  appsSynced: number;
  errors: string[];
}> {
  const result = { appsSynced: 0, errors: [] as string[] };
  const clients = await getEnabledArgoCDClients();
  if (!clients.length) return result;

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
      try {
        const cluster = await resolveRegisteredClusterForArgoCD({
          instance,
          argocdDestination: app.cluster,
        });
        await upsertResourceAppCatalogEntry(app.name, cluster, app.destinationNamespace);
        result.appsSynced += 1;
      } catch (err) {
        result.errors.push(
          `${app.name}: ${err instanceof Error ? err.message : 'catalog upsert failed'}`
        );
      }
    }
  }

  return result;
}

export async function getCatalogNamespacesForCluster(cluster: string): Promise<string[]> {
  const variants = clusterNameVariants(cluster);
  const rows = await prisma.resourceAppCatalog.findMany({
    where: { cluster: { in: variants } },
    distinct: ['namespace'],
    select: { namespace: true },
    orderBy: { namespace: 'asc' },
  });
  return rows.map((r) => r.namespace);
}

export async function getCatalogAppsForClusterNamespace(
  cluster: string,
  namespace: string
): Promise<string[]> {
  const rows = await prisma.resourceAppCatalog.findMany({
    where: { cluster, namespace },
    select: { argocdApp: true },
    orderBy: { argocdApp: 'asc' },
  });
  return rows.map((r) => r.argocdApp);
}

/** Fallback: namespaces from manifest snapshots for apps known on this cluster. */
export async function getSnapshotNamespacesForCluster(cluster: string): Promise<string[]> {
  const variants = clusterNameVariants(cluster);
  const [catalogApps, auditApps] = await Promise.all([
    prisma.resourceAppCatalog.findMany({
      where: { cluster: { in: variants } },
      select: { argocdApp: true },
    }),
    prisma.resourceChangeAudit.findMany({
      where: { cluster: { in: variants } },
      distinct: ['argocdApp'],
      select: { argocdApp: true },
    }),
  ]);

  const appNames = Array.from(
    new Set([...catalogApps, ...auditApps].map((a) => a.argocdApp))
  );
  if (!appNames.length) return [];

  const rows = await prisma.resourceSnapshot.findMany({
    where: { argocdApp: { in: appNames } },
    distinct: ['namespace'],
    select: { namespace: true },
    orderBy: { namespace: 'asc' },
  });
  return rows.map((r) => r.namespace);
}

/** Namespaces from live ArgoCD apps mapped to this registered cluster. */
export async function getArgoCDNamespacesForCluster(cluster: string): Promise<string[]> {
  const variants = new Set(clusterNameVariants(cluster));
  const { getEnabledArgoCDClients } = await import('./argocd-client');
  const clients = await getEnabledArgoCDClients();
  const namespaces = new Set<string>();

  for (const { instance, client } of clients) {
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
      if (variants.has(resolved) && app.destinationNamespace) {
        namespaces.add(app.destinationNamespace);
      }
    }
  }

  return Array.from(namespaces).sort();
}

export async function getK8sNamespacesForCluster(cluster: string): Promise<string[]> {
  try {
    return await listNamespaces(cluster);
  } catch {
    return [];
  }
}

export async function getSnapshotAppsForNamespace(namespace: string): Promise<string[]> {
  const rows = await prisma.resourceSnapshot.findMany({
    where: { namespace },
    distinct: ['argocdApp'],
    select: { argocdApp: true },
    orderBy: { argocdApp: 'asc' },
  });
  return rows.map((r) => r.argocdApp);
}

/** Seed catalog from snapshots + audit cluster mapping when ArgoCD is unavailable. */
export async function bootstrapCatalogFromSnapshots(): Promise<number> {
  const clusters = await prisma.cluster.findMany({
    where: { status: 'connected' },
    select: { name: true },
    orderBy: { createdAt: 'asc' },
  });
  const defaultCluster = clusters[0]?.name ?? null;

  const auditApps = await prisma.resourceChangeAudit.findMany({
    distinct: ['argocdApp'],
    select: { argocdApp: true, cluster: true, namespace: true },
  });
  const clusterByApp = new Map(
    auditApps.map((row) => [row.argocdApp, { cluster: row.cluster, namespace: row.namespace }])
  );

  const revisionApps = await prisma.resourceAppRevision.findMany({
    where: { cluster: { not: null }, namespace: { not: null } },
    select: { argocdApp: true, cluster: true, namespace: true },
  });
  for (const row of revisionApps) {
    if (row.cluster && row.namespace && !clusterByApp.has(row.argocdApp)) {
      clusterByApp.set(row.argocdApp, { cluster: row.cluster, namespace: row.namespace });
    }
  }

  const snapGroups = await prisma.resourceSnapshot.findMany({
    distinct: ['argocdApp', 'namespace'],
    select: { argocdApp: true, namespace: true },
  });

  let upserted = 0;
  for (const snap of snapGroups) {
    const mapped = clusterByApp.get(snap.argocdApp);
    const cluster = mapped?.cluster ?? defaultCluster;
    if (!cluster) continue;
    const namespace = mapped?.namespace ?? snap.namespace;
    await upsertResourceAppCatalogEntry(snap.argocdApp, cluster, namespace);
    upserted += 1;
  }

  return upserted;
}
