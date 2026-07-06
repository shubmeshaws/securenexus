import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  countFindingsBySeverity,
} from '@/lib/security-report-export';
import type { SecurityResourceView } from '@/lib/security-service';
import { resolveZapInstallDir, getZapVersion, isZapAvailable } from './zap-install';
import { parseZapHtmlSeverityCounts, readZapReportFile } from './zap-report-parse';
import { detectZapScanFailure, interpretReachabilityStatus } from './zap-scan-diagnostics';

const execFileAsync = promisify(execFile);
const ZAP_SCAN_TIMEOUT_MS = 60 * 60 * 1000;

export interface ZapScanResult {
  htmlContent: string;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findingCount: number;
  summary: string;
  zapVersion: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runShell(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
    timeout: ZAP_SCAN_TIMEOUT_MS,
    maxBuffer: 100 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return `${stdout}\n${stderr}`.trim();
}

function sanitizeZapError(message: string): string {
  return message.slice(0, 800);
}

async function preCheckTargetReachability(targetUrl: string): Promise<void> {
  try {
    const statusRaw = await runShell(
      `curl -sS -o /dev/null -w '%{http_code}' --max-time 30 ${shellQuote(targetUrl)} 2>/dev/null || echo '000'`
    );
    const statusCode = Number.parseInt(statusRaw.trim().split('\n').pop() ?? '', 10);
    if (!Number.isFinite(statusCode)) return;

    const message = interpretReachabilityStatus(statusCode, targetUrl);
    // Fail fast on Cloudflare 522 and hard connectivity failures — common on blocked EC2 egress.
    if (message && (statusCode === 522 || statusCode === 0 || statusCode === 403)) {
      throw new Error(message);
    }
  } catch (err) {
    if (err instanceof Error && /Preflight check|HTTP 522|could not connect/i.test(err.message)) {
      throw err;
    }
    // curl missing or blocked — continue with ZAP scan.
  }
}

export async function runZapScan(input: {
  resource: SecurityResourceView;
  onProgress?: (stagePercent: number, message: string) => void;
}): Promise<ZapScanResult> {
  const progress = input.onProgress;

  if (input.resource.type !== 'target_url') {
    throw new Error('OWASP ZAP scans require a URL target resource.');
  }

  const targetUrl = input.resource.targetUrl?.trim();
  if (!targetUrl) {
    throw new Error('URL target is missing a target URL.');
  }

  let outputDir: string | null = null;

  try {
    progress?.(8, 'Locating OWASP ZAP…');
    const zapDir = await resolveZapInstallDir();
    if (!zapDir) {
      throw new Error(
        'OWASP ZAP is not installed. Install ZAP from Security → Tools before running DAST scans.'
      );
    }

    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sn-zap-'));
    const htmlReportPath = path.join(outputDir, 'zap-report.html');

    progress?.(12, 'Checking target reachability from this server…');
    await preCheckTargetReachability(targetUrl);

    progress?.(20, `Running OWASP ZAP scan on ${targetUrl}…`);

    // Exact user command — run from ZAP install dir:
    // ./zap.sh -cmd -quickurl <url> -quickout <report.html> -quickprogress
    const scanCommand = [
      `cd ${shellQuote(zapDir)}`,
      '&&',
      './zap.sh -cmd',
      `-quickurl ${shellQuote(targetUrl)}`,
      `-quickout ${shellQuote(htmlReportPath)}`,
      '-quickprogress',
    ].join(' ');

    let scanOutput = '';
    let scanError: Error | null = null;
    try {
      scanOutput = await runShell(scanCommand, { ...process.env, ZAP_HOME: zapDir });
    } catch (err) {
      scanError = err instanceof Error ? err : new Error(String(err));
      const combined = `${scanError.message}\n${(err as { stdout?: string; stderr?: string }).stdout ?? ''}\n${(err as { stdout?: string; stderr?: string }).stderr ?? ''}`;
      scanOutput = combined.trim();
    }

    const attackFailure = detectZapScanFailure(scanOutput, targetUrl);
    if (attackFailure) {
      throw new Error(attackFailure);
    }

    progress?.(82, 'Processing ZAP results…');

    let reportStat: { size: number } | null = null;
    try {
      reportStat = await fs.stat(htmlReportPath);
    } catch {
      reportStat = null;
    }

    if (!reportStat || reportStat.size === 0) {
      const hint = scanOutput ? ` ZAP output: ${scanOutput.slice(-300)}` : '';
      throw new Error(
        (scanError?.message ??
          `ZAP did not create a report file. Run manually from ${zapDir}: ./zap.sh -cmd -quickurl <url> -quickout report.html -quickprogress`) + hint
      );
    }

    const { content: zapHtmlContent, findings, summaryTotal } = await readZapReportFile(htmlReportPath);

    if (findings.length === 0 && !/Attack complete/i.test(scanOutput)) {
      const failure = detectZapScanFailure(scanOutput, targetUrl);
      throw new Error(
        failure ??
          `ZAP finished but did not complete an attack on ${targetUrl}. Verify this server can reach the URL (compare with a working EC2 instance).`
      );
    }

    const parsedCounts = countFindingsBySeverity(findings);
    const summaryCounts = parseZapHtmlSeverityCounts(zapHtmlContent);
    const counts =
      findings.length > 0
        ? parsedCounts
        : summaryTotal > 0
          ? summaryCounts
          : parsedCounts;

    const versionLabel = (await getZapVersion()) ?? 'unknown';

    progress?.(92, 'Finalizing ZAP report…');
    const findingCount = counts.high + counts.medium + counts.low;
    const summary =
      findingCount === 0
        ? `OWASP ZAP completed for ${input.resource.name} — no vulnerabilities reported. (Target was reachable and scan finished successfully.)`
        : `OWASP ZAP completed for ${input.resource.name} — ${findingCount} finding${findingCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`;

    return {
      htmlContent: zapHtmlContent,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      findingCount,
      summary,
      zapVersion: versionLabel,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OWASP ZAP scan failed';

    if (/not installed|not on PATH|before running DAST|did not create a report/i.test(message)) {
      throw new Error(message);
    }

    if (/ENOENT|No such file|spawn/i.test(message)) {
      throw new Error(
        `OWASP ZAP is not installed at /opt/zap or Java is missing. Install ZAP from Security → Tools, then verify: cd /opt/zap && ./zap.sh -version`
      );
    }

    throw new Error(sanitizeZapError(message));
  } finally {
    if (outputDir) {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export { isZapAvailable } from './zap-install';
