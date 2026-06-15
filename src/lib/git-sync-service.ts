import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import prisma from './prisma';
import { getBitbucketCredentials, buildBitbucketCloneUrl } from './bitbucket-connection';
import { getGitReposRoot, repoClonePath } from './git-repositories';
import { runGitPullResourceAnalysis } from './git-resource-audit-join';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15 * 60_000; // 15 minutes per git command

/** Prevent overlapping git operations on the same repository. */
const repoOperationLocks = new Set<string>();

/** User-initiated clone/pull in progress — pauses scheduled pulls for all repos. */
const manualSyncInProgress = new Set<string>();

export interface GitSyncOptions {
  /** User clicked Clone/Pull — show progress in UI and block scheduled sync. */
  manual?: boolean;
}

export interface GitPullResult {
  repoId: string;
  ok: boolean;
  action: 'clone' | 'pull' | 'skip';
  message: string;
  newCommits: number;
}

type SyncStatus = 'idle' | 'cloning' | 'pulling';

async function runGit(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 20 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout.trim();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function removeCloneDirectory(clonePath: string): Promise<void> {
  try {
    await fs.rm(clonePath, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

async function setRepoSyncStatus(
  repoId: string,
  syncStatus: SyncStatus,
  extra?: Record<string, unknown>
): Promise<void> {
  await prisma.gitRepository.update({
    where: { id: repoId },
    data: {
      syncStatus,
      syncStartedAt: syncStatus === 'idle' ? null : new Date(),
      ...extra,
    },
  });
}

function formatGitError(err: unknown): string {
  if (err instanceof Error) {
    const execErr = err as Error & { killed?: boolean; signal?: string };
    if (execErr.killed || execErr.signal === 'SIGTERM') {
      return `Git operation timed out after ${GIT_TIMEOUT_MS / 60_000} minutes. The repository may be very large — try specifying a branch to clone a single branch only.`;
    }
    return err.message;
  }
  return 'Git operation failed';
}

export async function isRepositoryCloned(repoId: string): Promise<boolean> {
  const repo = await prisma.gitRepository.findUnique({ where: { id: repoId } });
  if (!repo) return false;
  const clonePath = repo.clonePath ?? repoClonePath(repo.workspace, repo.repoSlug);
  return pathExists(path.join(clonePath, '.git'));
}

async function resolveAuthenticatedCloneUrl(repo: {
  workspace: string;
  repoSlug: string;
}): Promise<string> {
  const creds = await getBitbucketCredentials();
  if (!creds) {
    throw new Error('Bitbucket is not connected');
  }
  return buildBitbucketCloneUrl(creds, repo.workspace, repo.repoSlug);
}

function localClonePath(repo: {
  workspace: string;
  repoSlug: string;
  clonePath: string | null;
}): string {
  return repo.clonePath ?? repoClonePath(repo.workspace, repo.repoSlug);
}

async function performClone(
  cloneUrl: string,
  clonePath: string,
  branch: string
): Promise<void> {
  const args = ['clone', '--depth', '200', '--branch', branch, '--single-branch', cloneUrl, clonePath];
  await runGit(args);
}

async function performPull(clonePath: string, cloneUrl: string, branch: string): Promise<void> {
  await runGit(['remote', 'set-url', 'origin', cloneUrl], clonePath);
  const currentBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], clonePath).catch(
    () => ''
  );
  if (currentBranch !== branch) {
    await runGit(['fetch', 'origin', branch, '--depth', '200'], clonePath);
    await runGit(['checkout', branch], clonePath);
  }
  await runGit(['pull', '--ff-only', 'origin', branch], clonePath);
}

/** Pick a single branch when none is configured — avoids slow fetch --all. */
async function resolveEffectiveBranch(
  repoId: string,
  clonePath: string | null,
  defaultBranch: string | null
): Promise<string> {
  const configured = defaultBranch?.trim();
  if (configured && configured.toLowerCase() !== 'all') {
    return configured;
  }

  const sources = await prisma.argoCDAppSource.findMany({
    where: { gitRepositoryId: repoId, targetRevision: { not: null } },
    select: { targetRevision: true },
  });
  const counts = new Map<string, number>();
  for (const source of sources) {
    const rev = source.targetRevision?.trim();
    if (!rev || rev === 'HEAD' || rev.startsWith('refs/')) continue;
    counts.set(rev, (counts.get(rev) ?? 0) + 1);
  }
  if (counts.size > 0) {
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  }

  if (clonePath) {
    try {
      const ref = await runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], clonePath);
      return ref.replace('refs/remotes/origin/', '');
    } catch {
      // fall through
    }
  }

  return 'main';
}

async function resolveHeadSha(clonePath: string, branch: string): Promise<string> {
  return runGit(['rev-parse', branch], clonePath);
}

const analysisInProgress = new Set<string>();

/** Run commit diff + resource audit linking (awaitable for manual pull). */
async function runRepositoryAnalysis(
  repo: { id: string; defaultBranch: string | null; lastCommitSha: string | null },
  clonePath: string,
  branch: string,
  previousSha: string | null,
  headSha: string,
  bootstrap = false
): Promise<number> {
  const result = await runGitPullResourceAnalysis({
    repoId: repo.id,
    clonePath,
    branch,
    previousSha,
    headSha,
    bootstrap,
  });
  const total = result.changesStored + result.auditRowsLinked;
  if (total > 0 || result.gitSyncRemoved > 0) {
    console.log(
      '[git-sync] analyzed',
      result.changesStored,
      'git change(s), linked',
      result.auditRowsLinked,
      'audit row(s), removed',
      result.gitSyncRemoved,
      'app-up row(s) for',
      repo.id
    );
  }
  return result.changesStored;
}

/** Run commit diff + resource audit linking without blocking scheduled pull. */
function enqueueRepositoryAnalysis(
  repo: { id: string; defaultBranch: string | null; lastCommitSha: string | null },
  clonePath: string,
  branch: string,
  previousSha: string | null,
  headSha: string,
  bootstrap = false
): void {
  if (analysisInProgress.has(repo.id)) return;
  analysisInProgress.add(repo.id);

  void (async () => {
    try {
      await runRepositoryAnalysis(repo, clonePath, branch, previousSha, headSha, bootstrap);
    } catch (err) {
      console.error('[git-sync] background analysis failed for', repo.id, err);
    } finally {
      analysisInProgress.delete(repo.id);
    }
  })();
}

async function withRepoLock(
  repoId: string,
  action: 'clone' | 'pull',
  fn: () => Promise<GitPullResult>
): Promise<GitPullResult> {
  if (repoOperationLocks.has(repoId)) {
    return {
      repoId,
      ok: false,
      action,
      message: 'A clone or pull is already running for this repository',
      newCommits: 0,
    };
  }

  repoOperationLocks.add(repoId);
  try {
    return await fn();
  } finally {
    repoOperationLocks.delete(repoId);
  }
}

export async function cloneRepository(
  repoId: string,
  force = false,
  options: GitSyncOptions = { manual: true }
): Promise<GitPullResult> {
  const manual = options.manual ?? true;
  return withRepoLock(repoId, 'clone', async () => {
    if (manual) manualSyncInProgress.add(repoId);
    try {
      const repo = await prisma.gitRepository.findUnique({ where: { id: repoId } });
      if (!repo) {
        return { repoId, ok: false, action: 'skip', message: 'Repository not found', newCommits: 0 };
      }

      if (!repo.enabled && !force) {
        return { repoId, ok: true, action: 'skip', message: 'Repository disabled', newCommits: 0 };
      }

      if (manual && (repo.syncStatus === 'cloning' || repo.syncStatus === 'pulling')) {
        return {
          repoId,
          ok: false,
          action: 'skip',
          message: 'Repository sync already in progress',
          newCommits: 0,
        };
      }

      const clonePath = localClonePath(repo);
      const gitDir = path.join(clonePath, '.git');
      if (await pathExists(gitDir)) {
        return {
          repoId,
          ok: false,
          action: 'skip',
          message: 'Repository is already cloned. Use Pull to update.',
          newCommits: 0,
        };
      }

      await fs.mkdir(getGitReposRoot(), { recursive: true });
      if (manual) {
        await setRepoSyncStatus(repoId, 'cloning');
      }

      const cloneUrl = await resolveAuthenticatedCloneUrl(repo);
      const branch = await resolveEffectiveBranch(repo.id, null, repo.defaultBranch);
      await performClone(cloneUrl, clonePath, branch);

      const headSha = await resolveHeadSha(clonePath, branch);
      const previousSha = repo.lastCommitSha;
      const now = new Date();

      await prisma.gitRepository.update({
        where: { id: repo.id },
        data: {
          clonePath,
          clonedAt: now,
          lastPullAt: now,
          lastCommitSha: headSha,
          lastPullStatus: 'ok',
          lastPullError: null,
          ...(manual ? { syncStatus: 'idle', syncStartedAt: null } : {}),
        },
      });

      enqueueRepositoryAnalysis(repo, clonePath, branch, previousSha, headSha, !previousSha);

      const branchLabel = repo.defaultBranch?.trim() || branch;
      return {
        repoId,
        ok: true,
        action: 'clone',
        message: `Repository cloned (branch: ${branchLabel})`,
        newCommits: 0,
      };
    } catch (err) {
      const message = formatGitError(err);
      const repo = await prisma.gitRepository.findUnique({ where: { id: repoId } });
      if (repo) {
        const clonePath = localClonePath(repo);
        await removeCloneDirectory(clonePath);
        await prisma.gitRepository.update({
          where: { id: repo.id },
          data: {
            lastPullAt: new Date(),
            lastPullStatus: 'error',
            lastPullError: message,
            ...(manual ? { syncStatus: 'idle', syncStartedAt: null } : {}),
          },
        });
      }
      return { repoId, ok: false, action: 'clone', message, newCommits: 0 };
    } finally {
      if (manual) manualSyncInProgress.delete(repoId);
    }
  });
}

export async function pullRepository(
  repoId: string,
  force = false,
  options: GitSyncOptions = { manual: false }
): Promise<GitPullResult> {
  const manual = options.manual ?? false;
  return withRepoLock(repoId, 'pull', async () => {
    if (manual) manualSyncInProgress.add(repoId);
    try {
      const repo = await prisma.gitRepository.findUnique({ where: { id: repoId } });
      if (!repo) {
        return { repoId, ok: false, action: 'skip', message: 'Repository not found', newCommits: 0 };
      }

      if (!repo.enabled && !force) {
        return { repoId, ok: true, action: 'skip', message: 'Repository disabled', newCommits: 0 };
      }

      if (manual && (repo.syncStatus === 'cloning' || repo.syncStatus === 'pulling')) {
        return {
          repoId,
          ok: false,
          action: 'skip',
          message: 'Repository sync already in progress',
          newCommits: 0,
        };
      }

      const clonePath = localClonePath(repo);
      const gitDir = path.join(clonePath, '.git');
      if (!(await pathExists(gitDir))) {
        return {
          repoId,
          ok: false,
          action: 'skip',
          message: 'Repository not cloned yet. Use Clone first.',
          newCommits: 0,
        };
      }

      if (manual) {
        await setRepoSyncStatus(repoId, 'pulling');
      }

      const cloneUrl = await resolveAuthenticatedCloneUrl(repo);
      const branch = await resolveEffectiveBranch(repo.id, clonePath, repo.defaultBranch);
      const previousSha = repo.lastCommitSha;
      const headBefore = await resolveHeadSha(clonePath, branch);
      await performPull(clonePath, cloneUrl, branch);

      const headSha = await resolveHeadSha(clonePath, branch);
      const now = new Date();

      await prisma.gitRepository.update({
        where: { id: repo.id },
        data: {
          clonedAt: repo.clonedAt ?? now,
          lastPullAt: now,
          lastCommitSha: headSha,
          lastPullStatus: 'ok',
          lastPullError: null,
          ...(manual ? { syncStatus: 'idle', syncStartedAt: null } : {}),
        },
      });

      let newCommits = 0;
      const needsBootstrap = !previousSha && headBefore === headSha;
      const rangeStart =
        previousSha ?? (headBefore !== headSha ? headBefore : null);

      if (rangeStart !== headSha || needsBootstrap) {
        try {
          if (manual) {
            newCommits = await runRepositoryAnalysis(
              repo,
              clonePath,
              branch,
              rangeStart,
              headSha,
              needsBootstrap
            );
          } else {
            enqueueRepositoryAnalysis(
              repo,
              clonePath,
              branch,
              rangeStart,
              headSha,
              needsBootstrap
            );
          }
        } catch (err) {
          console.error('[git-sync] commit analysis failed for', repo.id, err);
        }
      }

      const branchLabel = repo.defaultBranch?.trim() || branch;
      return {
        repoId,
        ok: true,
        action: 'pull',
        message:
          newCommits > 0
            ? `Repository pulled — ${newCommits} resource change(s) found (branch: ${branchLabel})`
            : `Repository pulled (branch: ${branchLabel})`,
        newCommits,
      };
    } catch (err) {
      const message = formatGitError(err);
      await prisma.gitRepository.update({
        where: { id: repoId },
        data: {
          lastPullAt: new Date(),
          lastPullStatus: 'error',
          lastPullError: message,
          ...(manual ? { syncStatus: 'idle', syncStartedAt: null } : {}),
        },
      });
      return { repoId, ok: false, action: 'pull', message, newCommits: 0 };
    } finally {
      if (manual) manualSyncInProgress.delete(repoId);
    }
  });
}

export async function syncDueGitRepositories(): Promise<GitPullResult[]> {
  if (manualSyncInProgress.size > 0) return [];

  const creds = await getBitbucketCredentials();
  if (!creds) return [];

  const repos = await prisma.gitRepository.findMany({
    where: {
      enabled: true,
      clonedAt: { not: null },
      syncStatus: 'idle',
    },
  });
  const now = Date.now();
  const results: GitPullResult[] = [];

  for (const repo of repos) {
    if (repoOperationLocks.has(repo.id)) continue;

    const intervalMs = Math.max(repo.pullIntervalMin, 1) * 60_000;
    const lastPull = repo.lastPullAt?.getTime() ?? 0;
    if (now - lastPull < intervalMs) continue;

    results.push(await pullRepository(repo.id, false, { manual: false }));
  }

  return results;
}

export async function resetStaleSyncStatuses(maxAgeMs = GIT_TIMEOUT_MS): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const stale = await prisma.gitRepository.updateMany({
    where: {
      syncStatus: { in: ['cloning', 'pulling'] },
      syncStartedAt: { lt: cutoff },
    },
    data: {
      syncStatus: 'idle',
      syncStartedAt: null,
      lastPullStatus: 'error',
      lastPullError: 'Sync timed out or was interrupted. Try Clone or Pull again.',
    },
  });
  return stale.count;
}
