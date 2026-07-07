import { execFile, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { toolPathEnv } from '@/lib/security/tool-path-env';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { getSecurityToolById } from '@/lib/security-tools';
import type { SecurityResourceView } from '@/lib/security-service';
import { prepareRepositoryPath, findNpmProjectRoot } from './security-repo-prep';

const execFileAsync = promisify(execFile);
const SNYK_SCAN_TIMEOUT_MS = 15 * 60 * 1000;

// Legacy token flow prints an app.snyk.io/login?token=... URL and polls for
// completion (no localhost callback). OAuth flow uses a 127.0.0.1:8080 callback
// which only works when the browser runs on the same host as the CLI.
const LOGIN_URL_PATTERN = /https:\/\/[^\s]*snyk\.io\/login\?token=[^\s]+/;
const OAUTH_URL_PATTERN = /https:\/\/app\.snyk\.io\/oauth2\/authorize[^\s]+/;

// Use the Snyk CLI's default config location (same place `snyk auth` writes and
// where an already-authenticated machine stores its token). Overriding
// XDG_CONFIG_HOME here would hide an existing `snyk auth` session.
export function snykEnv(): NodeJS.ProcessEnv {
  const env = toolPathEnv();
  if (process.env.SNYK_CFG_ORG) {
    env.SNYK_CFG_ORG = process.env.SNYK_CFG_ORG;
  }
  return env;
}

export async function isSnykToHtmlAvailable(): Promise<boolean> {
  try {
    await execFileAsync('snyk-to-html', ['--version'], { timeout: 8000, env: snykEnv() });
    return true;
  } catch {
    try {
      await execFileAsync('snyk-to-html', ['--help'], { timeout: 8000, env: snykEnv() });
      return true;
    } catch {
      return false;
    }
  }
}

export async function isSnykAvailable(): Promise<boolean> {
  try {
    await execFileAsync('snyk', ['--version'], { timeout: 8000, env: snykEnv() });
    return true;
  } catch {
    return false;
  }
}

// User-writable npm prefix for when a global (`-g`) install hits EACCES because
// the app user can't write to /usr/lib/node_modules. Binaries land in
// `.securenexus/bin`, which is already on the tool PATH (see tool-path-env.ts).
const LOCAL_NPM_PREFIX = path.join(process.cwd(), '.securenexus');

function isPermissionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /EACCES|permission denied|operation was rejected|EPERM|need sudo|as root/i.test(message);
}

async function npmInstallGlobalOrLocal(
  packageName: string,
  onProgress?: (message: string) => void
): Promise<void> {
  try {
    await execFileAsync('npm', ['install', packageName, '-g'], {
      timeout: 180_000,
      env: snykEnv(),
      maxBuffer: 20 * 1024 * 1024,
    });
    return;
  } catch (err) {
    if (!isPermissionError(err)) throw err;
  }

  onProgress?.(`Global install needs root — installing ${packageName} into .securenexus instead…`);
  await fs.mkdir(LOCAL_NPM_PREFIX, { recursive: true });
  await execFileAsync('npm', ['install', packageName, '-g', '--prefix', LOCAL_NPM_PREFIX], {
    timeout: 180_000,
    env: snykEnv(),
    maxBuffer: 20 * 1024 * 1024,
  });
}

export async function installSnykToHtml(
  onProgress?: (message: string) => void
): Promise<void> {
  if (await isSnykToHtmlAvailable()) return;
  onProgress?.('Installing snyk-to-html via npm…');
  await npmInstallGlobalOrLocal('snyk-to-html', onProgress);
  if (!(await isSnykToHtmlAvailable())) {
    throw new Error('snyk-to-html was installed but is not available on PATH.');
  }
}

export async function installSnykCli(
  onProgress?: (message: string) => void
): Promise<void> {
  if (await isSnykAvailable()) return;
  onProgress?.('Installing Snyk CLI via npm…');
  await npmInstallGlobalOrLocal('snyk', onProgress);
  if (!(await isSnykAvailable())) {
    throw new Error('Snyk CLI was installed but is not available on PATH.');
  }
}

export async function isSnykRuntimeReady(): Promise<boolean> {
  return (await isSnykAvailable()) && (await isSnykToHtmlAvailable());
}

// Snyk `whoami` is the source of truth
export async function isSnykAuthenticated(): Promise<boolean> {
  if (!(await isSnykAvailable())) return false;
  return Boolean(await readSnykWhoami());
}

export async function readSnykWhoami(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('snyk', ['whoami'], {
      timeout: 20000,
      env: snykEnv(),
    });
    const value = stdout.trim();
    if (value) return value;
  } catch {
    // Older/newer CLIs may require the experimental flag; try it next.
  }
  try {
    const { stdout } = await execFileAsync('snyk', ['whoami', '--experimental'], {
      timeout: 20000,
      env: snykEnv(),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function readSnykVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('snyk', ['--version'], {
      timeout: 8000,
      env: snykEnv(),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function authenticateSnykWithToken(token: string): Promise<string> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Snyk API token is required.');

  try {
    await execFileAsync('snyk', ['auth', trimmed], {
      timeout: 45000,
      env: snykEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const detail = [execErr.stderr, execErr.stdout, execErr.message]
      .filter(Boolean)
      .join('\n');
    if (/401|unauthor|not recognized|invalid/i.test(detail)) {
      throw new Error(
        'Snyk rejected this token. Copy the API token (not a personal access token expiry-limited value) from app.snyk.io/account and try again.'
      );
    }
    throw new Error(detail.slice(0, 400) || 'Failed to save Snyk token.');
  }

  const whoami = await readSnykWhoami();
  if (!whoami) {
    throw new Error(
      'Token saved but Snyk still reports unauthenticated. Generate a fresh API token from app.snyk.io/account and try again.'
    );
  }
  return whoami;
}

export function extractSnykOAuthUrl(output: string): string | null {
  const loginMatch = output.match(LOGIN_URL_PATTERN);
  if (loginMatch?.[0]) return loginMatch[0];
  const oauthMatch = output.match(OAUTH_URL_PATTERN);
  return oauthMatch?.[0] ?? null;
}

export type SnykAuthStartResult = {
  authUrl: string;
  message: string;
};

export async function startSnykBrowserAuth(
  onOutput?: (chunk: string) => void
): Promise<{ result: SnykAuthStartResult; child: import('child_process').ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn('snyk', ['auth', '--auth-type=token'], {
      env: snykEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let combined = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('Timed out waiting for Snyk to provide an authentication URL.'));
    }, 30_000);

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      combined += text;
      onOutput?.(text);
      const authUrl = extractSnykOAuthUrl(combined);
      if (authUrl && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          result: {
            authUrl,
            message:
              'Open the Snyk login page, sign in, then return here and click Check auth status.',
          },
          child,
        });
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        reject(new Error('Snyk authentication completed before a login URL was captured.'));
        return;
      }
      const authUrl = extractSnykOAuthUrl(combined);
      if (authUrl) {
        resolve({
          result: {
            authUrl,
            message:
              'Open the Snyk login page, sign in, then return here and click Check auth status.',
          },
          child,
        });
        return;
      }
      reject(
        new Error(
          combined.trim() ||
            'Snyk auth failed to start. Use an API token from your Snyk account instead.'
        )
      );
    });
  });
}

export interface SnykScanResult {
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findingCount: number;
  summary: string;
  snykVersion: string;
}

function countSnykJsonSeverities(
  jsonRaw: string,
  mode: 'sca' | 'code'
): { high: number; medium: number; low: number; total: number } {
  let high = 0;
  let medium = 0;
  let low = 0;
  try {
    const parsed = JSON.parse(jsonRaw) as Record<string, unknown>;
    if (mode === 'sca') {
      const vulns = Array.isArray(parsed.vulnerabilities) ? parsed.vulnerabilities : [];
      for (const row of vulns) {
        const sev = String((row as { severity?: string }).severity ?? '').toLowerCase();
        if (sev === 'critical' || sev === 'high') high += 1;
        else if (sev === 'medium' || sev === 'moderate') medium += 1;
        else low += 1;
      }
      return { high, medium, low, total: vulns.length };
    }

    const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    for (const run of runs) {
      const results = Array.isArray((run as { results?: unknown[] }).results)
        ? (run as { results: unknown[] }).results
        : [];
      for (const result of results) {
        const level = String((result as { level?: string }).level ?? '').toLowerCase();
        if (level === 'error') high += 1;
        else if (level === 'warning') medium += 1;
        else low += 1;
      }
    }
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    if (!runs.length && issues.length) {
      for (const issue of issues) {
        const sev = String(
          (issue as { severity?: string; level?: string }).severity ??
            (issue as { level?: string }).level ??
            ''
        ).toLowerCase();
        if (sev === 'critical' || sev === 'high' || sev === 'error') high += 1;
        else if (sev === 'medium' || sev === 'moderate' || sev === 'warning') medium += 1;
        else low += 1;
      }
      return { high, medium, low, total: issues.length };
    }
    const total = runs.reduce((sum, run) => {
      const results = (run as { results?: unknown[] }).results;
      return sum + (Array.isArray(results) ? results.length : 0);
    }, 0);
    return { high, medium, low, total };
  } catch {
    return { high: 0, medium: 0, low: 0, total: 0 };
  }
}

function sanitizeSnykError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://***@')
    .slice(0, 600);
}

async function runSnykJsonToHtml(input: {
  snykArgs: string[];
  cwd: string;
  outputDir: string;
  jsonFile: string;
  htmlFile: string;
  progressLabel: string;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<{ htmlContent: string; jsonRaw: string }> {
  let jsonRaw = '';
  try {
    const { stdout } = await execFileAsync('snyk', input.snykArgs, {
      cwd: input.cwd,
      maxBuffer: 100 * 1024 * 1024,
      timeout: SNYK_SCAN_TIMEOUT_MS,
      env: snykEnv(),
    });
    jsonRaw = stdout;
  } catch (err: unknown) {
    const execErr = err as { code?: number | string; stdout?: string; stderr?: string };
    if (typeof execErr.stdout === 'string' && execErr.stdout.trim()) {
      jsonRaw = execErr.stdout;
    }
    if (!jsonRaw || (execErr.code !== 1 && execErr.code !== '1')) {
      const detail = [execErr.stderr, execErr.stdout].filter(Boolean).join('\n').trim();
      throw new Error(detail || `${input.progressLabel} failed.`);
    }
  }

  const jsonPath = path.join(input.outputDir, input.jsonFile);
  const htmlPath = path.join(input.outputDir, input.htmlFile);
  await fs.writeFile(jsonPath, jsonRaw, 'utf-8');

  input.onProgress?.(75, 'Converting Snyk JSON to HTML…');
  await execFileAsync('snyk-to-html', ['-i', jsonPath, '-o', htmlPath], {
    timeout: 120_000,
    env: snykEnv(),
    maxBuffer: 20 * 1024 * 1024,
  });

  const htmlContent = await fs.readFile(htmlPath, 'utf-8');
  return { htmlContent, jsonRaw };
}

async function runSnykScanInternal(input: {
  resource: SecurityResourceView;
  mode: 'sca' | 'code';
  toolId: 'snyk' | 'snyk-code';
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<SnykScanResult> {
  const progress = input.onProgress;
  let cleanup: (() => Promise<void>) | null = null;

  if (input.resource.type !== 'repository') {
    throw new Error('Snyk scans require a repository resource.');
  }

  if (!(await isSnykRuntimeReady())) {
    throw new Error(
      'Snyk CLI and snyk-to-html must be installed on this server. Install Snyk from Security → Tools (SCA or SAST) before running scans.'
    );
  }
  if (!(await isSnykAuthenticated())) {
    throw new Error(
      'Snyk is not authenticated. Add a Snyk API token or authenticate in the browser from Security → Tools before running scans.'
    );
  }

  try {
    progress?.(8, 'Preparing repository…');
    const prepared = await prepareRepositoryPath(input.resource);
    cleanup = prepared.cleanup;
    const { repoPath, outputDir } = prepared;
    await fs.mkdir(outputDir, { recursive: true });

    const snykVersion = (await readSnykVersion()) ?? 'unknown';
    const tool = getSecurityToolById(input.toolId);
    const toolName = tool?.name ?? 'Snyk';

    let scanCwd = repoPath;
    if (input.mode === 'sca') {
      const projectRoot = await findNpmProjectRoot(repoPath);
      if (!projectRoot) {
        throw new Error(
          `No package.json found in ${input.resource.name}. Snyk SCA requires a Node.js project with dependencies.`
        );
      }
      scanCwd = projectRoot;
    }

    const label = input.mode === 'sca' ? 'Snyk SCA (snyk test)' : 'Snyk Code (snyk code test)';
    progress?.(28, `Running ${label}…`);

    const snykArgs =
      input.mode === 'sca'
        ? ['test', '--json']
        : ['code', 'test', scanCwd, '--json'];

    const baseName = input.mode === 'sca' ? 'snyk-sca-report' : 'snyk-sast-report';
    const { htmlContent, jsonRaw } = await runSnykJsonToHtml({
      snykArgs,
      cwd: scanCwd,
      outputDir,
      jsonFile: `${baseName}.json`,
      htmlFile: `${baseName}.html`,
      progressLabel: label,
      onProgress: progress,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (/not authorized|not enabled|snyk code is not supported/i.test(message)) {
        throw new Error(
          'Snyk Code is not enabled for this Snyk account/organization. Enable Snyk Code in your Snyk org settings, then retry.'
        );
      }
      throw err;
    });

    const counts = countSnykJsonSeverities(jsonRaw, input.mode);
    const findingCount = counts.total;
    const scanKind = input.mode === 'sca' ? 'dependency vulnerabilities' : 'Snyk Code static analysis';
    const summary =
      findingCount === 0
        ? `${toolName} scan completed for ${input.resource.name} — no ${scanKind} issues detected.`
        : `${toolName} scan completed for ${input.resource.name} — ${findingCount} ${scanKind} issue${findingCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`;

    return {
      htmlContent,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      findingCount,
      summary,
      snykVersion,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Snyk ')) throw err;
    if (err instanceof Error && err.message.startsWith('Bitbucket is not connected')) throw err;
    const message = err instanceof Error ? err.message : 'Snyk scan failed';
    const sanitized = formatRepositoryCloneError(err, input.resource.repoUrl ?? '');
    if (/git clone|unable to access|403|401/i.test(message)) throw new Error(sanitized);
    throw new Error(sanitizeSnykError(message));
  } finally {
    if (cleanup) await cleanup();
  }
}

export function runSnykScaScan(input: {
  resource: SecurityResourceView;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<SnykScanResult> {
  return runSnykScanInternal({ ...input, mode: 'sca', toolId: 'snyk' });
}

export function runSnykCodeScan(input: {
  resource: SecurityResourceView;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<SnykScanResult> {
  return runSnykScanInternal({ ...input, mode: 'code', toolId: 'snyk-code' });
}

/** @deprecated Use runSnykScaScan or runSnykCodeScan */
export function runSnykScan(input: {
  resource: SecurityResourceView;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<SnykScanResult> {
  return runSnykCodeScan(input);
}
