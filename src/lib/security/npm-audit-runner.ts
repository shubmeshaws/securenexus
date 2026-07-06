import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { toolPathEnv } from '@/lib/security/tool-path-env';
import type { SecurityResourceView } from '@/lib/security-service';
import { findNpmProjectRoot, prepareRepositoryPath } from './security-repo-prep';

const execFileAsync = promisify(execFile);
const NPM_AUDIT_TIMEOUT_MS = 10 * 60 * 1000;
const NPM_LOCKFILE_TIMEOUT_MS = 5 * 60 * 1000;
const PYTHON_EXECUTABLE = 'python3';
const NPM_SCA_SCRIPT_PATH = path.join(
  process.cwd(),
  'scripts',
  'security',
  'generate_npm_sca_report.py'
);

export interface NpmAuditScanResult {
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  dependencyCount: number;
  summary: string;
  npmVersion: string;
}

interface ScaFindingRow {
  severity: string;
}

function countSeverities(rows: ScaFindingRow[]): {
  high: number;
  medium: number;
  low: number;
} {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const row of rows) {
    const sev = row.severity.toLowerCase();
    if (sev === 'high' || sev === 'critical') high += 1;
    else if (sev === 'medium' || sev === 'moderate') medium += 1;
    else low += 1;
  }
  return { high, medium, low };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function getNpmVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('npm', ['--version'], {
      timeout: 5000,
      env: toolPathEnv(),
    });
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function ensureLockfile(projectRoot: string): Promise<void> {
  const hasLockfile =
    (await pathExists(path.join(projectRoot, 'package-lock.json'))) ||
    (await pathExists(path.join(projectRoot, 'npm-shrinkwrap.json')));

  if (hasLockfile) return;

  await execFileAsync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
    cwd: projectRoot,
    maxBuffer: 20 * 1024 * 1024,
    timeout: NPM_LOCKFILE_TIMEOUT_MS,
    env: toolPathEnv(),
  });
}

async function runNpmAuditJson(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('npm', ['audit', '--json'], {
      cwd: projectRoot,
      maxBuffer: 50 * 1024 * 1024,
      timeout: NPM_AUDIT_TIMEOUT_MS,
      env: toolPathEnv(),
    });
    return stdout;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; code?: number | string };
    if (typeof execErr.stdout === 'string' && execErr.stdout.trim()) {
      return execErr.stdout;
    }
    throw err;
  }
}

function formatExecError(err: unknown): string {
  const execErr = err as Error & { stderr?: string; stdout?: string };
  const detail = [execErr.stderr, execErr.stdout, execErr.message].filter(Boolean).join('\n').trim();
  return detail || 'npm SCA report generation failed';
}

function sanitizeNpmAuditError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://***@')
    .replace(/ATATT[A-Za-z0-9+/=%_-]+/g, '***')
    .slice(0, 800);
}

export async function runNpmAuditScan(input: {
  resource: SecurityResourceView;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<NpmAuditScanResult> {
  const progress = input.onProgress;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    await fs.access(NPM_SCA_SCRIPT_PATH);
  } catch {
    throw new Error('npm SCA report generator is missing from this installation.');
  }

  try {
    progress?.(8, 'Preparing repository…');
    const prepared = await prepareRepositoryPath(input.resource);
    cleanup = prepared.cleanup;
    const { repoPath, outputDir } = prepared;

    const projectRoot = await findNpmProjectRoot(repoPath);
    if (!projectRoot) {
      throw new Error(
        `No package.json found in ${input.resource.name}. npm audit requires a Node.js project at the repository root.`
      );
    }

    progress?.(22, 'Resolving dependency lockfile…');
    await ensureLockfile(projectRoot);

    progress?.(38, 'Running npm audit…');
    const auditRaw = await runNpmAuditJson(projectRoot);
    const parsed = JSON.parse(auditRaw) as { error?: { summary?: string } };

    if (parsed.error?.summary) {
      throw new Error(parsed.error.summary);
    }

    const npmVersion = await getNpmVersion();
    const auditJsonPath = path.join(outputDir, 'npm-audit-report.json');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(auditJsonPath, auditRaw, 'utf-8');

    progress?.(72, 'Generating SCA summary report…');
    try {
      await execFileAsync(
        PYTHON_EXECUTABLE,
        [
          NPM_SCA_SCRIPT_PATH,
          auditJsonPath,
          projectRoot,
          outputDir,
          input.resource.name,
          'npm audit',
          input.resource.repoUrl ?? '',
          npmVersion,
        ],
        {
          maxBuffer: 20 * 1024 * 1024,
          timeout: NPM_AUDIT_TIMEOUT_MS,
          env: toolPathEnv(),
        }
      );
    } catch (err) {
      throw new Error(formatExecError(err));
    }

    const htmlPath = path.join(outputDir, 'npm_sca_summary.html');
    const jsonPath = path.join(outputDir, 'npm_sca_summary.json');

    const [htmlContent, jsonRaw] = await Promise.all([
      fs.readFile(htmlPath, 'utf-8'),
      fs.readFile(jsonPath, 'utf-8'),
    ]);

    const reportJson = JSON.parse(jsonRaw) as {
      findings?: ScaFindingRow[];
      raw?: { npmVersion?: string };
    };
    const rows = reportJson.findings ?? [];
    const counts = countSeverities(rows);
    const dependencyCount = rows.length;
    const summary =
      dependencyCount === 0
        ? `npm audit completed for ${input.resource.name} — no vulnerable dependencies detected.`
        : `npm audit completed for ${input.resource.name} — ${dependencyCount} vulnerable package${dependencyCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} moderate, ${counts.low} low).`;

    return {
      htmlContent,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      dependencyCount,
      summary,
      npmVersion: reportJson.raw?.npmVersion ?? npmVersion,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Bitbucket is not connected')) {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith('No package.json found')) {
      throw err;
    }

    const message = err instanceof Error ? err.message : 'npm audit scan failed';
    const sanitized = formatRepositoryCloneError(err, input.resource.repoUrl ?? '');

    if (/ENOENT.*npm|not found.*npm/i.test(message)) {
      throw new Error(
        'npm CLI is not installed or not on PATH. Install Node.js/npm before running npm audit scans.'
      );
    }

    if (/ENOENT.*python|not found.*python/i.test(message)) {
      throw new Error('Python 3 is required to generate npm SCA reports.');
    }

    if (/git clone|unable to access|403|401/i.test(message)) {
      throw new Error(sanitized);
    }

    throw new Error(sanitizeNpmAuditError(message));
  } finally {
    if (cleanup) await cleanup();
  }
}

export async function isNpmAuditAvailable(): Promise<boolean> {
  try {
    await execFileAsync('npm', ['--version'], { timeout: 5000, env: toolPathEnv() });
    await execFileAsync(PYTHON_EXECUTABLE, ['--version'], { timeout: 5000 });
    await fs.access(NPM_SCA_SCRIPT_PATH);
    return true;
  } catch {
    return false;
  }
}
