import prisma from './prisma';
import { getEnabledArgoCDClients } from './argocd-client';
import { resolveRegisteredClusterForArgoCD } from './cluster-resolve';
import { normalizeRepoUrl } from './bitbucket-connection';
import { linkAppSourcesToRepositories } from './git-repositories';

export interface ArgoCDAppSourceInfo {
  repoURL: string;
  path?: string;
  targetRevision?: string;
  helmValueFiles?: string[];
}

export interface ArgoCDAppSourceView {
  id: string;
  argocdApp: string;
  argocdInstanceId: string;
  argocdInstanceName: string;
  cluster: string | null;
  namespace: string | null;
  repoUrl: string;
  repoPath: string | null;
  targetRevision: string | null;
  helmValueFiles: string[];
  gitRepositoryId: string | null;
  gitRepositoryName: string | null;
  updatedAt: string;
}

export function extractAppSourcesFromSpec(spec: Record<string, unknown> | undefined): ArgoCDAppSourceInfo[] {
  if (!spec) return [];

  const sources: ArgoCDAppSourceInfo[] = [];

  const processSource = (src: Record<string, unknown>) => {
    const repoURL = String(src.repoURL ?? '').trim();
    if (!repoURL) return;
    const helm = src.helm as Record<string, unknown> | undefined;
    const valueFiles = Array.isArray(helm?.valueFiles)
      ? (helm.valueFiles as string[]).map(String)
      : [];
    sources.push({
      repoURL,
      path: src.path != null ? String(src.path) : undefined,
      targetRevision: src.targetRevision != null ? String(src.targetRevision) : undefined,
      helmValueFiles: valueFiles,
    });
  };

  const multi = spec.sources as Record<string, unknown>[] | undefined;
  if (Array.isArray(multi) && multi.length > 0) {
    multi.forEach(processSource);
  } else {
    const single = spec.source as Record<string, unknown> | undefined;
    if (single) processSource(single);
  }

  return sources;
}

function toView(row: {
  id: string;
  argocdApp: string;
  argocdInstanceId: string;
  argocdInstanceName: string;
  cluster: string | null;
  namespace: string | null;
  repoUrl: string;
  repoPath: string | null;
  targetRevision: string | null;
  helmValueFiles: string[];
  gitRepositoryId: string | null;
  updatedAt: Date;
  gitRepository?: { name: string } | null;
}): ArgoCDAppSourceView {
  return {
    id: row.id,
    argocdApp: row.argocdApp,
    argocdInstanceId: row.argocdInstanceId,
    argocdInstanceName: row.argocdInstanceName,
    cluster: row.cluster,
    namespace: row.namespace,
    repoUrl: row.repoUrl,
    repoPath: row.repoPath,
    targetRevision: row.targetRevision,
    helmValueFiles: Array.isArray(row.helmValueFiles) ? row.helmValueFiles : [],
    gitRepositoryId: row.gitRepositoryId,
    gitRepositoryName: row.gitRepository?.name ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listArgoCDAppSourceViews(): Promise<ArgoCDAppSourceView[]> {
  const rows = await prisma.argoCDAppSource.findMany({
    orderBy: { argocdApp: 'asc' },
    include: { gitRepository: { select: { name: true } } },
  });
  return rows.map(toView);
}

export async function syncArgoCDAppSources(): Promise<{ synced: number; linked: number }> {
  const clients = await getEnabledArgoCDClients();
  let synced = 0;

  for (const { instance, client } of clients) {
    let apps;
    try {
      apps = await client.listApplications();
    } catch {
      continue;
    }

    for (const app of apps) {
      let detail;
      try {
        detail = await client.getApplication(app.name);
      } catch {
        continue;
      }

      const raw = await client.getApplicationRaw(app.name);
      const spec = raw?.spec as Record<string, unknown> | undefined;
      const sources = extractAppSourcesFromSpec(spec);
      if (!sources.length) continue;

      const primary = sources[0];
      const cluster =
        (await resolveRegisteredClusterForArgoCD({
          instance,
          argocdDestination: app.cluster,
        })) ?? app.cluster;
      const namespace = app.destinationNamespace;

      const repoUrlNorm = normalizeRepoUrl(primary.repoURL);
      const repos = await prisma.gitRepository.findMany();
      const matchedRepo = repos.find(
        (r) => normalizeRepoUrl(r.repoUrl.replace(/\/\/[^@]+@/, '//')) === repoUrlNorm
      );

      await prisma.argoCDAppSource.upsert({
        where: { argocdApp: app.name },
        create: {
          argocdApp: app.name,
          argocdInstanceId: instance.id,
          argocdInstanceName: instance.name,
          cluster,
          namespace,
          repoUrl: primary.repoURL,
          repoPath: primary.path ?? null,
          targetRevision: primary.targetRevision ?? detail.branchName ?? null,
          helmValueFiles: primary.helmValueFiles ?? [],
          gitRepositoryId: matchedRepo?.id ?? null,
        },
        update: {
          argocdInstanceId: instance.id,
          argocdInstanceName: instance.name,
          cluster,
          namespace,
          repoUrl: primary.repoURL,
          repoPath: primary.path ?? null,
          targetRevision: primary.targetRevision ?? detail.branchName ?? null,
          helmValueFiles: primary.helmValueFiles ?? [],
          gitRepositoryId: matchedRepo?.id ?? null,
        },
      });
      synced += 1;
    }
  }

  const linked = await linkAppSourcesToRepositories();
  return { synced, linked };
}
