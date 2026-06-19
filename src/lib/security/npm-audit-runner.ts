import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import {
  buildScaReportHtml,
  countFindingsBySeverity,
  type ScaDependencyRow,
} from '@/lib/security-report-export';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { getSecurityToolById } from '@/lib/security-tools';
import type { SecurityResourceView } from '@/lib/security-service';
import { findNpmProjectRoot, prepareRepositoryPath } from './security-repo-prep';

const execFileAsync = promisify(execFile);
const NPM_AUDIT_TIMEOUT_MS = 10 * 60 * 1000;
const NPM_LOCKFILE_TIMEOUT_MS = 5 * 60 * 1000;

export interface NpmAuditScanResult {
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  dependencyCount: number;
  summary: string;
  npmVersion: string;
}

interface NpmAuditViaAdvisory {
  source?: number;
  name?: string;
  title?: string;
  url?: string;
  severity?: string;
}

interface NpmAuditVulnerability {
  name?: string;
  severity?: string;
  via?: Array<string | NpmAuditViaAdvisory>;
  range?: string;
  fixAvailable?: false | { name?: string; version?: string; isSemVerMajor?: boolean };
}

interface NpmAuditReport {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
  metadata?: {
    vulnerabilities?: {
      total?: number;
      high?: number;
      moderate?: number;
      low?: number;
      critical?: number;
    };
  };
  error?: {
    code?: string;
    summary?: string;
  };
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
    const { stdout } = await execFileAsync('npm', ['--version'], { timeout: 5000 });
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
    env: process.env,
  });
}

async function runNpmAuditJson(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('npm', ['audit', '--json'], {
      cwd: projectRoot,
      maxBuffer: 50 * 1024 * 1024,
      timeout: NPM_AUDIT_TIMEOUT_MS,
      env: process.env,
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

function mapScaSeverity(severity: string): ScaDependencyRow['severity'] {
  const sev = severity.toLowerCase();
  if (sev === 'critical' || sev === 'high') return 'High';
  if (sev === 'moderate' || sev === 'medium') return 'Moderate';
  return 'Low';
}

function severityRank(severity: ScaDependencyRow['severity']): number {
  if (severity === 'High') return 0;
  if (severity === 'Moderate') return 1;
  return 2;
}

function extractAdvisory(via: NpmAuditVulnerability['via']): NpmAuditViaAdvisory | null {
  if (!via?.length) return null;
  for (const entry of via) {
    if (typeof entry === 'object' && entry !== null) {
      return entry;
    }
  }
  return null;
}

function extractCveId(advisory: NpmAuditViaAdvisory | null, via: NpmAuditVulnerability['via']): string {
  if (advisory?.url) {
    const ghsa = advisory.url.match(/GHSA-[a-z0-9-]+/i);
    if (ghsa) return ghsa[0].toUpperCase();
    const cve = advisory.url.match(/CVE-\d{4}-\d+/i);
    if (cve) return cve[0].toUpperCase();
  }
  if (advisory?.source) return `npm-advisory-${advisory.source}`;
  const chain = via?.find((entry) => typeof entry === 'string');
  return typeof chain === 'string' ? chain : '—';
}

function extractViaChain(via: NpmAuditVulnerability['via']): string {
  const chains = via?.filter((entry): entry is string => typeof entry === 'string') ?? [];
  return chains.join(' → ');
}

function buildVulnerabilityTitle(
  vuln: NpmAuditVulnerability,
  advisory: NpmAuditViaAdvisory | null
): string {
  if (advisory?.title?.trim()) return advisory.title.trim();
  const chain = extractViaChain(vuln.via);
  if (chain) return `Transitive vulnerability via ${chain}`;
  return 'Known vulnerability in dependency tree';
}

function extractCurrentVersion(range?: string): string {
  if (!range?.trim()) return '—';
  const trimmed = range.trim();
  if (trimmed.startsWith('<') || trimmed.startsWith('>') || trimmed.startsWith('=')) {
    return trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed;
  }
  const rangeMatch = trimmed.match(/^(.+?)\s*-\s*(.+)$/);
  if (rangeMatch) return rangeMatch[2].trim();
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed;
}

function buildFixAction(
  fixAvailable: NpmAuditVulnerability['fixAvailable']
): { fixVersion: string; action: string } {
  if (fixAvailable && typeof fixAvailable === 'object' && fixAvailable.version) {
    const suffix = fixAvailable.isSemVerMajor ? ' (may include breaking changes)' : '+';
    return {
      fixVersion: fixAvailable.version,
      action: `Upgrade to ${fixAvailable.version}${suffix}`,
    };
  }
  return {
    fixVersion: 'None',
    action: 'Review advisory — no automatic fix available',
  };
}

export function parseNpmAuditReport(raw: unknown): ScaDependencyRow[] {
  const report = raw as NpmAuditReport;
  const vulnerabilities = report.vulnerabilities ?? {};
  const rows: ScaDependencyRow[] = [];

  for (const [key, vuln] of Object.entries(vulnerabilities)) {
    const advisory = extractAdvisory(vuln.via);
    const severity = mapScaSeverity(advisory?.severity ?? vuln.severity ?? 'low');
    const { fixVersion, action } = buildFixAction(vuln.fixAvailable);
    const title = buildVulnerabilityTitle(vuln, advisory);

    rows.push({
      id: '',
      package: vuln.name ?? key,
      currentVersion: extractCurrentVersion(vuln.range),
      fixVersion,
      severity,
      cve: extractCveId(advisory, vuln.via),
      vulnerability: title,
      action,
    });
  }

  rows.sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.package.localeCompare(b.package);
  });

  return rows.map((row, index) => ({
    ...row,
    id: `D-${String(index + 1).padStart(3, '0')}`,
  }));
}

function sanitizeNpmAuditError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://***@')
    .replace(/ATATT[A-Za-z0-9+/=%_-]+/g, '***')
    .slice(0, 300);
}

export async function runNpmAuditScan(input: {
  resource: SecurityResourceView;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<NpmAuditScanResult> {
  const progress = input.onProgress;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    progress?.(8, 'Preparing repository…');
    const prepared = await prepareRepositoryPath(input.resource);
    cleanup = prepared.cleanup;

    const projectRoot = await findNpmProjectRoot(prepared.repoPath);
    if (!projectRoot) {
      throw new Error(
        `No package.json found in ${input.resource.name}. npm audit requires a Node.js project at the repository root.`
      );
    }

    progress?.(22, 'Resolving dependency lockfile…');
    await ensureLockfile(projectRoot);
    progress?.(38, 'Running npm audit…');
    const auditRaw = await runNpmAuditJson(projectRoot);
    const parsed = JSON.parse(auditRaw) as NpmAuditReport;

    if (parsed.error?.summary) {
      throw new Error(parsed.error.summary);
    }

    const dependencies = parseNpmAuditReport(parsed);
    const counts = countFindingsBySeverity(dependencies);
    const npmVersion = await getNpmVersion();
    const tool = getSecurityToolById('npm-audit');
    if (!tool) throw new Error('npm audit tool definition is missing');

    progress?.(82, 'Building SCA report…');
    const title = `${tool.name} scan — ${input.resource.name}`;
    const dependencyCount = dependencies.length;
    const summary =
      dependencyCount === 0
        ? `npm audit completed for ${input.resource.name} — no vulnerable dependencies detected.`
        : `npm audit completed for ${input.resource.name} — ${dependencyCount} vulnerable package${dependencyCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} moderate, ${counts.low} low).`;

    const htmlContent = buildScaReportHtml({
      resource: input.resource,
      tool,
      title,
      summary,
      scaDependencies: dependencies,
    });

    return {
      htmlContent,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      dependencyCount,
      summary,
      npmVersion,
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
    await execFileAsync('npm', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
