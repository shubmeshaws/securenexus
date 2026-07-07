import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { toolPathEnv } from '@/lib/security/tool-path-env';
import type { SecurityResourceView } from '@/lib/security-service';
import { findPythonProjectRoot, prepareRepositoryPath } from './security-repo-prep';

const execFileAsync = promisify(execFile);
const PIP_AUDIT_TIMEOUT_MS = 15 * 60 * 1000;
const PYTHON_EXECUTABLE = 'python3';
const PIP_AUDIT_SCA_SCRIPT_PATH = path.join(
  process.cwd(),
  'scripts',
  'security',
  'generate_pip_audit_sca_report.py'
);

export interface PipAuditScanResult {
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  dependencyCount: number;
  summary: string;
  pipAuditVersion: string;
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

async function getPipAuditVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('pip-audit', ['--version'], {
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
  return detail || 'pip-audit SCA report generation failed';
}

function sanitizePipAuditError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://***@')
    .slice(0, 800);
}

async function resolvePipAuditArgs(projectRoot: string): Promise<string[]> {
  const args = ['--format=json', '--progress-spinner=off', '--desc=on'];
  if (await pathExists(path.join(projectRoot, 'requirements.txt'))) {
    return [...args, '-r', 'requirements.txt'];
  }
  if (await pathExists(path.join(projectRoot, 'requirements.in'))) {
    return [...args, '-r', 'requirements.in'];
  }
  return [...args, projectRoot];
}

async function runPipAuditJson(projectRoot: string): Promise<string> {
  const args = await resolvePipAuditArgs(projectRoot);
  try {
    const { stdout } = await execFileAsync('pip-audit', args, {
      cwd: projectRoot,
      maxBuffer: 50 * 1024 * 1024,
      timeout: PIP_AUDIT_TIMEOUT_MS,
      env: toolPathEnv(),
    });
    return stdout;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; code?: number | string; stderr?: string };
    if (typeof execErr.stdout === 'string' && execErr.stdout.trim()) {
      return execErr.stdout;
    }
    const detail = [execErr.stderr, execErr.stdout].filter(Boolean).join('\n').trim();
    throw new Error(detail || 'pip-audit scan failed');
  }
}

export async function runPipAuditScan(input: {
  resource: SecurityResourceView;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<PipAuditScanResult> {
  const progress = input.onProgress;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    await fs.access(PIP_AUDIT_SCA_SCRIPT_PATH);
  } catch {
    throw new Error('pip-audit SCA report generator is missing from this installation.');
  }

  try {
    progress?.(8, 'Preparing repository…');
    const prepared = await prepareRepositoryPath(input.resource);
    cleanup = prepared.cleanup;
    const { repoPath, outputDir } = prepared;

    const projectRoot = await findPythonProjectRoot(repoPath);
    if (!projectRoot) {
      throw new Error(
        `No Python project manifest found in ${input.resource.name}. pip-audit requires requirements.txt, pyproject.toml, Pipfile, or setup.py at the repository root.`
      );
    }

    progress?.(35, 'Running pip-audit…');
    const auditRaw = await runPipAuditJson(projectRoot);
    const parsed = JSON.parse(auditRaw) as { dependencies?: unknown[] } | unknown[];
    const hasDeps = Array.isArray(parsed)
      ? parsed.length > 0
      : Array.isArray(parsed.dependencies) && parsed.dependencies.length > 0;

    const pipAuditVersion = await getPipAuditVersion();
    const auditJsonPath = path.join(outputDir, 'pip-audit-report.json');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(auditJsonPath, auditRaw, 'utf-8');

    progress?.(72, 'Generating SCA summary report…');
    try {
      await execFileAsync(
        PYTHON_EXECUTABLE,
        [
          PIP_AUDIT_SCA_SCRIPT_PATH,
          auditJsonPath,
          outputDir,
          input.resource.name,
          'pip-audit',
          input.resource.repoUrl ?? '',
          pipAuditVersion,
        ],
        {
          cwd: path.dirname(PIP_AUDIT_SCA_SCRIPT_PATH),
          maxBuffer: 20 * 1024 * 1024,
          timeout: PIP_AUDIT_TIMEOUT_MS,
          env: toolPathEnv(),
        }
      );
    } catch (err) {
      throw new Error(formatExecError(err));
    }

    const htmlPath = path.join(outputDir, 'pip_audit_sca_summary.html');
    const jsonPath = path.join(outputDir, 'pip_audit_sca_summary.json');

    const [htmlContent, jsonRaw] = await Promise.all([
      fs.readFile(htmlPath, 'utf-8'),
      fs.readFile(jsonPath, 'utf-8'),
    ]);

    const reportJson = JSON.parse(jsonRaw) as {
      findings?: ScaFindingRow[];
      raw?: { pipAuditVersion?: string };
    };
    const rows = reportJson.findings ?? [];
    const counts = countSeverities(rows);
    const dependencyCount = rows.length;
    const summary =
      !hasDeps && dependencyCount === 0
        ? `pip-audit completed for ${input.resource.name} — no vulnerable Python dependencies detected.`
        : `pip-audit completed for ${input.resource.name} — ${dependencyCount} vulnerable package${dependencyCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`;

    return {
      htmlContent,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      dependencyCount,
      summary,
      pipAuditVersion: reportJson.raw?.pipAuditVersion ?? pipAuditVersion,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Bitbucket is not connected')) {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith('No Python project manifest')) {
      throw err;
    }

    const message = err instanceof Error ? err.message : 'pip-audit scan failed';
    const sanitized = formatRepositoryCloneError(err, input.resource.repoUrl ?? '');

    if (/ENOENT.*pip-audit|not found.*pip-audit/i.test(message)) {
      throw new Error(
        'pip-audit CLI is not installed or not on PATH. Install pip-audit from Security → Tools before running scans.'
      );
    }

    if (/ENOENT.*python|not found.*python/i.test(message)) {
      throw new Error('Python 3 is required to generate pip-audit SCA reports.');
    }

    if (/git clone|unable to access|403|401/i.test(message)) {
      throw new Error(sanitized);
    }

    throw new Error(sanitizePipAuditError(message));
  } finally {
    if (cleanup) await cleanup();
  }
}

export async function isPipAuditAvailable(): Promise<boolean> {
  try {
    await execFileAsync('pip-audit', ['--version'], { timeout: 8000, env: toolPathEnv() });
    await execFileAsync(PYTHON_EXECUTABLE, ['--version'], { timeout: 5000 });
    await fs.access(PIP_AUDIT_SCA_SCRIPT_PATH);
    return true;
  } catch {
    return false;
  }
}
