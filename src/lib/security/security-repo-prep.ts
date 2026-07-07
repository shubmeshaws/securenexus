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
const GIT_TIMEOUT_MS = 15 * 60 * 1000;
const CLONE_DEPTH = '200';

function resolveSecurityRepoRoot(): string {
  const override = process.env.SECURITY_REPO_ROOT?.trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(process.cwd(), override);
  }
  return path.join(process.cwd(), '.securenexus', 'security-repos');
}

function resolveSecurityScanRoot(): string {
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

function resolveBranch(defaultBranch: string | null | undefined): string {
  const branch = defaultBranch?.trim();
  return branch || 'main';
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

const CLONE_STATUS_CACHE_TTL_MS = 60_000;
const cloneStatusCache = new Map<
  string,
  { at: number; status: SecurityResourceCloneStatus }
>();

export function invalidateSecurityResourceCloneStatusCache(resourceId?: string): void {
  if (resourceId) {
    cloneStatusCache.delete(resourceId);
    return;
  }
  cloneStatusCache.clear();
}

export async function getSecurityResourceCloneStatus(
  resourceId: string
): Promise<SecurityResourceCloneStatus> {
  const cached = cloneStatusCache.get(resourceId);
  if (cached && Date.now() - cached.at < CLONE_STATUS_CACHE_TTL_MS) {
    return cached.status;
  }

  const clonePath = securityResourceClonePath(resourceId);
  const cloned = await pathExists(path.join(clonePath, '.git'));
  if (!cloned) {
    const status: SecurityResourceCloneStatus = {
      cloned: false,
      clonedAt: null,
      lastPulledAt: null,
    };
    cloneStatusCache.set(resourceId, { at: Date.now(), status });
    return status;
  }

  const meta = await readCloneMeta(clonePath);
  const status: SecurityResourceCloneStatus = {
    cloned: true,
    clonedAt: meta?.clonedAt ?? null,
    lastPulledAt: meta?.lastPulledAt ?? null,
  };
  cloneStatusCache.set(resourceId, { at: Date.now(), status });
  return status;
}

export async function getSecurityResourceCloneStatuses(
  resourceIds: string[]
): Promise<Map<string, SecurityResourceCloneStatus>> {
  const statuses = new Map<string, SecurityResourceCloneStatus>();
  if (!resourceIds.length) return statuses;

  await Promise.all(
    resourceIds.map(async (resourceId) => {
      statuses.set(resourceId, await getSecurityResourceCloneStatus(resourceId));
    })
  );
  return statuses;
}

export async function removeSecurityResourceClone(resourceId: string): Promise<void> {
  const resourceDir = path.join(SECURITY_REPO_ROOT, resourceId);
  await fs.rm(resourceDir, { recursive: true, force: true });
  invalidateSecurityResourceCloneStatusCache(resourceId);
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 20 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    return `${stdout}\n${stderr}`.trim();
  } catch (err) {
    const execErr = err as Error & { stderr?: string; stdout?: string; killed?: boolean; signal?: string };
    if (execErr.killed || execErr.signal === 'SIGTERM') {
      throw new Error(`Git operation timed out after ${GIT_TIMEOUT_MS / 60_000} minutes.`);
    }
    const detail = [execErr.stderr, execErr.stdout, execErr.message].filter(Boolean).join('\n');
    throw new Error(detail || 'Git command failed');
  }
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

async function performSecurityClone(
  repoUrl: string,
  clonePath: string,
  branch: string,
  onProgress?: (message: string) => void
): Promise<void> {
  onProgress?.('Resolving Bitbucket credentials…');
  const cloneUrl = await resolveCloneUrl(repoUrl);

  onProgress?.(`Cloning branch ${branch}…`);
  try {
    await runGit(
      ['clone', '--depth', CLONE_DEPTH, '--branch', branch, '--single-branch', cloneUrl, clonePath]
    );
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (!/could not find remote branch|Remote branch|not found in upstream/i.test(message)) {
      throw err;
    }
  }

  onProgress?.(`Branch ${branch} not found on remote; cloning default branch…`);
  await runGit(['clone', '--depth', CLONE_DEPTH, cloneUrl, clonePath]);
  try {
    await runGit(['checkout', branch], clonePath);
  } catch {
    // Use whatever branch was cloned by default.
  }
}

async function performSecurityPull(
  repoUrl: string,
  clonePath: string,
  branch: string,
  onProgress?: (message: string) => void
): Promise<void> {
  onProgress?.('Refreshing remote credentials…');
  const cloneUrl = await resolveCloneUrl(repoUrl);

  await runGit(['remote', 'set-url', 'origin', cloneUrl], clonePath);

  const currentBranch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], clonePath)).trim();
  if (currentBranch !== branch) {
    onProgress?.(`Checking out ${branch}…`);
    await runGit(['fetch', 'origin', branch, '--depth', CLONE_DEPTH], clonePath);
    await runGit(['checkout', branch], clonePath);
  }

  onProgress?.('Pulling latest commits…');
  await runGit(['pull', '--ff-only', 'origin', branch], clonePath);
}

export async function cloneSecurityResourceRepo(
  resource: SecurityResourceView,
  onProgress?: (message: string) => void
): Promise<SecurityResourceCloneStatus> {
  if (resource.type !== 'repository' || !resource.repoUrl?.trim()) {
    throw new Error('Only repository resources can be cloned');
  }

  const clonePath = securityResourceClonePath(resource.id);
  const branch = resolveBranch(resource.defaultBranch);
  const repoUrl = resource.repoUrl.trim();

  await removeSecurityResourceClone(resource.id);
  await fs.mkdir(path.dirname(clonePath), { recursive: true });

  try {
    await performSecurityClone(repoUrl, clonePath, branch, onProgress);
    if (!(await pathExists(path.join(clonePath, '.git')))) {
      throw new Error('Git clone finished but .git directory was not created.');
    }
    await writeCloneMeta(clonePath, {
      clonedAt: new Date().toISOString(),
      lastPulledAt: null,
    });
  } catch (err) {
    await removeSecurityResourceClone(resource.id);
    throw new Error(formatRepositoryCloneError(err, repoUrl));
  }

  return getSecurityResourceCloneStatus(resource.id);
}

export async function pullSecurityResourceRepo(
  resource: SecurityResourceView,
  onProgress?: (message: string) => void
): Promise<SecurityResourceCloneStatus> {
  if (resource.type !== 'repository' || !resource.repoUrl?.trim()) {
    throw new Error('Only repository resources can be pulled');
  }

  const clonePath = securityResourceClonePath(resource.id);
  if (!(await pathExists(path.join(clonePath, '.git')))) {
    throw new Error(`"${resource.name}" is not cloned yet. Click Clone first.`);
  }

  const branch = resolveBranch(resource.defaultBranch);
  const repoUrl = resource.repoUrl.trim();

  try {
    await performSecurityPull(repoUrl, clonePath, branch, onProgress);
    await writeCloneMeta(clonePath, { lastPulledAt: new Date().toISOString() });
  } catch (err) {
    throw new Error(formatRepositoryCloneError(err, repoUrl));
  }

  return getSecurityResourceCloneStatus(resource.id);
}

export interface PreparedRepository {
  repoPath: string;
  outputDir: string;
  cleanup: () => Promise<void>;
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

async function refreshExistingClone(
  repoUrl: string,
  clonePath: string,
  branch?: string | null
): Promise<void> {
  const branchName = resolveBranch(branch);
  try {
    await performSecurityPull(repoUrl, clonePath, branchName);
  } catch {
    // Scan against the last synced copy if refresh fails.
  }
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
    await refreshExistingClone(repoUrl, persistentClone, resource.defaultBranch);
    await writeCloneMeta(persistentClone, { lastPulledAt: new Date().toISOString() });
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
    await refreshExistingClone(repoUrl, existingClone, resource.defaultBranch);
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

const PYTHON_PROJECT_MARKERS = [
  'requirements.txt',
  'requirements.in',
  'pyproject.toml',
  'Pipfile',
  'setup.py',
  'setup.cfg',
] as const;

export async function findPythonProjectRoot(repoPath: string): Promise<string | null> {
  for (const marker of PYTHON_PROJECT_MARKERS) {
    if (await pathExists(path.join(repoPath, marker))) {
      return repoPath;
    }
  }
  return null;
}

export async function findGoProjectRoot(repoPath: string): Promise<string | null> {
  if (await pathExists(path.join(repoPath, 'go.mod'))) {
    return repoPath;
  }
  return null;
}
