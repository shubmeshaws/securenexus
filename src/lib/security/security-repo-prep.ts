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

function resolveSecurityScanRoot(): string {
  // Allow relocating ephemeral scan clones outside the project tree so Next.js's
  // dev file watcher doesn't try to watch thousands of cloned repo files (EMFILE).
  const override = process.env.SECURITY_SCAN_ROOT?.trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(process.cwd(), override);
  }
  return path.join(process.cwd(), '.securenexus', 'security-scans');
}

export const SECURITY_SCAN_ROOT = resolveSecurityScanRoot();

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
  const scanDir = path.join(SECURITY_SCAN_ROOT, resource.id, Date.now().toString());
  const outputDir = path.join(scanDir, 'output');

  const existingClone = await findExistingSyncedClone(repoUrl);
  if (existingClone) {
    await refreshExistingClone(existingClone, resource.defaultBranch);
    await fs.mkdir(outputDir, { recursive: true });
    return {
      repoPath: existingClone,
      outputDir,
      cleanup: async () => {
        await fs.rm(scanDir, { recursive: true, force: true });
      },
    };
  }

  const repoPath = path.join(scanDir, 'repo');

  try {
    await fs.mkdir(scanDir, { recursive: true });
    await cloneRepository(repoUrl, repoPath, resource.defaultBranch);
    await fs.mkdir(outputDir, { recursive: true });
  } catch (err) {
    await fs.rm(scanDir, { recursive: true, force: true });
    throw new Error(formatRepositoryCloneError(err, repoUrl));
  }

  return {
    repoPath,
    outputDir,
    cleanup: async () => {
      await fs.rm(scanDir, { recursive: true, force: true });
    },
  };
}

export async function findNpmProjectRoot(repoPath: string): Promise<string | null> {
  if (await pathExists(path.join(repoPath, 'package.json'))) {
    return repoPath;
  }
  return null;
}
