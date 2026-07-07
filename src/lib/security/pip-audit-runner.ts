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

/**
 * Cap native build parallelism. If pip-audit ever has to build a source
 * distribution (e.g. pandas/numpy C extensions when no matching wheel exists),
 * these limit the compiler/ninja/cmake job count to a single core so the scan
 * cannot saturate every CPU or OOM-crash the meson build.
 */
function buildLimitedEnv(): NodeJS.ProcessEnv {
  return {
    ...toolPathEnv(),
    MAKEFLAGS: '-j1',
    MAX_JOBS: '1',
    CMAKE_BUILD_PARALLEL_LEVEL: '1',
    NPY_NUM_BUILD_JOBS: '1',
    NINJAFLAGS: '-j1',
    OMP_NUM_THREADS: '1',
    // Prefer already-built wheels; avoid compiling from source where possible.
    PIP_ONLY_BINARY: ':all:',
    PIP_PREFER_BINARY: '1',
  };
}

async function collectRequirementFiles(projectRoot: string): Promise<string[]> {
  const candidates = ['requirements.txt', 'requirements.in', 'requirements-dev.txt'];
  const found: string[] = [];
  for (const file of candidates) {
    if (await pathExists(path.join(projectRoot, file))) {
      found.push(file);
    }
  }
  return found;
}

const BASE_PIP_AUDIT_ARGS = ['--format=json', '--progress-spinner=off', '--desc=on'];

const PINNED_REQUIREMENT_RE =
  /^\s*([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]+\])?)\s*==\s*([^\s;#\\]+)/;

interface PinnedRequirements {
  filePath: string | null;
  pinnedCount: number;
  skippedCount: number;
}

/**
 * Build a requirements file containing ONLY exactly-pinned entries
 * (`name==version`), stripping markers, hashes, URLs, and unpinned lines.
 *
 * This lets us run `pip-audit --no-deps` against a guaranteed-pinned file so
 * pip-audit never invokes pip's resolver/installer — which is what triggers
 * source builds (pandas/numpy) and Python-version mismatches like
 * `pandas==2.1.4` not existing for Python 3.14.
 */
async function writePinnedRequirements(
  projectRoot: string,
  requirementFiles: string[],
  outFile: string
): Promise<PinnedRequirements> {
  const pinned = new Map<string, string>();
  let skipped = 0;

  for (const file of requirementFiles) {
    let content: string;
    try {
      content = await fs.readFile(path.join(projectRoot, file), 'utf-8');
    } catch {
      continue;
    }

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;

      const match = PINNED_REQUIREMENT_RE.exec(line);
      if (match) {
        const name = match[1];
        const version = match[2];
        pinned.set(name.toLowerCase(), `${name}==${version}`);
      } else {
        skipped += 1;
      }
    }
  }

  if (pinned.size === 0) {
    return { filePath: null, pinnedCount: 0, skippedCount: skipped };
  }

  const body = `${Array.from(pinned.values()).join('\n')}\n`;
  await fs.writeFile(outFile, body, 'utf-8');
  return { filePath: outFile, pinnedCount: pinned.size, skippedCount: skipped };
}

async function runPipAudit(projectRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('pip-audit', [...BASE_PIP_AUDIT_ARGS, ...args], {
    cwd: projectRoot,
    maxBuffer: 50 * 1024 * 1024,
    timeout: PIP_AUDIT_TIMEOUT_MS,
    env: buildLimitedEnv(),
  });
  return stdout;
}

function extractStdout(err: unknown): string | null {
  const execErr = err as { stdout?: string };
  return typeof execErr.stdout === 'string' && execErr.stdout.trim() ? execErr.stdout : null;
}

function execErrorDetail(err: unknown): string {
  return [(err as { stderr?: string }).stderr, (err as { stdout?: string }).stdout]
    .filter(Boolean)
    .join('\n')
    .trim();
}

export interface PipAuditRunResult {
  raw: string;
  pinnedCount: number;
  skippedCount: number;
  mode: 'pinned' | 'project';
}

/**
 * Audit strategy designed to avoid pip's resolver/installer entirely:
 *
 * 1. If requirement files exist, extract only exactly-pinned entries into a temp
 *    file and run `pip-audit -r <pinned> --no-deps`. No resolution, no downloads,
 *    no source builds, and immune to interpreter-version wheel mismatches.
 * 2. If nothing is pinned but a project definition exists (pyproject.toml,
 *    Pipfile, setup.py), fall back to a build-parallelism-capped project audit.
 */
async function runPipAuditJson(
  projectRoot: string,
  outputDir: string
): Promise<PipAuditRunResult> {
  const requirementFiles = await collectRequirementFiles(projectRoot);

  if (requirementFiles.length) {
    await fs.mkdir(outputDir, { recursive: true });
    const pinnedFile = path.join(outputDir, 'pinned-requirements.txt');
    const pinned = await writePinnedRequirements(projectRoot, requirementFiles, pinnedFile);

    if (pinned.filePath) {
      try {
        const raw = await runPipAudit(projectRoot, ['-r', pinned.filePath, '--no-deps']);
        return {
          raw,
          pinnedCount: pinned.pinnedCount,
          skippedCount: pinned.skippedCount,
          mode: 'pinned',
        };
      } catch (err) {
        const salvaged = extractStdout(err);
        if (salvaged) {
          return {
            raw: salvaged,
            pinnedCount: pinned.pinnedCount,
            skippedCount: pinned.skippedCount,
            mode: 'pinned',
          };
        }
        throw new Error(execErrorDetail(err) || 'pip-audit scan failed');
      }
    }

    // No pinned entries found — fall through to a project audit if possible.
  }

  try {
    const raw = await runPipAudit(projectRoot, [projectRoot]);
    return { raw, pinnedCount: 0, skippedCount: 0, mode: 'project' };
  } catch (err) {
    const salvaged = extractStdout(err);
    if (salvaged) return { raw: salvaged, pinnedCount: 0, skippedCount: 0, mode: 'project' };
    throw new Error(execErrorDetail(err) || 'pip-audit scan failed');
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

    progress?.(35, 'Running pip-audit (pinned, build-limited)…');
    await fs.mkdir(outputDir, { recursive: true });
    const auditRun = await runPipAuditJson(projectRoot, outputDir);
    const auditRaw = auditRun.raw;
    const parsed = JSON.parse(auditRaw) as { dependencies?: unknown[] } | unknown[];
    const hasDeps = Array.isArray(parsed)
      ? parsed.length > 0
      : Array.isArray(parsed.dependencies) && parsed.dependencies.length > 0;

    const pipAuditVersion = await getPipAuditVersion();
    const auditJsonPath = path.join(outputDir, 'pip-audit-report.json');
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
    const skippedNote =
      auditRun.mode === 'pinned' && auditRun.skippedCount > 0
        ? ` ${auditRun.skippedCount} unpinned entr${auditRun.skippedCount === 1 ? 'y was' : 'ies were'} skipped (pin them with == to include).`
        : '';
    const summary =
      !hasDeps && dependencyCount === 0
        ? `pip-audit completed for ${input.resource.name} — no vulnerable Python dependencies detected.${skippedNote}`
        : `pip-audit completed for ${input.resource.name} — ${dependencyCount} vulnerable package${dependencyCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).${skippedNote}`;

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

    if (/meson|subprocess-exited-with-error|Preparing metadata|Building wheel|internal pip failure/i.test(message)) {
      throw new Error(
        `pip-audit could not resolve ${input.resource.name} without building a dependency from source (this is CPU-heavy). Pin dependency versions in requirements.txt so pip-audit can scan them directly without building. Details: ${sanitizePipAuditError(message)}`
      );
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
