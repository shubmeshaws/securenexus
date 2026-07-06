import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import prisma from '@/lib/prisma';
import {
  buildBitbucketCloneUrl,
  getBitbucketCredentials,
  parseBitbucketRepoUrl,
} from '@/lib/bitbucket-connection';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { repoClonePath } from '@/lib/git-repositories';
import type { SecurityResourceView } from '@/lib/security-service';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

function resolveSecurityRepoRoot(): string {
  const override = process.env.SECURITY_REPO_ROOT?.trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(process.cwd(), override);
  }
  return path.join(process.cwd(), '.securenexus', 'security-repos');
}

function resolveSecurityScanRoot(): string {
  // Allow relocating ephemeral scan clones outside the project tree so Next.js's
  // dev file watcher doesn't try to watch thousands of cloned repo files (EMFILE).
  const override = process.env.SECURITY_SCAN_ROOT?.trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(process.cwd(), override);
  }
  return path.join(process.cwd(), '.securenexus', 'security-scans');
}

export const SECURITY_REPO_ROOT = resolveSecurityRepoRoot();
export const SECURITY_SCAN_ROOT = resolveSecurityScanRoot();

export interface SecurityResourceCloneStatus {
  cloned: boolean;
  clonedAt: string | null;
  lastPulledAt: string | null;
}

interface CloneMeta {
  clonedAt: string;
  lastPulledAt: string | null;
}

export function securityResourceClonePath(resourceId: string): string {
  return path.join(SECURITY_REPO_ROOT, resourceId, 'repo');
}

function cloneMetaPath(clonePath: string): string {
  return path.join(path.dirname(clonePath), 'clone-meta.json');
}

async function readCloneMeta(clonePath: string): Promise<CloneMeta | null> {
  try {
    const raw = await fs.readFile(cloneMetaPath(clonePath), 'utf-8');
    return JSON.parse(raw) as CloneMeta;
  } catch {
    return null;
  }
}

async function writeCloneMeta(clonePath: string, patch: Partial<CloneMeta> = {}): Promise<CloneMeta> {
  const existing = (await readCloneMeta(clonePath)) ?? {
    clonedAt: new Date().toISOString(),
    lastPulledAt: null,
  };
  const meta: CloneMeta = { ...existing, ...patch };
  await fs.mkdir(path.dirname(cloneMetaPath(clonePath)), { recursive: true });
  await fs.writeFile(cloneMetaPath(clonePath), JSON.stringify(meta, null, 2), 'utf-8');
  return meta;
}

export async function getSecurityResourceCloneStatus(
  resourceId: string
): Promise<SecurityResourceCloneStatus> {
  const clonePath = securityResourceClonePath(resourceId);
  const cloned = await pathExists(path.join(clonePath, '.git'));
  if (!cloned) {
    return { cloned: false, clonedAt: null, lastPulledAt: null };
  }
  const meta = await readCloneMeta(clonePath);
  return {
    cloned: true,
    clonedAt: meta?.clonedAt ?? null,
    lastPulledAt: meta?.lastPulledAt ?? null,
  };
}

export async function removeSecurityResourceClone(resourceId: string): Promise<void> {
  const resourceDir = path.join(SECURITY_REPO_ROOT, resourceId);
  await fs.rm(resourceDir, { recursive: true, force: true });
}

export async function cloneSecurityResourceRepo(
  resource: SecurityResourceView
): Promise<SecurityResourceCloneStatus> {
  if (resource.type !== 'repository' || !resource.repoUrl?.trim()) {
    throw new Error('Only repository resources can be cloned');
  }

  const clonePath = securityResourceClonePath(resource.id);
  await removeSecurityResourceClone(resource.id);
  await fs.mkdir(clonePath, { recursive: true });

  try {
    await cloneRepository(resource.repoUrl.trim(), clonePath, resource.defaultBranch);
    await writeCloneMeta(clonePath, {
      clonedAt: new Date().toISOString(),
      lastPulledAt: null,
    });
  } catch (err) {
    await removeSecurityResourceClone(resource.id);
    throw new Error(formatRepositoryCloneError(err, resource.repoUrl));
  }

  return getSecurityResourceCloneStatus(resource.id);
}

export async function pullSecurityResourceRepo(
  resource: SecurityResourceView
): Promise<SecurityResourceCloneStatus> {
  if (resource.type !== 'repository' || !resource.repoUrl?.trim()) {
    throw new Error('Only repository resources can be pulled');
  }

  const clonePath = securityResourceClonePath(resource.id);
  if (!(await pathExists(path.join(clonePath, '.git')))) {
    throw new Error(`"${resource.name}" is not cloned yet. Click Clone first.`);
  }

  try {
    await pullCloneStrict(clonePath, resource.defaultBranch);
    await writeCloneMeta(clonePath, { lastPulledAt: new Date().toISOString() });
  } catch (err) {
    throw new Error(formatRepositoryCloneError(err, resource.repoUrl));
  }

  return getSecurityResourceCloneStatus(resource.id);
}

async function pullCloneStrict(clonePath: string, branch?: string | null): Promise<void> {
  const branchName = branch?.trim();
  if (branchName) {
    await runGit(['fetch', 'origin', branchName, '--depth', '1'], clonePath);
    await runGit(['checkout', branchName], clonePath);
  }
  await runGit(['pull', '--ff-only'], clonePath);
}

export interface PreparedRepository {
  repoPath: string;
  outputDir: string;
  cleanup: () => Promise<void>;
}

async function runGit(args: string[], cwd?: string): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 20 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveCloneUrl(repoUrl: string): Promise<string> {
  const parsed = parseBitbucketRepoUrl(repoUrl);
  if (!parsed) return repoUrl.trim();

  const creds = await getBitbucketCredentials();
  if (!creds) {
    throw new Error('Bitbucket is not connected. Configure it under Admin → Settings.');
  }

  return buildBitbucketCloneUrl(creds, parsed.workspace, parsed.repoSlug);
}

async function findExistingSyncedClone(repoUrl: string): Promise<string | null> {
  const parsed = parseBitbucketRepoUrl(repoUrl);
  if (!parsed) return null;

  const gitRepo = await prisma.gitRepository.findFirst({
    where: {
      workspace: parsed.workspace,
      repoSlug: parsed.repoSlug,
    },
  });

  const clonePath = gitRepo?.clonePath ?? repoClonePath(parsed.workspace, parsed.repoSlug);
  if (!(await pathExists(path.join(clonePath, '.git')))) {
    return null;
  }

  return clonePath;
}

async function refreshExistingClone(clonePath: string, branch?: string | null): Promise<void> {
  const branchName = branch?.trim();
  try {
    if (branchName) {
      await runGit(['fetch', 'origin', branchName, '--depth', '1'], clonePath);
      await runGit(['checkout', branchName], clonePath);
    }
    await runGit(['pull', '--ff-only'], clonePath);
  } catch {
    // Scan against the last synced copy if refresh fails.
  }
}

async function cloneRepository(
  repoUrl: string,
  clonePath: string,
  branch?: string | null
): Promise<void> {
  const cloneUrl = await resolveCloneUrl(repoUrl);
  const branchName = branch?.trim();

  if (branchName) {
    try {
      await runGit([
        'clone',
        '--depth',
        '1',
        '--branch',
        branchName,
        '--single-branch',
        cloneUrl,
        clonePath,
      ]);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (!/403|401|could not find remote branch|Remote branch/i.test(message)) {
        throw err;
      }
    }
  }

  await runGit(['clone', '--depth', '1', cloneUrl, clonePath]);
}

export async function prepareRepositoryPath(
  resource: SecurityResourceView
): Promise<PreparedRepository> {
  if (resource.type !== 'repository' || !resource.repoUrl?.trim()) {
    throw new Error('Repository scans require a repository resource with a valid URL');
  }

  const repoUrl = resource.repoUrl.trim();
  const outputDir = path.join(SECURITY_SCAN_ROOT, resource.id, Date.now().toString(), 'output');

  const persistentClone = securityResourceClonePath(resource.id);
  if (await pathExists(path.join(persistentClone, '.git'))) {
    try {
      await refreshExistingClone(persistentClone, resource.defaultBranch);
      await writeCloneMeta(persistentClone, { lastPulledAt: new Date().toISOString() });
    } catch {
      // Scan against last pulled copy if refresh fails.
    }
    await fs.mkdir(outputDir, { recursive: true });
    return {
      repoPath: persistentClone,
      outputDir,
      cleanup: async () => {
        await fs.rm(path.dirname(outputDir), { recursive: true, force: true });
      },
    };
  }

  const existingClone = await findExistingSyncedClone(repoUrl);
  if (existingClone) {
    await refreshExistingClone(existingClone, resource.defaultBranch);
    await fs.mkdir(outputDir, { recursive: true });
    return {
      repoPath: existingClone,
      outputDir,
      cleanup: async () => {
        await fs.rm(path.dirname(outputDir), { recursive: true, force: true });
      },
    };
  }

  throw new Error(
    `"${resource.name}" is not cloned yet. Go to Security → Add resources and click Clone, then run the scan again.`
  );
}

export async function findNpmProjectRoot(repoPath: string): Promise<string | null> {
  if (await pathExists(path.join(repoPath, 'package.json'))) {
    return repoPath;
  }
  return null;
}
