import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import {
  buildSecretsReportHtml,
  countFindingsBySeverity,
  type SecretsFindingRow,
} from '@/lib/security-report-export';
import { resolveSecretsRemediation } from '@/lib/security/secrets-remediation';
import { buildFindingSourceUrls, type RepoSourceContext } from '@/lib/security/repo-source-url';
import { formatRepositoryCloneError } from '@/lib/git-error-utils';
import { toolPathEnv } from '@/lib/security/tool-path-env';
import { getSecurityToolById } from '@/lib/security-tools';
import type { SecurityResourceView } from '@/lib/security-service';
import { prepareRepositoryPath } from './security-repo-prep';
import { execForScanJob } from '@/lib/security-scan-exec';
import { ScanCancelledError } from '@/lib/security-scan-cancel';
import {
  buildTrufflehogCliArgs,
  DEFAULT_TRUFFLEHOG_SCAN_OPTIONS,
  trufflehogModeLabel,
  type TrufflehogScanOptions,
} from './trufflehog-options';

const execFileAsync = promisify(execFile);
const TRUFFLEHOG_TIMEOUT_MS = 20 * 60 * 1000;

export interface TrufflehogScanResult {
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findingCount: number;
  summary: string;
  trufflehogVersion: string;
}

interface TrufflehogGitMeta {
  commit?: string;
  file?: string;
  line?: number;
  repository?: string;
}

interface TrufflehogFilesystemMeta {
  file?: string;
  line?: number;
}

interface TrufflehogRawFinding {
  DetectorName?: string;
  DetectorDescription?: string;
  Verified?: boolean;
  Redacted?: string;
  Raw?: string;
  SourceMetadata?: {
    Data?: {
      Git?: TrufflehogGitMeta;
      Filesystem?: TrufflehogFilesystemMeta;
    };
  };
}

function mapDetectorSeverity(detector: string, verified: boolean): SecretsFindingRow['severity'] {
  if (verified) return 'High';
  const haystack = detector.toLowerCase();
  if (
    /aws|github|gitlab|slack|stripe|privatekey|private-key|vault|password|jwt|ssh|apikey|api-key|token|oauth|postgres|mysql|mongodb|redis|azure|gcp|google/i.test(
      haystack
    )
  ) {
    return 'High';
  }
  if (/generic|entropy|canary/i.test(haystack)) {
    return 'Medium';
  }
  return verified ? 'High' : 'Medium';
}

function redactPreview(value: string | undefined): string {
  if (!value?.trim()) return '[redacted]';
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '[redacted]';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-2)}`;
}

function extractLocation(finding: TrufflehogRawFinding): {
  file: string;
  line: number;
  commit?: string;
} {
  const git = finding.SourceMetadata?.Data?.Git;
  if (git?.file) {
    return {
      file: git.file,
      line: git.line ?? 0,
      commit: git.commit,
    };
  }
  const fsMeta = finding.SourceMetadata?.Data?.Filesystem;
  if (fsMeta?.file) {
    return { file: fsMeta.file, line: fsMeta.line ?? 0 };
  }
  return { file: 'unknown', line: 0 };
}

export function parseTrufflehogReport(
  rawStdout: string,
  context?: RepoSourceContext | null
): SecretsFindingRow[] {
  const lines = rawStdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));

  return lines.map((line, index) => {
    const finding = JSON.parse(line) as TrufflehogRawFinding;
    const detector = finding.DetectorName?.trim() || 'secret-detected';
    const { file, line: lineNo, commit } = extractLocation(finding);
    const location = lineNo > 0 ? `${file}:${lineNo}` : file;
    const verified = Boolean(finding.Verified);
    const description =
      finding.DetectorDescription?.trim() ||
      `${detector} credential${verified ? ' (verified live)' : ''}`;
    const preview = redactPreview(finding.Redacted ?? finding.Raw);
    const remediation = resolveSecretsRemediation(detector, location);
    const urls = buildFindingSourceUrls(context, {
      file,
      startLine: lineNo > 0 ? lineNo : undefined,
      commit,
    });

    return {
      id: `K-${String(index + 1).padStart(3, '0')}`,
      severity: mapDetectorSeverity(detector, verified),
      rule: verified ? `${detector} (verified)` : detector,
      location,
      message: `${description} — match: ${preview}`,
      urls,
      recommendation: remediation.summary,
      remediationSteps: remediation.steps,
      remediationCommands: remediation.commands,
    };
  });
}

async function getTrufflehogVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('trufflehog', ['--version'], {
      timeout: 5000,
      env: toolPathEnv(),
    });
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function sanitizeTrufflehogError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://***@')
    .slice(0, 300);
}

export async function runTrufflehogScan(input: {
  resource: SecurityResourceView;
  scanOptions?: TrufflehogScanOptions;
  scanJobId?: string;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<TrufflehogScanResult> {
  const progress = input.onProgress;
  const scanOptions = input.scanOptions ?? DEFAULT_TRUFFLEHOG_SCAN_OPTIONS;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    progress?.(8, 'Preparing repository…');
    const prepared = await prepareRepositoryPath(input.resource);
    cleanup = prepared.cleanup;

    const scanPath =
      scanOptions.mode === 'filesystem'
        ? prepared.repoPath
        : path.resolve(prepared.repoPath);

    progress?.(22, `Running TruffleHog (${trufflehogModeLabel(scanOptions.mode)})…`);
    const cliArgs = buildTrufflehogCliArgs(scanOptions, scanPath);

    let stdout = '';
    try {
      const result = await execForScanJob(input.scanJobId, 'trufflehog', cliArgs, {
        maxBuffer: 100 * 1024 * 1024,
        timeout: TRUFFLEHOG_TIMEOUT_MS,
        env: toolPathEnv(),
      });
      stdout = result.stdout;
    } catch (err: unknown) {
      if (err instanceof ScanCancelledError) throw err;
      const execErr = err as { stdout?: string; stderr?: string; code?: number | string };
      if (typeof execErr.stdout === 'string' && execErr.stdout.trim()) {
        stdout = execErr.stdout;
      } else {
        throw err;
      }
    }

    progress?.(78, 'Processing TruffleHog results…');
    const findings = parseTrufflehogReport(stdout, {
      repoUrl: input.resource.repoUrl ?? '',
      defaultBranch: input.resource.defaultBranch,
    });
    const counts = countFindingsBySeverity(findings);
    const trufflehogVersion = await getTrufflehogVersion();
    const tool = getSecurityToolById('trufflehog');
    if (!tool) throw new Error('TruffleHog tool definition is missing');

    progress?.(92, 'Building secrets report…');
    const title = `${tool.name} scan — ${input.resource.name}`;
    const findingCount = findings.length;
    const verifiedCount = findings.filter((row) => /\(verified\)/i.test(row.rule)).length;
    const summary =
      findingCount === 0
        ? `TruffleHog (${trufflehogModeLabel(scanOptions.mode)}) completed for ${input.resource.name} — no secrets detected.`
        : `TruffleHog (${trufflehogModeLabel(scanOptions.mode)}) completed for ${input.resource.name} — ${findingCount} potential secret${findingCount === 1 ? '' : 's'} (${verifiedCount} verified, ${counts.high} high, ${counts.medium} medium, ${counts.low} low).`;

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
      trufflehogVersion,
    };
  } catch (err) {
    if (err instanceof ScanCancelledError) throw err;
    if (err instanceof Error && err.message.startsWith('Bitbucket is not connected')) {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith('Repository scans require')) {
      throw err;
    }

    const message = err instanceof Error ? err.message : 'TruffleHog scan failed';
    const sanitized = formatRepositoryCloneError(err, input.resource.repoUrl ?? '');

    if (/ENOENT.*trufflehog|not found.*trufflehog|spawn trufflehog/i.test(message)) {
      throw new Error(
        'TruffleHog CLI is not installed or not on PATH. Install TruffleHog before running live scans.'
      );
    }

    if (/git clone|unable to access|403|401/i.test(message)) {
      throw new Error(sanitized);
    }

    throw new Error(sanitizeTrufflehogError(message));
  } finally {
    if (cleanup) await cleanup();
  }
}

export async function isTrufflehogAvailable(): Promise<boolean> {
  try {
    await execFileAsync('trufflehog', ['--version'], { timeout: 5000, env: toolPathEnv() });
    return true;
  } catch {
    return false;
  }
}
