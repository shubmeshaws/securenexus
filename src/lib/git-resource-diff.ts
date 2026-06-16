import { execFile } from 'child_process';
import { promisify } from 'util';
import prisma from './prisma';
import { extractSnapshotsFromManifests } from './resource-audit-manifests';
import { extractHelmValueSnapshots } from './git-values-parser';
import { inferAppFromHelmValuesPath } from './helm-values-path';
import { parseHelmValuesEnvFromPath, isHelmValuesResourcePath } from './helm-env-cluster';
import type { ResourceFieldSnapshot } from './resource-audit-types';
import { REPLICAS_CONTAINER_MARKER } from './resource-audit-types';
import { getResourceAuditDataWindow } from './resource-audit-retention';

const execFileAsync = promisify(execFile);
/** Max commits to scan on first pull when the clone is already up to date. */
export const INITIAL_COMMIT_SCAN_LIMIT = Math.min(
  500,
  Math.max(50, parseInt(process.env.GIT_INITIAL_COMMIT_SCAN_LIMIT ?? '200', 10) || 200)
);

interface GitCommitInfo {
  sha: string;
  authorName: string;
  authorEmail: string | null;
  committedAt: Date;
  message: string;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

function snapshotsFromFileContent(
  argocdApp: string,
  filePath: string,
  content: string
): ResourceFieldSnapshot[] {
  const fromManifests = extractSnapshotsFromManifests(argocdApp, [content]);
  if (fromManifests.length > 0) return fromManifests;
  return extractHelmValueSnapshots(argocdApp, filePath, content);
}

function diffSnapshots(
  oldSnaps: ResourceFieldSnapshot[],
  newSnaps: ResourceFieldSnapshot[]
): Array<{
  workload: string;
  containerName: string;
  resourceType: string;
  oldValue: string;
  newValue: string;
}> {
  const key = (s: ResourceFieldSnapshot) =>
    `${s.workload}::${s.containerName}::${s.resourceType}`;
  const oldMap = new Map(oldSnaps.map((s) => [key(s), s]));
  const changes: Array<{
    workload: string;
    containerName: string;
    resourceType: string;
    oldValue: string;
    newValue: string;
  }> = [];

  for (const snap of newSnaps) {
    const k = key(snap);
    const prev = oldMap.get(k);
    if (!prev) continue;
    if (prev.value !== snap.value) {
      changes.push({
        workload: snap.workload,
        containerName: snap.containerName,
        resourceType: snap.resourceType,
        oldValue: prev.value,
        newValue: snap.value,
      });
    }
  }

  for (const [k, prev] of Array.from(oldMap.entries())) {
    if (newSnaps.some((s) => key(s) === k)) continue;
    changes.push({
      workload: prev.workload,
      containerName: prev.containerName,
      resourceType: prev.resourceType,
      oldValue: prev.value,
      newValue: '(none)',
    });
  }

  return changes;
}

const FILE_TOUCH_MARKER = '__file_touch__';

type ProcessSource = {
  argocdApp: string;
};

function resolveSourcesForGitFile(filePath: string): ProcessSource[] {
  const inferred = inferAppFromHelmValuesPath(filePath);
  if (inferred) {
    return [{ argocdApp: inferred.argocdApp }];
  }
  return [];
}

async function recordFileTouch(input: {
  repoId: string;
  commit: GitCommitInfo;
  branch: string | null;
  filePath: string;
}): Promise<void> {
  await prisma.gitResourceChange.upsert({
    where: {
      gitRepositoryId_commitSha_filePath_workload_containerName_resourceType: {
        gitRepositoryId: input.repoId,
        commitSha: input.commit.sha,
        filePath: input.filePath,
        workload: '*',
        containerName: FILE_TOUCH_MARKER,
        resourceType: 'FILE_TOUCH',
      },
    },
    create: {
      gitRepositoryId: input.repoId,
      commitSha: input.commit.sha,
      branchName: input.branch,
      authorName: input.commit.authorName,
      authorEmail: input.commit.authorEmail,
      commitMessage: input.commit.message,
      committedAt: input.commit.committedAt,
      filePath: input.filePath,
      workload: '*',
      containerName: FILE_TOUCH_MARKER,
      resourceType: 'FILE_TOUCH',
      oldValue: '—',
      newValue: '—',
    },
    update: {
      pulledAt: new Date(),
      auditLinked: false,
    },
  });
}

async function storeResourceDiff(input: {
  repoId: string;
  commit: GitCommitInfo;
  branch: string | null;
  filePath: string;
  argocdApp: string;
  repoPath: string;
  parentSha: string | null;
}): Promise<number> {
  const oldContent = input.parentSha
    ? await fileContentAt(input.repoPath, input.parentSha, input.filePath)
    : null;
  const newContent = await fileContentAt(input.repoPath, input.commit.sha, input.filePath);
  if (!newContent && !oldContent) return 0;

  const oldSnaps = oldContent
    ? snapshotsFromFileContent(input.argocdApp, input.filePath, oldContent)
    : [];
  const newSnaps = newContent
    ? snapshotsFromFileContent(input.argocdApp, input.filePath, newContent)
    : [];

  const changes = diffSnapshots(oldSnaps, newSnaps);
  let stored = 0;

  for (const change of changes) {
    try {
      await prisma.gitResourceChange.upsert({
        where: {
          gitRepositoryId_commitSha_filePath_workload_containerName_resourceType: {
            gitRepositoryId: input.repoId,
            commitSha: input.commit.sha,
            filePath: input.filePath,
            workload: change.workload,
            containerName: change.containerName,
            resourceType: change.resourceType,
          },
        },
        create: {
          gitRepositoryId: input.repoId,
          commitSha: input.commit.sha,
          branchName: input.branch,
          authorName: input.commit.authorName,
          authorEmail: input.commit.authorEmail,
          commitMessage: input.commit.message,
          committedAt: input.commit.committedAt,
          filePath: input.filePath,
          workload: change.workload,
          containerName: change.containerName,
          resourceType: change.resourceType,
          oldValue: change.oldValue,
          newValue: change.newValue,
        },
        update: {
          oldValue: change.oldValue,
          newValue: change.newValue,
          pulledAt: new Date(),
          auditLinked: false,
        },
      });
      stored += 1;
    } catch {
      // skip duplicate race
    }
  }

  return stored;
}

export async function processCommitsForRepo(input: {
  repoId: string;
  repoPath: string;
  branch: string | null;
  commits: GitCommitInfo[];
}): Promise<{ stored: number; commitShas: string[] }> {
  const { dataAvailableFrom } = await getResourceAuditDataWindow();
  const inWindowCommits = input.commits
    .filter((c) => c.committedAt >= dataAvailableFrom)
    .sort((a, b) => b.committedAt.getTime() - a.committedAt.getTime());

  let stored = 0;
  const commitShas = inWindowCommits.map((c) => c.sha);

  for (const commit of inWindowCommits) {
    let storedThisCommit = 0;
    const files = await changedFilesForCommit(input.repoPath, commit.sha);
    const parentSha = await runGit(['rev-parse', `${commit.sha}^`], input.repoPath).catch(
      () => null
    );

    for (const filePath of files) {
      try {
        if (!parseHelmValuesEnvFromPath(filePath)) continue;

        if (isHelmValuesResourcePath(filePath)) {
          await recordFileTouch({
            repoId: input.repoId,
            commit,
            branch: input.branch,
            filePath,
          });

          const sources = resolveSourcesForGitFile(filePath);
          for (const source of sources) {
            storedThisCommit += await storeResourceDiff({
              repoId: input.repoId,
              commit,
              branch: input.branch,
              filePath,
              argocdApp: source.argocdApp,
              repoPath: input.repoPath,
              parentSha,
            });
          }
        }
      } catch {
        // skip malformed or template YAML files
      }
    }

    stored += storedThisCommit;

    if (storedThisCommit > 0) {
      const { linkGitChangesToResourceAudit } = await import('./git-resource-audit-join');
      await linkGitChangesToResourceAudit(input.repoId);
    }
  }

  return { stored, commitShas };
}

export async function listCommitsSince(
  repoPath: string,
  branch: string | null,
  previousSha: string | null,
  currentSha: string,
  options?: { bootstrap?: boolean }
): Promise<GitCommitInfo[]> {
  if (previousSha === currentSha) return [];

  const format = '%H|%an|%ae|%at|%s';
  let raw = '';

  try {
    if (previousSha) {
      // Commits landed since the last recorded pull (exclusive..inclusive).
      raw = await runGit(['log', `--format=${format}`, `${previousSha}..${currentSha}`], repoPath);
    } else if (options?.bootstrap) {
      // First clone — scan commits since earliest data date (newest first, capped).
      const { dataAvailableFrom } = await getResourceAuditDataWindow();
      const since = dataAvailableFrom.toISOString().slice(0, 10);
      const ref = branch ?? currentSha;
      raw = await runGit(
        [
          'log',
          `--format=${format}`,
          `--since=${since}`,
          '-n',
          String(INITIAL_COMMIT_SCAN_LIMIT),
          ref,
        ],
        repoPath
      );
    } else {
      return [];
    }
  } catch {
    return [];
  }

  if (!raw) return [];

  const seen = new Set<string>();
  const commits: GitCommitInfo[] = [];

  for (const line of raw.split('\n').filter(Boolean)) {
    const [sha, authorName, authorEmail, at, ...msgParts] = line.split('|');
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    commits.push({
      sha,
      authorName: authorName ?? 'unknown',
      authorEmail: authorEmail || null,
      committedAt: new Date(Number(at) * 1000),
      message: msgParts.join('|'),
    });
  }

  return commits.sort((a, b) => b.committedAt.getTime() - a.committedAt.getTime());
}

export async function changedFilesForCommit(repoPath: string, commitSha: string): Promise<string[]> {
  try {
    const parent = await runGit(['rev-parse', `${commitSha}^`], repoPath);
    const raw = await runGit(['diff', '--name-only', parent, commitSha], repoPath);
    return raw.split('\n').filter(Boolean);
  } catch {
    const raw = await runGit(['show', '--name-only', '--pretty=format:', commitSha], repoPath);
    return raw.split('\n').filter(Boolean);
  }
}

async function fileContentAt(repoPath: string, commitSha: string, filePath: string): Promise<string | null> {
  try {
    return await runGit(['show', `${commitSha}:${filePath}`], repoPath);
  } catch {
    return null;
  }
}

export async function processNewCommitsForRepo(input: {
  repoId: string;
  repoPath: string;
  branch: string | null;
  previousSha: string | null;
  currentSha: string;
  bootstrap?: boolean;
}): Promise<{ stored: number; commitShas: string[] }> {
  const commits = await listCommitsSince(
    input.repoPath,
    input.branch,
    input.previousSha,
    input.currentSha,
    { bootstrap: input.bootstrap }
  );

  return processCommitsForRepo({
    repoId: input.repoId,
    repoPath: input.repoPath,
    branch: input.branch,
    commits,
  });
}

export { REPLICAS_CONTAINER_MARKER };
