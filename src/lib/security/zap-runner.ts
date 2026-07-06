import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  buildDastReportHtml,
  countFindingsBySeverity,
  type DastFindingRow,
} from '@/lib/security-report-export';
import { getSecurityToolById } from '@/lib/security-tools';
import type { SecurityResourceView } from '@/lib/security-service';
import { resolveZapInstallDir, resolveZapSh, getZapVersion, isZapAvailable } from './zap-install';

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

interface ZapJsonAlert {
  pluginid?: string;
  alert?: string;
  name?: string;
  riskcode?: string;
  confidence?: string;
  riskdesc?: string;
  desc?: string;
  uri?: string;
  instances?: Array<{ uri?: string; method?: string; param?: string }>;
}

interface ZapJsonSite {
  '@name'?: string;
  alerts?: ZapJsonAlert[];
}

interface ZapJsonReport {
  site?: ZapJsonSite[];
}

function mapZapRiskCode(riskcode: string | undefined, riskdesc: string | undefined): string {
  const code = Number.parseInt(riskcode ?? '', 10);
  if (code >= 3) return 'High';
  if (code === 2) return 'Medium';
  if (code === 1) return 'Low';
  if (code === 0) return 'Low';

  const desc = (riskdesc ?? '').toLowerCase();
  if (desc.includes('high')) return 'High';
  if (desc.includes('medium')) return 'Medium';
  if (desc.includes('low')) return 'Low';
  return 'Low';
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseZapJsonReport(raw: unknown): DastFindingRow[] {
  const report = raw as ZapJsonReport;
  const sites = Array.isArray(report?.site) ? report.site : [];
  const findings: DastFindingRow[] = [];
  let index = 0;

  for (const site of sites) {
    const alerts = Array.isArray(site.alerts) ? site.alerts : [];
    for (const alert of alerts) {
      const severity = mapZapRiskCode(alert.riskcode, alert.riskdesc);
      const rule = alert.pluginid?.trim() || 'zap-alert';
      const title = alert.name?.trim() || alert.alert?.trim() || 'Security alert';
      const uri =
        alert.instances?.[0]?.uri?.trim() ||
        alert.uri?.trim() ||
        site['@name']?.trim() ||
        '—';
      const description = stripHtml(alert.desc?.trim() || title);
      const confidence = alert.confidence?.trim() || alert.riskdesc?.trim() || '';

      index += 1;
      findings.push({
        id: `D-${String(index).padStart(3, '0')}`,
        severity,
        rule: `zap:${rule}`,
        location: uri,
        message: confidence ? `${title} — ${description} (${confidence})` : `${title} — ${description}`,
        confidence,
      });
    }
  }

  return findings.sort((a, b) => {
    const rank = (value: string) =>
      value === 'High' ? 0 : value === 'Medium' ? 1 : value === 'Low' ? 2 : 3;
    return rank(a.severity) - rank(b.severity);
  });
}

function sanitizeZapError(message: string): string {
  return message.slice(0, 400);
}

async function readZapReportFile(reportPath: string): Promise<unknown> {
  const raw = await fs.readFile(reportPath, 'utf-8');
  if (!raw.trim()) return { site: [] };
  return JSON.parse(raw) as unknown;
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
    const zapSh = await resolveZapSh();
    const zapDir = (await resolveZapInstallDir())!;
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sn-zap-'));
    const jsonReportPath = path.join(outputDir, 'zap-report.json');

    progress?.(15, 'Updating ZAP add-ons and rule packs…');
    progress?.(22, `Running OWASP ZAP DAST scan on ${targetUrl}…`);

    // User-specified scan flow: zap.sh -cmd -quickurl … -quickout … -quickprogress
    // Pre-install alpha/beta rule packs so all vulnerability checks are enabled.
    await execFileAsync(
      zapSh,
      [
        '-cmd',
        '-addonupdate',
        '-addoninstall',
        'ascanrulesBeta',
        '-addoninstall',
        'pscanrulesBeta',
        '-addoninstall',
        'ascanrulesAlpha',
        '-addoninstall',
        'pscanrulesAlpha',
        '-quickurl',
        targetUrl,
        '-quickout',
        jsonReportPath,
        '-quickprogress',
      ],
      {
        cwd: zapDir,
        timeout: ZAP_SCAN_TIMEOUT_MS,
        maxBuffer: 100 * 1024 * 1024,
        env: {
          ...process.env,
          ZAP_HOME: zapDir,
        },
      }
    );

    progress?.(82, 'Processing ZAP results…');
    let parsedRaw: unknown = { site: [] };
    try {
      parsedRaw = await readZapReportFile(jsonReportPath);
    } catch {
      parsedRaw = { site: [] };
    }

    const findings = parseZapJsonReport(parsedRaw);
    const counts = countFindingsBySeverity(findings);
    const tool = getSecurityToolById('zap');
    if (!tool) throw new Error('OWASP ZAP tool definition is missing');

    const versionLabel = (await getZapVersion()) ?? 'unknown';

    progress?.(92, 'Building DAST report…');
    const title = `${tool.name} scan — ${input.resource.name}`;
    const findingCount = findings.length;
    const summary =
      findingCount === 0
        ? `OWASP ZAP completed for ${input.resource.name} — no vulnerabilities reported.`
        : `OWASP ZAP completed for ${input.resource.name} — ${findingCount} finding${findingCount === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`;

    const htmlContent = buildDastReportHtml({
      resource: input.resource,
      tool,
      title,
      summary,
      dastFindings: findings,
      severityCounts: counts,
    });

    return {
      htmlContent,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      findingCount,
      summary,
      zapVersion: versionLabel,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OWASP ZAP scan failed';

    if (/not installed|not on PATH|before running DAST/i.test(message)) {
      throw new Error(message);
    }

    if (/ENOENT|spawn/i.test(message)) {
      throw new Error(
        'OWASP ZAP is not installed or Java is missing. Install ZAP from Security → Tools before running live scans.'
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