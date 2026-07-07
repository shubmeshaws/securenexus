import { execFile, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { toolPathEnv } from '@/lib/security/tool-path-env';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { getSecurityToolById } from '@/lib/security-tools';
import type { SecurityResourceView } from '@/lib/security-service';
import { prepareRepositoryPath } from './security-repo-prep';
import { buildSnykReportHtml, type SnykFindingRow } from './snyk-report';

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

export async function isSnykAvailable(): Promise<boolean> {
  try {
    await execFileAsync('snyk', ['--version'], { timeout: 8000, env: snykEnv() });
    return true;
  } catch {
    return false;
  }
}

// Snyk `whoami` is the source of truth: it succeeds for OAuth, PAT, and API
// token sessions alike. `snyk config get api` is empty for OAuth logins, so it
// must not be used as an auth gate.
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

interface SarifRegion {
  startLine?: number;
}
interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: SarifRegion;
  };
}
interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
}
interface SarifRule {
  id?: string;
  name?: string;
  shortDescription?: { text?: string };
  properties?: { 'security-severity'?: string; cwe?: string[] };
  defaultConfiguration?: { level?: string };
}
interface SarifReport {
  runs?: Array<{
    tool?: { driver?: { rules?: SarifRule[] } };
    results?: SarifResult[];
  }>;
}

function severityFromScore(score: string | undefined): SnykFindingRow['severity'] | null {
  if (!score) return null;
  const value = Number(score);
  if (Number.isNaN(value)) return null;
  if (value >= 9) return 'Critical';
  if (value >= 7) return 'High';
  if (value >= 4) return 'Medium';
  return 'Low';
}

function severityFromLevel(level: string | undefined): SnykFindingRow['severity'] {
  switch ((level ?? '').toLowerCase()) {
    case 'error':
      return 'High';
    case 'warning':
      return 'Medium';
    default:
      return 'Low';
  }
}

export function parseSnykCodeSarif(raw: string): SnykFindingRow[] {
  let report: SarifReport;
  try {
    report = JSON.parse(raw) as SarifReport;
  } catch {
    return [];
  }

  const findings: SnykFindingRow[] = [];
  for (const run of report.runs ?? []) {
    const rulesById = new Map<string, SarifRule>();
    for (const rule of run.tool?.driver?.rules ?? []) {
      if (rule.id) rulesById.set(rule.id, rule);
    }

    for (const result of run.results ?? []) {
      const rule = result.ruleId ? rulesById.get(result.ruleId) : undefined;
      const severity =
        severityFromScore(rule?.properties?.['security-severity']) ??
        severityFromLevel(result.level ?? rule?.defaultConfiguration?.level);
      const loc = result.locations?.[0]?.physicalLocation;
      const file = loc?.artifactLocation?.uri ?? 'unknown';
      const line = loc?.region?.startLine;
      const location = line ? `${file}:${line}` : file;
      const title =
        rule?.shortDescription?.text || rule?.name || result.ruleId || 'Snyk Code issue';
      const message = result.message?.text?.trim() || title;

      findings.push({
        severity,
        rule: result.ruleId ?? 'snyk-code',
        title,
        location,
        message,
      });
    }
  }
  return findings;
}

function countSnykSeverities(findings: SnykFindingRow[]): {
  high: number;
  medium: number;
  low: number;
} {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const finding of findings) {
    if (finding.severity === 'Critical' || finding.severity === 'High') high += 1;
    else if (finding.severity === 'Medium') medium += 1;
    else low += 1;
  }
  return { high, medium, low };
}

function sanitizeSnykError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://***@')
    .slice(0, 600);
}

export async function runSnykScan(input: {
  resource: SecurityResourceView;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<SnykScanResult> {
  const progress = input.onProgress;
  let cleanup: (() => Promise<void>) | null = null;

  if (input.resource.type !== 'repository') {
    throw new Error('Snyk scans require a repository resource.');
  }

  if (!(await isSnykAvailable())) {
    throw new Error(
      'Snyk CLI is not installed or not on PATH. Install Snyk from Security → Tools before running scans.'
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
    const sarifPath = path.join(outputDir, 'snyk-code.sarif');
    const snykVersion = (await readSnykVersion()) ?? 'unknown';

    progress?.(30, 'Running Snyk Code test…');
    try {
      await execFileAsync(
        'snyk',
        ['code', 'test', repoPath, '--sarif', `--sarif-file-output=${sarifPath}`],
        {
          cwd: repoPath,
          maxBuffer: 100 * 1024 * 1024,
          timeout: SNYK_SCAN_TIMEOUT_MS,
          env: snykEnv(),
        }
      );
    } catch (err: unknown) {
      const execErr = err as { code?: number | string; stderr?: string; stdout?: string };
      // Exit code 1 = issues found (expected). Other codes are real errors,
      // unless the SARIF file was still produced.
      const sarifExists = await fs
        .access(sarifPath)
        .then(() => true)
        .catch(() => false);
      if (execErr.code !== 1 && !sarifExists) {
        const detail = [execErr.stderr, execErr.stdout].filter(Boolean).join('\n').trim();
        if (/not authorized|not enabled|snyk code is not supported/i.test(detail)) {
          throw new Error(
            'Snyk Code is not enabled for this Snyk account/organization. Enable Snyk Code in your Snyk org settings, then retry.'
          );
        }
        throw new Error(detail || 'Snyk Code test failed.');
      }
    }

    progress?.(78, 'Processing Snyk results…');
    let sarifRaw = '';
    try {
      sarifRaw = await fs.readFile(sarifPath, 'utf-8');
    } catch {
      sarifRaw = '';
    }

    const findings = sarifRaw ? parseSnykCodeSarif(sarifRaw) : [];
    const counts = countSnykSeverities(findings);
    const tool = getSecurityToolById('snyk');
    const toolName = tool?.name ?? 'Snyk';
    const title = `${toolName} scan — ${input.resource.name}`;
    const findingCount = findings.length;
    const summary =
      findingCount === 0
        ? `Snyk Code scan completed for ${input.resource.name} — no issues detected.`
        : `Snyk Code scan completed for ${input.resource.name} — ${findingCount} issue${findingCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`;

    progress?.(92, 'Building Snyk report…');
    const htmlContent = buildSnykReportHtml({
      resource: input.resource,
      toolName,
      title,
      summary,
      scanKind: 'Snyk Code static analysis',
      findings,
      snykVersion,
    });

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
    if (err instanceof Error && err.message.startsWith('Snyk ')) {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith('Bitbucket is not connected')) {
      throw err;
    }
    const message = err instanceof Error ? err.message : 'Snyk scan failed';
    const sanitized = formatRepositoryCloneError(err, input.resource.repoUrl ?? '');
    if (/git clone|unable to access|403|401/i.test(message)) {
      throw new Error(sanitized);
    }
    throw new Error(sanitizeSnykError(message));
  } finally {
    if (cleanup) await cleanup();
  }
}
