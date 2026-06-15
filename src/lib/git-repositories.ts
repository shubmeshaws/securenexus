import path from 'path';
import fs from 'fs/promises';
import prisma from './prisma';
import {
  buildBitbucketCloneUrl,
  getBitbucketCredentials,
  normalizeRepoUrl,
  parseBitbucketRepoUrl,
} from './bitbucket-connection';

export interface GitRepositoryView {
  id: string;
  name: string;
  workspace: string;
  repoSlug: string;
  repoUrl: string;
  defaultBranch: string | null;
  pullIntervalMin: number;
  enabled: boolean;
  isCloned: boolean;
  clonedAt: string | null;
  syncStatus: 'idle' | 'cloning' | 'pulling';
  syncStartedAt: string | null;
  clonePath: string | null;
  lastPullAt: string | null;
  lastCommitSha: string | null;
  lastPullStatus: string | null;
  lastPullError: string | null;
  appSourceCount: number;
  createdAt: string;
  updatedAt: string;
}

function toView(row: {
  id: string;
  name: string;
  workspace: string;
  repoSlug: string;
  repoUrl: string;
  defaultBranch: string | null;
  pullIntervalMin: number;
  enabled: boolean;
  clonedAt: Date | null;
  syncStatus: string;
  syncStartedAt: Date | null;
  clonePath: string | null;
  lastPullAt: Date | null;
  lastCommitSha: string | null;
  lastPullStatus: string | null;
  lastPullError: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { appSources: number };
}): GitRepositoryView {
  const localPath = row.clonePath ?? repoClonePath(row.workspace, row.repoSlug);
  return {
    id: row.id,
    name: row.name,
    workspace: row.workspace,
    repoSlug: row.repoSlug,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    pullIntervalMin: row.pullIntervalMin,
    enabled: row.enabled,
    isCloned: Boolean(row.clonedAt),
    clonedAt: row.clonedAt?.toISOString() ?? null,
    syncStatus: (row.syncStatus as GitRepositoryView['syncStatus']) ?? 'idle',
    syncStartedAt: row.syncStartedAt?.toISOString() ?? null,
    clonePath: localPath,
    lastPullAt: row.lastPullAt?.toISOString() ?? null,
    lastCommitSha: row.lastCommitSha,
    lastPullStatus: row.lastPullStatus,
    lastPullError: row.lastPullError,
    appSourceCount: row._count?.appSources ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function getGitReposRoot(): string {
  return path.join(process.cwd(), '.git-repos');
}

export function repoClonePath(workspace: string, repoSlug: string): string {
  return path.join(getGitReposRoot(), `${workspace}__${repoSlug}`);
}

export function publicRepoUrl(workspace: string, repoSlug: string): string {
  return `https://bitbucket.org/${workspace}/${repoSlug}`;
}

export async function listGitRepositoryViews(): Promise<GitRepositoryView[]> {
  const rows = await prisma.gitRepository.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { appSources: true } } },
  });

  return Promise.all(
    rows.map(async (row) => {
      const view = toView(row);
      if (view.isCloned) return view;
      const cp = view.clonePath ?? repoClonePath(row.workspace, row.repoSlug);
      try {
        await fs.access(path.join(cp, '.git'));
        return { ...view, isCloned: true };
      } catch {
        return view;
      }
    })
  );
}

export async function createGitRepository(input: {
  workspace: string;
  repoUrl: string;
  defaultBranch?: string | null;
  pullIntervalMin?: number;
  enabled?: boolean;
}): Promise<GitRepositoryView> {
  const creds = await getBitbucketCredentials();
  if (!creds) {
    throw new Error('Connect Bitbucket before adding repositories');
  }

  const workspace = input.workspace.trim();
  const rawUrl = input.repoUrl.trim();
  const parsed = parseBitbucketRepoUrl(rawUrl);
  if (!parsed) {
    throw new Error('Invalid Bitbucket repository URL (expected https://bitbucket.org/workspace/repo)');
  }

  if (parsed.workspace !== workspace) {
    throw new Error(
      `Workspace "${workspace}" does not match repo URL workspace "${parsed.workspace}"`
    );
  }

  const repoSlug = parsed.repoSlug;
  const displayUrl = publicRepoUrl(workspace, repoSlug);
  const branch = input.defaultBranch?.trim() || null;
  const clonePath = repoClonePath(workspace, repoSlug);

  const row = await prisma.gitRepository.create({
    data: {
      name: `${workspace}/${repoSlug}`,
      workspace,
      repoSlug,
      repoUrl: displayUrl,
      defaultBranch: branch,
      pullIntervalMin: input.pullIntervalMin ?? 1440,
      enabled: input.enabled ?? true,
      clonePath,
    },
    include: { _count: { select: { appSources: true } } },
  });

  return toView(row);
}

export async function updateGitRepository(
  id: string,
  input: {
    defaultBranch?: string | null;
    pullIntervalMin?: number;
    enabled?: boolean;
  }
): Promise<GitRepositoryView> {
  const data: Record<string, unknown> = {};
  if (input.defaultBranch !== undefined) {
    data.defaultBranch = input.defaultBranch?.trim() || null;
  }
  if (input.pullIntervalMin !== undefined) data.pullIntervalMin = input.pullIntervalMin;
  if (input.enabled !== undefined) data.enabled = input.enabled;

  const row = await prisma.gitRepository.update({
    where: { id },
    data,
    include: { _count: { select: { appSources: true } } },
  });
  return toView(row);
}

export async function deleteGitRepository(id: string): Promise<{ message: string }> {
  const repo = await prisma.gitRepository.findUnique({ where: { id } });
  if (!repo) {
    return { message: 'Repository not found' };
  }

  const clonePath = repo.clonePath ?? repoClonePath(repo.workspace, repo.repoSlug);
  let removedFromDisk = false;
  try {
    await fs.access(path.join(clonePath, '.git'));
    await fs.rm(clonePath, { recursive: true, force: true });
    removedFromDisk = true;
  } catch {
    try {
      await fs.rm(clonePath, { recursive: true, force: true });
    } catch {
      // continue with DB delete even if disk cleanup fails
    }
  }

  await prisma.gitRepository.delete({ where: { id } });

  if (removedFromDisk) {
    return {
      message: `Deleted ${repo.name} and removed local clone from disk.`,
    };
  }
  return { message: `Deleted ${repo.name} from tracking.` };
}

export async function linkAppSourcesToRepositories(): Promise<number> {
  const repos = await prisma.gitRepository.findMany();
  const normalized = new Map(
    repos.map((repo) => [normalizeRepoUrl(repo.repoUrl), repo.id])
  );

  let linked = 0;
  const sources = await prisma.argoCDAppSource.findMany({ where: { gitRepositoryId: null } });
  for (const source of sources) {
    const key = normalizeRepoUrl(source.repoUrl);
    const repoId = normalized.get(key);
    if (!repoId) continue;
    await prisma.argoCDAppSource.update({
      where: { id: source.id },
      data: { gitRepositoryId: repoId },
    });
    linked += 1;
  }
  return linked;
}

// keep for backwards compat if referenced elsewhere
export { buildBitbucketCloneUrl };
