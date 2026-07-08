import fs from 'fs/promises';
import path from 'path';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { countFindingsBySeverity } from '@/lib/security-report-export';
import { getSecurityToolById } from '@/lib/security-tools';
import type { SecurityResourceView } from '@/lib/security-service';
import { prepareRepositoryPath } from './security-repo-prep';
import { execForScanJob } from '@/lib/security-scan-exec';
import { ScanCancelledError } from '@/lib/security-scan-cancel';
import { DEFAULT_SONAR_HOST_URL } from './sonarqube-constants';
import {
  readSonarqubeConfig,
  writeSonarqubeConfig,
  type SonarqubeConfig,
} from './sonarqube-config';
import {
  isSonarScannerAvailable,
  readSonarScannerVersion,
  resolveSonarScannerBin,
} from './sonarqube-install';
import { buildSonarqubeReportHtml, type SonarqubeFindingRow } from './sonarqube-report';
import { extendedToolPath } from './tool-path-env';

const SONAR_SCAN_TIMEOUT_MS = 30 * 60 * 1000;

export interface SonarqubeScanResult {
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findingCount: number;
  summary: string;
  scannerVersion: string;
}

interface SonarApiIssue {
  key?: string;
  rule?: string;
  severity?: string;
  component?: string;
  project?: string;
  line?: number;
  message?: string;
  type?: string;
  status?: string;
}

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function sonarProjectKey(resource: SecurityResourceView): string {
  const slug = resource.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `sn-${resource.id.slice(0, 8)}-${slug || 'repo'}`.slice(0, 100);
}

function mapSonarSeverity(severity: string | undefined): SonarqubeFindingRow['severity'] {
  switch ((severity ?? '').toUpperCase()) {
    case 'BLOCKER':
      return 'Critical';
    case 'CRITICAL':
      return 'High';
    case 'MAJOR':
      return 'Medium';
    case 'MINOR':
    case 'INFO':
      return 'Low';
    default:
      return 'Medium';
  }
}

function issueLocation(issue: SonarApiIssue): string {
  const component = issue.component ?? '';
  const file = component.includes(':') ? component.split(':').slice(1).join(':') : component;
  if (issue.line && issue.line > 0) return `${file}:${issue.line}`;
  return file || '—';
}

function parseSonarIssues(issues: SonarApiIssue[]): SonarqubeFindingRow[] {
  return issues.map((issue) => ({
    severity: mapSonarSeverity(issue.severity),
    rule: issue.rule ?? '—',
    title: issue.message?.split('\n')[0]?.slice(0, 200) || issue.rule || 'SonarQube issue',
    location: issueLocation(issue),
    message: issue.message ?? 'No description provided by SonarQube.',
    type: issue.type ?? '—',
  }));
}

export async function validateSonarqubeCredentials(
  serverUrl: string,
  token: string
): Promise<{ valid: boolean; username: string | null }> {
  const base = normalizeServerUrl(serverUrl);
  const headers = { Authorization: `Bearer ${token.trim()}` };

  const validateRes = await fetch(`${base}/api/authentication/validate`, { headers });
  if (!validateRes.ok) {
    throw new Error(
      `SonarQube rejected the token (HTTP ${validateRes.status}). Check the server URL and generate a new token from your SonarQube account.`
    );
  }

  const validateBody = (await validateRes.json()) as { valid?: boolean };
  if (!validateBody.valid) {
    throw new Error('SonarQube rejected this token. Generate a new user token in SonarQube and try again.');
  }

  let username: string | null = null;
  try {
    const userRes = await fetch(`${base}/api/users/current`, { headers });
    if (userRes.ok) {
      const userBody = (await userRes.json()) as { login?: string; name?: string };
      username = userBody.login?.trim() || userBody.name?.trim() || null;
    }
  } catch {
    // optional
  }

  return { valid: true, username };
}

export async function isSonarqubeAuthenticated(): Promise<boolean> {
  const config = await readSonarqubeConfig();
  if (!config) return false;
  try {
    const result = await validateSonarqubeCredentials(config.serverUrl, config.token);
    return result.valid;
  } catch {
    return false;
  }
}

export async function readSonarqubeUsername(): Promise<string | null> {
  const config = await readSonarqubeConfig();
  if (!config) return null;
  if (config.username) return config.username;
  try {
    const result = await validateSonarqubeCredentials(config.serverUrl, config.token);
    return result.username;
  } catch {
    return null;
  }
}

export async function authenticateSonarqubeWithToken(
  serverUrl: string,
  token: string
): Promise<string> {
  const trimmedUrl = normalizeServerUrl(serverUrl || DEFAULT_SONAR_HOST_URL);
  const trimmedToken = token.trim();
  if (!trimmedToken) throw new Error('SonarQube user token is required.');
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    throw new Error('SonarQube server URL must start with http:// or https://');
  }

  const { username } = await validateSonarqubeCredentials(trimmedUrl, trimmedToken);
  await writeSonarqubeConfig({
    serverUrl: trimmedUrl,
    token: trimmedToken,
    username,
  });

  if (!username) {
    return 'SonarQube user';
  }
  return username;
}

export function sonarScanEnv(config: SonarqubeConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: extendedToolPath(),
    SONAR_HOST_URL: config.serverUrl,
    SONAR_TOKEN: config.token,
  };
}

async function fetchSonarIssues(
  config: SonarqubeConfig,
  projectKey: string
): Promise<SonarApiIssue[]> {
  const issues: SonarApiIssue[] = [];
  const pageSize = 500;
  let page = 1;

  while (true) {
    const url = new URL(`${config.serverUrl}/api/issues/search`);
    url.searchParams.set('projectKeys', projectKey);
    url.searchParams.set('ps', String(pageSize));
    url.searchParams.set('p', String(page));
    url.searchParams.set('resolved', 'false');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${config.token}` },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Failed to fetch SonarQube issues (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`
      );
    }

    const body = (await res.json()) as { issues?: SonarApiIssue[]; total?: number };
    const batch = body.issues ?? [];
    issues.push(...batch);

    const total = body.total ?? batch.length;
    if (page * pageSize >= total || batch.length === 0) break;
    page += 1;
  }

  return issues;
}

function sanitizeSonarError(message: string): string {
  return message
    .replace(/sonar\.token=[^\s]+/gi, 'sonar.token=***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .slice(0, 600);
}

export async function runSonarqubeScan(input: {
  resource: SecurityResourceView;
  scanJobId?: string;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<SonarqubeScanResult> {
  const progress = input.onProgress;

  if (!(await isSonarScannerAvailable())) {
    throw new Error(
      'SonarScanner CLI is not installed. Install SonarQube scanner from Security → Tools before running live scans.'
    );
  }

  const config = await readSonarqubeConfig();
  if (!config) {
    throw new Error(
      'SonarQube is not authenticated. Paste your SonarQube server URL and user token in Security → Tools → SonarQube.'
    );
  }

  if (!(await isSonarqubeAuthenticated())) {
    throw new Error(
      'SonarQube token is invalid or expired. Generate a new user token in SonarQube and save it again.'
    );
  }

  let cleanup: (() => Promise<void>) | null = null;

  try {
    progress?.(8, 'Preparing repository…');
    const prepared = await prepareRepositoryPath(input.resource);
    cleanup = prepared.cleanup;

    const projectKey = sonarProjectKey(input.resource);
    const projectName = `${input.resource.name} (SecureNexus)`;
    const scannerBin = await resolveSonarScannerBin();
    if (!scannerBin) {
      throw new Error('SonarScanner binary could not be located after installation.');
    }

    progress?.(22, `Running SonarScanner on ${input.resource.name}…`);
    const scannerArgs = [
      `-Dsonar.projectKey=${projectKey}`,
      `-Dsonar.projectName=${projectName}`,
      '-Dsonar.sources=.',
      `-Dsonar.host.url=${config.serverUrl}`,
      `-Dsonar.token=${config.token}`,
      '-Dsonar.scm.disabled=true',
      '-Dsonar.scanner.skipSystemTruststore=true',
    ];

    try {
      await execForScanJob(input.scanJobId, scannerBin, scannerArgs, {
        cwd: prepared.repoPath,
        maxBuffer: 50 * 1024 * 1024,
        timeout: SONAR_SCAN_TIMEOUT_MS,
        env: sonarScanEnv(config),
      });
    } catch (err) {
      if (err instanceof ScanCancelledError) throw err;
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      const combined = [execErr.stderr, execErr.stdout, execErr.message].filter(Boolean).join('\n');
      if (/401|403|not authorized|authentication/i.test(combined)) {
        throw new Error(
          'SonarQube rejected the scan upload. Verify the token has analysis permissions on this project.'
        );
      }
      throw new Error(combined.slice(0, 500) || 'SonarScanner failed.');
    }

    progress?.(78, 'Fetching issues from SonarQube…');
    const issues = await fetchSonarIssues(config, projectKey);
    const findings = parseSonarIssues(issues);
    const counts = countFindingsBySeverity(findings);
    const scannerVersion = (await readSonarScannerVersion()) ?? 'unknown';
    const tool = getSecurityToolById('sonarqube');
    if (!tool) throw new Error('SonarQube tool definition is missing');

    const findingCount = findings.length;
    const criticalCount = findings.filter((row) => row.severity === 'Critical').length;
    const summary =
      findingCount === 0
        ? `SonarQube scan completed for ${input.resource.name} — no open issues reported.`
        : `SonarQube scan completed for ${input.resource.name} — ${findingCount} issue${findingCount === 1 ? '' : 's'} (${criticalCount + counts.high} high/critical, ${counts.medium} medium, ${counts.low} low).`;

    progress?.(92, 'Building SAST report…');
    const htmlContent = buildSonarqubeReportHtml({
      resource: input.resource,
      toolName: tool.name,
      title: `${tool.name} scan — ${input.resource.name}`,
      summary,
      findings,
      scannerVersion,
      serverUrl: config.serverUrl,
      projectKey,
    });

    return {
      htmlContent,
      highCount: counts.high + criticalCount,
      mediumCount: counts.medium,
      lowCount: counts.low,
      findingCount,
      summary,
      scannerVersion,
    };
  } catch (err) {
    if (err instanceof ScanCancelledError) throw err;
    if (err instanceof Error && err.message.startsWith('Bitbucket is not connected')) {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith('Repository scans require')) {
      throw err;
    }

    const message = err instanceof Error ? err.message : 'SonarQube scan failed';
    const sanitized = formatRepositoryCloneError(err, input.resource.repoUrl ?? '');

    if (/ENOENT.*sonar-scanner|not found.*sonar-scanner|spawn sonar-scanner/i.test(message)) {
      throw new Error(
        'SonarScanner CLI is not installed or not on PATH. Install it from Security → Tools before running live scans.'
      );
    }

    if (/git clone|unable to access|403|401/i.test(message)) {
      throw new Error(sanitized);
    }

    throw new Error(sanitizeSonarError(message));
  } finally {
    if (cleanup) await cleanup();
  }
}

export async function isSonarqubeRuntimeReady(): Promise<boolean> {
  return (await isSonarScannerAvailable()) && (await isSonarqubeAuthenticated());
}

export { isSonarScannerAvailable } from './sonarqube-install';
