import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { resolveSemgrepBin, semgrepScanEnv, toolPathEnv } from '@/lib/security/tool-path-env';
import type { SecurityResourceView } from '@/lib/security-service';
import { prepareRepositoryPath } from './security-repo-prep';
import { execForScanJob } from '@/lib/security-scan-exec';
import { ScanCancelledError } from '@/lib/security-scan-cancel';

const execFileAsync = promisify(execFile);
const SEMGREP_TIMEOUT_MS = 15 * 60 * 1000;
const PYTHON_EXECUTABLE = 'python3';
const SEMGREP_SCRIPT_PATH = path.join(
  process.cwd(),
  'scripts',
  'security',
  'generate_semgrep_report.py'
);

export interface SemgrepScanResult {
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findingCount: number;
  summary: string;
  semgrepVersion: string;
}

interface SemgrepFindingRow {
  severity: string;
}

function countSeverities(rows: SemgrepFindingRow[]): {
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
    else if (sev === 'medium') medium += 1;
    else low += 1;
  }
  return { high, medium, low };
}

export async function runSemgrepScan(input: {
  resource: SecurityResourceView;
  scanJobId?: string;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<SemgrepScanResult> {
  const progress = input.onProgress;
  try {
    await fs.access(SEMGREP_SCRIPT_PATH);
  } catch {
    throw new Error('Semgrep report generator is missing from this installation.');
  }

  let cleanup: (() => Promise<void>) | null = null;

  try {
    progress?.(8, 'Preparing repository…');
    const prepared = await prepareRepositoryPath(input.resource);
    cleanup = prepared.cleanup;
    const { repoPath, outputDir } = prepared;

    progress?.(18, 'Locating Semgrep CLI…');
    await resolveSemgrepBin();

    progress?.(22, 'Running Semgrep analysis…');
    const scanEnv = await semgrepScanEnv();
    try {
      await execForScanJob(
        input.scanJobId,
        PYTHON_EXECUTABLE,
        [
          SEMGREP_SCRIPT_PATH,
          repoPath,
          outputDir,
          input.resource.name,
          'Semgrep CE',
          input.resource.repoUrl ?? '',
        ],
        {
          maxBuffer: 50 * 1024 * 1024,
          timeout: SEMGREP_TIMEOUT_MS,
          env: scanEnv,
        }
      );
    } catch (err) {
      if (err instanceof ScanCancelledError) throw err;
      throw new Error(formatExecError(err));
    }

    progress?.(78, 'Processing Semgrep results…');
    const htmlPath = path.join(outputDir, 'semgrep_sast_summary.html');
    const jsonPath = path.join(outputDir, 'semgrep_sast_summary.json');

    const [htmlContent, jsonRaw] = await Promise.all([
      fs.readFile(htmlPath, 'utf-8'),
      fs.readFile(jsonPath, 'utf-8'),
    ]);

    const parsed = JSON.parse(jsonRaw) as {
      findings?: SemgrepFindingRow[];
      raw?: { version?: string };
    };
    const rows = parsed.findings ?? [];
    const counts = countSeverities(rows);
    const semgrepVersion = parsed.raw?.version ?? 'unknown';
    const findingCount = rows.length;

    progress?.(92, 'Finalizing SAST report…');
    const summary =
      findingCount === 0
        ? `Semgrep scan completed for ${input.resource.name} — no findings detected.`
        : `Semgrep scan completed for ${input.resource.name} — ${findingCount} finding${findingCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`;

    return {
      htmlContent,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      findingCount,
      summary,
      semgrepVersion,
    };
  } catch (err) {
    if (err instanceof ScanCancelledError) throw err;
    if (err instanceof Error && err.message.startsWith('Cannot access')) {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith('Bitbucket is not connected')) {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith('Failed to prepare repository')) {
      throw err;
    }

    const message = err instanceof Error ? err.message : 'Semgrep scan failed';
    const sanitized = formatRepositoryCloneError(err, input.resource.repoUrl ?? '');

    if (/ENOENT.*semgrep/i.test(message) || /not found.*semgrep/i.test(message)) {
      throw new Error(
        'Semgrep CLI is not installed or not on PATH. Install Semgrep before running live scans.'
      );
    }

    if (/git clone|unable to access|403|401/i.test(message)) {
      throw new Error(sanitized);
    }

    throw new Error(sanitizeSemgrepError(message));
  } finally {
    if (cleanup) await cleanup();
  }
}

function formatExecError(err: unknown): string {
  const execErr = err as Error & { stderr?: string; stdout?: string; killed?: boolean; signal?: string };
  if (execErr.killed || execErr.signal === 'SIGTERM') {
    return `Semgrep scan timed out after ${SEMGREP_TIMEOUT_MS / 60_000} minutes.`;
  }

  const detail = [execErr.stderr, execErr.stdout, execErr.message]
    .filter((part) => typeof part === 'string' && part.trim())
    .join('\n')
    .trim();

  return detail || 'Semgrep scan failed';
}

function sanitizeSemgrepError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://***@')
    .replace(/ATATT[A-Za-z0-9+/=%_-]+/g, '***')
    .slice(0, 800);
}

export async function isSemgrepAvailable(): Promise<boolean> {
  try {
    await execFileAsync(PYTHON_EXECUTABLE, ['--version'], { timeout: 5000 });
    await fs.access(SEMGREP_SCRIPT_PATH);
    await execFileAsync('semgrep', ['--version'], { timeout: 5000, env: toolPathEnv() });
    return true;
  } catch {
    return false;
  }
}
