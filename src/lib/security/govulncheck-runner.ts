import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { toolPathEnv } from '@/lib/security/tool-path-env';
import type { SecurityResourceView } from '@/lib/security-service';
import { findGoProjectRoot, prepareRepositoryPath } from './security-repo-prep';
import { execForScanJob } from '@/lib/security-scan-exec';
import { ScanCancelledError } from '@/lib/security-scan-cancel';

const execFileAsync = promisify(execFile);
const GOVULNCHECK_TIMEOUT_MS = 15 * 60 * 1000;
const PYTHON_EXECUTABLE = 'python3';
const GOVULNCHECK_SCA_SCRIPT_PATH = path.join(
  process.cwd(),
  'scripts',
  'security',
  'generate_govulncheck_sca_report.py'
);

export interface GovulncheckScanResult {
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  dependencyCount: number;
  summary: string;
  govulncheckVersion: string;
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

async function getGovulncheckVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('govulncheck', ['-version'], {
      timeout: 8000,
      env: toolPathEnv(),
    });
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function formatExecError(err: unknown): string {
  const execErr = err as Error & { stderr?: string; stdout?: string };
  const detail = [execErr.stderr, execErr.stdout, execErr.message].filter(Boolean).join('\n').trim();
  return detail || 'govulncheck SCA report generation failed';
}

function sanitizeGovulncheckError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://***@')
    .slice(0, 800);
}

async function runGovulncheckJson(projectRoot: string, scanJobId?: string): Promise<string> {
  try {
    const { stdout } = await execForScanJob(scanJobId, 'govulncheck', ['-json', './...'], {
      cwd: projectRoot,
      maxBuffer: 50 * 1024 * 1024,
      timeout: GOVULNCHECK_TIMEOUT_MS,
      env: toolPathEnv(),
    });
    return stdout;
  } catch (err: unknown) {
    if (err instanceof ScanCancelledError) throw err;
    const execErr = err as { stdout?: string; code?: number | string; stderr?: string };
    if (typeof execErr.stdout === 'string' && execErr.stdout.trim()) {
      return execErr.stdout;
    }
    const detail = [execErr.stderr, execErr.stdout].filter(Boolean).join('\n').trim();
    throw new Error(detail || 'govulncheck scan failed');
  }
}

export async function runGovulncheckScan(input: {
  resource: SecurityResourceView;
  scanJobId?: string;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<GovulncheckScanResult> {
  const progress = input.onProgress;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    await fs.access(GOVULNCHECK_SCA_SCRIPT_PATH);
  } catch {
    throw new Error('govulncheck SCA report generator is missing from this installation.');
  }

  try {
    progress?.(8, 'Preparing repository…');
    const prepared = await prepareRepositoryPath(input.resource);
    cleanup = prepared.cleanup;
    const { repoPath, outputDir } = prepared;

    const projectRoot = await findGoProjectRoot(repoPath);
    if (!projectRoot) {
      throw new Error(
        `No go.mod found in ${input.resource.name}. govulncheck requires a Go module at the repository root.`
      );
    }

    progress?.(30, 'Downloading Go module metadata…');
    try {
      await execForScanJob(input.scanJobId, 'go', ['mod', 'download'], {
        cwd: projectRoot,
        maxBuffer: 20 * 1024 * 1024,
        timeout: GOVULNCHECK_TIMEOUT_MS,
        env: toolPathEnv(),
      });
    } catch (err) {
      if (err instanceof ScanCancelledError) throw err;
      // Non-fatal — govulncheck may still proceed with cached modules.
    }

    progress?.(45, 'Running govulncheck…');
    const auditRaw = await runGovulncheckJson(projectRoot, input.scanJobId);

    const govulncheckVersion = await getGovulncheckVersion();
    const auditJsonPath = path.join(outputDir, 'govulncheck-report.jsonl');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(auditJsonPath, auditRaw, 'utf-8');

    progress?.(72, 'Generating SCA summary report…');
    try {
      await execForScanJob(
        input.scanJobId,
        PYTHON_EXECUTABLE,
        [
          GOVULNCHECK_SCA_SCRIPT_PATH,
          auditJsonPath,
          outputDir,
          input.resource.name,
          'govulncheck',
          input.resource.repoUrl ?? '',
          govulncheckVersion,
        ],
        {
          cwd: path.dirname(GOVULNCHECK_SCA_SCRIPT_PATH),
          maxBuffer: 20 * 1024 * 1024,
          timeout: GOVULNCHECK_TIMEOUT_MS,
          env: toolPathEnv(),
        }
      );
    } catch (err) {
      if (err instanceof ScanCancelledError) throw err;
      throw new Error(formatExecError(err));
    }

    const htmlPath = path.join(outputDir, 'govulncheck_sca_summary.html');
    const jsonPath = path.join(outputDir, 'govulncheck_sca_summary.json');

    const [htmlContent, jsonRaw] = await Promise.all([
      fs.readFile(htmlPath, 'utf-8'),
      fs.readFile(jsonPath, 'utf-8'),
    ]);

    const reportJson = JSON.parse(jsonRaw) as {
      findings?: ScaFindingRow[];
      raw?: { govulncheckVersion?: string };
    };
    const rows = reportJson.findings ?? [];
    const counts = countSeverities(rows);
    const dependencyCount = rows.length;
    const summary =
      dependencyCount === 0
        ? `govulncheck completed for ${input.resource.name} — no vulnerable Go dependencies detected.`
        : `govulncheck completed for ${input.resource.name} — ${dependencyCount} vulnerable module${dependencyCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`;

    return {
      htmlContent,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      dependencyCount,
      summary,
      govulncheckVersion: reportJson.raw?.govulncheckVersion ?? govulncheckVersion,
    };
  } catch (err) {
    if (err instanceof ScanCancelledError) throw err;
    if (err instanceof Error && err.message.startsWith('Bitbucket is not connected')) {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith('No go.mod found')) {
      throw err;
    }

    const message = err instanceof Error ? err.message : 'govulncheck scan failed';
    const sanitized = formatRepositoryCloneError(err, input.resource.repoUrl ?? '');

    if (/ENOENT.*govulncheck|not found.*govulncheck/i.test(message)) {
      throw new Error(
        'govulncheck CLI is not installed or not on PATH. Install govulncheck from Security → Tools before running scans.'
      );
    }

    if (/ENOENT.*\bgo\b|not found.*\bgo\b/i.test(message)) {
      throw new Error('Go is required to run govulncheck scans. Install Go from Security → Tools.');
    }

    if (/ENOENT.*python|not found.*python/i.test(message)) {
      throw new Error('Python 3 is required to generate govulncheck SCA reports.');
    }

    if (/git clone|unable to access|403|401/i.test(message)) {
      throw new Error(sanitized);
    }

    throw new Error(sanitizeGovulncheckError(message));
  } finally {
    if (cleanup) await cleanup();
  }
}

export async function isGovulncheckAvailable(): Promise<boolean> {
  try {
    await execFileAsync('govulncheck', ['-version'], { timeout: 8000, env: toolPathEnv() });
    await execFileAsync('go', ['version'], { timeout: 8000, env: toolPathEnv() });
    await execFileAsync(PYTHON_EXECUTABLE, ['--version'], { timeout: 5000 });
    await fs.access(GOVULNCHECK_SCA_SCRIPT_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function isGoAvailable(): Promise<boolean> {
  try {
    await execFileAsync('go', ['version'], { timeout: 5000, env: toolPathEnv() });
    return true;
  } catch {
    return false;
  }
}
