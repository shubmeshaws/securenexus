import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import {
  buildSecretsReportHtml,
  countFindingsBySeverity,
  type SecretsFindingRow,
} from '@/lib/security-report-export';
import { resolveSecretsRemediation } from '@/lib/security/secrets-remediation';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { toolPathEnv } from '@/lib/security/tool-path-env';
import { getSecurityToolById } from '@/lib/security-tools';
import type { SecurityResourceView } from '@/lib/security-service';
import { prepareRepositoryPath } from './security-repo-prep';
import {
  buildGitleaksCliArgs,
  gitleaksModeLabel,
  type GitleaksScanOptions,
} from './gitleaks-options';

const execFileAsync = promisify(execFile);
const GITLEAKS_TIMEOUT_MS = 15 * 60 * 1000;

export interface GitleaksScanResult {
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findingCount: number;
  summary: string;
  gitleaksVersion: string;
}

interface GitleaksRawFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  EndLine?: number;
  Match?: string;
  Secret?: string;
  Tags?: string[];
}

function mapRuleSeverity(ruleId: string, tags: string[] = []): SecretsFindingRow['severity'] {
  const haystack = `${ruleId} ${tags.join(' ')}`.toLowerCase();
  if (
    /private-key|aws|github-pat|gitlab-pat|slack|stripe|vault|password|credential|jwt|ssh/i.test(
      haystack
    )
  ) {
    return 'High';
  }
  if (/generic|entropy|api-key|token/i.test(haystack)) {
    return 'Medium';
  }
  return 'High';
}

function redactPreview(value: string | undefined): string {
  if (!value?.trim()) return '[redacted]';
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '[redacted]';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-2)}`;
}

export function parseGitleaksReport(raw: unknown): SecretsFindingRow[] {
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((entry, index) => {
    const finding = entry as GitleaksRawFinding;
    const rule = finding.RuleID?.trim() || 'secret-detected';
    const file = finding.File?.trim() || 'unknown';
    const line = finding.StartLine ?? finding.EndLine ?? 0;
    const location = line > 0 ? `${file}:${line}` : file;
    const description =
      finding.Description?.trim() ||
      `Potential secret detected (${rule})`;
    const preview = redactPreview(finding.Match ?? finding.Secret);
    const remediation = resolveSecretsRemediation(rule, location);

    return {
      id: `K-${String(index + 1).padStart(3, '0')}`,
      severity: mapRuleSeverity(rule, finding.Tags ?? []),
      rule,
      location,
      message: `${description} — match: ${preview}`,
      recommendation: remediation.summary,
      remediationSteps: remediation.steps,
      remediationCommands: remediation.commands,
    };
  });
}

async function getGitleaksVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gitleaks', ['version'], { timeout: 5000 });
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function sanitizeGitleaksError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://***@')
    .replace(/ATATT[A-Za-z0-9+/=%_-]+/g, '***')
    .slice(0, 300);
}

export async function runGitleaksScan(input: {
  resource: SecurityResourceView;
  scanOptions?: GitleaksScanOptions;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<GitleaksScanResult> {
  const progress = input.onProgress;
  const scanOptions = input.scanOptions ?? { mode: 'detect' };
  let cleanup: (() => Promise<void>) | null = null;

  try {
    progress?.(8, 'Preparing repository…');
    const prepared = await prepareRepositoryPath(input.resource);
    cleanup = prepared.cleanup;

    const reportPath = path.join(prepared.outputDir, 'gitleaks-report.json');
    progress?.(22, `Running Gitleaks (${gitleaksModeLabel(scanOptions.mode)})…`);

    const cliArgs = buildGitleaksCliArgs(scanOptions, prepared.repoPath, reportPath);

    try {
      await execFileAsync('gitleaks', cliArgs, {
        maxBuffer: 50 * 1024 * 1024,
        timeout: GITLEAKS_TIMEOUT_MS,
        env: toolPathEnv(),
      });
    } catch (err: unknown) {
      const execErr = err as { code?: number | string };
      if (execErr.code !== 1) {
        throw err;
      }
    }

    progress?.(78, 'Processing Gitleaks results…');
    let parsedRaw: unknown = [];
    try {
      const raw = await fs.readFile(reportPath, 'utf-8');
      parsedRaw = raw.trim() ? JSON.parse(raw) : [];
    } catch {
      parsedRaw = [];
    }

    const findings = parseGitleaksReport(parsedRaw);
    const counts = countFindingsBySeverity(findings);
    const gitleaksVersion = await getGitleaksVersion();
    const tool = getSecurityToolById('gitleaks');
    if (!tool) throw new Error('Gitleaks tool definition is missing');

    progress?.(92, 'Building secrets report…');
    const title = `${tool.name} scan — ${input.resource.name}`;
    const findingCount = findings.length;
    const summary =
      findingCount === 0
        ? `Gitleaks (${gitleaksModeLabel(scanOptions.mode)}) completed for ${input.resource.name} — no secrets detected.`
        : `Gitleaks (${gitleaksModeLabel(scanOptions.mode)}) completed for ${input.resource.name} — ${findingCount} potential secret${findingCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`;

    const htmlContent = buildSecretsReportHtml({
      resource: input.resource,
      tool,
      title,
      summary,
      secretsFindings: findings,
    });

    return {
      htmlContent,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      findingCount,
      summary,
      gitleaksVersion,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Bitbucket is not connected')) {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith('Repository scans require')) {
      throw err;
    }

    const message = err instanceof Error ? err.message : 'Gitleaks scan failed';
    const sanitized = formatRepositoryCloneError(err, input.resource.repoUrl ?? '');

    if (/ENOENT.*gitleaks|not found.*gitleaks|spawn gitleaks/i.test(message)) {
      throw new Error(
        'Gitleaks CLI is not installed or not on PATH. Install Gitleaks before running live scans.'
      );
    }

    if (/git clone|unable to access|403|401/i.test(message)) {
      throw new Error(sanitized);
    }

    throw new Error(sanitizeGitleaksError(message));
  } finally {
    if (cleanup) await cleanup();
  }
}

export async function isGitleaksAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gitleaks', ['version'], { timeout: 5000, env: toolPathEnv() });
    return true;
  } catch {
    return false;
  }
}
